/**
 * The table wire: @hanzo/base/rest.
 *
 * A sibling of the collection client rather than a replacement for it. That one
 * speaks Base's own /v1 surface — collections, records, realtime, CRDT. This one
 * speaks the /rest/v1 table wire the console's grid is built on, where a table is
 * the path and the filters are query params.
 *
 * One table per path, filters in the query string, rows as a bare array:
 *
 *     const db = base('https://base.example', key)
 *     const { data } = await db.from('posts').select('*').eq('status', 'live').limit(20)
 *
 * It has no dependencies and reaches nothing but `fetch`. The wire it speaks is
 * Base's `/rest/v1`, which the server implements in `apis/rest.go` — that file
 * is the contract, and every behaviour below is there rather than invented here.
 */

/** A row, as it comes off the wire. */
export type Row = Record<string, unknown>

/** What a call answers with. `error` is null on success and data is null on failure — never both. */
export interface Result<T> {
  data: T | null
  error: Fault | null
  /** Present when a count was asked for, null otherwise, because an unasked count is not zero. */
  count: number | null
  status: number
}

/**
 * A failure, as the wire states it.
 *
 * `code` is what callers branch on: a store code for a constraint the database
 * refused (`23505` for a duplicate) or a wire code for a request it would not
 * accept. `details` carries the specifics a person needs to act on it.
 */
export interface Fault {
  message: string
  details: string
  hint: string
  code: string
}

type Method = 'GET' | 'HEAD' | 'POST' | 'PATCH' | 'DELETE'

export interface Options {
  /** Sent as the bearer. */
  key?: string
  /** Swapped in tests, and in a runtime that carries its own fetch. */
  fetch?: typeof fetch
  /** Merged into every request. */
  headers?: Record<string, string>
}

/** Opens a client against a Base. */
export function base(url: string, key?: string, options: Options = {}): Client {
  return new Client(url, { ...options, key: key ?? options.key })
}

export class Client {
  readonly #url: string
  readonly #options: Options

  constructor(url: string, options: Options = {}) {
    this.#url = url.replace(/\/+$/, '')
    this.#options = options
  }

  /** Names the table a query runs against. */
  from(table: string): Query {
    return new Query(`${this.#url}/rest/v1/${encodeURIComponent(table)}`, this.#options)
  }
}

/**
 * A query, built by chaining and sent when awaited.
 *
 * Nothing leaves until the promise is awaited, so a builder can be passed around
 * and narrowed without anyone accidentally issuing a request by holding it.
 */
export class Query implements PromiseLike<Result<Row[]>> {
  #path: string
  #params = new URLSearchParams()
  #options: Options
  #method: Method = 'GET'
  #body: unknown
  #headers: Record<string, string> = {}
  #wantCount = false

  constructor(path: string, options: Options) {
    this.#path = path
    this.#options = options
  }

  // --- shaping ---------------------------------------------------------------

  /** Which columns to return. Omit or pass `*` for all of them. */
  select(columns = '*'): this {
    this.#params.set('select', columns)
    // On a write, asking for columns is also asking for the rows back — the
    // server returns nothing unless told to, so saying select() means both.
    if (this.#method !== 'GET' && this.#method !== 'HEAD') {
      this.#headers['Prefer'] = join(this.#headers['Prefer'], 'return=representation')
    }
    return this
  }

  /** Sort. A bare column is ascending, as in SQL. */
  order(column: string, opts: { ascending?: boolean } = {}): this {
    const dir = opts.ascending === false ? 'desc' : 'asc'
    const prior = this.#params.get('order')
    this.#params.set('order', join(prior ?? undefined, `${column}.${dir}`, ','))
    return this
  }

  /** How many rows at most. */
  limit(n: number): this {
    this.#params.set('limit', String(n))
    return this
  }

  /**
   * Where the window starts. Base pages, so an offset has to land on a page
   * boundary — an offset that does not is refused rather than rounded, because a
   * shifted window returns real rows for a range nobody asked for.
   */
  range(from: number, to: number): this {
    this.#params.set('limit', String(to - from + 1))
    this.#params.set('offset', String(from))
    return this
  }

  /** Ask for the total. Without this the count is not computed and comes back null. */
  count(): this {
    this.#wantCount = true
    this.#headers['Prefer'] = join(this.#headers['Prefer'], 'count=exact')
    return this
  }

  /** Answer one row rather than an array, or fail if the query did not match exactly one. */
  single(): PromiseLike<Result<Row>> {
    // The server does the narrowing: this Accept is a claim that the query hits
    // exactly one row, and it answers a bare object or refuses. There is nothing
    // for the client to remember afterwards.
    this.#headers['Accept'] = 'application/vnd.pgrst.object+json'
    return this as unknown as PromiseLike<Result<Row>>
  }

