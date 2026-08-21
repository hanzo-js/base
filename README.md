# @hanzo/base

[![npm](https://img.shields.io/npm/v/@hanzo/base.svg)](https://www.npmjs.com/package/@hanzo/base)

The JavaScript/TypeScript client for [Hanzo Base](https://hanzo.ai), the
reactive backend. Auth is [Hanzo IAM](https://hanzo.id)-native: the client
holds the IAM-issued JWT and validates it locally.

Zero runtime dependencies. Records/collections CRUD, realtime (SSE), files,
reactive queries with optimistic writes, and CRDT primitives — with optional
React bindings.

There is a companion Dart client, [`hanzo`](https://github.com/hanzo-dart/base),
that mirrors this shape.

## Install

```sh
npm install @hanzo/base
```

```ts
import { BaseClient } from '@hanzo/base'

const base = new BaseClient('https://base.hanzo.ai')
```

## Auth (Hanzo IAM)

```ts
await base.collection('users').authWithPassword('me@example.com', 'secret')

base.authStore.isValid   // JWT present and unexpired
base.authStore.token     // the IAM JWT
base.authStore.record    // the authenticated record

base.signOut()
```

Persist the session in the browser:

```ts
import { BaseClient } from '@hanzo/base'
import { LocalAuthStore } from '@hanzo/base/compat'

const base = new BaseClient({
  url: 'https://base.hanzo.ai',
  authStore: new LocalAuthStore(),
})
```

## Records / collections

```ts
const page = await base.collection('posts').getList(1, 20, {
  filter: 'published = true',
  sort: '-created',
})

const one = await base.collection('posts').getOne('RECORD_ID')
const made = await base.collection('posts').create({ title: 'hi' })
await base.collection('posts').update('RECORD_ID', { title: 'yo' })
await base.collection('posts').delete('RECORD_ID')
```

## Realtime (SSE)

```ts
const off = base.collection('posts').subscribe('*', (e) => {
  console.log(e.action, e.record) // 'create' | 'update' | 'delete'
})
off()
```

## Files

```ts
const url = base.files.getURL(record, 'photo.png', { thumb: '100x100' })
```

## Reactive queries + CRDT

`@hanzo/base` ships a reactive `QueryStore` with optimistic updates and
server reconciliation, plus CRDT primitives (`@hanzo/base/crdt`) for
collaborative state. React bindings live at `@hanzo/base/react`.

```ts
import { QueryStore } from '@hanzo/base'
import { CRDTText } from '@hanzo/base/crdt'
```

## Develop

```sh
npm install
npm run build
npm test
```

## License

MIT © Hanzo AI, Inc. See [LICENSE](LICENSE).

## `@hanzo/base/rest` — the table wire

A sibling of the collection client, not a replacement. That one speaks Base's own
`/v1` surface: collections, records, realtime, CRDT. This one speaks the
table wire at `<prefix>/rest/{table}`, where a table is the path and the filters
are query params — the shape the console's data grid is built on.

```ts
import { base } from '@hanzo/base/rest'

const db = base('https://base.example', key)

const { data, count } = await db
  .from('posts')
  .select('id,title')
  .eq('status', 'live')
  .order('created', { ascending: false })
  .limit(20)
  .count()
```

Filters are `eq neq gt gte lt lte like ilike is in`, with `.not(column, op,
value)` negating any of them. Writes are `.insert()`, `.update()` and
`.delete()`, and return nothing unless `.select()` asks for the rows back.

Three things worth knowing, because each is where a client usually gets it wrong:

- **An unasked count is `null`, never `0`.** The server does not compute a total
  unless asked, so reporting zero would be inventing an answer to a question
  nobody put.
- **A query sends nothing until it is awaited**, so a builder can be passed
  around and narrowed without anyone issuing a request by holding one.
- **`update` and `delete` require a filter.** They act on every row the filter
  selects, and an unfiltered one would mean the whole table — the server refuses
  it rather than applying it.

Failures carry `{ message, details, hint, code }`. `code` is what to branch on:

```ts
const { error } = await db.from('posts').insert({ title })
if (error?.code === '23505') return 'that title is taken'
```
