/**
 * 权限模型：角色 → 菜单、角色 → 接口、数据范围、高危标记。
 *
 * 这个文件是**授权判定的唯一出处**。前端拿到的菜单、接口返回 403 时说的"缺哪个权限"、
 * 写操作要不要二次确认，全部由这里的数据推导——不允许在路由里另写一份 if/else。
 *
 * 三条不可动摇的规则：
 *
 * 1. **服务端强制**。前端只做呈现：菜单列表是服务端按权限过滤后的结果，
 *    但即使有人手工构造请求，也过不了 `can()` 这一关。
 * 2. **与算力运营台彻底分离**。本面所有角色带 `surface: 'ai-admin'`；
 *    任何 `surface !== 'ai-admin'` 的角色都不能授予到本管理台（{@link roleGrantable}）。
 *    两套角色表分开是用户明确的硬边界：算力台后期要给非 AI 的企业客户用，
 *    把两边的角色混在一起，等于让一个客户面的角色拿到 AI 运营权限。
 * 3. **未知即拒绝**。目录里没有的权限键一律不生效（`can` 返回 `false`），
 *    角色里带了未知键在写入时就会被拒绝（{@link validatePermissions}）。
 */

/** 本面的标识。算力台是 `compute`，两者永不互通。 */
export const SURFACE = 'ai-admin'

/** 算力运营台的角色面标识（只用来**拒绝**，绝不接受）。 */
export const COMPUTE_SURFACE = 'compute'

/** 一个权限点。 */
export interface PermissionDef {
  /** 权限键：`<模块>.<动作>`。 */
  readonly key: string
  readonly title: string
  /** 所属模块（与 `modules.ts` 的模块 key 一致）。 */
  readonly module: string
  /** 高危操作：必须走两步确认，且审计里必须留下 before → after。 */
  readonly highRisk: boolean
  readonly description: string
}

/** 模块分组标题（权限矩阵与侧栏共用）。 */
export const MODULE_TITLES: Readonly<Record<string, string>> = {
  overview: '总览',
  account: '账号与额度',
  subscription: '订阅与档位',
  market: '技能 / 专家市场',
  community: '讨论区',
  discovery: '发现页内容',
  order: '订单与工单',
  enterprise: '企业咨询',
  rbac: '权限与角色',
  audit: '审计日志',
  whitelist: 'IP 白名单',
  flags: '功能开关',
  credential: '上游密钥',
  models: '模型路由',
  apiConnections: 'API管理',
}

/**
 * 权限目录。
 *
 * 刻意**先把目录定全**（包括还没建成的模块）：角色配置是给人看的合同，
 * 等市场服务建好再补权限点，等于让"谁能审核上架"这件事推迟到那天才讨论。
 */
