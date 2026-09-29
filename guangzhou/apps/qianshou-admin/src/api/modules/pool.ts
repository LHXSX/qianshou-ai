/**
 * §8.8 上游号池：列表（`pool/list`）、加号（`pool/preflight` → `pool/apply`）、
 * 移除（`pool/preflight` op=remove → `pool/remove`）。
 *
 * ## 这个模块的三条纪律
 *
 * 1. **凭据明文只在这里出现一次，而且只往服务端送。** 由调用方通过闭包交给
 *    `applyPoolAdd`，不进 localStorage、不进 URL、不进日志、不进错误上报。
 *    类型里也没有任何"读回明文"的字段 —— 服务端根本不回，所以"忘记脱敏"在类型层面写不出来。
 * 2. **不做任何权限判断。** 谁能看、谁能改全部由服务端决定；视图只按 `session/me`
 *    下发的身份隐藏写入口（服务端仍会 403），不在 API 层做安全判断。
 * 3. **服务端没给的字段一律不编。** 例如 `fingerprint: null` 有**两种完全不同的含义**
 *    （已配置但服务端没给 vs. 会话形态还没落盘值），由 `fingerprintSubject` / `valueKnown`
 *    区分；本模块把它们收口成 `fingerprintCell()` 一个函数，视图不自己猜。
 *
 * ## 契约与实现的差异（以 `server.ts` 为准，已在交付说明里登记）
 *
 * - `apply` 的 `result` **没有** `existingRef` 字段：`duplicate` 时服务端回
 *   `result.duplicateBasis` 与 `result.existingRef`（`server.ts` 判重分支），
 *   但 API.md §8.8 只写了 `existingRef`/`duplicateBasis` 在 `apply` 里"给出"。
 *   这里按实现声明为可选字段，缺失时不显示，不补占位。
 * - 探测结论的形状取自 `pool.ts` 的 `PoolProbe`（成功 `{ok:true,latencyMs,endpoint,status}`、
 *   失败 `{ok:false,kind,message,status}`），**不是** §8.7 的 `UpstreamProbeOutcome`
 *   （后者用 `model`），所以本模块单独定义 `PoolProbeOutcome`，不复用。
 */
import { apply, preflight } from '../confirm'
import { postJson } from '../client'
import { ENDPOINTS } from '../endpoints'
import type { ConfirmPreview } from '../types'

// —— 服务端返回的形状 ——————————————————————————————————————————

/**
 * 号池里一个号的状态 —— **只有这两种**（服务端 `PoolKeyView.status`）：
 * `active` = 凭据文件里有值；`missing` = 只剩元数据（有人手工删过那一行）。
 * 服务端将来新增取值时，界面会走"未识别状态"分支，不假装是 `active`。
 */
export const POOL_KEY_STATUS = { active: 'active', missing: 'missing' } as const

/**
 * 输入凭据的形态（服务端 `cursor-credential.ts` 的 `CursorCredentialShape`）。
 *
 * 这里刻意**保留 `string` 作为字段类型**、只用常量做比较：契约是冻结的，
 * 但服务端仍然是唯一的判定者 —— 前端遇到没见过的取值要如实说"未识别"，
 * 而不是靠一份本地枚举把它当 `unknown` 处理（那会把"没认出来"和"服务端说认不出来"混为一谈）。
 */
export const POOL_CREDENTIAL_SHAPE = {
  apiKey: 'api-key',
  session: 'session',
  sessionWrapped: 'session-wrapped',
  unknown: 'unknown',
} as const

/** `pool/list` 里的一个号。**任何字段都不含明文凭据。** */
export interface PoolKeyRow {
  readonly ref: string
  readonly label: string
  /** `active` / `missing`；其它取值按"未识别状态"渲染。 */
  readonly status: string
  /** 落盘值的指纹（sha256 前 8 位）；未知时为 `null`。 */
  readonly fingerprint: string | null
  readonly lastVerifiedAt: number | null
  readonly authId: string | null
  readonly email: string | null
  readonly addedAt: number | null
  readonly addedBy: string | null
  readonly previousFingerprint: string | null
  /** 输入形态（`api-key` / `session` / `session-wrapped` / `unknown`）。 */
  readonly shape: string | null
}

