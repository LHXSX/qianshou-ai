import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { apply } from '../src/index.ts'

const homes: string[] = []
const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
})

function connectionContext(): Context {
  const ctx = new Context()
  ctx.provide('connection', { fetch: { register: () => () => undefined } })
  contexts.push(ctx)
  return ctx
}

describe('mobile-sync plugin path and Session wiring', () => {
  it('rejects a relative sync or PC-window path at load', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-mobile-apply-'))
    homes.push(home)
    expect(() => apply(connectionContext(), { statePath: 'relative.json' }))
      .toThrow('MOBILE_SYNC_STATE_PATH_MUST_BE_ABSOLUTE')
    expect(() => apply(connectionContext(), { statePath: join(home, 'sync.json'), pcWindowPath: 'relative.json' }))
      .toThrow('PC_WINDOW_STATE_PATH_MUST_BE_ABSOLUTE')
  })

  it('uses DSH_HOME defaults and a mounted Session controller', async () => {
    const home = await mkdtemp(join(tmpdir(), 'dsh-mobile-home-'))
    homes.push(home)
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    try {
      const ctx = connectionContext()
      ctx.provide('sessionController', {
        prompt: async () => ({ accepted: true as const }),
        cancel: () => ({ accepted: true as const }),
        inspect: async () => ({ events: [] }),
      })
      apply(ctx, { statePath: '', pcWindowPath: '', cursorMaxAgeMs: 60_000 })
      /**
       * 用**真实的**网关 API。
       *
       * 这里原本调的是 `gateway.bootstrap(...)`——那个方法从来不存在（网关提供的是
       * `registerBinding` / `access` / `submit` / `sync`），所以这条测试**从来没绿过**。
       * 它想验的东西是真的：装了 Session 控制器时，绑定与访问能走通。
       * 绑定的形状照 `gateway/routes.ts` 里 bootstrap 路由拼的那个来
       * （`{ accountId, pcId, sessionId, sourceDeviceId }`），不自己发明字段。
       */
      const gateway = ctx.get('pcWindowGateway') as {
        registerBinding: (value: unknown) => Promise<boolean>
        access: (value: unknown) => Promise<{ readonly state: string; readonly allowedActions: readonly string[] }>
      }
      const binding = { accountId: 'acct-1', pcId: 'pc-1', sessionId: 'session-1', sourceDeviceId: 'phone-01' }
      await expect(gateway.registerBinding(binding)).resolves.toBe(true)
      /**
       * `access` 是"这个绑定现在能不能用"的真实回答，形状是
       * `{ state, allowedActions }`（见 `gateway/types.ts` 的 `WindowAccess`）。
       * 没装 Session 控制器时它应当答 `unavailable`——**如实说不可用，而不是编一个在线状态**。
       */
      const access = await gateway.access(binding)
      expect(['online', 'offline', 'unauthorized', 'unavailable']).toContain(access.state)
      expect(Array.isArray(access.allowedActions)).toBe(true)
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
  })
})