export const PERMISSIONS: readonly PermissionDef[] = [
  { key: 'apiConnections.read', title: '查看节点 API 连接', module: 'apiConnections', highRisk: false,
    description: '查看广州节点的真实连接、任务与结算回执数量；按全部或本人数据范围过滤。' },
  { key: 'apiConnections.manage', title: '管理节点 API 授权', module: 'apiConnections', highRisk: true,
    description: '暂停、恢复或吊销节点授权；两步确认和持久审计，不伪造执行终态或结算。' },
  {
    key: 'account.read', title: '查账号与额度', module: 'account', highRisk: false,
    description: '查看账号的档位、授予额度、已用额度与调用次数。',
  },
  {
    key: 'account.ledger.read', title: '看额度流水', module: 'account', highRisk: false,
    description: '查看逐次调用的 token 用量与扣费（含上游后端键）。',
  },
  {
    key: 'account.charge.adjust', title: '处理异常扣费', module: 'account', highRisk: true,
    description: '给账号补扣或退还 SP。涉及钱，必须两步确认并留 before → after。',
  },
  {
    key: 'subscription.read', title: '看订阅与档位', module: 'subscription', highRisk: false,
    description: '查看订阅记录与档位目录（价格、额度、并发）。',
  },
  {
    key: 'subscription.manage', title: '定义档位与开通订阅', module: 'subscription', highRisk: true,
    description: '改档位价格/有效期、给账号开通或降级。涉及定价，必须两步确认。',
  },
  {
    key: 'market.read', title: '看技能/专家市场', module: 'market', highRisk: false,
    description: '查看第三方技能与专家条目、审核状态。',
  },
  {
    key: 'market.review', title: '上架审核与下架', module: 'market', highRisk: false,
    description: '通过/驳回第三方上架申请，下架已发布条目。',
  },
  {
    key: 'market.pricing.manage', title: '官方定价与分成规则', module: 'market', highRisk: true,
    description: '改官方定价与开发者分成比例。涉及第三方收入，必须两步确认。',
  },
  { key: 'community.read', title: '查看讨论与举报', module: 'community', highRisk: false, description: '查看讨论区全部主题与待处理举报。' },
  { key: 'community.manage', title: '审核讨论与发布活动', module: 'community', highRisk: false, description: '隐藏、恢复、置顶讨论，处理举报及发布官方活动；写入审计。' },
  {
    key: 'discovery.read', title: '看发现页内容', module: 'discovery', highRisk: false,
    description: '查看公告、推荐位与举报队列。',
  },
  {
    key: 'discovery.publish', title: '公告发布与推荐位', module: 'discovery', highRisk: true,
    description: '发布/下线公告、调整推荐位。会直接影响全部用户，必须两步确认。',
  },
  {
    key: 'discovery.report.handle', title: '处理举报', module: 'discovery', highRisk: false,
    description: '受理并处置发现页举报。',
  },
  { key: 'payment.read', title: '查询支付订单与提现', module: 'order', highRisk: false, description: '查询上海全局支付订单与待审批提现；需要全部数据范围及上海管理员身份。' },
  { key: 'payment.manage', title: '管理充值与提现', module: 'order', highRisk: true, description: '核实后确认手工订单、手动充值、审批提现及登记已打款；两步确认并写审计，不含退款。' },
  { key: 'enterprise.read', title: '查看企业咨询', module: 'enterprise', highRisk: false, description: '只读查看官网企业咨询与联系信息；需要全部数据范围及上海管理员身份。' },
  {
    key: 'order.read', title: '查订单与工单', module: 'order', highRisk: false,
    description: '查询订单、退款记录与客服工单。',
  },
  {
    key: 'order.refund', title: '退款', module: 'order', highRisk: true,
    description: '发起退款。涉及钱，必须两步确认。',
  },
  {
    key: 'ticket.read', title: '看客服工单', module: 'order', highRisk: false,
    description: '查看用户工单与历史回复。',
  },
  {
    key: 'ticket.reply', title: '回复工单', module: 'order', highRisk: false,
    description: '以客服身份回复用户工单。',
  },
  {
    key: 'rbac.read', title: '看角色与授权', module: 'rbac', highRisk: false,
    description: '查看角色、权限矩阵与管理员授权。',
  },
  {
    key: 'rbac.manage', title: '改角色与授权', module: 'rbac', highRisk: true,
    description: '增删角色、改权限、授予/撤销管理员。**权限本身**，必须两步确认。',
  },
  {
    key: 'audit.read', title: '看审计日志', module: 'audit', highRisk: false,
    description: '查询操作留痕（谁、何时、改了什么、before → after）。',
  },
  {
    key: 'whitelist.read', title: '看 IP 白名单', module: 'whitelist', highRisk: false,
    description: '查看允许访问管理台的来源 IP/CIDR。',
  },
  {
    key: 'whitelist.manage', title: '改 IP 白名单', module: 'whitelist', highRisk: true,
    description: '增删白名单条目。改错会把自己锁在外面，必须两步确认。',
  },
  {
    key: 'flags.read', title: '看功能开关', module: 'flags', highRisk: false,
    description: '查看灰度开关状态与灰度比例。',
  },
  {
    key: 'flags.manage', title: '改功能开关', module: 'flags', highRisk: true,
    description: '开关功能或调整灰度比例。影响全部用户，必须两步确认。',
  },
  {
    key: 'credential.read', title: '看上游密钥状态', module: 'credential', highRisk: false,
    description: '查看上游密钥的键名、是否已配置、指纹与更新记录。**密钥值永不回显。**',
  },
  {
    key: 'credential.manage', title: '更换上游密钥', module: 'credential', highRisk: true,
    description: '更换模型网关使用的上游密钥。换错会影响全部用户的上游调用；'
      + '除了本权限，服务端还硬性要求调用者是 super-admin 角色。',
  },
  {
    key: 'models.read', title: '看前台模型名字与绑定', module: 'models', highRisk: false,
    description: '查看工作台前台名字、后端列表与绑定历史。不改路由。',
  },
  {
    key: 'models.bind', title: '追加模型绑定', module: 'models', highRisk: true,
    description: '给前台名字追加一条后端绑定。生效日必须在未来；换错会影响全部用户的作答后端，必须两步确认。',
  },
]

