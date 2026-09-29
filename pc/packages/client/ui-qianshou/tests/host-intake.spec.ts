import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply } from '../src/index.ts'
import type { RelayRoute } from '../src/relay/node-relay.ts'

vi.mock('../src/relay/host-runtime.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/relay/host-runtime.ts')>(),
  // Boot must not reclaim a real local node port during this test.
  loadHostRuntime: async () => { throw new Error('test runtime unavailable') },
}))

afterEach(() => { vi.unstubAllEnvs() })

function accessToken(): string {
  const encode = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ sub: '7', exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`
}

describe('Qianshou host intake', () => {
  it('refreshes power and node owner after sign-in without turning on intake or leaving a teardown veto', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'qianshou')
    const setPanelAccepting = vi.fn()
    let token: string | null = null
    let account: { id: string } | null = null
    const state = vi.fn(async () => ({ phase: account === null ? 'signed-out' : 'authenticated', account }))
    const credentials = { resolve: vi.fn(async () => token === null ? undefined : { value: token }) }
    const disposers: Array<() => void> = []
    let route: RelayRoute | null = null
    const scope = {
      effect(callback: () => (() => void) | void) {
        const dispose = callback()
        if (dispose !== undefined) disposers.push(dispose)
      },
      webServer: { register: vi.fn((registered: RelayRoute) => { route = registered; return vi.fn() }) },
      connection: { fetch: { register: vi.fn(() => vi.fn()) } },
      accountSession: { ensureAccessToken: vi.fn(async () => token) },
      credentials,
      qianshouAccount: { state },
      nodeContributor: {
        setPanelAccepting,
        status: () => ({ intake: 'running', driver: 'running', resident: null }),
        acknowledgedWorkerId: () => 'worker-7',
      },
    }
    const ctx = {
      inject: (_names: readonly string[], callback: (value: typeof scope) => void) => { callback(scope) },
      get: () => scope.nodeContributor,
    }

    apply(ctx as unknown as Context)
    const get = async (path: string): Promise<Record<string, unknown>> => {
      if (route === null) throw new Error('relay did not register')
      let body = ''
      await route.handler({
        method: 'GET', url: `/qianshou-node/${path}`, headers: {}, socket: { remoteAddress: '127.0.0.1' },
        async *[Symbol.asyncIterator]() { /* GET has no body. */ },
      }, { writeHead() { /* The payload is asserted below. */ }, end(value) { body = value ?? '' } })
      await vi.waitFor(() => expect(body).not.toBe(''))
      return JSON.parse(body) as Record<string, unknown>
    }
    expect(await get('power')).toMatchObject({ code: 'NODE_SWITCH_NO_SESSION', running: false })
    token = accessToken()
    account = { id: '7' }
    expect(await get('power')).toMatchObject({ running: true, mode: 'running' })
    expect(await get('status')).toMatchObject({ connection: { ownerId: 7, state: 'online' } })
    account = { id: '8' }
    expect(await get('power')).toMatchObject({ code: 'NODE_SWITCH_NO_SESSION', running: false })
    account = { id: '7' }
    token = null
    account = null
    expect(await get('power')).toMatchObject({ code: 'NODE_SWITCH_NO_SESSION', running: false })
    expect(await get('status')).toMatchObject({ connection: { ownerId: null } })
    expect(setPanelAccepting).not.toHaveBeenCalled()

    for (const dispose of disposers.reverse()) dispose()
    // The relay/UI lifecycle is not the owner's saved supply decision. Hot reload
    // must not leave a process-local veto over an already authorized resident node.
    expect(setPanelAccepting).not.toHaveBeenCalled()
  })
})
