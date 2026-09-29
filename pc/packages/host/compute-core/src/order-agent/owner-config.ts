/**
 * 主人配置面（owner config）：CEO 模式（真 LLM 子代理）**唯一**的授权来源。
 *
 * 本模块只做一件事：把主人给这台机器定的"档位 / 模型账户 / 工具白名单 / 预算"变成
 * **可校验、可留痕、默认关**的一份配置。它**不读任务文本**、**不落盘**、**不发请求**、
 * 不知道任何凭据的值。
 *
 * ## 四条边界在这里是类型，不是注释
 *
 * 1. **默认关**（{@link OWNER_AGENT_CONFIG_OFF}）：档位默认 `builtin`、账户 `null`、
 *    工具白名单 `[]`、子代理深度 `0`、成本上限不放松 ⇒ 不给任何东西，除非主人显式点。
 * 2. **凭据只来自主人配置/环境变量**：{@link OwnerModelCredentialRef} **只有**
 *    `kind` + `variable` 两个字段，**没有任何存值的字段** ⇒ "凭据写进配置"在类型上做不到。
 *    {@link validateOwnerAgentConfig} 还会主动拒绝"看着像凭据的值"（长串/`sk-`/`Bearer`/私钥头），
 *    因为主人也可能从别处把值粘进来。
 * 3. **工具面完全由主人白名单决定**：{@link ORDER_AGENT_TOOL_CATALOG} 是一个**闭合**目录，
 *    白名单之外的 id 一律判配置非法（**不静默丢**）。`agent.dispatch` 与 `fs.*`/`net.*`/`process.*`
 *    一样，默认不在白名单里。
 * 4. **有界**：{@link OrderAgentBudget} 的每一格默认值都写在这里，可逐格收紧；
 *    "任一到顶即中止"由 `llm-worker.ts` 执行，本模块只负责把上限说清楚。
 *
 * ## 本工单不提供任何工具实现
 *
 * {@link ORDER_AGENT_TOOL_IMPLEMENTATIONS_SHIPPED_HERE} 是**空的**：白名单只决定"允许"，不决定"能"。
 * 白名单里有、但调用方没有注入实现 ⇒ `EDGE_ORDER_AGENT_TOOL_UNBOUND`（**明确拒绝**，
 * 不假装执行成功）。工具执行器属其他工包/后续工单，本工单不越界。
 */
/**
 * 稳定拒绝码表：本模块（CEO 模式的 seam）对外说的话。
 *
 * 与 V1 的关系：V1 把 CEO 模式留成 `EDGE_ORDER_AGENT_MODE_UNIMPLEMENTED`（**未实现**）。
 * 现在这一层实现了，所以"已启用但缺凭据/缺账户/缺 transport"必须是**更精确的新码**，
 * 而**不是**继续复用"未实现"，更不是静默回落到 `builtin`。
 */