/** `pool/list` 的生效机制说明（**明确说明消费方还没接**）。 */
export interface PoolActivation {
  readonly fileWatcher: string
  readonly consumer: string
  readonly restartRequired: boolean
  readonly restartService: string | null
  readonly restartCommand: string | null
  readonly note: string
}

/** `pool/list` 的 `fileError`：凭据文件读不懂时的降级说明。 */
export interface PoolFileProblem {
  readonly code: string
  readonly message: string
}

/**
 * `pool/list` 的**原始**响应字段。
 *
 * `keys` / `fileError` 刻意声明成可选：`postJson` 的泛型只是**断言**，不是校验，
 * 所以"字段真的在不在"要由 `fetchPool` 逐项确认 —— 声明成必填再写 `?? []`
 * 等于用一个永远不会为真的分支来假装检查（类型系统看不出区别，读者却会以为检查过了）。
 */
interface PoolListResponse {
  readonly keys?: readonly PoolKeyRow[]
  readonly fileError?: PoolFileProblem | null
  readonly activation: PoolActivation
  readonly metadataPath: string
}

/** `pool/list` 收口后的业务字段（`ok` 由 `postJson` 的信封吃掉）。 */
export interface PoolListResult {
  readonly keys: readonly PoolKeyRow[]
  readonly fileError: PoolFileProblem | null
  readonly activation: PoolActivation
  readonly metadataPath: string
}

/** 探测结论（`pool.ts` 的 `PoolProbe`，**不是** §8.7 的 `UpstreamProbeOutcome`）。 */
export type PoolProbeOutcome =
  | {
    readonly ok: true
    readonly latencyMs: number
    /** 打的是哪个（哪几个）接口 —— API key 形态是两步，必须说出来。 */
    readonly endpoint: string
    readonly status: number
  }
  | {
    readonly ok: false
    readonly kind: string
    readonly message: string
    readonly status: number | null
  }

/** 这次操作对号池的影响。 */
export const POOL_ACTION = {
  add: 'add',
  duplicate: 'duplicate',
  replace: 'replace',
  remove: 'remove',
} as const

/** 判重命中的是哪一条判据（服务端 `duplicateBasis`）。 */
export const POOL_DUPLICATE_BASIS = { value: 'value', ref: 'ref', authId: 'auth_id' } as const

/** 预览差异（`pool/preflight` 的 `confirm.diff`）。 */
export interface PoolDiff {
  readonly ref: string
  readonly action: string
  readonly identity?: { readonly authId: string; readonly email: string | null } | null
  /**
   * 只从**将要落盘的那把值**算；会话形态在预览阶段还没有落盘值 → `null`。
   */
  readonly fingerprint?: string | null
  /** `"stored-value"` = 指纹就是落盘值的；`null` = 预览阶段还没有落盘值。 */
  readonly fingerprintSubject?: 'stored-value' | null
  /** 落盘值是否已经确定（会话形态在预览阶段为 `false`）。 */
  readonly valueKnown?: boolean
  readonly shape?: string | null
  readonly existingRef?: string | null
  readonly duplicateBasis?: string | null
  readonly previousFingerprint?: string | null
  readonly probe?: PoolProbeOutcome | null
  readonly note?: string
  // op=remove 分支
  readonly before?: {
    readonly ref: string
    readonly label: string
    readonly fingerprint: string | null
    readonly authId: string | null
    readonly email: string | null
  } | null
  readonly after?: null
}

/** 预览结果：令牌 + 差异（号池的 `diff` 不是通用 `before → after` 形状，见上）。 */
export type PoolPreview = ConfirmPreview & { readonly diff: PoolDiff }

/** 写接口（`…/apply`、`pool/remove`）的成功信封：审计 id + 业务结果。 */
export interface PoolApplyResult {
  readonly auditId: string
  readonly result: PoolWriteOutcome
}

/** `pool/apply` / `pool/remove` 的 `result`。 */
export interface PoolWriteOutcome {
  readonly ref: string
  /** 新增/替换后落盘值的指纹；移除后为 `null`（没有"新指纹"）。 */
  readonly fingerprint: string | null
  readonly previousFingerprint?: string | null
  readonly action: string
  /** `duplicate` 时必有（服务端判重分支）。 */
  readonly duplicateBasis?: string | null
  readonly existingRef?: string | null
  readonly backupPath: string | null
  readonly updatedAt: number | null
  readonly updatedBy: string
  /**
   * 凭据到底有没有被写进池子。
   *
   * `false` 有两种成因，界面必须分开说：`duplicate`（本来就在池子里，没写盘）
   * 与探测失败（`pool.ts` 的拒绝分支，响应里带 `written: false`）。
   */
  readonly written: boolean
}

