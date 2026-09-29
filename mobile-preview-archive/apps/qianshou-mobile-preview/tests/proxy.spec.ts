/** Exercise the real static dev proxy against a local HTTP account fixture, never production. */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

it('forwards the account path and Bearer, strips ambient cookies in both directions', async () => {
  const fixture = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Set-Cookie', 'fixture_refresh=local-test; HttpOnly')
    response.end(JSON.stringify({
      path: request.url, cookie: request.headers.cookie ?? null, authorization: request.headers.authorization,
      ...(request.url?.startsWith('/api/qianshou/ai/') ? { host: request.headers.host, origin: request.headers.origin } : {}),
    }))
  }).listen(0, '127.0.0.1')
  await once(fixture, 'listening')
  const fixturePort = (fixture.address() as { port: number }).port
  const free = createServer().listen(0, '127.0.0.1'); await once(free, 'listening')
  const previewPort = (free.address() as { port: number }).port
  await new Promise<void>(yes => free.close(() => { yes() }))
  const process = spawn(resolve('node_modules/.bin/vite'), ['--config', 'apps/qianshou-mobile-preview/vite.config.ts', '--port', String(previewPort)], {
    env: { ...globalThis.process.env, QIANSHOU_PREVIEW_ACCOUNT_ORIGIN: `http://127.0.0.1:${fixturePort}`, QIANSHOU_PREVIEW_IMAGE_ORIGIN: `http://127.0.0.1:${fixturePort}` }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  try {
    await new Promise<void>((yes, no) => {
      let output = ''
      const timeout = setTimeout(() => { no(new Error('PREVIEW_START_TIMEOUT')) }, 12_000)
      process.once('exit', () => { clearTimeout(timeout); no(new Error('PREVIEW_START_EXIT')) })
      process.stdout.on('data', (chunk) => { output += String(chunk); if (output.includes(`127.0.0.1:${previewPort}/`)) { clearTimeout(timeout); yes() } })
    })
    const response = await fetch(`http://127.0.0.1:${previewPort}/account-api/api/v8/auth/me`, { headers: { Cookie: 'other_local_owner=fixture-private', Authorization: 'Bearer fixture-access' } })
    expect(response.status).toBe(200)
    expect(response.headers.get('set-cookie')).toBeNull()
    expect(await response.json()).toEqual({ path: '/api/v8/auth/me', cookie: null, authorization: 'Bearer fixture-access' })
    for (const path of ['/api/qianshou/ai/images/generations', '/api/qianshou/ai/images/edits', '/api/qianshou/ai/intent', '/api/qianshou/ai/subscriptions/wallet']) {
      const sameOrigin = await fetch(`http://127.0.0.1:${previewPort}${path}`, { method: 'POST', body: '{}', headers: {
        Origin: `http://127.0.0.1:${previewPort}`, 'Sec-Fetch-Site': 'same-origin', Cookie: 'other_local_owner=fixture-private', Authorization: 'Bearer fixture-access',
      } })
      expect(sameOrigin.headers.get('set-cookie')).toBeNull()
      expect(await sameOrigin.json()).toEqual({ path, cookie: null, authorization: 'Bearer fixture-access', host: `127.0.0.1:${fixturePort}`, origin: `http://127.0.0.1:${fixturePort}` })
    }
    const external = await fetch(`http://127.0.0.1:${previewPort}/api/qianshou/ai/intent`, { method: 'POST', body: '{}', headers: {
      Origin: 'https://external.invalid', 'Sec-Fetch-Site': 'cross-site', Cookie: 'external=not-authority',
    } })
    expect(await external.json()).toMatchObject({ cookie: null, origin: 'https://external.invalid' })
  } finally {
    process.kill('SIGTERM'); await once(process, 'exit')
    await new Promise<void>(yes => fixture.close(() => { yes() }))
  }
}, 20_000)