/** 权限键集合（判定用）。 */
const PERMISSION_KEYS: ReadonlySet<string> = new Set(PERMISSIONS.map(permission => permission.key))

/** 权限定义表（渲染与校验用）。 */
const PERMISSION_BY_KEY: ReadonlyMap<string, PermissionDef> = new Map(PERMISSIONS.map(permission => [permission.key, permission]))

/** 取一个权限点的定义。 */
export function permissionOf(key: string): PermissionDef | undefined {
  return PERMISSION_BY_KEY.get(key)
}

/** 这个键是不是目录里的权限。 */
export function isKnownPermission(key: string): boolean {
  return PERMISSION_KEYS.has(key)
}

/** 该权限点是不是高危。**未知键一律按高危处理**（不认识的动作用户必须当面确认）。 */
export function isHighRisk(key: string): boolean {
  return PERMISSION_BY_KEY.get(key)?.highRisk ?? true
}

/** 角色。 */
export interface RoleRecord {
  readonly id: string
  readonly name: string
  /** `builtin` 的权限不可改（改了就等于偷偷扩权），只能改它的成员。 */
  readonly kind: 'builtin' | 'custom'
  /**
   * 角色面。本管理台的角色恒为 `ai-admin`；算力台的是 `compute`。
   *
   * 类型是 `string` 而不是字面量 `'ai-admin'`：这个字段存在的意义正是**校验从磁盘
   * 读回来的值**，如果类型已经断言它一定是本面，`roleGrantable` 就成了一行永远为真的代码。
   */
  readonly surface: string
  readonly description: string
  /** 权限键列表。 */
  readonly permissions: readonly string[]
  /** 新成员默认的数据范围。 */
  readonly scopeDefault: DataScope
}

/** 数据范围：看全部，或只看自己经办的。 */
export type DataScope = 'all' | 'self'

/**
 * 内置角色。
 *
 * 为什么内置而不是"开局空表让用户自己配"：权限模型的默认值应当是**保守且可用**的。
 * 空表意味着第一个管理员必须理解全部 22 个权限点才能开始工作，
 * 而一旦配错（比如给客服 `rbac.manage`）没人会立刻发现。
 */