export const ORDER_AGENT_REFUSAL_CODES = Object.freeze({
  /** 主人配置本身不合法（未知字段、越界数值、看着像凭据的值…）。 */
  configInvalid: 'EDGE_ORDER_AGENT_CONFIG_INVALID',
  /** 拿到的档位不是 `ceo`：本工厂**只**服务 CEO 模式，`builtin` 由 V1 既有 worker 承担（不回落）。 */
  modeNotCeo: 'EDGE_ORDER_AGENT_MODE_NOT_CEO',
  /** 档位是 `ceo`，但主人**没有**配模型账户。 */
  modelAccountMissing: 'EDGE_ORDER_AGENT_MODEL_ACCOUNT_MISSING',
  /** 账户配了，但它引用的环境变量**不存在或为空** ⇒ 凭据缺失。 */
  modelCredentialsMissing: 'EDGE_ORDER_AGENT_MODEL_CREDENTIALS_MISSING',
  /** 账户与凭据都在，但调用方**没有**注入模型 transport（本包不含任何网络客户端）。 */
  modelTransportMissing: 'EDGE_ORDER_AGENT_MODEL_TRANSPORT_MISSING',
  /** transport 抛了、或回了一份本模块读不懂的响应。 */
  modelCallFailed: 'EDGE_ORDER_AGENT_MODEL_CALL_FAILED',
  /** 模型这一轮没有给出可交付的文本（空文本 / 被长度截断 / 该轮标记为 error）。 */
  modelIncomplete: 'EDGE_ORDER_AGENT_MODEL_INCOMPLETE',
  /** transport 没报花费，而主人没有允许"花费未报"（默认不允许：未知不算通过）。 */
  modelUsageUnreported: 'EDGE_ORDER_AGENT_MODEL_USAGE_UNREPORTED',
  /** 预算到顶（调用次数 / token / 费用 / 工具次数 / 派子代理次数 / 墙钟）：**中止并如实报告**。 */
  budgetExceeded: 'EDGE_ORDER_AGENT_BUDGET_EXCEEDED',
  /** 请求的工具**不在主人白名单**里（任务文本里怎么写都不算授权）。 */
  toolNotAuthorized: 'EDGE_ORDER_AGENT_TOOL_NOT_AUTHORIZED',
  /** 工具在白名单里，但调用方没有绑定实现（本工单不提供任何工具实现）。 */
  toolUnbound: 'EDGE_ORDER_AGENT_TOOL_UNBOUND',
  /** 绑定的工具实现自己抛了。 */
  toolFailed: 'EDGE_ORDER_AGENT_TOOL_FAILED',
  /** 派子代理被拒（深度上限）——白名单允许也不等于深度无限。 */
  subagentRefused: 'EDGE_ORDER_AGENT_SUBAGENT_REFUSED',
  /** 派单没有可读的任务文本（调用方给错了 payload 形状）。 */
  taskPayloadInvalid: 'EDGE_ORDER_AGENT_TASK_PAYLOAD_INVALID',
  /** 产物写不出（例如目标已存在、目录不可写）。 */
  artifactWriteFailed: 'EDGE_ORDER_AGENT_ARTIFACT_WRITE_FAILED',
} as const)

/**
 * 主人中止的码**不新造**：值与本仓 E3/E9 已经定下的那个一致
 * （源头 `apps/qianshou-node/owner-abort.ts:21` 的 `OWNER_CANCEL_CODE`）。
 * 本包不能 import `apps/**`，所以这里只钉住**同一个值**，并允许调用方覆盖（`cancelCode`）。
 */
export const ORDER_AGENT_OWNER_CANCEL_CODE = 'EDGE_CANCELED_BY_OWNER' as const

/**
 * 能力档位（主人配置）。
 *
 * - `builtin`：内建 worker（无模型、无新增权限）—— **默认值**；
 * - `ceo`：真 LLM 子代理（本工单交付的 seam 服务这一档）。
 */
export type OrderAgentMode = 'builtin' | 'ceo'

/** 主人给这台机器定的档位。`builtin` 是默认值（铁律：默认关）。 */
export type OwnerOrderAgentMode = OrderAgentMode

/**
 * 模型凭据的**引用**：只有"从哪个环境变量读"这一种。
 *
 * 故意没有 `value`/`key`/`secret` 字段 —— 凭据的值**永不**出现在配置里，
 * 因此也不会被写进仓库文件、日志或轨迹。
 */
export interface OwnerModelCredentialRef {
  readonly kind: 'environment'
  /** 环境变量名（大写机器名形状）。本模块只读它，从不回写。 */
  readonly variable: string
}

/** 主人给这台机器配的模型账户：route + 凭据引用 + 单次输出上限。 */
export interface OwnerModelAccount {
  readonly provider: string
  readonly model: string
  readonly credential: OwnerModelCredentialRef
  /** 单次模型调用的输出 token 上限（不含在 {@link OrderAgentBudget} 的总量预算里）。 */
  readonly maxOutputTokens: number
}

