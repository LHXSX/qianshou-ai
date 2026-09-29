import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { connect } from 'node:net'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { createPluginLicenseBearerRoute, createPluginLicenseBearerVerifier,
  PLUGIN_LICENSE_BEARER_PATH } from '../src/plugin-license-bearer.ts'

const valid = 'request-bound-access-token-0000000001'
const endpoint = `https://guangzhou.example${PLUGIN_LICENSE_BEARER_PATH}`
const bearerRequest = (token = valid) => new Request(endpoint, {
  method: 'POST', headers: { authorization: `Bearer ${token}` }, body: '{"action":"check"}',
})

test('Mac bearer verification binds identity to Shanghai /auth/me, never the browser session', async () => {
  const seen = []
  const verify = createPluginLicenseBearerVerifier({ accountApiOrigin: 'https://account.example',
    fetcher: async (url, init) => {
      seen.push({ url, init })
      return Response.json({ ok: true, account: { id: 167, username: 'owner', role: 'personal' } })
    } })
  assert.deepEqual(await verify(bearerRequest()), { accountId: '167', role: 'personal', isAdmin: false, username: 'owner' })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].url, 'https://account.example/api/v8/auth/me')
  assert.equal(seen[0].init.headers.authorization, `Bearer ${valid}`)
  assert.equal(seen[0].init.redirect, 'error')
  assert.equal(seen[0].init.credentials, 'omit')
  assert.equal(await verify(new Request(endpoint, { method: 'POST' })), null)
  assert.equal(seen.length, 1)
})

test('missing, invalid, revoked and changed-account tokens cannot reuse a host account', async () => {
  let calls = 0
  const verify = createPluginLicenseBearerVerifier({ accountApiOrigin: 'https://account.example',
    fetcher: async (_url, init) => {
      calls += 1
      const token = init.headers.authorization
      if (token.includes('revoked')) return Response.json({ ok: false }, { status: 401 })
      if (token.includes('another')) return Response.json({ ok: true, account: { id: 202 } })
      return Response.json({ ok: true, account: { id: 101 } })
    } })
  assert.equal(await verify(new Request(endpoint, { method: 'POST' })), null)
  assert.equal(await verify(bearerRequest('bad')), null)
  assert.equal(await verify(bearerRequest('revoked-token-00000000000000000')), null)
  assert.equal((await verify(bearerRequest('another-token-00000000000000000'))).accountId, '202')
  assert.equal((await verify(bearerRequest('first-token-000000000000000000'))).accountId, '101')
  assert.equal(calls, 3)
})

test('missing config, bad origin, upstream outage, redirect and malformed /me all fail closed', async () => {
  assert.throws(() => createPluginLicenseBearerVerifier({ accountApiOrigin: 'https://user@account.example' }),
    /PLUGIN_LICENSE_ACCOUNT_ORIGIN_INVALID/)
  await assert.rejects(createPluginLicenseBearerVerifier({})(bearerRequest()), /ACCOUNT_VERIFICATION_UNAVAILABLE/)
  for (const fetcher of [
    async () => { throw new Error('private upstream detail') },
    async () => Response.redirect('https://evil.example', 302),
    async () => Response.json({ ok: true, account: { id: 'from-client' } }),
    async () => Response.json({ ok: false, account: { id: 12 } }),
    async () => new Response('x'.repeat(32 * 1024 + 1)),
  ]) {
    const verify = createPluginLicenseBearerVerifier({ accountApiOrigin: 'https://account.example', fetcher })
    await assert.rejects(verify(bearerRequest()), /ACCOUNT_VERIFICATION_UNAVAILABLE/)
  }
})

