/**
 * 仅开发期使用的 mock 后端（**不进入生产构建**）。
 *
 * 挂载条件：`vite.config.ts` 里由 `QIANSHOU_ADMIN_DEV_MOCK=1` 显式开启，
 * 因此 `vite build` 的产物里不含本文件的任何代码；生产代码只认真实接口。
 *
 * 目的：后端（`packages/host/admin-console`）可能与前端并行开发，
 * 这里让「接口形状 + 错误分类 + 两步确认」三条链路在没有后端时也能跑通。
 * 返回的数据是**明确标注的开发夹具**，与真实业务无关，绝不能当成生产数据。
 */

import type { Connect, Plugin } from 'vite'

const PREFIX = '/api/qianshou/ai/admin'

/** 契约端点（与 src/api/endpoints.ts 保持一致；写死在这里是为了让 mock 与生产代码解耦）。 */
const PATH = {
  sessionLogin: `${PREFIX}/session/login`,
  sessionLoginTotp: `${PREFIX}/session/login-totp`,
  sessionLogout: `${PREFIX}/session/logout`,
  sessionMe: `${PREFIX}/session/me`,
  modules: `${PREFIX}/modules`,
  rbacPermissions: `${PREFIX}/rbac/permissions`,
  rbacRolesList: `${PREFIX}/rbac/roles/list`,
  rbacRolesPreflight: `${PREFIX}/rbac/roles/preflight`,
  rbacRolesApply: `${PREFIX}/rbac/roles/apply`,
  rbacAdminsList: `${PREFIX}/rbac/admins/list`,
  rbacAdminsPreflight: `${PREFIX}/rbac/admins/preflight`,
  rbacAdminsApply: `${PREFIX}/rbac/admins/apply`,
  auditList: `${PREFIX}/audit/list`,
  auditDetail: `${PREFIX}/audit/detail`,
  flagsList: `${PREFIX}/flags/list`,
  flagsPreflight: `${PREFIX}/flags/preflight`,
  flagsApply: `${PREFIX}/flags/apply`,
  whitelistStatus: `${PREFIX}/whitelist/status`,
  whitelistEntriesPreflight: `${PREFIX}/whitelist/entries/preflight`,
  whitelistEntriesApply: `${PREFIX}/whitelist/entries/apply`,
  accountList: `${PREFIX}/account/list`,
  accountDetail: `${PREFIX}/account/detail`,
  accountLedger: `${PREFIX}/account/ledger`,
  accountAdjustmentPreflight: `${PREFIX}/account/adjustment/preflight`,
  subscriptionList: `${PREFIX}/subscription/list`,
  subscriptionTiers: `${PREFIX}/subscription/tiers`,
  subscriptionManagePreflight: `${PREFIX}/subscription/manage/preflight`,
  marketOverview: `${PREFIX}/market/overview`,
  discoveryOverview: `${PREFIX}/discovery/overview`,
  orderOverview: `${PREFIX}/order/overview`,
  modelsOverview: `${PREFIX}/models/overview`,
  health: `${PREFIX}/health`,
} as const

/** mock 身份：super-admin（契约 §4.3）。 */
const MOCK_ADMIN = {
  accountId: '167',
  displayName: '开发夹具管理员',
  roleId: 'super-admin',
  roleName: '超级管理员',
  roleKind: 'builtin',
  scope: 'all',
  surface: 'ai-admin',
} as const

const MENU = [
  { key: 'overview', title: '总览', group: '运营', perm: null },
  { key: 'account', title: '账号与额度', group: '运营', perm: 'account.read' },
  { key: 'subscription', title: '订阅与档位', group: '运营', perm: 'subscription.read' },
  { key: 'models', title: '模型路由', group: '运营', perm: 'models.read' },
  { key: 'order', title: '订单与工单', group: '运营', perm: 'order.read' },
  { key: 'market', title: '技能 / 专家市场', group: '内容与市场', perm: 'market.read' },
  { key: 'discovery', title: '发现页内容', group: '内容与市场', perm: 'discovery.read' },
  { key: 'rbac', title: '权限管理', group: '治理', perm: 'rbac.read' },
  { key: 'audit', title: '审计日志', group: '治理', perm: 'audit.read' },
  { key: 'whitelist', title: '白名单', group: '治理', perm: 'whitelist.read' },
  { key: 'flags', title: '功能开关', group: '治理', perm: 'flags.read' },
] as const

