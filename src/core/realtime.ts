/**
 * RealtimeService -- SSE-based subscription manager.
 *
 * The stream is opened the way Base serves it:
 *
 *   1. POST {prefix}/realtime/token with the caller's credential mints a grant,
 *      good once and for thirty seconds (an EventSource cannot send a header,
 *      and a credential never travels in a query string);
 *   2. GET  {prefix}/realtime?token=<grant> opens the stream, which answers
 *      CONNECT with the client id;
 *   3. POST {prefix}/realtime {clientId, subscriptions} with the credential
 *      says which topics the stream carries.
 *
 * Base names each event after the subscription it answers ("people/*",
 * "people/RECORD_ID"), so a subscription listens for its own name. Every
 * (re)connect mints a fresh grant. With no credential the stream opens without
 * one and carries what an anonymous caller may read.
 *
 * Features:
 * - Subscription deduplication by topic with reference counting
 * - Auto-reconnect with exponential backoff
 * - Max observed timestamp tracking
 * - Connection state notifications
 */

import type { BaseRecord } from './state.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConnectionState = 'disconnected' | 'connecting' | 'connected'

export interface RealtimeEvent {
  action: 'create' | 'update' | 'delete'
  record: BaseRecord
}

export type RealtimeCallback = (event: RealtimeEvent) => void
export type ConnectionCallback = (state: ConnectionState) => void

interface Subscription {
  /** The topic as Base names it, which is also the event's name. */
  name: string
  collection: string
  topic: string
  callbacks: Set<RealtimeCallback>
  /** The listener bound on the current stream, if one is open. */
  listener: ((e: MessageEvent) => void) | null
}

// ---------------------------------------------------------------------------
// RealtimeService
// ---------------------------------------------------------------------------

export class RealtimeService {
  private readonly _baseUrl: string
  private readonly _prefix: string
  private readonly _getToken: () => string

  private _eventSource: EventSource | null = null
  private _state: ConnectionState = 'disconnected'
  private _connectionListeners = new Set<ConnectionCallback>()

  /** Subscriptions by topic name. */
  private _subscriptions = new Map<string, Subscription>()

  /** SSE client id assigned by the server on connect. */
  private _clientId: string | null = null

  /**
   * Counts connection attempts, so an attempt that is still minting its grant
   * when a newer one starts (or disconnect() is called) knows it was superseded.
   */
  private _attempt = 0

  /** Reconnect state. */
  private _reconnectAttempts = 0
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _maxReconnectDelay = 30_000
  private _baseReconnectDelay = 500

  /** High-water mark of observed server timestamps. */
  private _maxTimestamp = 0n

  /** Set to true when disconnect() is called explicitly. */
  private _intentionalDisconnect = false

  constructor(baseUrl: string, getToken: () => string, prefix = '/v1') {
    this._baseUrl = baseUrl.replace(/\/$/, '')
    this._prefix = prefix
    this._getToken = getToken
  }

  // ---- Public API ---------------------------------------------------------

  get state(): ConnectionState {
    return this._state
  }

  get maxTimestamp(): bigint {
    return this._maxTimestamp
  }

  /**
   * Subscribe to realtime events for a collection topic.
   *
   * Topic is usually "*" (all changes) or a record id.
   * Returns an unsubscribe function.
   */
  subscribe(
    collection: string,
    topic: string,
    callback: RealtimeCallback,
  ): () => void {
    const name = `${collection}/${topic}`
    let sub = this._subscriptions.get(name)
    const added = !sub

    if (!sub) {
      sub = { name, collection, topic, callbacks: new Set(), listener: null }
      this._subscriptions.set(name, sub)
      this._listen(sub)
    }
    sub.callbacks.add(callback)

    if (!this._eventSource && this._state === 'disconnected') {
      this._connect()
    } else if (added && this._clientId) {
      // Already connected -- the server needs the new topic.
      void this._submitSubscriptions()
    }

    return () => {
      sub!.callbacks.delete(callback)
      if (sub!.callbacks.size === 0 && this._subscriptions.get(name) === sub) {
        this._drop([sub!])
      }
    }
  }

  /**
   * Remove every subscriber of a collection, or of one of its topics, or of
   * every collection when called with nothing.
   */
  unsubscribe(collection?: string, topic?: string): void {
    const dropped = [...this._subscriptions.values()].filter(
      (s) =>
        collection === undefined ||
        (s.collection === collection && (topic === undefined || s.topic === topic)),
    )
    if (dropped.length > 0) {
      this._drop(dropped)
    }
  }

  /** Register a connection-state listener. Returns unsubscribe. */
  onConnectionChange(callback: ConnectionCallback): () => void {
    this._connectionListeners.add(callback)
    return () => {
      this._connectionListeners.delete(callback)
    }
  }

  /** Explicitly disconnect. */
  disconnect(): void {
    this._intentionalDisconnect = true
    this._attempt++
    this._clearReconnect()
    this._closeStream()
    this._setState('disconnected')
  }

  // ---- Connection ---------------------------------------------------------