// —— 调用 ————————————————————————————————————————————————————

/** `POST pool/list`：号池现状、凭据文件问题、生效机制、元数据文件路径。 */
export async function fetchPool(): Promise<PoolListResult> {
  const response = await postJson<{ ok: true } & PoolListResponse>(ENDPOINTS.poolList, {})
  return {
    // 服务端没给或给的不是数组时是空列表（页面会渲染空态），不是编造的条目。
    keys: Array.isArray(response.keys) ? response.keys : [],
    fileError: response.fileError ?? null,
    activation: response.activation,
    metadataPath: response.metadataPath,
  }
}

/**
 * 第一步（加号）：服务端做**真实探测**并给出差异，同时发一次性令牌。
 *
 * 载荷里的 `op: 'add'` 必须与第二步**逐字节一致**（服务端用它重算载荷哈希），
 * 所以这里把它固化成同一个函数返回的闭包，调用方拿不到"改过的载荷"。
 * @param credential - 粘贴进来的 Cursor 凭据（`crsr_…` / `userId::eyJ…` / 裸 JWT）。
 * @param label - 给人看的标签；空串表示不起名。
 * @returns 令牌与差异（差异里**没有明文**）。
 */
export async function preflightPoolAdd(credential: string, label: string): Promise<PoolPreview> {
  const preview = await preflight(ENDPOINTS.poolPreflight, { op: 'add', credential, label })
  return preview as PoolPreview
}

/**
 * 第二步（加号）：带令牌、原因与**同一份载荷**执行。
 *
 * `apply` 只拿得到 `(token, reason)` —— 凭据由闭包捕获，不从组件状态里取第二遍，
 * 免得"预览看到的"与"提交的"变成两份值。
 * @param credential - 与预览时完全一致的凭据。
 * @param label - 与预览时完全一致的标签。
 * @returns 执行函数（由通用两步确认弹窗调用）。
 */
export function applyPoolAdd(
  credential: string,
  label: string,
): (token: string, reason: string) => Promise<PoolApplyResult> {
  return async (token, reason) =>
    await apply(ENDPOINTS.poolApply, token, reason, { credential, label }) as PoolApplyResult
}

/**
 * 第一步（移除）：服务端的移除预览分支（`op: 'remove'`）。
 *
 * 号池**没有**单独的移除预览端点：令牌必须绑住确切的载荷，而四个端点里只有
 * `preflight` 发令牌，所以移除的预览也走这里。
 * @param ref - 号池 ref（`CURSOR_CK_xxxxxxxx`）。
 * @returns 令牌与差异（`before` 是那个号的公开信息，`probe` 恒为 `null`）。
 */
export async function preflightPoolRemove(ref: string): Promise<PoolPreview> {
  const preview = await preflight(ENDPOINTS.poolPreflight, { op: 'remove', ref })
  return preview as PoolPreview
}

/**
 * 第二步（移除）：带令牌与原因真的把 `refs:` 段里那一行删掉。
 * @param ref - 与预览时完全一致的 ref。
 * @returns 执行函数（由移除确认弹窗调用）。
 */
export function applyPoolRemove(
  ref: string,
): (token: string, reason: string) => Promise<PoolApplyResult> {
  return async (token, reason) =>
    await apply(ENDPOINTS.poolRemove, token, reason, { ref }) as PoolApplyResult
}

// —— 展示用的纯函数（**视图不自己猜**）——————————————————————————————

/** 指纹单元格的三种语义：有指纹 / 没有（且**不是** 0 或空白）/ 值未知。 */
export interface FingerprintCell {
  /** 主文案；永远不会是空串、`0` 或 `null`。 */
  readonly text: string
  /** 说明为什么（例如"指纹要落盘后才产生"）；没有额外说明时为 `''`。 */
  readonly hint: string
  /** 是不是"暂时没有指纹"（而不是"有一个指纹"）。 */
  readonly unknown: boolean
}

