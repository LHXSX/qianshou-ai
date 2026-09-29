/**
 * 插件装配 × 持久化的集成测试：**证明插件的账本真的接在了文件上**。
 *
 * 为什么单独要这一层：`persistence.host.spec.ts` 测的是账本与文件的契约，
 * 而这里测的是**插件有没有把那两者接起来**——插件的 `onChange` 是否接到了
 * `markDirty`、冷启动是否真的 `restore` 了。这两处任何一处漏接，
 * 单元测试都会全绿地骗过去，而线上表现是"重启后额度归零"。
 *
 * 用真实 cordis `Context`（与 `plugin.host.spec.ts` 同一套办法）。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/plugin.ts'
import { ADMIN_BIND_PATH, ADMIN_NAMES_PATH } from '../src/admin-routes.ts'
import { ADMIN_AUDIT_PATH, AI_AUDIT_PATH } from '../src/audit-routes.ts'
import { ADMIN_SUBSCRIPTIONS_PATH, ADMIN_SUBSCRIPTION_PATH } from '../src/subscription-routes.ts'
import { AI_COMPLETIONS_PATH } from '../src/routes.ts'
import { AI_CHAT_PATH, AI_STATUS_PATH } from '../src/routes.ts'

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.allSettled(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

/** 一条被登记的 Fetch 路由。 */
interface RegisteredRoute {
  readonly path: string
  readonly fetch: (request: Request) => Promise<Response>
}

/**
 * 装载插件并把账本指向给定文件。
 *
 * 直接调 `apply` 而不是 `ctx.plugin`：这里要把 `ledgerPath` 明确传给插件，
 * 直接调用最稳，也把这个测试的意图限定在"账本接线"上。
 * @param ledgerPath - 账本文件路径。
 * @returns 真实作用域与登记到的路由。
 */
async function bootSimple(ledgerPath: string): Promise<{ ctx: Context; routes: RegisteredRoute[] }> {
  const ctx = new Context()
  contexts.push(ctx)
  const routes: RegisteredRoute[] = []
  ctx.provide('connection', {
    fetch: {
      register: (route: RegisteredRoute) => {
        routes.push(route)
        return () => { routes.splice(routes.indexOf(route), 1) }
      },
    },
  } as never)
  // 直接调 apply：这样能把 config 明确传进去（ledgerPath），不依赖 loader 的注入时机。
  apply(ctx, { ledgerPath })
  return { ctx, routes }
}

/** 暂存一份额度并结掉一笔：模拟"用了一次订阅"。 */
async function spendOnce(ctx: Context): Promise<void> {
  const ledger = (ctx as unknown as {
    creditLedger: {
      grant: (accountId: string, tier: string, sp: number) => void
      reserve: (input: { callId: string; accountId: string; sp: number }) => void
      settle: (input: { callId: string; sp: number; call?: unknown }) => unknown
      creditOf: (accountId: string, tier: string) => { remainingMonthlySp: number }
    }
  }).creditLedger
  ledger.grant('acc-1', 'basic', 390)
  ledger.reserve({ callId: 'c1', accountId: 'acc-1', sp: 3.47 })
  ledger.settle({
    callId: 'c1',
    sp: 0.07,
    call: { tier: 'basic', publishedName: '千手·迅捷', backendKey: 'deepseek-flash', inputTokens: 120, outputTokens: 40 },
  })
}

describe('插件 × 持久化：账本真的接在文件上', () => {
  it('通过插件花的钱，被新的插件实例读回来（重启不归零）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qianshou-plugin-ledger-'))
    dirs.push(dir)
    const ledgerPath = join(dir, '.qianshou-ledger.json')

    // —— 第一次装载：花掉 0.07 SP ——
    const first = await bootSimple(ledgerPath)
    await spendOnce(first.ctx)
    const before = (first.ctx as unknown as { creditLedger: { creditOf: (a: string, t: string) => { remainingMonthlySp: number } } })
      .creditLedger.creditOf('acc-1', 'basic').remainingMonthlySp
    expect(before).toBe(389.93)

    // 等落盘（合并写是异步的）。插件没有暴露 flush，所以这里等一小会儿——
    // 真实部署下这个窗口是 50ms，永远早于任何一次重启。
    await new Promise(resolve => setTimeout(resolve, 200))

    // —— 第二次装载：同一个文件 ——
    const second = await bootSimple(ledgerPath)
    // 读取是异步的，给它一拍。
    await new Promise(resolve => setTimeout(resolve, 100))
    const after = (second.ctx as unknown as { creditLedger: { creditOf: (a: string, t: string) => { remainingMonthlySp: number } } })
      .creditLedger.creditOf('acc-1', 'basic').remainingMonthlySp
    expect(after).toBe(389.93)
  })

  it('插件仍然登记全部路由（持久化没有破坏装配）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qianshou-plugin-ledger-'))
    dirs.push(dir)
    const { routes } = await bootSimple(join(dir, '.qianshou-ledger.json'))
    expect(routes.map(route => route.path).sort())
      .toEqual([
        ADMIN_BIND_PATH, ADMIN_NAMES_PATH, AI_CHAT_PATH, AI_COMPLETIONS_PATH, AI_STATUS_PATH,
        AI_AUDIT_PATH, ADMIN_AUDIT_PATH, ADMIN_SUBSCRIPTION_PATH, ADMIN_SUBSCRIPTIONS_PATH,
      ].sort())
  })

  it('坏的账本文件不让插件崩（工作台必须能起来）', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'qianshou-plugin-ledger-'))
    dirs.push(dir)
    const ledgerPath = join(dir, '.qianshou-ledger.json')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(ledgerPath, 'not json at all', 'utf8')
    const { ctx, routes } = await bootSimple(ledgerPath)
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(routes.length).toBe(12)
    // 坏文件被安静忽略：账本从零开始，但插件照常可用。
    const credit = (ctx as unknown as { creditLedger: { creditOf: (a: string, t: string) => { remainingMonthlySp: number } } })
      .creditLedger.creditOf('nobody', 'basic')
    expect(credit.remainingMonthlySp).toBe(0)
  })
})