  private _connect(): void {
    if (this._eventSource || this._state === 'connecting') return
    this._clearReconnect()
    this._intentionalDisconnect = false
    this._setState('connecting')

    const attempt = ++this._attempt
    void this._open(attempt)
  }

  private async _open(attempt: number): Promise<void> {
    let url = `${this._baseUrl}${this._prefix}/realtime`

    const token = this._getToken()
    if (token) {
      let grant: string
      try {
        grant = await this._grant(token)
      } catch {
        if (attempt === this._attempt) this._failed()
        return
      }
      // superseded while the grant was being minted
      if (attempt !== this._attempt) return
      url += `?token=${encodeURIComponent(grant)}`
    }

    const es = new EventSource(url)
    this._eventSource = es

    es.addEventListener('CONNECT', (e: MessageEvent) => {
      try {
        const data = JSON.parse(e.data) as { clientId: string }
        this._clientId = data.clientId
        this._reconnectAttempts = 0
        this._setState('connected')
        void this._submitSubscriptions()
      } catch {
        // malformed connect event
      }
    })

    for (const sub of this._subscriptions.values()) {
      this._listen(sub)
    }

    es.onerror = () => {
      if (this._eventSource === es) this._failed()
    }
  }

  /** Mint the grant a stream is opened with. */
  private async _grant(token: string): Promise<string> {
    const res = await fetch(`${this._baseUrl}${this._prefix}/realtime/token`, {
      method: 'POST',
      headers: { Authorization: token },
    })
    if (!res.ok) {
      throw new Error(`realtime grant refused: ${res.status}`)
    }
    const body = (await res.json()) as { token?: string }
    if (!body.token) {
      throw new Error('realtime grant missing from the answer')
    }
    return body.token
  }

  /** The stream failed or was refused: close it and try again later. */
  private _failed(): void {
    this._closeStream()
    this._setState('disconnected')
    if (!this._intentionalDisconnect && this._subscriptions.size > 0) {
      this._scheduleReconnect()
    }
  }

  private _closeStream(): void {
    const es = this._eventSource
    this._eventSource = null
    this._clientId = null
    if (!es) return
    for (const sub of this._subscriptions.values()) {
      if (sub.listener) {
        es.removeEventListener(sub.name, sub.listener as EventListener)
        sub.listener = null
      }
    }
    es.close()
  }

  /** Bind a subscription's event on the open stream, once. */
  private _listen(sub: Subscription): void {
    const es = this._eventSource
    if (!es || sub.listener) return
    sub.listener = (e: MessageEvent) => this._deliver(sub, e)
    es.addEventListener(sub.name, sub.listener as EventListener)
  }

  /** Remove subscriptions, and tell the server, or close an idle stream. */
  private _drop(subs: Subscription[]): void {
    const es = this._eventSource
    for (const sub of subs) {
      if (es && sub.listener) {
        es.removeEventListener(sub.name, sub.listener as EventListener)
      }
      sub.listener = null
      this._subscriptions.delete(sub.name)
    }

    if (this._subscriptions.size === 0) {
      this.disconnect()
    } else if (this._clientId) {
      void this._submitSubscriptions()
    }
  }

  private _deliver(sub: Subscription, e: MessageEvent): void {
    let payload: { action: string; record: BaseRecord }
    try {
      payload = JSON.parse(e.data)
    } catch {
      return
    }

    const action = payload.action as RealtimeEvent['action']
    const record = payload.record
    if (!record?.id) return

    // Track timestamp high-water mark.
    const ts = record.updated ?? record.created
    if (ts) {
      const n = BigInt(new Date(ts).getTime()) * 1000n
      if (n > this._maxTimestamp) {
        this._maxTimestamp = n
      }
    }

    const event: RealtimeEvent = { action, record }
    for (const cb of sub.callbacks) {
      try {
        cb(event)
      } catch {
        // subscriber errors must not break fanout
      }
    }
  }

  /** Submit current subscription set to the server via POST. */
  private async _submitSubscriptions(): Promise<void> {
    if (!this._clientId) return

    const token = this._getToken()
    try {
      await fetch(`${this._baseUrl}${this._prefix}/realtime`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: token } : {}),
        },
        body: JSON.stringify({
          clientId: this._clientId,
          subscriptions: [...this._subscriptions.keys()],
        }),
      })
    } catch {
      // will retry on next reconnect
    }
  }

  // ---- Reconnect ----------------------------------------------------------

  private _scheduleReconnect(): void {
    this._clearReconnect()
    const delay = Math.min(
      this._baseReconnectDelay * Math.pow(2, this._reconnectAttempts),
      this._maxReconnectDelay,
    )
    // Add jitter: +/- 25%
    const jitter = delay * (0.75 + Math.random() * 0.5)
    this._reconnectAttempts++

    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null
      this._connect()
    }, jitter)
  }

  private _clearReconnect(): void {
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer)
      this._reconnectTimer = null
    }
  }

  // ---- State --------------------------------------------------------------

  private _setState(state: ConnectionState): void {
    if (this._state === state) return
    this._state = state
    for (const cb of this._connectionListeners) {
      try {
        cb(state)
      } catch {
        // listener errors must not break notification
      }
    }
  }
}
