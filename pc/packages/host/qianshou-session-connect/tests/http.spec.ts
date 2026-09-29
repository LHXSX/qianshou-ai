/** Real local HTTP sockets and SQLite with synthetic Session text; no remote model or owner cookie. */
import { afterEach, describe, expect, it } from 'vitest'
import { createServer, request as nodeRequest } from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConnectStore } from '../src/store.ts'
import { ConnectService } from '../src/service.ts'
import { ConnectHttp, connectOrigin } from '../src/http.ts'
import type { ConnectionGrantInput } from '../src/types.ts'

const cleanups: Array<() => Promise<void>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
async function fixture(timeoutMs = 500) {
  const store = await ConnectStore.open(':memory:', 4, 10)
  const service = new ConnectService(store, { inspect: async () => ({ events: [], running: false }),
    admitted: async () => false, submit: async () => {},
  }, 5, timeoutMs)
  const server = createServer((req, res) => { void handler.handle(req, res) })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  const handler = new ConnectHttp(service, { origin, viewer: '/* synthetic static browser asset */', maxRequests: 5, timeoutMs })
  cleanups.push(async () => {
    await handler.dispose(); await service.dispose(); server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  })
  const created = await service.create({ sessionId: 'fixture-session', label: 'Synthetic device', mode: 'read', durationMinutes: 1 } as ConnectionGrantInput)
  const token = created.path.split('#')[1]!
  const post = (action: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${origin}/qianshou-connect/api/${action}`, {
    method: 'POST', headers: { Origin: origin, Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  })
  return { origin, service, created, token, post }
}
describe('isolated bearer-only HTTP carrier', () => {
  it('serves only credential-free assets and requires the narrow bearer for transcript access', async () => {
    const f = await fixture(), html = await fetch(`${f.origin}/qianshou-connect/`)
    expect(html.status).toBe(200); expect(html.headers.get('set-cookie')).toBeNull()
    expect(html.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(await html.text()).not.toContain(f.token)
    const missing = await f.post('read', { cursor: null }, { Authorization: '', Cookie: 'owner-browser-auth=fake' })
    expect(missing.status).toBe(401)
    const valid = await f.post('read', { cursor: null })
    expect(valid.status).toBe(200); expect(await valid.json()).toMatchObject({ mode: 'read', turns: [] })
    const forbidden = await f.post('send', { requestId: 'request_001', text: 'MustNotRun' })
    expect(forbidden.status).toBe(403)
  })
  it('rejects CSRF, untrusted Host, extra session fields and unimplemented routes', async () => {
    const f = await fixture()
    expect((await f.post('read', { cursor: null }, { Origin: 'https://untrusted.example' })).status).toBe(403)
    expect((await f.post('read', { cursor: null }, { Origin: '' })).status).toBe(403)
    const foreignHost = await new Promise<number>((resolve, reject) => {
      const req = nodeRequest(`${f.origin}/qianshou-connect/api/read`, { method: 'POST', headers: { Host: 'untrusted.example', Origin: f.origin } }, (res) => {
        res.resume(); res.on('end', () => { resolve(res.statusCode!) }); res.on('error', reject)
      }); req.on('error', reject); req.end()
    })
    expect(foreignHost).toBe(403)
    expect((await f.post('read', { cursor: null, sessionId: 'another' })).status).toBe(400)
    expect((await f.post('interrupt', {})).status).toBe(404)
    expect((await f.post('read', { cursor: null }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
  })
  it('flushes an early 413 before closing an unfinished large upload', async () => {
    const f = await fixture()
    const result = await new Promise<{ status: number; body: string }>((resolve, reject) => {
      const req = nodeRequest(`${f.origin}/qianshou-connect/api/read`, { method: 'POST', headers: { Origin: f.origin, Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json', 'Content-Length': '100000000' } }, (res) => {
        let body = ''; res.on('data', (chunk) => { body += String(chunk) }); res.on('end', () => { resolve({ status: res.statusCode!, body }) }); res.on('error', reject)
      })
      req.on('error', reject); req.flushHeaders(); req.write('{')
    })
    expect(result.status).toBe(413); expect(JSON.parse(result.body)).toEqual({ error: 'invalid-request' })
  })
  it('bounds chunked bodies and closes slow incomplete bodies on the request deadline', async () => {
    const f = await fixture(100)
    const large = await f.post('read', { cursor: 'x'.repeat(20000) })
    expect(large.status).toBe(413)
    const slow = await new Promise<number>((resolve, reject) => {
      const req = nodeRequest(`${f.origin}/qianshou-connect/api/read`, { method: 'POST', headers: { Origin: f.origin, Authorization: `Bearer ${f.token}`, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' } }, (res) => {
        res.resume(); res.on('end', () => { resolve(res.statusCode!) }); res.on('error', reject)
      })
      req.on('error', reject); req.flushHeaders(); req.write('{')
    })
    expect(slow).toBe(504)
  })
  it('denies a revoked grant on the real route and accepts only explicit secure external origins', async () => {
    const f = await fixture(); f.service.revoke(f.created.grant.sessionId, f.created.grant.id)
    expect((await f.post('read', { cursor: null })).status).toBe(403)
    expect(connectOrigin('', 1234)).toBe('http://127.0.0.1:1234')
    expect(connectOrigin('https://connect.example', 1234)).toBe('https://connect.example')
    for (const invalid of ['http://lan.example', 'https://user:password@example.com', 'https://example.com/path', 'https://example.com/?q=x']) expect(() => connectOrigin(invalid, 1234)).toThrow()
  })
})