const READINESS = [
  {
    key: 'account',
    title: '账号与额度',
    status: 'read-only',
    summary: '可读真实额度与流水；异常扣费处理等待账本属主服务开放写接口。',
    missing: [{ interface: 'POST /internal/ledger/adjust', why: '写接口在账本属主服务' }],
  },
  {
    key: 'subscription',
    title: '订阅与档位',
    status: 'read-only',
    summary: '订阅记录与档位目录可读；订阅变更等待属主服务。',
    missing: [{ interface: 'POST /internal/subscription/manage', why: '订阅变更在账本/订阅属主服务' }],
  },
  {
    key: 'models',
    title: '模型路由',
    status: 'dependency-unavailable',
    summary: '模型网关 7080 的 names/bind 已存在，本台尚未同一身份。',
    missing: [
      { interface: 'POST /api/qianshou/ai/admin/names', why: '列出前台名字与绑定历史' },
      { interface: 'POST /api/qianshou/ai/admin/bind', why: '追加绑定' },
    ],
  },
  {
    key: 'market',
    title: '技能 / 专家市场',
    status: 'dependency-unavailable',
    summary: '市场目录服务尚未建成。',
    missing: [
      { interface: 'GET /internal/market/items', why: '第三方技能/专家条目' },
      { interface: 'POST /internal/market/review', why: '上架审核与下架' },
    ],
  },
  {
    key: 'discovery',
    title: '发现页内容',
    status: 'dependency-unavailable',
    summary: '内容服务尚未建成。',
    missing: [
      { interface: 'GET /internal/discovery/feed', why: '发现页内容来源' },
      { interface: 'POST /internal/discovery/publish', why: '内容发布与下架' },
    ],
  },
  {
    key: 'order',
    title: '订单与工单',
    status: 'dependency-unavailable',
    summary: '订单/工单服务尚未建成。',
    missing: [
      { interface: 'GET /internal/order/list', why: '订单与退款事实来源' },
      { interface: 'POST /internal/ticket/reply', why: '工单回复通道' },
    ],
  },
  {
    key: 'rbac',
    title: '权限与审计',
    status: 'ready',
    summary: '角色、管理员、审计、功能开关、白名单全部可用。',
    missing: [],
  },
  { key: 'audit', title: '审计日志', status: 'ready', summary: '只追加的 JSONL 审计可读。', missing: [] },
  { key: 'flags', title: '功能开关', status: 'ready', summary: '开关与灰度可读写（两步确认）。', missing: [] },
  { key: 'whitelist', title: '白名单', status: 'ready', summary: '白名单条目可读写（两步确认）。', missing: [] },
] as const

/** 明确标注为开发夹具的账号数据。 */
const ACCOUNTS = [
  { accountId: '167', tier: 'pro', grantedSp: 200000, usedSp: 48210, remainingSp: 151790, callCount: 1284, lastCallAt: 1700000000000 },
  { accountId: '188', tier: 'free', grantedSp: 5000, usedSp: 5000, remainingSp: 0, callCount: 96, lastCallAt: 1699990000000 },
  { accountId: '203', tier: 'team', grantedSp: 800000, usedSp: 120000, remainingSp: 680000, callCount: 9312, lastCallAt: 1700010000000 },
] as const

const LEDGER = [
  { at: 1700010000000, model: 'deepseek-flash', inputTokens: 1820, outputTokens: 640, sp: -12 },
  { at: 1700009000000, model: 'deepseek-pro', inputTokens: 5200, outputTokens: 1800, sp: -48 },
  { at: 1700005000000, model: '（账本补充）', inputTokens: 0, outputTokens: 0, sp: 500 },
] as const

const SUBSCRIPTIONS = [
  { accountId: '167', tier: 'pro', from: 1690000000000, to: 1722000000000, grantedBy: '167', reason: '年度续费', active: true },
  { accountId: '203', tier: 'team', from: 1685000000000, to: 1700000000000, grantedBy: '167', reason: '试用转正', active: false },
] as const

