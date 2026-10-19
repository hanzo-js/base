/**
 * The realtime stream, against Base's contract (apis/realtime.go,
 * apis/realtime_grant.go):
 *
 *   POST {prefix}/realtime/token   with the credential   -> {"token"}
 *   GET  {prefix}/realtime?token=  opens the stream       -> event CONNECT {clientId}
 *   POST {prefix}/realtime         {clientId, subscriptions} with the credential
 *
 * and every record event is NAMED after the subscription it answers. A test of
 * onmessage alone would pass against a server that never sends an unnamed event,
 * which is the server Base is, so these drive named events only.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { BaseClient } from '../dist/core/index.js'

/** A stand-in for the browser's EventSource that the test drives by hand. */
class FakeEventSource {
  static opened = []

  constructor(url) {
    this.url = url
    this.closed = false
    this.listeners = new Map()
    this.onerror = null
    FakeEventSource.opened.push(this)
  }

  addEventListener(name, fn) {
    if (!this.listeners.has(name)) this.listeners.set(name, new Set())
    this.listeners.get(name).add(fn)
  }

  removeEventListener(name, fn) {
    this.listeners.get(name)?.delete(fn)
  }

  close() {
    this.closed = true
  }

  /** The server writes `event:<name>\ndata:<data>`. */
  emit(name, data) {
    for (const fn of this.listeners.get(name) ?? []) fn({ data: JSON.stringify(data) })
  }

  fail() {
    this.onerror?.()
  }
}

/** Records every request and answers the grant route with fresh grants. */
function server() {
  const calls = []
  let grants = 0
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(url)
    const call = {
      path: u.pathname,
      method: init.method ?? 'GET',
      auth: init.headers?.Authorization ?? '',
      body: init.body ? JSON.parse(init.body) : undefined,
    }
    calls.push(call)
    if (call.path.endsWith('/realtime/token')) {
      if (!call.auth) return new Response('{}', { status: 401 })
      grants++
      return Response.json({ token: `grant-${grants}` })
    }
    return new Response(null, { status: 204 })
  }
  return calls
}

const tick = () => new Promise((r) => setTimeout(r, 0))

function setup(token = 'iam-jwt') {
  FakeEventSource.opened = []
  globalThis.EventSource = FakeEventSource
  const calls = server()
  const client = new BaseClient({ url: 'https://api.hanzo.ai', prefix: '/v1/base' })
  if (token) client.authStore.save(token, null)
  return { client, calls }
}

test('the stream is opened with a grant minted by an authenticated POST', async () => {
  const { client, calls } = setup()

  client.collection('people').subscribe('*', () => {})
  await tick()

  assert.equal(calls[0].path, '/v1/base/realtime/token')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].auth, 'Bearer iam-jwt')

  assert.equal(FakeEventSource.opened.length, 1)
  const es = FakeEventSource.opened[0]
  assert.equal(es.url, 'https://api.hanzo.ai/v1/base/realtime?token=grant-1')
  assert.ok(!es.url.includes('iam-jwt'), 'the credential never travels in the query')
  client.disconnect()
})

test('CONNECT submits the subscriptions with the credential', async () => {
  const { client, calls } = setup()

  client.collection('people').subscribe('*', () => {})
  client.collection('companies').subscribe('rec1', () => {})
  await tick()
  FakeEventSource.opened[0].emit('CONNECT', { clientId: 'c1' })
  await tick()

  const post = calls.find((c) => c.path === '/v1/base/realtime' && c.method === 'POST')
  assert.ok(post, 'subscriptions were submitted')
  assert.equal(post.auth, 'Bearer iam-jwt')
  assert.deepEqual(post.body, { clientId: 'c1', subscriptions: ['people/*', 'companies/rec1'] })
  assert.equal(client.realtime.state, 'connected')
  client.disconnect()
})

test('a named event reaches the subscriber of that topic and no other', async () => {
  const { client } = setup()

  const people = []
  const companies = []
  client.collection('people').subscribe('*', (e) => people.push(e))
  client.collection('companies').subscribe('*', (e) => companies.push(e))
  await tick()
  const es = FakeEventSource.opened[0]
  es.emit('CONNECT', { clientId: 'c1' })

  es.emit('people/*', { action: 'create', record: { id: 'p1', collectionName: 'people', updated: '2026-10-18 10:00:00.000Z' } })

  assert.equal(people.length, 1)
  assert.equal(people[0].action, 'create')
  assert.equal(people[0].record.id, 'p1')
  assert.equal(companies.length, 0)
  assert.ok(client.realtime.maxTimestamp > 0n, 'the high-water mark follows the event')
  client.disconnect()
})

