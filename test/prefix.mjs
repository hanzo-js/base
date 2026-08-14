/**
 * The API prefix — the client half of the server's BASE_API_PREFIX.
 *
 * A Base is not always alone on its origin. A host that mounts several apps
 * gives each one a prefix so their routes cannot collide, and Base is told its
 * own at router build; a client that assumed `/v1` could only ever talk to a
 * Base that had the origin to itself. Hanzo Cloud serves each org's Base at
 * `/v1/base`, which is what this exists for.
 *
 * The request URL is what these assert, because that is the whole contract —
 * a prefix that is stored but not spelled onto the wire is a prefix that does
 * nothing. So every case captures the URL a real call would send.
 */

import { BaseClient, FileService } from '../dist/core/index.js'

let passed = 0
let failed = 0

function check(name, actual, expected) {
  if (actual === expected) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.log(`  FAIL ${name}\n       expected ${expected}\n       actual   ${actual}`)
  }
}

/**
 * Capture the URL of the next request, without one leaving.
 *
 * The body is a well-formed list envelope because the client parses what comes
 * back before this test gets to look at anything — an empty object throws in the
 * store, and the failure reads like a prefix bug rather than a stub one.
 */
function capturing() {
  const seen = []
  globalThis.fetch = async (url) => {
    seen.push(String(url))
    const body = { items: [], page: 1, perPage: 30, totalItems: 0, totalPages: 0, id: 'abc' }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }
  return seen
}

console.log('\nAPI prefix')

// The default is /v1, so every existing caller is unaffected by the knob existing.
{
  const c = new BaseClient('https://myapp.hanzo.ai')
  const seen = capturing()
  await c.list('posts')
  check('defaults to /v1', seen[0], 'https://myapp.hanzo.ai/v1/collections/posts/records')
  check('exposes the default', c.prefix, '/v1')
}

// The case this was built for: cloud mounts each org's Base under /v1/base.
{
  const c = new BaseClient({ url: 'https://api.hanzo.ai', prefix: '/v1/base' })
  const seen = capturing()
  await c.list('posts')
  check(
    'honours a nested prefix',
    seen[0],
    'https://api.hanzo.ai/v1/base/collections/posts/records',
  )
}

// One record, through the collection service rather than the direct helper —
// a different code path, and it has to agree with the one above.
{
  const c = new BaseClient({ url: 'https://api.hanzo.ai', prefix: '/v1/base' })
  const seen = capturing()
  await c.collection('posts').getOne('abc')
  check(
    'collection() agrees with list()',
    seen[0],
    'https://api.hanzo.ai/v1/base/collections/posts/records/abc',
  )
}

// Health is on the same root, so it moves with the prefix.
{
  const c = new BaseClient({ url: 'https://api.hanzo.ai', prefix: '/v1/base' })
  const seen = capturing()
  await c.health()
  check('health moves with the prefix', seen[0], 'https://api.hanzo.ai/v1/base/health')
}

// A file URL is built, not fetched, so it is checked directly.
check(
  'file URLs carry the prefix',
  new FileService('https://api.hanzo.ai', '/v1/base').getURL(
    { id: 'r1', collectionId: 'c1' },
    'a.png',
  ),
  'https://api.hanzo.ai/v1/base/files/c1/r1/a.png',
)

// Spelling: a caller should not have to know whether we want the slashes.
{
  const bare = new BaseClient({ url: 'https://x.dev', prefix: 'v1/base' })
  check('adds a missing leading slash', bare.prefix, '/v1/base')
  const trailing = new BaseClient({ url: 'https://x.dev', prefix: '/v1/base/' })
  check('drops a trailing slash', trailing.prefix, '/v1/base')
}

// An empty prefix means the API is at the origin root — expressible on purpose,
// because "no prefix" is a real answer and must not silently become /v1.
{
  const c = new BaseClient({ url: 'https://x.dev', prefix: '/' })
  const seen = capturing()
  await c.list('posts')
  check('an empty prefix roots at the origin', seen[0], 'https://x.dev/collections/posts/records')
}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed === 0 ? 0 : 1)
