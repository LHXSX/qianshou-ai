/**
 * WP1 验收：**重启瞬间的请求不越月度上限**（缺陷 A-05）。
 *
 * 缺陷的形状很具体：账本是从磁盘异步读回来的，而路由是同步登记的。于是一次重启之后，
 * 在快照读回来之前的那个窗口里，账本看起来是"空"的——`ensureGranted` 按空账本授予
 * 整月额度，五小时刹车也归零。**攻击面低、收益高**：重启（或等到进程自己重启一次）
 * 就能重置自己的额度。
 *
 * 这个文件把那个窗口**人为拉长**（把读账本文件的耗时垫高到 120 ms），于是时序变成确定的：
 * 请求必须在快照恢复之后才被处理，否则响应里的余额就是整月额度。
 *
 * 为什么不用"发完请求立刻断言"来碰运气：那种写法在快循环里会偶发通过——
 * 文件读取通常比一次 HTTP 往返快，于是它**测不出真正的缺陷**。
 */
import { Context } from '@deepseek-ai/cordis'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

/** 读账本的人为延迟（毫秒）。 */
const LEDGER_READ_DELAY_MS = 120

/**
 * 只把**账本文件**的读取拖慢，其余读写照旧。
 *
 * 用真实的 `node:fs/promises` 实现转发，所以除时序之外的行为没有任何改变。
 */
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  const slowReadFile = async (path: unknown, ...rest: unknown[]): Promise<unknown> => {
    if (String(path).endsWith('.qianshou-ledger.json')) {
      await new Promise(resolve => setTimeout(resolve, LEDGER_READ_DELAY_MS))
    }
    return await (actual.readFile as (...args: unknown[]) => Promise<unknown>)(path, ...rest)
  }
  return { ...actual, readFile: slowReadFile }
})

const { apply } = await import('../src/plugin.ts')
const { AI_STATUS_PATH } = await import('../src/routes.ts')

const dirs: string[] = []
const contexts: Context[] = []

afterEach(async () => {
  await Promise.allSettled(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** 一条被登记的 Fetch 路由。 */
interface RegisteredRoute {
  readonly path: string
  readonly fetch: (request: Request) => Promise<Response>
}

describe('重启窗口：账本还没读回来就不能放行（WP1 A-05）', () => {
  it('重启后的第一个请求看得到上次的用量，不会重新拿到整月额度', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qianshou-wp1-restart-'))
    dirs.push(dir)
    const ledgerPath = join(dir, '.qianshou-ledger.json')
    const now = Date.now()
    const started = new Date(now)
    const periodStart = new Date(started.getFullYear(), started.getMonth(), 1).getTime()
    /** 本账期已授予 basic 的 390 SP，其中 100 SP 已经花掉（一次完整调用）。 */
    writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      savedAt: now,
      grants: [{ accountId: 'acc-1', tier: 'basic', microSp: 390 * 1_000_000, periodStart }],
      partialCharges: [],
      reservations: [],
      records: [{
        callId: 'call-before-restart',
        accountId: 'acc-1',
        tier: 'basic',
        publishedName: '千手·迅捷',
        backendKey: 'flash',
        at: now - 1000,
        inputTokens: 1000,
        outputTokens: 1000,
        microSp: 100 * 1_000_000,
      }],
    }), { mode: 0o600 })

    const ctx = new Context()
    contexts.push(ctx)
    const routes: RegisteredRoute[] = []
    ctx.provide('connection', {
      fetch: { register: (route: RegisteredRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
    } as never)
    ctx.provide('accountSession', {
      account: async () => ({ id: 'acc-1', role: 'personal' }),
      verifiedAccount: async () => ({ id: 'acc-1', role: 'personal' }),
    } as never)
    apply(ctx, { dshHome: dir, ledgerPath, subscriptionsPath: join(dir, 'subscriptions.json') })

    // **不等任何东西**：就像一次刚重启完就到达的请求。
    const route = routes.find(item => item.path === AI_STATUS_PATH)
    if (route === undefined) throw new Error('状态路由没登记')
    const response = await route.fetch(new Request(`http://127.0.0.1${AI_STATUS_PATH}`, { method: 'POST' }))
    const body = await response.json() as { credit: { remainingSp: number; usedInWindowSp: number; monthlySp: number } }

    // 390 授予 − 100 已用 = 290。没有 `await ready` 时这里会是 390（按空账本重新授予）。
    expect(body.credit.monthlySp).toBe(390)
    expect(body.credit.remainingSp).toBe(290)
    expect(body.credit.usedInWindowSp).toBe(100)
  })

  it('合法账本照常恢复；被改坏字段的账本整份拒绝并留证（WP1 A-10）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qianshou-wp1-restart-'))
    dirs.push(dir)
    const ledgerPath = join(dir, '.qianshou-ledger.json')
    const now = Date.now()
    const started = new Date(now)
    const periodStart = new Date(started.getFullYear(), started.getMonth(), 1).getTime()
    // 把余额字段改成字符串：这正是"改一行文件就能改余额"的做法。
    writeFileSync(ledgerPath, JSON.stringify({
      version: 1,
      savedAt: now,
      grants: [{ accountId: 'acc-1', tier: 'basic', microSp: '999999999', periodStart }],
      partialCharges: [],
      reservations: [],
      records: [],
    }), { mode: 0o600 })

    const ctx = new Context()
    contexts.push(ctx)
    const routes: RegisteredRoute[] = []
    ctx.provide('connection', {
      fetch: { register: (route: RegisteredRoute) => { routes.push(route); return () => { routes.splice(routes.indexOf(route), 1) } } },
    } as never)
    ctx.provide('accountSession', {
      account: async () => ({ id: 'acc-1', role: 'personal' }),
      verifiedAccount: async () => ({ id: 'acc-1', role: 'personal' }),
    } as never)
    apply(ctx, { dshHome: dir, ledgerPath, subscriptionsPath: join(dir, 'subscriptions.json') })
    // 等恢复流程走完（它一定会走完，只是被我们的 mock 拖慢了）。
    await new Promise(resolve => setTimeout(resolve, LEDGER_READ_DELAY_MS + 60))

    const route = routes.find(item => item.path === AI_STATUS_PATH)
    if (route === undefined) throw new Error('状态路由没登记')
    const body = await (await route.fetch(new Request(`http://127.0.0.1${AI_STATUS_PATH}`, { method: 'POST' }))).json() as {
      credit: { remainingSp: number }
    }
    // 非法快照被整份拒绝，所以余额是"本账期刚授予"的 390，而不是那份文件里的任何数字。
    expect(body.credit.remainingSp).toBe(390)
    // 原文件被挪到带时间戳的旁支留证，没有被原地覆盖。
    expect(readdirSync(dir).some(name => name.startsWith('.qianshou-ledger.json.rejected-'))).toBe(true)
  })
})
