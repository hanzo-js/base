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