/** 一项动作类别。词表与 `capability-pipeline/owner-approval.ts` 的 `CapabilityActionClass` 相同。 */
export type OrderAgentToolActionClass = 'compute' | 'file' | 'network' | 'process'

/** 工具目录里的 id（闭合集合）。 */
export const ORDER_AGENT_TOOL_IDS = Object.freeze([
  'fs.read', 'fs.write', 'net.http', 'process.spawn', 'agent.dispatch',
] as const)

/** 工具 id。 */
export type OrderAgentToolId = (typeof ORDER_AGENT_TOOL_IDS)[number]

/** 一项工具在主人眼里是什么（会不会碰文件/网络/进程、有没有副作用）。 */
export interface OrderAgentToolDeclaration {
  readonly id: OrderAgentToolId
  readonly actionClasses: readonly OrderAgentToolActionClass[]
  /** 有副作用 = 白名单之外**永远**不许发生的那一类动作。 */
  readonly sideEffect: boolean
  readonly detail: string
}

/**
 * 工具目录：**闭合**的一张小表，每一项都要主人显式点。
 *
 * `agent.dispatch` 也算工具：派子代理会**再花主人的钱**，默认不在白名单里。
 */
export const ORDER_AGENT_TOOL_CATALOG: Readonly<Record<OrderAgentToolId, OrderAgentToolDeclaration>> = Object.freeze({
  'fs.read': {
    id: 'fs.read', actionClasses: Object.freeze(['file'] as const), sideEffect: false,
    detail: '读本地文件（读者，不改东西，但仍要把主人的盘暴露给模型 ⇒ 需显式开）',
  },
  'fs.write': {
    id: 'fs.write', actionClasses: Object.freeze(['file'] as const), sideEffect: true,
    detail: '写本地文件（会改变本机状态 ⇒ 需显式开）',
  },
  'net.http': {
    id: 'net.http', actionClasses: Object.freeze(['network'] as const), sideEffect: true,
    detail: '出网（会把任务内容带出去 ⇒ 需显式开）',
  },
  'process.spawn': {
    id: 'process.spawn', actionClasses: Object.freeze(['process'] as const), sideEffect: true,
    detail: '起本地进程（等价于本机任意执行 ⇒ 需显式开）',
  },
  'agent.dispatch': {
    id: 'agent.dispatch', actionClasses: Object.freeze(['compute'] as const), sideEffect: true,
    detail: '派子代理（同一模型账户、同一白名单、同一预算池；受 maxSubagentDepth 二次限制）',
  },
})

/**
 * 本工单**提供的**工具实现：**一个都没有**。
 *
 * 这不是遗漏，是边界：本工单交付"闸门与通道"，工具执行器（读文件/出网/起进程）
 * 属其他工包与后续工单。白名单里点了、但这里没有实现 ⇒ `EDGE_ORDER_AGENT_TOOL_UNBOUND`。
 */
export const ORDER_AGENT_TOOL_IMPLEMENTATIONS_SHIPPED_HERE: readonly OrderAgentToolId[] = Object.freeze([])

/** 主人允许的动作上限：任一到顶即中止（由 `llm-worker.ts` 执行）。 */
export interface OrderAgentBudget {
  /** 整单的模型调用次数上限（**含**子代理的调用）。 */
  readonly maxModelCalls: number
  /** 整单的工具调用次数上限（**含**子代理的调用）。 */
  readonly maxToolCalls: number
  /** 整单派子代理的次数上限。 */
  readonly maxSubagentDispatches: number
  /** 整单输入+输出 token 上限（以 transport 报数为准）。 */
  readonly maxTotalTokens: number
  /** 整单费用上限（微美元，1e-6 USD）。 */
  readonly maxCostMicroUsd: number
  /** 整单墙钟上限（毫秒）。 */
  readonly wallClockMs: number
}

