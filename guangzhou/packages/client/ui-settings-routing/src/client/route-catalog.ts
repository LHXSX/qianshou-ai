/**
 * 模型路由控制台的纯逻辑核心：响应校验、绑定表单校验、顺序调整与历史投影。
 *
 * 这里没有 React、没有 fetch、没有任何浏览器 API，只有函数进出的数据，
 * 所以每一条规则都能被单测直接钉住——尤其是「不许在计费周期中间换绑」这条：
 * 它必须在**发请求之前**就挡住（见 {@link validateBindRequest}），
 * 否则界面就得靠服务端报错来解释，用户已经点过一次「追加」了。
 *
 * 展示纪律（第二道闸门）：接口的 `backends[].id` 是上游真实模型标识，
 * 只允许活着留在这个模块的 {@link RouteBackend} 里供程序使用；
 * 界面上只渲染 `key`（后端键位）与 `concurrency`。见 `tests/page.client.spec.tsx`
 * 里对 DOM 的断言。
 */

/** 读目录与控制台状态。 */
export const ADMIN_NAMES_PATH = '/api/qianshou/ai/admin/names'
/** 追加一条绑定。 */
export const ADMIN_BIND_PATH = '/api/qianshou/ai/admin/bind'
/** 响应结构不认识时抛这个：界面据此显示「数据不完整」，而不是把它当有效目录。 */
export const INVALID_ROUTE_RESPONSE = 'INVALID_ROUTE_RESPONSE'

/** 档位标识（与宿主 `tiers.ts` 的 TierId 同集合）。 */
export type TierId = 'basic' | 'plus' | 'max'
/** 生命周期阶段。 */
export type LifecycleStage = 'preview' | 'ga' | 'legacy' | 'deprecated' | 'retired'
/** 上游换默认版本时跟不跟。 */
export type UpgradeRule = 'follow-default' | 'on-expiry' | 'never'

/** 一个前台名字的记录。 */
export interface PublishedNameRecord {
  /** 用户看到的名字，也是绑定与账单的口径。 */
  readonly publishedName: string
  /** 界面显示名。 */
  readonly label: string
  /** 哪些档位能用它。 */
  readonly tiers: readonly TierId[]
  readonly maxOutputTokens: number
  readonly order: number
  readonly upgradeRule: UpgradeRule
  readonly lifecycleStage: LifecycleStage
  /** 停止路由的时刻；`null` 表示没有计划。 */
  readonly shutdownDate: number | null
  /** 退役后建议迁到哪个名字。 */
  readonly migrationTarget: string | null
  /** 全量历史（含已失效），按生效时刻升序。 */
  readonly history: readonly BackendBinding[]
}

/** 一条绑定：某个名字在某段生效区间里由哪些后端按顺序作答。 */
export interface BackendBinding {
  readonly publishedName: string
  readonly effectiveFrom: number
  /** `null` 表示至今有效（或被下一条封顶前的形态）。 */
  readonly effectiveTo: number | null
  /** 有序后端键位：主用在前，备用在后。 */
  readonly backendKeys: readonly string[]
  readonly reason: string
  readonly operator: string
  readonly rolloutPercent: number
}

/**
 * 一个可选后端。
 *
 * `upstreamId` 是上游真实模型标识，**只给程序用，不上屏**：
 * 管理员要的是键位与容量，用户要的只是前台名字。
 */
export interface RouteBackend {
  /** 内部键位，绑定表单里选的就是它。 */
  readonly key: string
  /** 上游真实模型标识（运维字段；界面不得作为用户可见文案渲染）。 */
  readonly upstreamId: string
  /** 并发上限。 */
  readonly concurrency: number
}

/** 一次目录读取的完整结果。 */
export interface RouteCatalog {
  readonly names: readonly PublishedNameRecord[]
  readonly backends: readonly RouteBackend[]
}

/** 追加绑定失败的分类。 */
export type BindFailureKind = 'invalid' | 'not-signed-in' | 'forbidden' | 'request-failed'

/** 追加绑定请求体（`operator` 由宿主按已验证主体填入，请求体自报不算数）。 */
export interface BindRequestPayload {
  readonly publishedName: string
  readonly backendKeys: readonly string[]
  readonly effectiveFrom: number
  readonly reason: string
  readonly rolloutPercent: number
}

/** 表单校验结果。 */
export type BindRequestCheck =
  | { readonly ok: true; readonly request: BindRequestPayload }
  | { readonly ok: false; readonly message: string }

/** 一条绑定在某个时刻的状态。 */
export type BindingPhase = 'scheduled' | 'active' | 'retired'