/**
 * 把"指纹有没有、为什么没有"收口成一句人话。
 *
 * `fingerprint: null` 单独出现时**不足以**判断原因，所以要连 `fingerprintSubject`
 * 与 `valueKnown` 一起看：
 * - `fingerprintSubject === 'stored-value'` → 指纹就是这个号的落盘值（可信）；
 * - `fingerprintSubject === null` 或 `valueKnown === false` → 会话形态，预览阶段
 *   **还没有落盘值**，于是也没有落盘指纹：要说"落盘后才产生"，不能显示空白或 0，
 *   更不能拿"贴进来那一串的指纹"顶替（那个值不是将要落盘的值）。
 * - 两个字段**都没有**（老响应/字段缺失）→ 如实说"服务端没给"，不猜是哪种。
 * @param input - 差异或列表行里与指纹有关的那几个字段。
 * @returns 展示文案 + 说明 + 是否"未知"。
 */
export function fingerprintCell(input: {
  readonly fingerprint?: unknown
  readonly fingerprintSubject?: unknown
  readonly valueKnown?: unknown
}): FingerprintCell {
  const fingerprint = typeof input.fingerprint === 'string' && input.fingerprint !== ''
    ? input.fingerprint
    : null
  if (fingerprint !== null) {
    return { text: fingerprint, hint: '', unknown: false }
  }
  if (input.fingerprintSubject === 'stored-value') {
    // 显式说了"指纹主体就是落盘值"，但值本身缺失 —— 如实说没给，不编一个。
    return { text: '（服务端未返回指纹）', hint: '', unknown: true }
  }
  if (input.fingerprintSubject === null || input.valueKnown === false) {
    return {
      text: '（要落盘后才产生）',
      hint: '这是会话凭据：写入时会先归一化成一把新的长期 key（`crsr_…`）再落盘，所以预览阶段没有落盘指纹。能确定的是这个号的身份与 ref。',
      unknown: true,
    }
  }
  // 字段整体缺失（例如列表里元数据还没记过）：不猜，说明"没给"。
  return { text: '（服务端未返回指纹）', hint: '', unknown: true }
}

/** 动作的中文说法。`duplicate` 是最容易被误解成"加了两个号"的那一种。 */
export function actionLabel(action: string | undefined): string {
  if (action === 'add') return '新增（号池里还没有这个号）'
  if (action === 'replace') return '替换（同一个账号换了一枚新凭据）'
  if (action === 'duplicate') return '已在池中（不会重复添加）'
  if (action === 'remove') return '移除（真的删掉凭据文件里那一行）'
  return `未识别的动作（${action ?? '服务端未返回'}）`
}

/**
 * 判据的中文说法。
 *
 * 三种判据的证据强度不一样，抹平成一句"重复了"等于把证据的强度也抹平了 ——
 * 服务端的 `duplicateBasisLabel` 就是这么写的，这里保持一致（前端不重复实现规则，
 * 只做展示映射）。
 * @param basis - 判据。
 * @returns 可直接展示的中文说法；未提供时说明"服务端未返回判据"。
 */
export function duplicateBasisLabel(basis: string | null | undefined): string {
  if (basis === 'value') return '值相同（同一把 key 必然是同一个号）'
  if (basis === 'ref') return 'ref 名相同（同一个 Cursor 账号）'
  if (basis === 'auth_id') return 'authId 相同（元数据里的身份相同）'
  return '服务端未返回判据'
}

/** 输入形态的中文说法（用来回答"贴进来的这串被认成了什么"）。 */
export function shapeLabel(shape: string | null | undefined): string {
  if (shape === 'api-key') return 'API key（`crsr_…`，长期有效）'
  if (shape === 'session') return '会话 JWT（裸）'
  if (shape === 'session-wrapped') return '包装过的会话凭据（`userId::JWT` 或 `userId%3A%3AJWT`）'
  if (shape === 'unknown') return '无法识别的形状（服务端会拒绝）'
  return '服务端未返回形态'
}

/** `shape` 是不是"服务端没给"（而不是一个认不出来的值）。 */
export function shapeMissing(shape: string | null | undefined): boolean {
  return shape === null || shape === undefined || shape === ''
}

