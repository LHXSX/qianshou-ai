/**
 * 订阅管理路由的契约测试。
 *
 * 守三件事：
 * 1. **只有管理员能开通**（否则谁来都能给自己发一份免费订阅）；
 * 2. **必须给期限与理由**（默认"永久"是漏钱的默认值；没有理由就无法对账）；
 * 3. **操作者来自已验证主体**，不信请求体自报。
 */
import { describe, expect, it } from 'vitest'
import { createSubscriptionAdminRoutes } from '../src/subscription-routes.ts'
import { createTierStore } from '../src/tier-store.ts'

const DAY = 24 * 60 * 60 * 1000
const T0 = new Date('2026-09-01T00:00:00Z').getTime()

/** 造一个带管理员身份的路由组。 */
function routes(principal: { accountId: string; role: string; isAdmin: boolean } | null = { accountId: 'admin-1', role: 'admin', isAdmin: true }) {
  const store = createTierStore()
  return {
    store,
    ...createSubscriptionAdminRoutes({ store, authenticate: () => principal, now: () => T0 }),
  }
}

/** 发一条 POST。 */
async function post(handler: (request: Request) => Promise<Response>, body: unknown): Promise<Response> {
  return await handler(new Request('http://127.0.0.1/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('开通订阅：只有管理员能做，且必须留痕', () => {
  it('未登录被拒', async () => {
    const { grant } = routes(null)
    expect((await post(grant, { accountId: 'a', tier: 'plus', days: 30, reason: 'x' })).status).toBe(401)
  })

  it('非管理员被拒（否则谁都能给自己发免费订阅）', async () => {
    const { grant } = routes({ accountId: 'someone', role: 'personal', isAdmin: false })
    // 403 而不是 401：界面据此显示"权限不够"而不是"请去登录"（WP1 A-11）。
    expect((await post(grant, { accountId: 'a', tier: 'plus', days: 30, reason: 'x' })).status).toBe(403)
  })

  it('管理员开通成功，档位立刻生效', async () => {
    const { grant, store } = routes()
    const response = await post(grant, { accountId: 'a', tier: 'plus', days: 30, reason: '订单 QS-1' })
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; subscription: { tier: string } }
    expect(body.ok).toBe(true)
    expect(body.subscription.tier).toBe('plus')
    expect(store.tierOf('a', T0 + DAY)).toBe('plus')
  })

  it('days 被换算成到期时刻', async () => {
    const { grant, store } = routes()
    await post(grant, { accountId: 'a', tier: 'max', days: 30, reason: 'r' })
    expect(store.historyOf('a')[0]?.to).toBe(T0 + 30 * DAY)
  })

  it('**不给期限就拒绝**——默认"永久"是会漏钱的默认值', async () => {
    const { grant } = routes()
    const response = await post(grant, { accountId: 'a', tier: 'plus', reason: 'r' })
    expect(response.status).toBe(400)
    const body = await response.json() as { message: string }
    expect(body.message).toContain('days')
    // 说明里要告诉管理员"确实不过期就显式传 null"，否则他只能猜。
    expect(body.message).toContain('null')
  })

  it('显式 to: null 表示不过期（内部账号），这是刻意的动作', async () => {
    const { grant, store } = routes()
    expect((await post(grant, { accountId: 'staff', tier: 'max', to: null, reason: '内部账号' })).status).toBe(200)
    expect(store.tierOf('staff', T0 + 3650 * DAY)).toBe('max')
  })

  it('不给理由就拒绝（对账时要靠它解释）', async () => {
    const { grant } = routes()
    const response = await post(grant, { accountId: 'a', tier: 'plus', days: 30 })
    expect(response.status).toBe(400)
    expect((await response.json() as { message: string }).message).toContain('reason')
  })

  it('档位不合法的说明列出了合法值', async () => {
    const { grant } = routes()
    const body = await (await post(grant, { accountId: 'a', tier: 'gold', days: 30, reason: 'r' })).json() as { message: string }
    expect(body.message).toContain('basic')
    expect(body.message).toContain('max')
  })

  it('到期时刻早于生效时刻被拒', async () => {
    const { grant } = routes()
    expect((await post(grant, { accountId: 'a', tier: 'plus', to: T0 - DAY, reason: 'r' })).status).toBe(400)
  })

  it('缺 accountId 被拒', async () => {
    const { grant } = routes()
    expect((await post(grant, { tier: 'plus', days: 30, reason: 'r' })).status).toBe(400)
  })

  it('**操作者来自已验证主体**，请求体自报无效', async () => {
    const { grant, store } = routes({ accountId: 'admin-1', role: 'admin', isAdmin: true })
    await post(grant, { accountId: 'a', tier: 'plus', days: 30, reason: 'r', grantedBy: '别人冒名' })
    expect(store.historyOf('a')[0]?.grantedBy).toBe('admin-1')
  })

  it('非法 JSON 被拒且说明请求格式不对', async () => {
    const { grant } = routes()
    const response = await grant(new Request('http://127.0.0.1/x', { method: 'POST', body: 'not json' }))
    expect(response.status).toBe(400)
  })

  it('续费是追加一条，不是改历史', async () => {
    const { grant, store } = routes()
    await post(grant, { accountId: 'a', tier: 'plus', from: T0, days: 30, reason: 'Q1' })
    await post(grant, { accountId: 'a', tier: 'plus', from: T0 + 30 * DAY, days: 30, reason: 'Q2' })
    expect(store.historyOf('a').length).toBe(2)
    expect(store.tierOf('a', T0 + 45 * DAY)).toBe('plus')
  })
})

