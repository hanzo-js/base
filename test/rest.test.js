import { test } from 'node:test'
import assert from 'node:assert/strict'
import { base } from '../dist/rest/index.js'

/** Captures the one request a query sends, and answers whatever the test wants. */
function spy(answer = { body: '[]', status: 200, headers: {} }) {
  const seen = {}
  const fetch = async (url, init) => {
    seen.raw = url
    seen.url = new URL(url, 'http://relative.invalid')
    seen.method = init.method
    seen.headers = init.headers
    seen.body = init.body
    return {
      ok: answer.status < 400,
      status: answer.status,
      headers: { get: (k) => answer.headers[k.toLowerCase()] ?? null },
      text: async () => answer.body,
    }
  }
  return { seen, fetch }
}

test('a table is one path, and the client adds the wire prefix', async () => {
  const { seen, fetch } = spy()
  await base('https://db.example', 'k', { fetch }).from('posts').select('*')
  assert.equal(seen.url.pathname, '/v1/rest/posts')
  assert.equal(seen.method, 'GET')
  assert.equal(seen.headers['Authorization'], 'Bearer k')
})

test('a trailing slash on the host does not double up', async () => {
  const { seen, fetch } = spy()
  await base('https://db.example///', 'k', { fetch }).from('posts').select()
  assert.equal(seen.url.pathname, '/v1/rest/posts')
})

test('filters become query params the server can read', async () => {
  const { seen, fetch } = spy()
  await base('https://db.example', 'k', { fetch })
    .from('posts')
    .select('id,title')
    .eq('status', 'live')
    .gte('views', 100)
    .order('created', { ascending: false })
    .limit(20)

  const q = seen.url.searchParams
  assert.equal(q.get('select'), 'id,title')
  assert.equal(q.get('status'), 'eq.live')
  assert.equal(q.get('views'), 'gte.100')
  assert.equal(q.get('order'), 'created.desc')
  assert.equal(q.get('limit'), '20')
})

test('in carries every value, and not negates whatever follows', async () => {
  const { seen, fetch } = spy()
  await base('https://db.example', 'k', { fetch })
    .from('posts')
    .select()
    .in('id', ['a', 'b'])
    .not('deleted', 'is', null)

  assert.equal(seen.url.searchParams.get('id'), 'in.(a,b)')
  assert.equal(seen.url.searchParams.get('deleted'), 'not.is.null')
})

test('is takes a state, not a quoted word', async () => {
  const { seen, fetch } = spy()
  await base('https://db.example', 'k', { fetch }).from('posts').select().is('deleted', null)
  assert.equal(seen.url.searchParams.get('deleted'), 'is.null')
})

test('range asks for a window by limit and offset', async () => {
  const { seen, fetch } = spy()
  await base('https://db.example', 'k', { fetch }).from('posts').select().range(50, 74)
  assert.equal(seen.url.searchParams.get('limit'), '25')
  assert.equal(seen.url.searchParams.get('offset'), '50')
})

test('a count is asked for, and read out of the header', async () => {
  const { seen, fetch } = spy({ body: '[]', status: 200, headers: { 'content-range': '0-2/37' } })
  const res = await base('https://db.example', 'k', { fetch }).from('posts').select().count()
  assert.match(seen.headers['Prefer'], /count=exact/)
  assert.equal(res.count, 37)
})

test('an unasked count is null, never zero', async () => {
  const { fetch } = spy({ body: '[]', status: 200, headers: {} })
  const res = await base('https://db.example', 'k', { fetch }).from('posts').select()
  assert.equal(res.count, null)
})

test('a write asks for its rows back only when select() says so', async () => {
  const bare = spy({ body: '', status: 201, headers: {} })
  await base('https://db.example', 'k', { fetch: bare.fetch }).from('posts').insert({ title: 'x' })
  assert.equal(bare.seen.method, 'POST')
  assert.equal(bare.seen.headers['Prefer'], undefined)

  const back = spy({ body: '[{"id":"1"}]', status: 201, headers: {} })
  await base('https://db.example', 'k', { fetch: back.fetch }).from('posts').insert({ title: 'x' }).select()
  assert.match(back.seen.headers['Prefer'], /return=representation/)
})

test('an empty body is a success with nothing to hand back', async () => {
  const { fetch } = spy({ body: '', status: 204, headers: {} })
  const res = await base('https://db.example', 'k', { fetch }).from('posts').delete().eq('id', '1')
  assert.equal(res.error, null)
  assert.equal(res.data, null)
  assert.equal(res.status, 204)
})

test('a failure is read into the shape callers branch on', async () => {
  const { fetch } = spy({
    status: 409,
    headers: {},
    body: JSON.stringify({
      message: 'duplicate key value violates unique constraint',
      details: 'Key (title) already exists.',
      hint: '',
      code: '23505',
    }),
  })
  const res = await base('https://db.example', 'k', { fetch }).from('posts').insert({ title: 'test1' })
  assert.equal(res.data, null)
  assert.equal(res.error.code, '23505')
  assert.match(res.error.details, /already exists/)
})

test('a failure that is not a failure body still yields something readable', async () => {
  const { fetch } = spy({ body: 'upstream exploded', status: 502, headers: {} })
  const res = await base('https://db.example', 'k', { fetch }).from('posts').select()
  assert.equal(res.error.message, 'upstream exploded')
  assert.equal(res.error.code, '')
})

test('single asks for one row rather than an array', async () => {
  const { seen, fetch } = spy({ body: '{"id":"1"}', status: 200, headers: {} })
  const res = await base('https://db.example', 'k', { fetch }).from('posts').select().eq('id', '1').single()
  assert.equal(seen.headers['Accept'], 'application/vnd.hanzo.object+json')
  assert.equal(res.data.id, '1')
})

test('nothing is sent until the query is awaited', async () => {
  const { seen, fetch } = spy()
  const q = base('https://db.example', 'k', { fetch }).from('posts').select().eq('a', 1)
  assert.equal(seen.url, undefined, 'building a query must not issue a request')
  await q
  assert.ok(seen.url, 'awaiting it must')
})

test('a relative base addresses the same origin, which is what an app served beside Base needs', async () => {
  const { seen, fetch } = spy()
  await base('', undefined, { fetch }).from('posts').select().eq('id', '1')
  assert.equal(seen.raw, '/v1/rest/posts?select=*&id=eq.1', 'a relative base must stay relative')
})