/**
 * 保守默认值（**默认关**的延伸）：一次调用、不花工具、不派子代理、5 分钱、30 秒。
 *
 * 30 秒与编排器默认的单任务墙钟（`RESIDENT_ORCHESTRATION_DEFAULT_LIMITS.taskTimeoutMs`）对齐：
 * 谁先到谁中止，本 seam 自己也会报 `EDGE_ORDER_AGENT_BUDGET_EXCEEDED`。
 */
export const ORDER_AGENT_DEFAULT_BUDGET: OrderAgentBudget = Object.freeze({
  maxModelCalls: 1,
  maxToolCalls: 0,
  maxSubagentDispatches: 0,
  maxTotalTokens: 32_000,
  maxCostMicroUsd: 50_000,
  wallClockMs: 30_000,
})

/** 子代理深度的硬上限：主人可以配 0..3，再深一律判配置非法（防"套娃烧钱"）。 */
export const ORDER_AGENT_MAX_SUBAGENT_DEPTH_CEILING = 3

/** 主人给的 CEO 模式配置（已解析、已冻结的那一份）。 */
export interface OwnerAgentConfig {
  readonly mode: OwnerOrderAgentMode
  readonly account: OwnerModelAccount | null
  readonly authorizedTools: readonly OrderAgentToolId[]
  readonly budget: OrderAgentBudget
  readonly maxSubagentDepth: number
  /** 是否接受 transport 不报花费。默认 `false`：未知不算通过（费用上限就没法执行了）。 */
  readonly allowUnreportedCost: boolean
}

/** 默认配置：`builtin`、无账户、空白名单、零工具、零子代理、默认预算。 */
export const OWNER_AGENT_CONFIG_OFF: OwnerAgentConfig = Object.freeze({
  mode: 'builtin',
  account: null,
  authorizedTools: Object.freeze([]),
  budget: ORDER_AGENT_DEFAULT_BUDGET,
  maxSubagentDepth: 0,
  allowUnreportedCost: false,
})

/** 配置校验的结论。非法时**给出字段与原因**，绝不取默认值把它咽下去。 */
export type OwnerAgentConfigValidation =
  | { readonly ok: true; readonly config: OwnerAgentConfig; readonly notes: readonly string[] }
  | { readonly ok: false; readonly code: string; readonly field: string; readonly detail: string }

/** 配置里允许出现的键（多一个都不行：未知字段会被静默忽略，那正是"静默即缺陷"）。 */
const CONFIG_KEYS = ['mode', 'account', 'authorizedTools', 'budget', 'maxSubagentDepth', 'allowUnreportedCost'] as const
const ACCOUNT_KEYS = ['provider', 'model', 'credential', 'maxOutputTokens'] as const
const CREDENTIAL_KEYS = ['kind', 'variable'] as const
const BUDGET_KEYS = ['maxModelCalls', 'maxToolCalls', 'maxSubagentDispatches', 'maxTotalTokens', 'maxCostMicroUsd', 'wallClockMs'] as const

