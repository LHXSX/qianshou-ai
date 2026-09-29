/**
 * 管理路由的契约测试。
 *
 * 这几条路由能**改动全局路由**（所有人的模型都受影响），所以断言的重点是**安全性质**：
 * 谁能改、改不成时会不会留下痕迹、错误输入会不会被挡住。
 */
import { describe, expect, it } from 'vitest'
import { createAiAdminRoutes, normalizeBindInput, normalizeNameRecord, type Principal } from '../src/admin-routes.ts'
import { createRoutingConsole } from '../src/routing.ts'

const T0 = new Date('2026-09-01T00:00:00Z').getTime()
const DAY = 24 * 60 * 60 * 1000

/** 搭一套管理路由。 */
function setup(options: { readonly principal?: Principal | null } = {}) {
  const routing = createRoutingConsole()
  const routes = createAiAdminRoutes({
    routing,
    authenticate: () => (options.principal === undefined ? { accountId: 'admin-1', role: 'admin', isAdmin: true } : options.principal),
    now: () => T0,
  })
  return { routing, routes }
}

/** 造一个请求。 */
function post(path: string, body: unknown): Request {
  return new Request(`http://host${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** 一份合法的名字记录。 */
const RECORD = {
  publishedName: '千手·迅捷',
  label: '千手·迅捷',
  tiers: ['basic', 'plus', 'max'],
  maxOutputTokens: 4096,
  order: 0,
}

describe('授权：fail-closed，缺授权一律拒绝', () => {
  it('未登录 → 401，且**没有任何改动**', async () => {
    const { routes, routing } = setup({ principal: null })
    const response = await routes.bind(post('/bind', { ...RECORD, backendKeys: ['flash'], effectiveFrom: T0 + DAY, reason: 'r' }))
    expect(response.status).toBe(401)
    // 没登记、没绑定：拒绝必须是无副作用的
    expect(routing.names()).toHaveLength(0)
  })

  it('非管理员 → 403，且**没有绑定被写入**', async () => {
    const { routes, routing } = setup({ principal: { accountId: 'user-9', role: 'personal', isAdmin: false } })
    routing.publish({ ...RECORD, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
    const response = await routes.bind(post('/bind', { ...RECORD, backendKeys: ['flash'], effectiveFrom: T0 + DAY, reason: 'r' }))
    expect(response.status).toBe(403)
    expect(routing.historyOf('千手·迅捷')).toHaveLength(0)
  })

  it('名字清单同样要管理员：非管理员连读都不给', async () => {
    const { routes } = setup({ principal: { accountId: 'user-9', role: 'personal', isAdmin: false } })
    const response = await routes.names(post('/names', {}))
    expect(response.status).toBe(403)
  })
})

describe('写入：可验、可追责、不许改当下', () => {
  it('登记之后追加绑定，回读给**全量历史**', async () => {
    const { routes, routing } = setup()
    routing.publish({ ...RECORD, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
    const response = await routes.bind(post('/bind', { publishedName: '千手·迅捷', backendKeys: ['flash'], effectiveFrom: T0 + DAY, reason: '首发', rolloutPercent: 100 }))
    expect(response.status).toBe(200)
    const body = await response.json() as { ok: boolean; history: unknown[] }
    expect(body.ok).toBe(true)
    expect(body.history).toHaveLength(1)
  })

  it('操作者取自**已验证的主体**，不接受请求体自报（否则追责链就断了）', async () => {
    const { routes, routing } = setup({ principal: { accountId: 'real-admin', role: 'admin', isAdmin: true } })
    routing.publish({ ...RECORD, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
    await routes.bind(post('/bind', {
      publishedName: '千手·迅捷', backendKeys: ['flash'], effectiveFrom: T0 + DAY, reason: 'r',
      operator: '我是别人', // 请求体自报的操作者必须被忽略
    }))
    expect(routing.historyOf('千手·迅捷')[0]?.operator).toBe('real-admin')
  })

  it('生效时刻在当下或过去 → 拒绝（不许在计费周期中间换后端）', async () => {
    const { routes, routing } = setup()
    routing.publish({ ...RECORD, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
    const response = await routes.bind(post('/bind', { publishedName: '千手·迅捷', backendKeys: ['flash'], effectiveFrom: T0, reason: 'r' }))
    expect(response.status).toBe(400)
    expect((await response.json() as { message: string }).message).toContain('必须在将来')
    expect(routing.historyOf('千手·迅捷')).toHaveLength(0)
  })

  it('没有原因 → 拒绝（将来对账的人要知道为什么改）', async () => {
    const { routes, routing } = setup()
    routing.publish({ ...RECORD, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
    const response = await routes.bind(post('/bind', { publishedName: '千手·迅捷', backendKeys: ['flash'], effectiveFrom: T0 + DAY }))
    expect(response.status).toBe(400)
    expect(routing.historyOf('千手·迅捷')).toHaveLength(0)
  })

  it('不认识的后端键 → 拒绝（写错一个字母会让所有请求打空）', async () => {
    const { routes, routing } = setup()
    routing.publish({ ...RECORD, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
    const response = await routes.bind(post('/bind', { publishedName: '千手·迅捷', backendKeys: ['flashh'], effectiveFrom: T0 + DAY, reason: 'r' }))
    expect(response.status).toBe(400)
    expect((await response.json() as { message: string }).message).toContain('不认识的后端')
  })

  it('名字没登记过 → 拒绝（不让绑定挂在一个没人认识的名字上）', async () => {
    const { routes } = setup()
    const response = await routes.bind(post('/bind', { publishedName: '不存在的名字', backendKeys: ['flash'], effectiveFrom: T0 + DAY, reason: 'r' }))
    expect(response.status).toBe(400)
    expect((await response.json() as { message: string }).message).toContain('还没登记')
  })
})

describe('回读：清单带上每个名字的历史与可用后端', () => {
  it('管理员能读到名字、历史与后端清单', async () => {
    const { routes, routing } = setup()
    routing.publish({ ...RECORD, upgradeRule: 'on-expiry', lifecycleStage: 'ga', shutdownDate: null, migrationTarget: null })
    const response = await routes.names(post('/names', {}))
    const body = await response.json() as { names: { publishedName: string; history: unknown[] }[]; backends: { key: string }[] }
    expect(body.names[0]?.publishedName).toBe('千手·迅捷')
    expect(body.names[0]?.history).toEqual([])
    // 不写死后端数量：加一个后端是**正常的演进**，而写死的断言每次都会红——
    // 人就会养成"红了就改数字"的习惯，那种测试守不住任何东西。
    // 这里断言"必须有的都在"，外加不重复。
    const keys = body.backends.map(item => item.key)
    expect(keys).toContain('flash')
    expect(keys).toContain('pro')
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('输入校验（纯函数，独立可测）', () => {
  it('名字记录：缺 publishedName / 缺档位 / 上限不是正整数 都被挡', () => {
    expect(normalizeNameRecord({}).ok).toBe(false)
    expect(normalizeNameRecord({ publishedName: 'x' }).ok).toBe(false)
    expect(normalizeNameRecord({ publishedName: 'x', tiers: ['basic'] }).ok).toBe(false)
    expect(normalizeNameRecord({ publishedName: 'x', tiers: ['basic'], maxOutputTokens: 0 }).ok).toBe(false)
    expect(normalizeNameRecord({ publishedName: 'x', tiers: ['basic'], maxOutputTokens: 100 }).ok).toBe(true)
  })

  it('名字记录：不认识的档位被过滤掉，全是无效档位就报错', () => {
    expect(normalizeNameRecord({ publishedName: 'x', tiers: ['vip'], maxOutputTokens: 100 }).ok).toBe(false)
    const mixed = normalizeNameRecord({ publishedName: 'x', tiers: ['basic', 'vip'], maxOutputTokens: 100 })
    expect(mixed.ok).toBe(true)
    if (mixed.ok) expect(mixed.record.tiers).toEqual(['basic'])
  })

  it('绑定输入：生效时刻必须是有限数字且在未来', () => {
    expect(normalizeBindInput({ publishedName: 'x', backendKeys: ['flash'], effectiveFrom: 'soon', reason: 'r' }, T0).ok).toBe(false)
    expect(normalizeBindInput({ publishedName: 'x', backendKeys: ['flash'], effectiveFrom: T0 + DAY, reason: 'r' }, T0).ok).toBe(true)
  })
})