/** 一个前台名字的绑定表单草稿（组件持有，不进 store）。 */
export interface BindDraft {
  readonly publishedName: string
  /** 有序键位：用户选的顺序就是 spillover 顺序。 */
  readonly backendKeys: readonly string[]
  /** 0–100 的十进制字符串（表单里就是文本，校验在这里收口）。 */
  readonly rolloutPercent: string
  readonly reason: string
}

/** 生效时刻的预设。 */
export type EffectivePreset = 'in-24h' | 'in-3d' | 'in-7d' | 'custom'

const STAGES: readonly LifecycleStage[] = ['preview', 'ga', 'legacy', 'deprecated', 'retired']
const RULES: readonly UpgradeRule[] = ['follow-default', 'on-expiry', 'never']
const TIERS: readonly TierId[] = ['basic', 'plus', 'max']

const HOUR_MS = 3_600_000

/** 结构不认识：抛而不是降级，避免把半个目录当有效事实。 */
function fail(): never { throw new Error(INVALID_ROUTE_RESPONSE) }

/** 非数组对象。 */
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 非空、无控制字符、已去首尾空白的字符串。 */
function text(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && value === value.trim() && !/[\u0000-\u001f\u007f]/u.test(value)
}

/** 有限数字。 */
function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 正整数。 */
function positiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

/** 可空时间戳：缺字段与 `null` 都是「没有计划」，其它值必须是有限数字。 */
function timestampOrNull(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (!finite(value)) fail()
  return value
}

/** 可空字符串：缺字段与 `null` 都是「没有」，其它值必须是非空文本。 */
function stringOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (!text(value)) fail()
  return value
}

/** 校验一条绑定。 */
export function parseBinding(value: unknown): BackendBinding {
  if (!record(value) || !text(value['publishedName']) || !finite(value['effectiveFrom'])) fail()
  const effectiveTo = timestampOrNull(value['effectiveTo'])
  if (effectiveTo !== null && effectiveTo < (value['effectiveFrom'] as number)) fail()
  const keys = value['backendKeys']
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every(text)) fail()
  const backendKeys = keys as string[]
  if (new Set(backendKeys).size !== backendKeys.length) fail()
  if (!text(value['reason']) || !text(value['operator'])) fail()
  if (!finite(value['rolloutPercent']) || value['rolloutPercent'] < 0 || value['rolloutPercent'] > 100) fail()
  return {
    publishedName: value['publishedName'] as string,
    effectiveFrom: value['effectiveFrom'] as number,
    effectiveTo,
    backendKeys,
    reason: value['reason'] as string,
    operator: value['operator'] as string,
    rolloutPercent: value['rolloutPercent'] as number,
  }
}

/** 校验一个前台名字记录，并把它的历史一起收进来。 */
export function parsePublishedName(value: unknown, history: unknown): PublishedNameRecord {
  if (!record(value) || !text(value['publishedName'])) fail()
  // 显示名可以由接口省略：那就显示名字本身，不编一个带后缀的假显示名。
  if ('label' in value && value['label'] !== null && !text(value['label'])) fail()
  const tiers = value['tiers']
  if (!Array.isArray(tiers) || tiers.length === 0 || !tiers.every(tier => TIERS.includes(tier as TierId))) fail()
  if (!positiveInteger(value['maxOutputTokens'])) fail()
  if (!finite(value['order'])) fail()
  if (!RULES.includes(value['upgradeRule'] as UpgradeRule)) fail()
  if (!STAGES.includes(value['lifecycleStage'] as LifecycleStage)) fail()
  if (!Array.isArray(history)) fail()
  const bindings = history.map(parseBinding).sort((left, right) => left.effectiveFrom - right.effectiveFrom)
  if (bindings.some(binding => binding.publishedName !== value['publishedName'])) fail()
  return {
    publishedName: value['publishedName'] as string,
    label: text(value['label']) ? value['label'] as string : value['publishedName'] as string,
    tiers: tiers as TierId[],
    maxOutputTokens: value['maxOutputTokens'] as number,
    order: value['order'] as number,
    upgradeRule: value['upgradeRule'] as UpgradeRule,
    lifecycleStage: value['lifecycleStage'] as LifecycleStage,
    shutdownDate: timestampOrNull(value['shutdownDate']),
    migrationTarget: stringOrNull(value['migrationTarget']),
    history: bindings,
  }
}

/** 校验一个可选后端。 */
export function parseBackend(value: unknown): RouteBackend {
  if (!record(value) || !text(value['key']) || !text(value['id']) || !positiveInteger(value['concurrency'])) fail()
  return { key: value['key'] as string, upstreamId: value['id'] as string, concurrency: value['concurrency'] as number }
}