export const BUILTIN_ROLES: readonly RoleRecord[] = [
  {
    id: 'super-admin',
    name: '超级管理员',
    kind: 'builtin',
    surface: SURFACE,
    description: '全部权限，含权限管理、白名单与高危操作。',
    permissions: PERMISSIONS.map(permission => permission.key),
    scopeDefault: 'all',
  },
  {
    id: 'ops',
    name: '运营',
    kind: 'builtin',
    surface: SURFACE,
    description: '发现页内容、市场上架审核、工单处理；账号与订单只读。',
    permissions: [
      'account.read',
      'discovery.read', 'discovery.publish', 'discovery.report.handle',
      'market.read', 'market.review',
      'community.read', 'community.manage',
      'models.read',
      'enterprise.read',
      'order.read', 'ticket.read', 'ticket.reply',
    ],
    scopeDefault: 'all',
  },
  {
    id: 'finance',
    name: '财务',
    kind: 'builtin',
    surface: SURFACE,
    description: '账号额度、订阅档位、退款；不含权限与白名单。',
    permissions: [
      'account.read', 'account.ledger.read', 'account.charge.adjust',
      'subscription.read', 'subscription.manage',
      'order.read', 'order.refund',
      'audit.read',
    ],
    scopeDefault: 'all',
  },
  {
    id: 'support',
    name: '客服',
    kind: 'builtin',
    surface: SURFACE,
    description: '只读账号信息、处理工单；数据范围默认只看自己经办的。',
    permissions: ['account.read', 'order.read', 'ticket.read', 'ticket.reply'],
    scopeDefault: 'self',
  },
  {
    id: 'auditor',
    name: '审计员',
    kind: 'builtin',
    surface: SURFACE,
    description: '只看不改：审计日志、角色与授权、白名单。',
    permissions: ['audit.read', 'rbac.read', 'whitelist.read'],
    scopeDefault: 'all',
  },
]

/** 管理员记录。 */
export interface AdminRecord {
  /** 上游账号 id（**复用既有账号体系**，不另造账号）。 */
  readonly accountId: string
  /** 展示名（登录时从上游账号资料带过来）。 */
  readonly displayName: string
  readonly roleId: string
  /** 个人数据范围覆盖；省略时用角色的 `scopeDefault`。 */
  readonly scope?: DataScope
  readonly enabled: boolean
  readonly createdAt: number
  readonly createdBy: string
}

/** 侧栏菜单项。`perm` 为 `null` 表示登录即可见。 */
export interface MenuItem {
  readonly key: string
  readonly title: string
  readonly group: string
  readonly perm: string | null
}

/**
 * 菜单表。
 *
 * 菜单是**权限的投影**，不是另一份配置：`perm` 与 `PERMISSIONS` 的键一一对应，
 * 前端拿到的就是过滤后的结果，不需要（也不允许）自己判断。
 */
export const MENU: readonly MenuItem[] = [
  { key: 'apiConnections', title: 'API管理', group: '运营', perm: 'apiConnections.read' },
  { key: 'overview', title: '总览', group: '运营', perm: null },
  { key: 'account', title: '账号与额度', group: '运营', perm: 'account.read' },
  { key: 'subscription', title: '订阅与档位', group: '运营', perm: 'subscription.read' },
  { key: 'models', title: '模型路由', group: '运营', perm: 'models.read' },
  { key: 'market', title: '技能 / 专家市场', group: '运营', perm: 'market.read' },
  { key: 'community', title: '讨论区', group: '运营', perm: 'community.read' },
  { key: 'discovery', title: '发现页内容', group: '运营', perm: 'discovery.read' },
  { key: 'order', title: '支付订单与提现', group: '运营', perm: 'payment.read' },
  { key: 'enterprise', title: '企业咨询', group: '运营', perm: 'enterprise.read' },
  { key: 'rbac', title: '权限管理', group: '安全', perm: 'rbac.read' },
  { key: 'audit', title: '审计日志', group: '安全', perm: 'audit.read' },
  { key: 'whitelist', title: 'IP 白名单', group: '安全', perm: 'whitelist.read' },
  { key: 'flags', title: '功能开关', group: '安全', perm: 'flags.read' },
  // 放在"安全"组末尾：改上游密钥会影响全部用户，读权限是 `credential.read`；
  // 改的那一步另有 super-admin 硬判定（菜单只决定"显不显示"，不是权限边界）。
  { key: 'credential', title: '上游密钥', group: '安全', perm: 'credential.read' },
  // 号池和上游密钥共用同一对权限键（`credential.read` / `credential.manage`）：
  // 它做的是同一类事情（往凭据文件里放凭据），多造一对权限键只会让授权矩阵多两行噪音。
  { key: 'pool', title: '上游号池', group: '安全', perm: 'credential.read' },
]