test('a subscription made on an open stream listens and resubmits', async () => {
  const { client, calls } = setup()

  client.collection('people').subscribe('*', () => {})
  await tick()
  const es = FakeEventSource.opened[0]
  es.emit('CONNECT', { clientId: 'c1' })
  await tick()

  const got = []
  client.collection('tasks').subscribe('*', (e) => got.push(e))
  await tick()

  const posts = calls.filter((c) => c.path === '/v1/base/realtime' && c.method === 'POST')
  assert.deepEqual(posts.at(-1).body.subscriptions, ['people/*', 'tasks/*'])
  es.emit('tasks/*', { action: 'update', record: { id: 't1' } })
  assert.equal(got.length, 1)
  client.disconnect()
})

test('unsubscribing resubmits what is left, and the last one closes the stream', async () => {
  const { client, calls } = setup()

  const offPeople = client.collection('people').subscribe('*', () => {})
  const got = []
  const offTasks = client.collection('tasks').subscribe('*', (e) => got.push(e))
  await tick()
  const es = FakeEventSource.opened[0]
  es.emit('CONNECT', { clientId: 'c1' })
  await tick()

  offTasks()
  await tick()
  const posts = calls.filter((c) => c.path === '/v1/base/realtime' && c.method === 'POST')
  assert.deepEqual(posts.at(-1).body.subscriptions, ['people/*'])
  es.emit('tasks/*', { action: 'update', record: { id: 't1' } })
  assert.equal(got.length, 0, 'a dropped topic delivers nothing')

  offPeople()
  assert.equal(es.closed, true)
  assert.equal(client.realtime.state, 'disconnected')
})

test('collection().unsubscribe() drops that collection only', async () => {
  const { client, calls } = setup()

  client.collection('people').subscribe('*', () => {})
  client.collection('people').subscribe('p1', () => {})
  client.collection('tasks').subscribe('*', () => {})
  await tick()
  FakeEventSource.opened[0].emit('CONNECT', { clientId: 'c1' })
  await tick()

  client.collection('people').unsubscribe()
  await tick()
  const posts = calls.filter((c) => c.path === '/v1/base/realtime' && c.method === 'POST')
  assert.deepEqual(posts.at(-1).body.subscriptions, ['tasks/*'])
  client.disconnect()
})

test('a reconnect mints a new grant, because a grant is spent once', async () => {
  const { client, calls } = setup()
  client.realtime._baseReconnectDelay = 1

  const got = []
  client.collection('people').subscribe('*', (e) => got.push(e))
  await tick()
  const first = FakeEventSource.opened[0]
  first.emit('CONNECT', { clientId: 'c1' })
  first.fail()
  assert.equal(first.closed, true)

  await new Promise((r) => setTimeout(r, 20))
  assert.equal(FakeEventSource.opened.length, 2)
  const second = FakeEventSource.opened[1]
  assert.equal(second.url, 'https://api.hanzo.ai/v1/base/realtime?token=grant-2')
  assert.equal(calls.filter((c) => c.path.endsWith('/realtime/token')).length, 2)

  second.emit('CONNECT', { clientId: 'c2' })
  second.emit('people/*', { action: 'delete', record: { id: 'p9' } })
  assert.equal(got.length, 1, 'the new stream carries the old subscription')
  client.disconnect()
})

test('a refused grant opens no stream and retries', async () => {
  const { client } = setup()
  client.realtime._baseReconnectDelay = 1
  let refuse = true
  const ok = globalThis.fetch
  globalThis.fetch = async (url, init) =>
    refuse && String(url).endsWith('/realtime/token') ? new Response('{}', { status: 503 }) : ok(url, init)

  client.collection('people').subscribe('*', () => {})
  await tick()
  assert.equal(FakeEventSource.opened.length, 0)
  assert.equal(client.realtime.state, 'disconnected')

  refuse = false
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(FakeEventSource.opened.length, 1)
  client.disconnect()
})

test('with no credential the stream opens anonymously, with no grant', async () => {
  const { client, calls } = setup('')

  client.collection('posts').subscribe('*', () => {})
  await tick()

  assert.equal(calls.filter((c) => c.path.endsWith('/realtime/token')).length, 0)
  assert.equal(FakeEventSource.opened[0].url, 'https://api.hanzo.ai/v1/base/realtime')
  client.disconnect()
})

test('disconnect while a grant is minted opens nothing', async () => {
  const { client } = setup()

  client.collection('people').subscribe('*', () => {})
  client.disconnect()
  await tick()

  assert.equal(FakeEventSource.opened.length, 0)
  assert.equal(client.realtime.state, 'disconnected')
})

test('the password, OAuth, verification and reset calls are gone', () => {
  const { client } = setup()
  const svc = client.collection('users')
  for (const name of [
    'authWithPassword',
    'authWithOAuth2',
    'requestVerification',
    'confirmVerification',
    'requestPasswordReset',
    'confirmPasswordReset',
  ]) {
    assert.equal(svc[name], undefined, `${name} is not offered`)
  }
  assert.equal(client.signInWithPassword, undefined)
  assert.equal(client.signUp, undefined)
})