const TIERS = [
  { id: 'free', label: '免费版', monthlySp: 5000, priceCny: 0 },
  { id: 'pro', label: '专业版', monthlySp: 200000, priceCny: 68 },
  { id: 'team', label: '团队版', monthlySp: 800000, priceCny: 298 },
] as const

const PERMISSION_GROUPS = [
  {
    module: 'account',
    title: '账号与额度',
    items: [
      { key: 'account.read', title: '查看账号与额度', highRisk: false, description: '读取账号列表与额度' },
      { key: 'account.ledger.read', title: '查看额度流水', highRisk: false, description: '读取账本流水' },
      { key: 'account.charge.adjust', title: '异常扣费处理', highRisk: true, description: '调整账号额度（需账本属主服务）' },
    ],
  },
  {
    module: 'subscription',
    title: '订阅与档位',
    items: [
      { key: 'subscription.read', title: '查看订阅', highRisk: false, description: '读取订阅与档位目录' },
      { key: 'subscription.manage', title: '变更订阅', highRisk: true, description: '调整账号订阅档位' },
    ],
  },
  {
    module: 'models',
    title: '模型路由',
    items: [
      { key: 'models.read', title: '看前台模型名字与绑定', highRisk: false, description: '读取前台名字与绑定历史' },
      { key: 'models.bind', title: '追加模型绑定', highRisk: true, description: '追加绑定（生效日必须在未来）' },
    ],
  },
  {
    module: 'market',
    title: '技能/专家市场',
    items: [
      { key: 'market.read', title: '查看市场', highRisk: false, description: '读取技能/专家条目' },
      { key: 'market.review', title: '上架审核', highRisk: false, description: '审核与下架条目' },
      { key: 'market.pricing.manage', title: '管理定价', highRisk: true, description: '调整市场定价' },
    ],
  },
  {
    module: 'discovery',
    title: '发现页内容',
    items: [
      { key: 'discovery.read', title: '查看内容', highRisk: false, description: '读取发现页内容' },
      { key: 'discovery.publish', title: '发布内容', highRisk: true, description: '发布与下架内容' },
      { key: 'discovery.report.handle', title: '处理举报', highRisk: false, description: '处理内容举报' },
    ],
  },
  {
    module: 'order',
    title: '订单与工单',
    items: [
      { key: 'order.read', title: '查看订单', highRisk: false, description: '读取订单' },
      { key: 'order.refund', title: '退款', highRisk: true, description: '发起退款' },
      { key: 'ticket.read', title: '查看工单', highRisk: false, description: '读取工单' },
      { key: 'ticket.reply', title: '回复工单', highRisk: false, description: '回复用户工单' },
    ],
  },
  {
    module: 'rbac',
    title: '权限与审计',
    items: [
      { key: 'rbac.read', title: '查看权限配置', highRisk: false, description: '读取角色与管理员' },
      { key: 'rbac.manage', title: '管理权限', highRisk: true, description: '增删角色、授予管理员' },
      { key: 'audit.read', title: '查看审计', highRisk: false, description: '查询审计日志' },
      { key: 'flags.read', title: '查看功能开关', highRisk: false, description: '读取开关' },
      { key: 'flags.manage', title: '管理功能开关', highRisk: true, description: '修改开关与灰度' },
      { key: 'whitelist.read', title: '查看白名单', highRisk: false, description: '读取白名单' },
      { key: 'whitelist.manage', title: '管理白名单', highRisk: true, description: '增删白名单条目' },
    ],
  },
] as const

const ROLES = [
  { id: 'super-admin', name: '超级管理员', kind: 'builtin', surface: 'ai-admin', description: '全部权限', permissions: PERMISSION_GROUPS.flatMap(g => g.items.map(i => i.key)), scopeDefault: 'all', memberCount: 1 },
  { id: 'auditor', name: '审计员', kind: 'builtin', surface: 'ai-admin', description: '只读审计与权限视图', permissions: ['audit.read', 'rbac.read', 'whitelist.read'], scopeDefault: 'all', memberCount: 0 },
  { id: 'market-reviewer', name: '市场审核员', kind: 'custom', surface: 'ai-admin', description: '开发夹具自定义角色', permissions: ['market.read', 'market.review'], scopeDefault: 'self', memberCount: 0 },
] as const