/**
 * 一个角色能不能授予到本管理台。
 *
 * 这是「两套角色表分开」的**执行点**：算力台的角色（`surface: 'compute'`）
 * 或任何来路不明的角色都拒绝。
 * @param role - 候选角色。
 * @returns 可授予返回 `null`，否则返回一句可直接展示的原因。
 */
export function roleGrantable(role: RoleRecord | undefined): string | null {
  if (role === undefined) return '这个角色不存在。'
  if (role.surface !== SURFACE) {
    return `角色「${role.id}」属于 ${role.surface} 面，不能用于 AI 运营管理台（两套角色表必须分开）。`
  }
  return null
}

/** 校验一组权限键。 */
export function validatePermissions(permissions: readonly string[]): string | null {
  for (const key of permissions) {
    if (!isKnownPermission(key)) return `不认识的权限键：${key}。`
  }
  return null
}

/**
 * 判定一个角色是否拥有某权限。
 *
 * **未知权限键一律不通过**（即使它不知怎么被写进了角色文件里）。这条兜底很重要：
 * 角色文件是磁盘上的 JSON，手工塞一个不存在的键进去，最不该发生的事就是它"意外生效"。
 * @param role - 角色。
 * @param permission - 权限键。
 * @returns 拥有返回 `true`。
 */
export function can(role: RoleRecord, permission: string): boolean {
  if (!isKnownPermission(permission)) return false
  return role.permissions.includes(permission)
}

/**
 * 取某个管理员的有效数据范围。
 *
 * 管理员记录上的 `scope` 是**个人覆盖**（同一个角色的人可以有不同范围），
 * 记录里没写时才回落到角色的默认值。
 * @param admin - 管理员记录。
 * @param role - 该管理员的角色。
 * @returns 有效范围。
 */
export function scopeOf(admin: AdminRecord, role: RoleRecord): DataScope {
  return admin.scope ?? role.scopeDefault
}

/**
 * 按角色过滤菜单。
 * @param role - 角色。
 * @returns 可见菜单项。
 */
export function menuFor(role: RoleRecord): readonly MenuItem[] {
  return MENU.filter(item => item.perm === null || can(role, item.perm))
}

/** 按模块分组权限（权限矩阵）。 */
export interface PermissionGroup {
  readonly module: string
  readonly title: string
  readonly items: readonly PermissionDef[]
}

/**
 * 权限矩阵分组。
 * @returns 按 `MODULE_TITLES` 顺序排列的分组。
 */
export function permissionGroups(): readonly PermissionGroup[] {
  const groups = new Map<string, PermissionDef[]>()
  for (const permission of PERMISSIONS) {
    const list = groups.get(permission.module)
    if (list === undefined) groups.set(permission.module, [permission])
    else list.push(permission)
  }
  return [...groups.entries()].map(([module, items]) => ({
    module,
    title: MODULE_TITLES[module] ?? module,
    items,
  }))
}

/** 角色表（内置 + 自定义）的合并视图。 */
export function allRoles(custom: readonly RoleRecord[]): readonly RoleRecord[] {
  return [...BUILTIN_ROLES, ...custom.filter(role => !BUILTIN_ROLES.some(builtin => builtin.id === role.id))]
}

/** 按 id 找角色。 */
export function findRole(custom: readonly RoleRecord[], id: string): RoleRecord | undefined {
  return allRoles(custom).find(role => role.id === id)
}

/** 校验自定义角色的输入。 */
export function validateRoleInput(input: {
  readonly id: string
  readonly name: string
  readonly permissions: readonly string[]
}): string | null {
  if (!/^[a-z][a-z0-9-]{1,30}$/.test(input.id)) {
    return '角色 id 只能是小写字母、数字与连字符（2–31 字符）。'
  }
  if (BUILTIN_ROLES.some(role => role.id === input.id)) {
    return `「${input.id}」是内置角色，不能改它的权限。`
  }
  if (input.name.trim().length === 0) return '角色名不能为空。'
  if (input.permissions.length === 0) return '至少勾选一个权限。'
  return validatePermissions(input.permissions)
}