  // --- filters ---------------------------------------------------------------

  eq(column: string, value: unknown): this { return this.#filter(column, 'eq', value) }
  neq(column: string, value: unknown): this { return this.#filter(column, 'neq', value) }
  gt(column: string, value: unknown): this { return this.#filter(column, 'gt', value) }
  gte(column: string, value: unknown): this { return this.#filter(column, 'gte', value) }
  lt(column: string, value: unknown): this { return this.#filter(column, 'lt', value) }
  lte(column: string, value: unknown): this { return this.#filter(column, 'lte', value) }

  /** Pattern match. `*` is the wildcard. */
  like(column: string, pattern: string): this { return this.#filter(column, 'like', pattern) }
  /** Pattern match, ignoring case. */
  ilike(column: string, pattern: string): this { return this.#filter(column, 'ilike', pattern) }

  /** `null`, `true` or `false` — a state rather than a comparison. */
  is(column: string, value: null | boolean): this {
    return this.#filter(column, 'is', value === null ? 'null' : String(value))
  }

  /** Any of these values. */
  in(column: string, values: readonly unknown[]): this {
    return this.#filter(column, 'in', `(${values.map(String).join(',')})`)
  }

  /** Negates any of the above: `.not('deleted', 'is', null)` is IS NOT NULL. */
  not(column: string, op: string, value: unknown): this {
    this.#params.append(column, `not.${op}.${stringify(value)}`)
    return this
  }

  // --- writes ----------------------------------------------------------------

  /**
   * Adds one row.
   *
   * One row per call, deliberately: several rows have to be one statement to
   * roll back as one, and a client loop would half-apply a failure while
   * reporting success for whatever landed.
   */
  insert(row: Row): this {
    this.#method = 'POST'
    this.#body = row
    return this
  }

  /** Changes every row the filters select. */
  update(patch: Row): this {
    this.#method = 'PATCH'
    this.#body = patch
    return this
  }

  /** Removes every row the filters select. */
  delete(): this {
    this.#method = 'DELETE'
    return this
  }

  // --- sending ---------------------------------------------------------------

  then<A = Result<Row[]>, B = never>(
    onDone?: ((value: Result<Row[]>) => A | PromiseLike<A>) | null,
    onFail?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): PromiseLike<A | B> {
    return this.#send().then(onDone, onFail)
  }

  #filter(column: string, op: string, value: unknown): this {
    this.#params.append(column, `${op}.${stringify(value)}`)
    return this
  }

  async #send(): Promise<Result<any>> {
    const send = this.#options.fetch ?? fetch
    const headers: Record<string, string> = {
      ...(this.#options.headers ?? {}),
      ...this.#headers,
    }
    if (this.#options.key) headers['Authorization'] = `Bearer ${this.#options.key}`
    if (this.#body !== undefined) headers['Content-Type'] = 'application/json'

    const query = this.#params.toString()
    const res = await send(query ? `${this.#path}?${query}` : this.#path, {
      method: this.#method,
      headers,
      body: this.#body === undefined ? undefined : JSON.stringify(this.#body),
    })

    // The count rides in Content-Range as `<from>-<to>/<total>`, and `*` where
    // it was not asked for — which is why an unasked count is null rather than 0.
    let count: number | null = null
    if (this.#wantCount) {
      const total = res.headers.get('content-range')?.split('/')[1]
      if (total && total !== '*') count = Number(total)
    }

    const text = this.#method === 'HEAD' ? '' : await res.text()

    if (!res.ok) {
      return { data: null, error: fault(text, res.status), count: null, status: res.status }
    }

    // An empty body is a write that was not asked to return anything, which is
    // a success with nothing to hand back rather than a parse failure.
    const data = text === '' ? null : JSON.parse(text)
    return { data, error: null, count, status: res.status }
  }
}

/** Reads a failure body, falling back to the raw text when it is not one. */
function fault(text: string, status: number): Fault {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && 'message' in parsed) {
      return {
        message: String(parsed.message ?? ''),
        details: String(parsed.details ?? ''),
        hint: String(parsed.hint ?? ''),
        code: String(parsed.code ?? ''),
      }
    }
  } catch {
    // not a failure body; fall through to the raw text
  }
  return { message: text || `request failed with ${status}`, details: '', hint: '', code: '' }
}

/** Joins header or query parts without producing a leading separator. */
function join(prior: string | undefined, next: string, sep = ','): string {
  return prior ? `${prior}${sep}${next}` : next
}

function stringify(value: unknown): string {
  return value === null ? 'null' : String(value)
}