/**
 * 校验一次目录读取的响应。
 *
 * 兼容两种已见的线上形状：宿主把历史挂在 `names[].history` 上（当前实现），
 * 也接受把历史放在顶层 `bindings` 的形态——两者都按同一套规则校验，缺历史的名字
 * 得到空数组，界面会说「接口没有返回历史」，而不会替它编一条。
 * @param value - 响应 JSON。
 * @returns 校验后的目录。
 */
export function parseRouteCatalog(value: unknown): RouteCatalog {
  if (!record(value) || value['ok'] !== true || !Array.isArray(value['names']) || !Array.isArray(value['backends'])) fail()
  const topLevel = value['bindings']
  if (topLevel !== undefined && !Array.isArray(topLevel)) fail()
  const unassigned = (topLevel ?? []).map(parseBinding)
  const names = value['names'].map((name) => {
    const own = record(name) && Array.isArray(name['history']) ? name['history'] : undefined
    if (own !== undefined) return parsePublishedName(name, own)
    const publishedName = record(name) ? name['publishedName'] : undefined
    return parsePublishedName(name, unassigned.filter(binding => binding.publishedName === publishedName))
  })
  if (new Set(names.map(name => name.publishedName)).size !== names.length) fail()
  const backends = value['backends'].map(parseBackend)
  if (new Set(backends.map(backend => backend.key)).size !== backends.length) fail()
  return { names, backends }
}

/**
 * 读响应的中文说明（服务端把可行动的原因放在这里）。
 * @param value - 响应 JSON。
 * @returns 说明文本；没有就返回 `undefined`。
 */
export function serverMessage(value: unknown): string | undefined {
  if (!record(value)) return undefined
  const direct = value['message']
  if (text(direct)) return direct
  const error = value['error']
  if (record(error) && text(error['message'])) return error['message'] as string
  return undefined
}

/**
 * 把 HTTP 状态码与响应体翻译成失败分类；服务端给的中文原因原样带回。
 * @param status - HTTP 状态码。
 * @param body - 已解析的响应体（可能解析失败）。
 * @returns 分类与可展示消息。
 */
export function bindFailure(status: number, body: unknown): { readonly kind: BindFailureKind; readonly message: string } {
  const message = serverMessage(body)
  if (status === 401) return { kind: 'not-signed-in', message: message ?? '请先登录。' }
  if (status === 403) return { kind: 'forbidden', message: message ?? '这个操作需要管理员权限。' }
  if (status >= 400 && status < 500) return { kind: 'invalid', message: message ?? `HTTP_${status}` }
  return { kind: 'request-failed', message: message ?? `HTTP_${status}` }
}

/** 目录里最新的绑定时刻（同名字的追加下限）；没有绑定时返回 `null`。 */
export function latestBindingAt(history: readonly BackendBinding[]): number | null {
  return history.reduce<number | null>((latest, binding) => (
    latest === null || binding.effectiveFrom > latest ? binding.effectiveFrom : latest
  ), null)
}

/** 某个名字当前（或指定时刻）的历史。 */
export function historyOf(catalog: RouteCatalog, publishedName: string): readonly BackendBinding[] {
  return catalog.names.find(name => name.publishedName === publishedName)?.history ?? []
}

/**
 * 校验绑定表单，并在**提交前**给出可行动的中文原因。
 *
 * 三条硬规则（与服务端同源，不靠服务端兜底）：
 * 1. 生效时刻必须在**将来**——不许在计费周期中间换绑；
 * 2. 生效时刻必须**晚于**同名字上一条绑定——只允许往后追加；
 * 3. 后端键位必须来自接口返回的可选后端，且不重复、非空。
 * @param draft - 表单草稿。
 * @param catalog - 当前目录（提供上一条绑定的时刻与可选键位）。
 * @param effectiveFrom - 解析好的生效时刻（毫秒）。
 * @param now - 当前时刻（毫秒）。
 * @returns 通过时给出请求体，否则给出中文原因。
 */