const ADMINS = [
  { accountId: '167', displayName: '开发夹具管理员', roleId: 'super-admin', scope: 'all', enabled: true, createdAt: 1690000000000, createdBy: '167' },
] as const

const FLAGS = [
  { key: 'feature.new-router', title: '新路由策略', enabled: false, rolloutPercent: 0, description: '开发夹具', updatedAt: 1700000000000, updatedBy: '167', version: 3 },
  { key: 'feature.discovery-feed', title: '发现页新信息流', enabled: true, rolloutPercent: 20, description: '开发夹具', updatedAt: 1700005000000, updatedBy: '167', version: 7 },
] as const

const WHITELIST = {
  enabled: true,
  clientIp: '203.0.113.7',
  entries: [
    { cidr: '203.0.113.0/24', note: '办公出口（开发夹具）', addedBy: '167', addedAt: 1700000000000 },
    { cidr: '127.0.0.1/32', note: '回环逃生路径', addedBy: '167', addedAt: 1700000000000 },
  ],
  escapeHatch: {
    loopbackAlwaysAllowed: true,
    cliHint: "ssh root@203.0.113.20 'node /srv/qianshou-agent/packages/host/admin-console/src/main.ts whitelist add 203.0.113.7/32'",
  },
}

const AUDIT_TEMPLATE = [
  { id: 'a-1001', at: 1700010000000, actorId: '167', actorRole: '超级管理员', ip: '203.0.113.7', action: 'session.login', target: 'account:167', result: 'allow', reason: '', summary: '登录成功（开发夹具）' },
  { id: 'a-1002', at: 1700010100000, actorId: '188', actorRole: '客服', ip: '203.0.113.9', action: 'account.list', target: 'account:list', result: 'deny', reason: '缺少 account.read', summary: '越权请求被拒' },
  { id: 'a-1003', at: 1700010200000, actorId: '—', actorRole: '—', ip: '198.51.100.4', action: 'whitelist.reject', target: 'ip:198.51.100.4', result: 'deny', reason: 'ip_not_allowed', summary: '来源 IP 不在白名单' },
  { id: 'a-1004', at: 1700010300000, actorId: '167', actorRole: '超级管理员', ip: '203.0.113.7', action: 'flags.apply', target: 'flag:feature.discovery-feed', result: 'allow', reason: '灰度放量到 20%', summary: 'enable=true, rolloutPercent 0 → 20' },
] as const

interface MockRequest {
  readonly path: string
  readonly body: Record<string, unknown>
  readonly setCookie: (header: string) => void
  readonly setStatus: (status: number) => void
}

type MockHandler = (request: MockRequest) => unknown

/** 一次性确认令牌表：与契约一致，60 秒有效、用完即弃。 */
const tokens = new Map<string, { path: string; expiresAt: number; payload: unknown }>()
let tokenSeq = 0
let auditSeq = 2000

function issueToken(path: string, payload: unknown): { token: string; expiresAt: number } {
  tokenSeq += 1
  const token = `dev-${tokenSeq}-${Math.random().toString(36).slice(2, 10)}`
  const expiresAt = Date.now() + 60_000
  tokens.set(token, { path, expiresAt, payload })
  return { token, expiresAt }
}

function consumeToken(token: unknown, path: string): { ok: true; payload: unknown } | { ok: false; code: string; message: string } {
  if (typeof token !== 'string' || token === '') {
    return { ok: false, code: 'confirm_required', message: '缺少二次确认令牌，请先预览差异。' }
  }
  const record = tokens.get(token)
  if (record === undefined) {
    return { ok: false, code: 'confirm_invalid', message: '二次确认令牌无效，请重新预览。' }
  }
  tokens.delete(token)
  if (record.expiresAt < Date.now()) {
    return { ok: false, code: 'confirm_expired', message: '二次确认令牌已过期（60 秒），请重新预览。' }
  }
  if (record.path !== path) {
    return { ok: false, code: 'confirm_mismatch', message: '二次确认令牌与本次操作不匹配。' }
  }
  return { ok: true, payload: record.payload }
}