test('public POST bridge forwards only the bearer and bounded JSON; browser origin, duplicate auth and cookies are rejected', async () => {
  const seen = []
  const route = createPluginLicenseBearerRoute({ handle: async request => {
    seen.push({ url: request.url, authorization: request.headers.get('authorization'),
      cookie: request.headers.get('cookie'), body: await request.json() })
    return Response.json({ ok: true, accountId: '167', authMode: 'bearer-request-bound' })
  } })
  const server = createServer((request, response) => void route.handler(request, response))
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}${PLUGIN_LICENSE_BEARER_PATH}`
  const post = (headers, body = '{"action":"check"}') => fetch(url, { method: 'POST', headers, body })
  try {
    const okay = await post({ authorization: `Bearer ${valid}`, cookie: 'browser-session=someone-else' })
    assert.equal(okay.status, 200)
    assert.deepEqual(await okay.json(), { ok: true, accountId: '167', authMode: 'bearer-request-bound' })
    assert.deepEqual(seen, [{ url: `https://qianshou.local${PLUGIN_LICENSE_BEARER_PATH}`,
      authorization: `Bearer ${valid}`, cookie: null, body: { action: 'check' } }])
    assert.equal((await post({ authorization: `Bearer ${valid}`, origin: 'https://other.example' })).status, 403)
    assert.equal((await post({ cookie: 'browser-session=someone-else' })).status, 401)
    const duplicate = await new Promise((resolve, reject) => {
      const socket = connect(address.port, '127.0.0.1')
      let output = ''
      socket.on('connect', () => socket.write(`POST ${PLUGIN_LICENSE_BEARER_PATH} HTTP/1.1\r\nHost: 127.0.0.1\r\n`
        + `Authorization: Bearer ${valid}\r\nAuthorization: Bearer ${valid}\r\n`
        + 'Content-Length: 18\r\nConnection: close\r\n\r\n{"action":"check"}'))
      socket.on('data', chunk => { output += chunk.toString('utf8') })
      socket.on('end', () => resolve(output))
      socket.on('error', reject)
    })
    assert.match(duplicate, /^HTTP\/1\.1 401 /u)
    assert.equal((await post({ authorization: `Bearer ${valid}` }, 'x'.repeat(4097))).status, 400)
    assert.equal((await fetch(url, { method: 'GET' })).status, 405)
    assert.equal(seen.length, 1)
  } finally { await new Promise(resolve => server.close(resolve)) }
})

test('isolated loopback server serves check, idempotent free claim and exact archive through the new route', async () => {
  const child = spawn(process.execPath, ['--experimental-strip-types',
    fileURLToPath(new URL('./seed-loopback-server.mjs', import.meta.url)), '167'],
  { stdio: ['ignore', 'pipe', 'pipe'] })
  const fixture = await new Promise((resolve, reject) => {
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk.toString('utf8')
      if (output.includes('\n')) {
        try { resolve(JSON.parse(output.split('\n')[0])) } catch (error) { reject(error) }
      }
    })
    child.once('error', reject)
    child.once('exit', code => reject(new Error(`TEST_LOOPBACK_EXIT_${code}`)))
  })
  try {
    assert.equal(fixture.testOnly, true)
    const url = fixture.origin + fixture.bearerLicensePath
    const post = (action, token = fixture.testBearer) => fetch(url, { method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(action) })
    const missing = await fetch(url, { method: 'POST', body: '{"action":"check"}' })
    assert.equal(missing.status, 401)
    assert.equal((await post({ action: 'check' }, 'invalid-access-token-0000000001')).status, 401)
    const check = await post({ action: 'check' })
    assert.equal(check.status, 200)
    assert.deepEqual(await check.json(), { ok: true, accountId: '167', authMode: 'bearer-request-bound' })
    const first = await post({ action: 'claim', releaseId: fixture.releaseId })
    assert.equal(first.status, 200)
    const grant = await first.json()
    assert.equal(grant.license.accountId, '167')
    const second = await post({ action: 'claim', releaseId: fixture.releaseId })
    assert.equal((await second.json()).license.licenseId, grant.license.licenseId)
    const archive = await fetch(fixture.origin + grant.download.url, {
      headers: { authorization: `Bearer ${grant.download.token}` },
    })
    assert.equal(archive.status, 200)
    assert.equal(archive.headers.get('x-qianshou-package-sha256'), fixture.packageSha256)
  } finally {
    child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  }
})
