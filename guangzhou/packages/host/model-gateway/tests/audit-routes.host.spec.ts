/**
 * 审计接口的契约测试。
 *
 * 守两条边界：
 * 1. **用户只能看到自己的记录**。查别人的用量是越权，也是对账口径的污染。
 * 2. **用户看不到上游厂商标识**。用户知道的是「千手·迅捷」，账单口径就该是这个名字；
 *    `backendKey` 只留给管理面做成本核对。
 */
import { describe, expect, it } from 'vitest'
import { createCreditLedger } from '../src/ledger.ts'
import { createAiAdminAuditRoutes, createAiAuditRoutes } from '../src/audit-routes.ts'

/** 造一个有点记录和两个账号的账本。 */
function ledgerWithRecords(): ReturnType<typeof createCreditLedger> {
  const ledger = createCreditLedger()
  for (const [accountId, tier, sp] of [['me', 'basic', 390], ['other', 'plus', 990]] as const) {
    ledger.grant(accountId, tier, sp)
    ledger.reserve({ callId: `${accountId}-1`, accountId, sp: 1 })
    ledger.settle({
      callId: `${accountId}-1`,
      sp: 0.07,
      call: { tier, publishedName: '千手·迅捷', backendKey: 'deepseek-flash', inputTokens: 120, outputTokens: 40 },
    })
  }
  return ledger
}

/** 发一条 POST。 */
async function post(handler: (request: Request) => Promise<Response>, body: unknown = {}): Promise<Response> {
  return await handler(new Request('http://127.0.0.1/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }))
}

describe('用户侧审计：只能看自己花的钱', () => {
  it('未登录返回 401', async () => {
    const routes = createAiAuditRoutes({ ledger: createCreditLedger(), authenticate: () => null })
    const response = await post(routes.audit)
    expect(response.status).toBe(401)
  })

  it('登录后只返回自己的记录', async () => {
    const routes = createAiAuditRoutes({ ledger: ledgerWithRecords(), authenticate: () => ({ accountId: 'me', role: 'personal', isAdmin: false }) })
    const body = await (await post(routes.audit)).json() as { ok: boolean; count: number; entries: { model: string; sp: number }[] }
    expect(body.ok).toBe(true)
    expect(body.count).toBe(1)
    expect(body.entries[0]?.model).toBe('千手·迅捷')
    expect(body.entries[0]?.sp).toBe(0.07)
  })

  it('**不**透出上游厂商标识（用户账单口径只有前台名字）', async () => {
    const routes = createAiAuditRoutes({ ledger: ledgerWithRecords(), authenticate: () => ({ accountId: 'me', role: 'personal', isAdmin: false }) })
    const raw = await (await post(routes.audit)).text()
    expect(raw).not.toContain('deepseek')
    expect(raw).toContain('千手·迅捷')
  })

  it('管理员用用户侧接口时同样只看自己的（两个接口边界不同）', async () => {
    const routes = createAiAuditRoutes({ ledger: ledgerWithRecords(), authenticate: () => ({ accountId: 'me', role: 'admin', isAdmin: true }) })
    const body = await (await post(routes.audit)).json() as { count: number }
    expect(body.count).toBe(1)
  })

  it('limit 被尊重且有上限（防止一次拉走整本账）', async () => {
    const ledger = createCreditLedger()
    ledger.grant('me', 'basic', 390)
    for (let index = 0; index < 5; index += 1) {
      const callId = `c-${index}`
      ledger.reserve({ callId, accountId: 'me', sp: 1 })
      ledger.settle({ callId, sp: 0.07, call: { tier: 'basic', publishedName: '千手·迅捷', backendKey: 'deepseek-flash', inputTokens: 1, outputTokens: 1 } })
    }
    const routes = createAiAuditRoutes({ ledger, authenticate: () => ({ accountId: 'me', role: 'personal', isAdmin: false }) })
    const two = await (await post(routes.audit, { limit: 2 })).json() as { count: number }
    expect(two.count).toBe(2)
    const huge = await (await post(routes.audit, { limit: 99999 })).json() as { count: number }
    expect(huge.count).toBe(5)
  })

  it('没有请求体也能查（审计查询不该强制带参数）', async () => {
    const routes = createAiAuditRoutes({ ledger: ledgerWithRecords(), authenticate: () => ({ accountId: 'me', role: 'personal', isAdmin: false }) })
    const response = await routes.audit(new Request('http://127.0.0.1/x', { method: 'POST' }))
    expect(response.status).toBe(200)
  })
})

describe('管理面审计：可查任意账号，且带成本核对字段', () => {
  it('已登录但非管理员返回 403（与"未登录"分开：WP1 A-11）', async () => {
    const routes = createAiAdminAuditRoutes({ ledger: ledgerWithRecords(), authenticate: () => ({ accountId: 'me', role: 'personal', isAdmin: false }) })
    // 403 而不是 401：界面据此显示"权限不够"而不是"请去登录"（WP1 A-11）。
    expect((await post(routes.audit)).status).toBe(403)
  })

  it('未登录返回 401', async () => {
    const routes = createAiAdminAuditRoutes({ ledger: ledgerWithRecords(), authenticate: () => null })
    expect((await post(routes.audit)).status).toBe(401)
  })

  it('管理员可以按 accountId 查别人的记录', async () => {
    const routes = createAiAdminAuditRoutes({ ledger: ledgerWithRecords(), authenticate: () => ({ accountId: 'admin', role: 'admin', isAdmin: true }) })
    const body = await (await post(routes.audit, { accountId: 'other' })).json() as { accountId: string; count: number }
    expect(body.accountId).toBe('other')
    expect(body.count).toBe(1)
  })

  it('管理员带上 backendKey（换绑后靠它核对成本口径）', async () => {
    const routes = createAiAdminAuditRoutes({ ledger: ledgerWithRecords(), authenticate: () => ({ accountId: 'admin', role: 'admin', isAdmin: true }) })
    const body = await (await post(routes.audit, { accountId: 'other' })).json() as { entries: { backendKey?: string }[] }
    expect(body.entries[0]?.backendKey).toBe('deepseek-flash')
  })

  it('不带 accountId 时查自己（管理员查自己同样有意义）', async () => {
    const routes = createAiAdminAuditRoutes({ ledger: ledgerWithRecords(), authenticate: () => ({ accountId: 'me', role: 'admin', isAdmin: true }) })
    const body = await (await post(routes.audit)).json() as { accountId: string; count: number }
    expect(body.accountId).toBe('me')
    expect(body.count).toBe(1)
  })
})