export function validateBindRequest(
  draft: BindDraft,
  catalog: RouteCatalog,
  effectiveFrom: number,
  now: number,
): BindRequestCheck {
  const name = catalog.names.find(item => item.publishedName === draft.publishedName)
  if (name === undefined) return { ok: false, message: '请选择一个已登记的前台名字。' }
  if (draft.backendKeys.length === 0) return { ok: false, message: '至少要选一个后端键位；主后端在前，备用在后。' }
  const known = new Set(catalog.backends.map(backend => backend.key))
  const unknown = draft.backendKeys.filter(key => !known.has(key))
  if (unknown.length > 0) {
    return { ok: false, message: `不认识的后端键位：${unknown.join('、')}。可用的是 ${catalog.backends.map(backend => backend.key).join('、') || '（接口没有返回）'}。` }
  }
  if (new Set(draft.backendKeys).size !== draft.backendKeys.length) {
    return { ok: false, message: '同一个后端键位不能出现两次。' }
  }
  if (!Number.isSafeInteger(effectiveFrom)) {
    return { ok: false, message: '请先选好生效时刻。' }
  }
  const latest = latestBindingAt(name.history)
  if (latest !== null && effectiveFrom <= latest) {
    return {
      ok: false,
      message: `生效时刻必须晚于这个名字上一条绑定（${formatEffectiveFrom(latest)}）。绑定只允许往后追加。`,
    }
  }
  if (effectiveFrom <= now) {
    return { ok: false, message: '生效时刻必须在将来。要立刻生效请等一个周期，或联系运维走紧急流程。' }
  }
  const reason = draft.reason.trim()
  if (reason.length === 0) return { ok: false, message: '请填写变更原因：将来对账的人要知道为什么改。' }
  const percent = parseRolloutPercent(draft.rolloutPercent)
  if (percent === null) return { ok: false, message: '灰度百分比必须是 0 到 100 之间的整数。' }
  return { ok: true, request: { publishedName: name.publishedName, backendKeys: [...draft.backendKeys], effectiveFrom, reason, rolloutPercent: percent } }
}

/**
 * 解析灰度百分比输入。
 * @param value - 表单原文。
 * @returns 0–100 的整数；不合法返回 `null`。
 */
export function parseRolloutPercent(value: string): number | null {
  if (!/^\d{1,3}$/.test(value.trim())) return null
  const percent = Number(value.trim())
  return Number.isInteger(percent) && percent >= 0 && percent <= 100 ? percent : null
}

/** 把毫秒时刻落成 `<input type="datetime-local">` 需要的本机时刻文本。 */
export function toLocalInputValue(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 把 `<input type="datetime-local">` 的本机时刻文本解析成毫秒；不合法返回 `null`。 */
export function fromLocalInputValue(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value.trim())
  if (match === null) return null
  const [, year = '', month = '', day = '', hour = '', minute = ''] = match
  const date = new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), 0, 0)
  // 回读校验：2 月 31 日会被 Date 滚到 3 月，那不是用户填的时刻。
  if (date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day)) return null
  return date.getTime()
}

/** 预设生效时刻；24 小时/3 天/7 天。 */
export function presetEffectiveFrom(preset: Exclude<EffectivePreset, 'custom'>, now: number): number {
  if (preset === 'in-24h') return now + 24 * HOUR_MS
  if (preset === 'in-3d') return now + 72 * HOUR_MS
  return now + 168 * HOUR_MS
}

/** 本机时区的可读时刻文本（界面与预览共用一份实现）。 */
export function formatEffectiveFrom(at: number): string {
  const date = new Date(at)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 一条绑定在给定时刻的状态：计划中 / 生效中 / 已失效。 */
export function bindingPhase(binding: BackendBinding, now: number): BindingPhase {
  if (binding.effectiveFrom > now) return 'scheduled'
  if (binding.effectiveTo !== null && binding.effectiveTo <= now) return 'retired'
  return 'active'
}

/** 调整有序键位：把某一项移动一位；越界时原样返回（不复制出新历史）。 */
export function moveBackend(keys: readonly string[], index: number, direction: -1 | 1): readonly string[] {
  const target = index + direction
  if (index < 0 || index >= keys.length || target < 0 || target >= keys.length) return keys
  const next = [...keys]
  const [moved] = next.splice(index, 1)
  if (moved === undefined) return keys
  next.splice(target, 0, moved)
  return next
}

/** 移除一个键位；`key` 不在列表里时原样返回。 */
export function removeBackend(keys: readonly string[], key: string): readonly string[] {
  return keys.includes(key) ? keys.filter(item => item !== key) : keys
}

/** 追加一个键位到末尾（备用位）；已经在列表里则原样返回。 */
export function appendBackend(keys: readonly string[], key: string): readonly string[] {
  return keys.includes(key) ? keys : [...keys, key]
}

/**
 * 把某个名字当前的键位顺序作为新绑定的初值。
 *
 * 优先取当前生效的那条（用户看到的就是它）；没有生效的取最新一条（计划中的那条，
 * 也就是「再过一会儿会生效」的顺序）；这个名字**从来没有绑定过**时，退化成接口给的
 * 后端顺序——那是宿主登记的默认可选顺序，用户随后可以自己调。三者都没有就是空列表，
 * 而空列表在 {@link validateBindRequest} 里会被挡住，不会提交一条空绑定。
 */
export function seedBackendKeys(catalog: RouteCatalog, publishedName: string, now: number): readonly string[] {
  const history = historyOf(catalog, publishedName)
  const current = history.find(binding => bindingPhase(binding, now) === 'active')
  const latest = history[history.length - 1]
  return (current ?? latest)?.backendKeys ?? catalog.backends.map(backend => backend.key)
}
