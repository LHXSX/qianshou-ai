/** Guangzhou's inbound calls: adopt the same account, bootstrap the newest Session, admit phone text on this PC. */
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { PcWindowService } from '../src/service.ts'
import type { MobileSessionPort } from '../src/session-port.ts'
import { MobileSyncStore } from '../src/store.ts'
import type { ConnectionFetchRoute } from '@deepseek-ai/dsh-client-connection'
import { registerPhoneWindowRoutes } from '../src/window-http.ts'

const ACCOUNT = 'acct-1'
const WORKER = 'worker-7'
const COOKIE = 'dsh-auth-abc=v1.aaa.bbb; Max-Age=60; Path=/; Expires=Thu, 01 Jan 2099 00:00:00 GMT; HttpOnly; SameSite=Strict'
const NOW = 1_700_000_000_000

interface RecordedRoute { readonly path: string; readonly fetch: ConnectionFetchRoute['fetch'] }

function routesOf(): { ctx: Context; routes: Map<string, RecordedRoute> } {
  const routes = new Map<string, RecordedRoute>()
  const ctx = {
    effect: (register: () => void) => { register() },
    connection: {
      fetch: { register: (route: ConnectionFetchRoute) => { routes.set(route.path, route); return () => Promise.resolve() } },
      issueBrowserSessionCookie: () => COOKIE,
    },
  }
  return { ctx: ctx as unknown as Context, routes }
}

const services: PcWindowService[] = []
const stores: MobileSyncStore[] = []
afterEach(async () => {
  for (const service of services.splice(0)) await service.dispose()
  stores.splice(0)
})

async function booted() {
  const submissions: { sessionId: string; text: string }[] = []
  const port: MobileSessionPort = {
    listContinuable: () => Promise.resolve([
      { sessionId: 'sess-new', updatedAt: 200, running: false },
      { sessionId: 'sess-old', updatedAt: 100, running: false },
    ]),
    requireContinuable: () => Promise.resolve(),
    transcript: () => Promise.resolve({ status: 'idle', turns: [], cursor: 'c', reset: false, hasMore: false, earlierOmitted: false }),
    admitted: () => Promise.resolve(false),
    submit: (sessionId, _rpcId, text, _signal, check) => { check(); submissions.push({ sessionId, text }); return Promise.resolve() },
  }
  const store = await MobileSyncStore.open(':memory:', 8, 64)
  stores.push(store)
  const service = new PcWindowService(store, port, {
    pcId: 'local-unused', pcIdOf: () => WORKER, currentAccount: () => ACCOUNT, maxRequests: 4, timeoutMs: 2000, now: () => NOW,
  })
  services.push(service)
  const { ctx, routes } = routesOf()
  let phoneId: string | null = ACCOUNT
  registerPhoneWindowRoutes(ctx, {
    accountOrigin: 'https://qianshousuanli.com',
    currentAccount: () => ACCOUNT,
    handle: request => service.handle(request),
    issueCookie: () => COOKIE,
    now: () => NOW,
    fetch: () => Promise.resolve(Response.json(phoneId === null ? {} : { id: phoneId, username: 'Owner' })),
  })
  return { routes, submissions, setPhoneId: (id: string | null) => { phoneId = id } }
}

const post = (path: string, body: unknown, host = 'pc.qianshousuanli.com') =>
  new Request(`https://pc.qianshousuanli.com${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', host }, body: JSON.stringify(body),
  })

describe('phone window routes', () => {
  it('adopts the same account, opens the newest Session, and types the phone text into it', async () => {
    const { routes, submissions } = await booted()
    const adopt = await routes.get('/api/qianshou/account/adopt-browser')!.fetch(post('/api/qianshou/account/adopt-browser', { access_token: 'phone-token' }))
    expect(adopt.status).toBe(200)
    expect(adopt.headers.get('set-cookie')).toBe(COOKIE)
    await expect(adopt.json()).resolves.toEqual({ ok: true, account: { id: ACCOUNT } })

    const state = await routes.get('/api/qianshou/account/state')!.fetch(post('/api/qianshou/account/state', {}))
    await expect(state.json()).resolves.toEqual({ state: 'authenticated', account: { id: ACCOUNT } })

    const bootstrap = await routes.get('/api/qianshou/mobile/pc-window/bootstrap')!.fetch(post('/api/qianshou/mobile/pc-window/bootstrap', { deviceId: 'phone-1' }))
    expect(bootstrap.headers.get('x-qianshou-pc-owner-bound')).toBe('v1')
    expect(bootstrap.headers.get('x-qianshou-pc-owner-id')).toBe(ACCOUNT)
    const opened = await bootstrap.json() as { binding: { sessionId: string; pcId: string; sourceDeviceId: string } }
    expect(opened.binding).toMatchObject({ sessionId: 'sess-new', pcId: WORKER, sourceDeviceId: 'phone-1' })

    const submit = await routes.get('/api/qianshou/mobile/pc-window/submit')!.fetch(post('/api/qianshou/mobile/pc-window/submit', {
      command: {
        requestId: 'req-1', origin: opened.binding, createdAt: NOW - 1000, expiresAt: NOW + 60_000,
        action: { type: 'dispatch', text: '从手机发出' },
      },
    }))
    expect(submit.status).toBe(200)
    const body = await submit.json() as { outcome: string; receipt: { state: string } }
    expect(body.outcome).toBe('executed')
    expect(body.receipt.state).toBe('received')
    expect(submissions).toEqual([{ sessionId: 'sess-new', text: '从手机发出' }])
  })

  it('refuses a phone signed in as someone else and stops proving tokens after ten tries', async () => {
    const { routes, setPhoneId } = await booted()
    setPhoneId('other')
    const mismatch = await routes.get('/api/qianshou/account/adopt-browser')!.fetch(post('/api/qianshou/account/adopt-browser', { access_token: 'phone-token' }))
    expect(mismatch.status).toBe(403)
    expect(mismatch.headers.get('set-cookie')).toBeNull()
    setPhoneId(ACCOUNT)
    const calls = []
    for (let index = 0; index < 10; index += 1) calls.push(routes.get('/api/qianshou/account/adopt-browser')!.fetch(post('/api/qianshou/account/adopt-browser', { access_token: 'phone-token' })))
    const results = await Promise.all(calls)
    expect(results.at(-1)?.status).toBe(429)
  })
})