/** 环境变量名的形状（只接受机器名，避免把值当名字）。 */
const ENV_VARIABLE = /^[A-Z][A-Z0-9_]{0,63}$/
/** 看着像凭据的值：`sk-…`、`Bearer …`、私钥头… */
const CREDENTIAL_LIKE = /(?:^|[\s"'=:])(?:sk|pk|rk|ghp|gho|xox[abps])-[\w-]{8,}|Bearer\s+[\w.\-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/
/** 配置面字符串的长度上界：主人可能从别处粘一大段东西进来，凭据就是这么进仓库的。 */
const CONFIG_STRING_CEILING = 200

/** 值是不是普通对象（不是数组/null）。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 找一个合法整数；非法返回 null。 */
function integerOrNull(value: unknown, minimum: number, maximum: number): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum ? value : null
}

/** 非法配置的构造器（收敛成一个形状，调用方好处理）。 */
function invalid(field: string, detail: string): OwnerAgentConfigValidation {
  return { ok: false, code: ORDER_AGENT_REFUSAL_CODES.configInvalid, field, detail }
}

/** 校验失败时的形状判别（比 `'ok' in x` 更紧：成功分支没有 `ok` 之外的判别字段）。 */
function isInvalid(value: OwnerModelAccount | OrderAgentBudget | OwnerAgentConfigValidation): value is OwnerAgentConfigValidation {
  return (value as { ok?: unknown }).ok === false
}

/**
 * 配置面里不许出现"看着像凭据的值"。
 *
 * 动机（实测的坑，同一类错误在本仓已经发生过）：主人/脚本很容易把
 * `credential: { kind: 'environment', variable: 'X', value: 'sk-…' }` 这样粘进配置文件，
 * 于是凭据进了仓库。这里**主动拒绝**，而不是把多出来的字段忽略掉。
 * @param node - 要检查的配置子树。
 * @param path - 出问题时报的字段路径。
 * @returns 非法时返回结论；合法返回 null。
 */
function scanForCredentialLikeValues(node: unknown, path: string): OwnerAgentConfigValidation | null {
  if (typeof node === 'string') {
    if (node.length > CONFIG_STRING_CEILING) {
      return invalid(path, `配置面不许携带长字符串（${node.length} 字符 > ${CONFIG_STRING_CEILING}）：凭据必须写成环境变量**名**，不许把值写进配置`)
    }
    if (CREDENTIAL_LIKE.test(node)) {
      return invalid(path, '这个取值看着像一份凭据字面量（sk-/Bearer/私钥头）：配置面只接受凭据的**引用**（环境变量名），不许携带凭据的值')
    }
    return null
  }
  if (Array.isArray(node)) {
    for (const [index, item] of node.entries()) {
      const problem = scanForCredentialLikeValues(item, `${path}[${index}]`)
      if (problem !== null) return problem
    }
    return null
  }
  if (isRecord(node)) {
    for (const [key, value] of Object.entries(node)) {
      const problem = scanForCredentialLikeValues(value, path.length === 0 ? key : `${path}.${key}`)
      if (problem !== null) return problem
    }
    return null
  }
  return null
}

/** 校验账户：provider/model 非空、credential 是环境变量引用、maxOutputTokens 是正整数。 */
function validateAccount(raw: unknown): OwnerModelAccount | OwnerAgentConfigValidation {
  if (!isRecord(raw)) return invalid('account', 'account 必须是对象或 null')
  const unknownKeys = Object.keys(raw).filter(key => !(ACCOUNT_KEYS as readonly string[]).includes(key))
  if (unknownKeys.length > 0) return invalid('account', `account 出现未知字段：${unknownKeys.join(', ')}（未知字段会被静默忽略，所以这里判非法）`)
  if (typeof raw.provider !== 'string' || raw.provider.trim().length === 0) return invalid('account.provider', 'provider 必须是非空字符串')
  if (typeof raw.model !== 'string' || raw.model.trim().length === 0) return invalid('account.model', 'model 必须是非空字符串')
  const credential = raw.credential
  if (!isRecord(credential)) return invalid('account.credential', 'credential 必须是 { kind: "environment", variable } 形状')
  const credentialUnknown = Object.keys(credential).filter(key => !(CREDENTIAL_KEYS as readonly string[]).includes(key))
  if (credentialUnknown.length > 0) {
    return invalid('account.credential',
      `credential 出现未知字段：${credentialUnknown.join(', ')} —— 凭据的**值**不许出现在配置里，只许写它所在的环境变量名`)
  }
  if (credential.kind !== 'environment') return invalid('account.credential.kind', 'kind 只能是 "environment"')
  if (typeof credential.variable !== 'string' || !ENV_VARIABLE.test(credential.variable)) {
    return invalid('account.credential.variable', 'variable 必须是环境变量名形状（大写机器名，例如 QIANSHOU_MODEL_API_KEY）')
  }
  const maxOutputTokens = integerOrNull(raw.maxOutputTokens, 1, 1_000_000)
  if (maxOutputTokens === null) return invalid('account.maxOutputTokens', 'maxOutputTokens 必须是 1..1000000 的安全整数')
  return Object.freeze({
    provider: raw.provider,
    model: raw.model,
    credential: Object.freeze({ kind: 'environment' as const, variable: credential.variable }),
    maxOutputTokens,
  })
}

/** 校验预算：每一格都必须在范围内；缺省格用 {@link ORDER_AGENT_DEFAULT_BUDGET}。 */
function validateBudget(raw: unknown): OrderAgentBudget | OwnerAgentConfigValidation {
  if (raw === undefined) return ORDER_AGENT_DEFAULT_BUDGET
  if (!isRecord(raw)) return invalid('budget', 'budget 必须是对象')
  const unknownKeys = Object.keys(raw).filter(key => !(BUDGET_KEYS as readonly string[]).includes(key))
  if (unknownKeys.length > 0) return invalid('budget', `budget 出现未知上限：${unknownKeys.join(', ')}`)
  const resolved: Record<string, number> = { ...ORDER_AGENT_DEFAULT_BUDGET }
  const ranges: Readonly<Record<(typeof BUDGET_KEYS)[number], readonly [number, number]>> = {
    maxModelCalls: [0, 64], maxToolCalls: [0, 256], maxSubagentDispatches: [0, 64],
    maxTotalTokens: [0, 10_000_000], maxCostMicroUsd: [0, 1_000_000_000], wallClockMs: [1, 3_600_000],
  }
  for (const key of BUDGET_KEYS) {
    const value = raw[key]
    if (value === undefined) continue
    const range = ranges[key]
    const parsed = integerOrNull(value, range[0], range[1])
    if (parsed === null) return invalid(`budget.${key}`, `budget.${key} 必须是 ${range[0]}..${range[1]} 的安全整数`)
    resolved[key] = parsed
  }
  return Object.freeze(resolved as unknown as OrderAgentBudget)
}

/**
 * 校验主人配置。**默认关**：`mode` 缺省即 `builtin`。
 *
 * 拒绝的三种东西（都是"静默即缺陷"的形状）：
 * 未知字段（会被静默忽略）、越界的数值（会被静默取默认）、看着像凭据的值（会进仓库）。
 * @param raw - 主人配置原文（未信任形状）。
 * @returns 合法时给出冻结的配置与若干条提示（`notes`）；非法时给出字段与原因。
 */
export function validateOwnerAgentConfig(raw: unknown): OwnerAgentConfigValidation {
  if (raw === undefined || raw === null) {
    return { ok: true, config: OWNER_AGENT_CONFIG_OFF, notes: ['没有给配置 ⇒ 按默认（builtin / 无账户 / 空白名单）处理'] }
  }
  if (!isRecord(raw)) return invalid('<root>', '配置必须是对象')
  const unknownKeys = Object.keys(raw).filter(key => !(CONFIG_KEYS as readonly string[]).includes(key))
  if (unknownKeys.length > 0) return invalid('<root>', `配置出现未知字段：${unknownKeys.join(', ')}（未知字段会被静默忽略，所以这里判非法）`)
  const credentialLike = scanForCredentialLikeValues(raw, '')
  if (credentialLike !== null) return credentialLike

  const mode = raw.mode ?? 'builtin'
  if (mode !== 'builtin' && mode !== 'ceo') {
    return invalid('mode', `mode 只能是 "builtin" 或 "ceo"（拿到 ${JSON.stringify(raw.mode)}）：不猜、也不取默认值`)
  }

  const account = raw.account === undefined || raw.account === null ? null : validateAccount(raw.account)
  if (account !== null && isInvalid(account)) return account

  const budget = validateBudget(raw.budget)
  if (isInvalid(budget)) return budget

  const tools = raw.authorizedTools ?? []
  if (!Array.isArray(tools)) return invalid('authorizedTools', 'authorizedTools 必须是数组')
  const authorized: OrderAgentToolId[] = []
  for (const [index, entry] of tools.entries()) {
    if (typeof entry !== 'string' || !(ORDER_AGENT_TOOL_IDS as readonly string[]).includes(entry)) {
      return invalid(`authorizedTools[${index}]`,
        `未知工具 ${JSON.stringify(entry)}：不在工具目录里（${ORDER_AGENT_TOOL_IDS.join(', ')}）⇒ 判非法，不静默丢`)
    }
    if (authorized.includes(entry as OrderAgentToolId)) return invalid(`authorizedTools[${index}]`, `工具 ${entry} 重复出现`)
    authorized.push(entry as OrderAgentToolId)
  }

  const depth = raw.maxSubagentDepth === undefined ? 0 : integerOrNull(raw.maxSubagentDepth, 0, ORDER_AGENT_MAX_SUBAGENT_DEPTH_CEILING)
  if (depth === null) return invalid('maxSubagentDepth', `maxSubagentDepth 必须是 0..${ORDER_AGENT_MAX_SUBAGENT_DEPTH_CEILING} 的安全整数`)

  const allowUnreportedCost = raw.allowUnreportedCost === undefined ? false : raw.allowUnreportedCost
  if (typeof allowUnreportedCost !== 'boolean') return invalid('allowUnreportedCost', 'allowUnreportedCost 必须是布尔值')

  const notes: string[] = []
  const dispatchesAllowed = authorized.includes('agent.dispatch')
  if (dispatchesAllowed && depth < 1) {
    return invalid('maxSubagentDepth',
      '白名单里有 agent.dispatch 但 maxSubagentDepth=0：既然允许派子代理，就必须显式给出深度上限（不猜主人的意思）')
  }
  if (!dispatchesAllowed && depth > 0) notes.push(`maxSubagentDepth=${depth} 但白名单里没有 agent.dispatch ⇒ 派子代理仍然会被拒（上限是第二道闸，不是第一道）`)
  if (mode === 'builtin' && (account !== null || authorized.length > 0)) {
    notes.push('mode=builtin：账户与工具白名单**不生效**（CEO 模式的 seam 在 builtin 档位下不会被调用）')
  }
  if (authorized.length > 0 && (budget as OrderAgentBudget).maxToolCalls === 0) {
    notes.push('白名单非空但 budget.maxToolCalls=0 ⇒ 任何工具调用都会被预算闸拦下（要真的用工具就得显式抬这个上限）')
  }
  if (mode === 'ceo' && account === null) {
    notes.push('mode=ceo 但没有 account ⇒ 这一档**会明确失败**（EDGE_ORDER_AGENT_MODEL_ACCOUNT_MISSING），不会回落到 builtin')
  }

  return {
    ok: true,
    config: Object.freeze({
      mode,
      account,
      authorizedTools: Object.freeze(authorized),
      budget: budget as OrderAgentBudget,
      maxSubagentDepth: depth,
      allowUnreportedCost,
    }),
    notes: Object.freeze(notes),
  }
}

/**
 * 白名单里这一项涉及哪些敏感动作类别（文件/网络/进程）。
 * @param tool - 工具 id。
 * @returns 类别列表；目录里没有的 id 返回空数组（不编造类别去拦人）。
 */
export function toolActionClasses(tool: string): readonly OrderAgentToolActionClass[] {
  if (!(ORDER_AGENT_TOOL_IDS as readonly string[]).includes(tool)) return Object.freeze([])
  return ORDER_AGENT_TOOL_CATALOG[tool as OrderAgentToolId].actionClasses
}