function nextAuditId(): string {
  auditSeq += 1
  return `dev-audit-${auditSeq}`
}

function requireReason(body: Record<string, unknown>): { ok: true; reason: string } | { ok: false; code: string; message: string } {
  const reason = typeof body.reason === 'string' ? body.reason.trim() : ''
  if (reason.length < 4) {
    return { ok: false, code: 'bad_request', message: '操作原因至少需要 4 个字。' }
  }
  return { ok: true, reason }
}

function dependencyUnavailable(module: string, title: string, missing: readonly { interface: string; why: string }[]): never {
  const error = new MockHttpError(503, {
    ok: false,
    code: 'dependency_unavailable',
    message: `${title}的属主服务尚未提供接口，页面为占位。`,
    module,
    moduleTitle: title,
    missing: [...missing],
  })
  throw error
}

/** 让 handler 能直接抛 HTTP 错误，由中间件统一序列化。 */
class MockHttpError extends Error {
  readonly status: number
  readonly payload: unknown

  constructor(status: number, payload: unknown) {
    super(`mock http ${status}`)
    this.status = status
    this.payload = payload
  }
}

function notFound(path: string): never {
  throw new MockHttpError(404, { ok: false, code: 'bad_request', message: `mock 未实现该路径：${path}` })
}

const HANDLERS: Readonly<Record<string, MockHandler>> = {
  [PATH.sessionLogin]: ({ body }) => {
    if (typeof body.username !== 'string' || body.username === '' || typeof body.password !== 'string' || body.password === '') {
      throw new MockHttpError(400, { ok: false, code: 'bad_request', message: '账号或密码为空。' })
    }
    // 用用户名后缀触发第二步，便于前端两条路径都能演练。
    if (body.username.endsWith('2fa')) {
      return { ok: true, twoFactor: true, challenge: { challengeToken: 'dev-challenge' } }
    }
    return { ok: true, twoFactor: false }
  },
  [PATH.sessionLoginTotp]: ({ body }) => {
    if (body.challengeToken !== 'dev-challenge' || typeof body.code !== 'string' || !/^\d{6}$/.test(body.code)) {
      throw new MockHttpError(401, { ok: false, code: 'invalid_credentials', message: '动态验证码不正确。' })
    }
    return { ok: true, twoFactor: false }
  },
  [PATH.sessionLogout]: () => ({ ok: true }),
  [PATH.sessionMe]: ({ setCookie }) => {
    setCookie('qianshou_admin_sid=dev-session; Path=/; HttpOnly; SameSite=Strict')
    return {
      ok: true,
      admin: MOCK_ADMIN,
      permissions: PERMISSION_GROUPS.flatMap(group => group.items.map(item => item.key)),
      menu: MENU,
      readiness: READINESS,
      clientIp: WHITELIST.clientIp,
    }
  },
  [PATH.modules]: () => ({ ok: true, modules: READINESS }),
  [PATH.health]: () => ({ ok: true, service: 'qianshou-admin-console', version: '0.0.0-dev-mock', uptimeMs: 123456 }),

  [PATH.rbacPermissions]: () => ({ ok: true, groups: PERMISSION_GROUPS }),
  [PATH.rbacRolesList]: () => ({ ok: true, roles: ROLES }),
  [PATH.rbacRolesPreflight]: ({ body }) => {
    const before = ROLES.find(role => role.id === body.id) ?? null
    const after = body.op === 'delete' ? null : { ...body }
    return { ok: true, confirm: { ...issueToken(PATH.rbacRolesPreflight, body), diff: { before, after } } }
  },
  [PATH.rbacRolesApply]: ({ body }) => {
    const reason = requireReason(body)
    if (!reason.ok) throw new MockHttpError(400, { ok: false, code: reason.code, message: reason.message })
    const token = consumeToken(body.token, PATH.rbacRolesPreflight)
    if (!token.ok) throw new MockHttpError(409, { ok: false, code: token.code, message: token.message })
    return { ok: true, auditId: nextAuditId(), result: token.payload }
  },
  [PATH.rbacAdminsList]: () => ({ ok: true, admins: ADMINS }),
  [PATH.rbacAdminsPreflight]: ({ body }) => {
    const before = ADMINS.find(admin => admin.accountId === body.accountId) ?? null
    const after = body.op === 'revoke' ? null : { ...body }
    return { ok: true, confirm: { ...issueToken(PATH.rbacAdminsPreflight, body), diff: { before, after } } }
  },
  [PATH.rbacAdminsApply]: ({ body }) => {
    const reason = requireReason(body)
    if (!reason.ok) throw new MockHttpError(400, { ok: false, code: reason.code, message: reason.message })
    const token = consumeToken(body.token, PATH.rbacAdminsPreflight)
    if (!token.ok) throw new MockHttpError(409, { ok: false, code: token.code, message: token.message })
    return { ok: true, auditId: nextAuditId(), result: token.payload }
  },

  [PATH.auditList]: ({ body }) => {
    const limit = typeof body.limit === 'number' ? body.limit : 50
    const offset = typeof body.offset === 'number' ? body.offset : 0
    let rows = [...AUDIT_TEMPLATE]
    if (typeof body.actorId === 'string' && body.actorId !== '') rows = rows.filter(row => row.actorId === body.actorId)
    if (typeof body.actionPrefix === 'string' && body.actionPrefix !== '') {
      rows = rows.filter(row => row.action.startsWith(body.actionPrefix as string))
    }
    if (body.result === 'allow' || body.result === 'deny') rows = rows.filter(row => row.result === body.result)
    return { ok: true, total: rows.length, entries: rows.slice(offset, offset + limit) }
  },
  [PATH.auditDetail]: ({ body }) => {
    const entry = AUDIT_TEMPLATE.find(row => row.id === body.id) ?? AUDIT_TEMPLATE[0]
    return {
      ok: true,
      entry: {
        ...entry,
        before: { rolloutPercent: 0 },
        after: { rolloutPercent: 20 },
        diff: [
          { path: 'enabled', before: false, after: true },
          { path: 'rolloutPercent', before: 0, after: 20 },
        ],
      },
    }
  },

  [PATH.flagsList]: () => ({ ok: true, flags: FLAGS }),
  [PATH.flagsPreflight]: ({ body }) => {
    const before = FLAGS.find(flag => flag.key === body.key) ?? null
    const after = { ...before, ...body }
    return { ok: true, confirm: { ...issueToken(PATH.flagsPreflight, body), diff: { before, after } } }
  },
  [PATH.flagsApply]: ({ body }) => {
    const reason = requireReason(body)
    if (!reason.ok) throw new MockHttpError(400, { ok: false, code: reason.code, message: reason.message })
    const token = consumeToken(body.token, PATH.flagsPreflight)
    if (!token.ok) throw new MockHttpError(409, { ok: false, code: token.code, message: token.message })
    return { ok: true, auditId: nextAuditId(), result: token.payload }
  },

  [PATH.whitelistStatus]: () => ({ ok: true, ...WHITELIST }),
  [PATH.whitelistEntriesPreflight]: ({ body }) => {
    const cidr = typeof body.cidr === 'string' ? body.cidr : ''
    const before = WHITELIST.entries
    const after =
      body.op === 'remove'
        ? before.filter(entry => entry.cidr !== cidr)
        : [...before, { cidr, note: typeof body.note === 'string' ? body.note : '', addedBy: MOCK_ADMIN.accountId, addedAt: Date.now() }]
    return { ok: true, confirm: { ...issueToken(PATH.whitelistEntriesPreflight, body), diff: { before, after } } }
  },
  [PATH.whitelistEntriesApply]: ({ body }) => {
    const reason = requireReason(body)
    if (!reason.ok) throw new MockHttpError(400, { ok: false, code: reason.code, message: reason.message })
    const token = consumeToken(body.token, PATH.whitelistEntriesPreflight)
    if (!token.ok) throw new MockHttpError(409, { ok: false, code: token.code, message: token.message })
    return { ok: true, auditId: nextAuditId(), result: token.payload }
  },

  [PATH.accountList]: ({ body }) => {
    const query = typeof body.query === 'string' ? body.query : ''
    const limit = typeof body.limit === 'number' ? body.limit : 20
    const offset = typeof body.offset === 'number' ? body.offset : 0
    const rows = query === '' ? [...ACCOUNTS] : ACCOUNTS.filter(row => row.accountId.includes(query))
    return { ok: true, total: rows.length, accounts: rows.slice(offset, offset + limit) }
  },
  [PATH.accountDetail]: ({ body }) => {
    const account = ACCOUNTS.find(row => row.accountId === body.accountId)
    if (account === undefined) {
      throw new MockHttpError(400, { ok: false, code: 'bad_request', message: `未知账号：${String(body.accountId)}` })
    }
    return { ok: true, account, reservations: [] }
  },
  [PATH.accountLedger]: ({ body }) => {
    const limit = typeof body.limit === 'number' ? body.limit : 20
    const offset = typeof body.offset === 'number' ? body.offset : 0
    return { ok: true, total: LEDGER.length, entries: [...LEDGER].slice(offset, offset + limit) }
  },
  // 契约 §8.1：该写接口在账本属主服务里，尚未开放 —— mock 如实返回 503。
  [PATH.accountAdjustmentPreflight]: () => {
    dependencyUnavailable('account', '账号与额度', READINESS[0].missing)
  },

  [PATH.subscriptionList]: ({ body }) => {
    const limit = typeof body.limit === 'number' ? body.limit : 20
    const offset = typeof body.offset === 'number' ? body.offset : 0
    return { ok: true, total: SUBSCRIPTIONS.length, entries: [...SUBSCRIPTIONS].slice(offset, offset + limit) }
  },
  [PATH.subscriptionTiers]: () => ({ ok: true, source: 'account-service（开发夹具）', tiers: TIERS }),
  [PATH.subscriptionManagePreflight]: () => {
    dependencyUnavailable('subscription', '订阅与档位', READINESS[1].missing)
  },

  [PATH.marketOverview]: () => {
    dependencyUnavailable('market', '技能 / 专家市场', READINESS[3].missing)
  },
  [PATH.discoveryOverview]: () => {
    dependencyUnavailable('discovery', '发现页内容', READINESS[4].missing)
  },
  [PATH.orderOverview]: () => {
    dependencyUnavailable('order', '订单与工单', READINESS[5].missing)
  },
  [PATH.modelsOverview]: () => {
    dependencyUnavailable('models', '模型路由', READINESS[2].missing)
  },
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseJson(text: string): Record<string, unknown> {
  if (text.trim() === '') return {}
  try {
    const parsed = JSON.parse(text) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Vite 插件：仅在开发服务器内挂载 `/api/qianshou/ai/admin/*`。 */
export function createAdminDevMock(): Plugin {
  return {
    name: 'qianshou-admin-dev-mock',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith(`${PREFIX}/`) || req.method !== 'POST') {
          next()
          return
        }
        const path = url.split('?')[0] ?? ''
        void (async () => {
          const body = parseJson(await readBody(req))
          const headers: string[] = []
          let status = 200
          const request: MockRequest = {
            path,
            body,
            setCookie: header => headers.push(header),
            setStatus: (value) => {
              status = value
            },
          }
          let payload: unknown
          try {
            const handler = HANDLERS[path]
            payload = handler === undefined ? notFound(path) : handler(request)
          } catch (error) {
            if (error instanceof MockHttpError) {
              status = error.status
              payload = error.payload
            } else {
              status = 500
              payload = {
                ok: false,
                code: 'internal',
                message: `mock 处理器异常：${error instanceof Error ? error.message : String(error)}`,
              }
            }
          }
          res.statusCode = status
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.setHeader('cache-control', 'no-store')
          for (const header of headers) res.setHeader('set-cookie', header)
          res.end(JSON.stringify(payload))
        })().catch((error: unknown) => {
          res.statusCode = 500
          res.setHeader('content-type', 'application/json; charset=utf-8')
          res.end(JSON.stringify({ ok: false, code: 'internal', message: String(error) }))
        })
      })
      server.config.logger.info('[qianshou-admin-dev-mock] 已挂载开发夹具后端（不进入生产构建）')
    },
  }
}