/**
 * 探测结论的中文说法。
 *
 * 四类失败给出的下一步**不一样**（密钥被拒 ≠ 限流 ≠ 链路问题 ≠ 没配探测目标），
 * 所以这里逐类分开；认不出来时如实说"未识别"，不一律说"失败"。
 * @param probe - 探测结论。
 * @returns 标题 + 说明 + 是不是通过。
 */
export function probeText(probe: PoolProbeOutcome | null | undefined): {
  readonly ok: boolean
  readonly title: string
  readonly detail: string
} | undefined {
  if (probe === null || probe === undefined) return undefined
  if (probe.ok) {
    return {
      ok: true,
      title: `探测通过（HTTP ${probe.status}，${probe.latencyMs} 毫秒）`,
      detail: `打的是 ${probe.endpoint}。预览通过不等于写入一定成功 —— 执行前服务端会拿**将要落盘的那把值**再测一次。`,
    }
  }
  const detail = probe.message
  if (probe.kind === 'credential_rejected') {
    return { ok: false, title: '凭据被上游拒绝（确定性失败）', detail: `${detail}（HTTP ${probe.status ?? '—'}）` }
  }
  if (probe.kind === 'upstream_unavailable') {
    return {
      ok: false,
      title: '上游不可达或限流（**不能证明凭据无效**）',
      detail: `${detail}（HTTP ${probe.status ?? '—'}）。稍后重试，或换一枚凭据再试。`,
    }
  }
  if (probe.kind === 'probe_not_configured') {
    return { ok: false, title: '没有探测目标（管理台不猜该打哪个地址）', detail }
  }
  return { ok: false, title: `未识别的探测结论（${probe.kind}）`, detail }
}

/**
 * 列表行的状态文案。
 *
 * `missing` 必须显式渲染成"凭据已经不在文件里了"：有人手工删过那一行时，
 * 界面显示"还在"就是在骗人。
 * @param status - 服务端给的 `status`。
 * @returns 标签文案 + 标签类型 + 是否异常。
 */
export function statusMeta(status: string): {
  readonly text: string
  readonly tagType: 'success' | 'danger' | 'info'
  readonly description: string
} {
  if (status === 'active') {
    return { text: '在池中', tagType: 'success', description: '凭据文件里有这一行的值。' }
  }
  if (status === 'missing') {
    return {
      text: '凭据已丢失',
      tagType: 'danger',
      description: '只剩元数据：凭据文件里那一行已经被删掉了（有人手工删过）。这个号当前用不了。',
    }
  }
  return {
    text: `未识别状态（${status}）`,
    tagType: 'info',
    description: '前端未识别这个状态，请核对契约；不按"在池中"渲染。',
  }
}

/** 写操作的结果文案：把「号进没进池」与「账有没有记上」分开说。 */
export function writeOutcomeText(result: PoolWriteOutcome): {
  readonly level: 'success' | 'warning' | 'info'
  readonly title: string
  readonly detail: string
} {
  if (result.action === 'duplicate') {
    return {
      level: 'info',
      title: '这个号已经在号池里了，没有重复添加',
      detail: `判据：${duplicateBasisLabel(result.duplicateBasis)}`
        + (result.existingRef ? `；命中的是 ${result.existingRef}` : '')
        + '。没有写盘、没有备份，审计里留了一条记录 —— 你不需要再贴一次。',
    }
  }
  if (result.action === 'remove') {
    if (!result.written) {
      return { level: 'info', title: '没有删除任何东西', detail: '凭据文件逐字节未变，也没有留下备份。' }
    }
    return {
      level: 'success',
      title: `已从号池移除 ${result.ref}`,
      detail: `凭据文件里那一行已经删掉（改前指纹 ${result.previousFingerprint ?? '未知'}）。回滚点：${result.backupPath ?? '未留下备份'}`,
    }
  }
  if (!result.written) {
    return { level: 'warning', title: '没有写入号池', detail: '凭据文件逐字节未变，也没有留下备份。' }
  }
  return {
    level: 'success',
    title: `号已进池：${result.ref}`,
    detail: `指纹 ${result.fingerprint ?? '未返回'}`
      + (result.previousFingerprint ? `（原 ${result.previousFingerprint}）` : '')
      + `；回滚点：${result.backupPath ?? '未留下备份'}`,
  }
}