describe('查订阅：管理员看得到历史与当前档位', () => {
  it('非管理员被拒', async () => {
    const { list } = routes({ accountId: 'someone', role: 'personal', isAdmin: false })
    expect((await post(list, { accountId: 'a' })).status).toBe(403)
  })

  it('不带账号时给账号概览', async () => {
    const { grant, list } = routes()
    await post(grant, { accountId: 'a', tier: 'plus', days: 30, reason: 'r' })
    await post(grant, { accountId: 'b', tier: 'max', days: 30, reason: 'r' })
    const body = await (await post(list, {})).json() as { count: number; accounts: { accountId: string }[] }
    expect(body.count).toBe(2)
    expect(body.accounts.map(entry => entry.accountId)).toEqual(['a', 'b'])
  })

  it('给了账号则返回**此刻有效**的档位与完整历史', async () => {
    // 注意 `now` 固定为 T0：升级那条从 T0+1天起生效，所以此刻仍然是首月的档位。
    // 这不是缺陷——"未来生效的变更不算数"正是订阅该有的语义。
    const { grant, list } = routes()
    await post(grant, { accountId: 'a', tier: 'basic', from: T0, days: 30, reason: '首月' })
    await post(grant, { accountId: 'a', tier: 'max', from: T0 + DAY, days: 30, reason: '升级' })
    const body = await (await post(list, { accountId: 'a' })).json() as { tier: string; history: unknown[] }
    expect(body.tier).toBe('basic')
    // 但历史要完整：升级已经记下了，只是还没到生效时刻。
    expect(body.history.length).toBe(2)
  })

  it('升级生效之后读到的是新档位（同一份数据，换个时刻）', async () => {
    const store = createTierStore()
    const admin = createSubscriptionAdminRoutes({ store, authenticate: () => ({ accountId: 'admin-1', role: 'admin', isAdmin: true }), now: () => T0 })
    await post(admin.grant, { accountId: 'a', tier: 'basic', from: T0, days: 30, reason: '首月' })
    await post(admin.grant, { accountId: 'a', tier: 'max', from: T0 + DAY, days: 30, reason: '升级' })
    const later = createSubscriptionAdminRoutes({ store, authenticate: () => ({ accountId: 'admin-1', role: 'admin', isAdmin: true }), now: () => T0 + 2 * DAY })
    const body = await (await post(later.list, { accountId: 'a' })).json() as { tier: string }
    expect(body.tier).toBe('max')
  })

  it('从未开通的账号：档位为 null（由调用方兜底成普通版）', async () => {
    const { list } = routes()
    const body = await (await post(list, { accountId: 'never' })).json() as { tier: string | null; history: unknown[] }
    expect(body.tier).toBeNull()
    expect(body.history).toEqual([])
  })
})
