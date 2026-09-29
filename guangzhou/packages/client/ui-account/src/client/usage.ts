/**
 * 用量审计的读层：把网关的逐调用记录折叠成界面事实。
 *
 * 为什么这一页值得存在：额度是按**真实 token 用量**扣的，而用户看不到 token。
 * 没有这一页，「扣了 0.05 SP」就是一个无法核对的数字；有了它，每一分都能对到
 * 某一次调用、某个模型、多少输入多少输出。**可核对**是订阅制能被信任的前提。
 *
 * 实测正文（本机 3091）：
 * ```json
 * {"ok":true,"count":9,"entries":[
 *   {"at":1789508812395,"model":"千手·迅捷","inputTokens":31,"outputTokens":33,"sp":0.04}]}
 * ```
 * 注意：这条路由**只返回调用方自己的记录**（`accountId` 由服务端身份决定，
 * 传参也会被忽略），所以这里不需要、也不该带任何账号参数。
 */

/** 用量审计路由；只收 POST，与另外两条读路由一致。 */
export const AI_AUDIT_PATH = '/api/qianshou/ai/audit'

/** 1 SP 的微单位数；与服务端账本一致（`MICRO_SP_PER_SP`）。 */
const MICRO_SP_PER_SP = 1_000_000

/** 一次调用。 */
export interface UsageEntry {
  /** 调用时刻（毫秒）。 */
  readonly at: number
  /** 当时实际作答的**前台名**（用户看到的名字）。 */
  readonly model: string
  readonly inputTokens: number
  readonly outputTokens: number
  /** 本次扣费（SP）。 */
  readonly sp: number
}

/** 用量读取的结果。 */
export type UsageRead =
  | { readonly kind: 'ok'; readonly entries: readonly UsageEntry[] }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'rejected'; readonly message: string | null }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * 解析一条记录；形状不对返回 `null`（**丢掉它而不是补零**）。
 *
 * 为什么不补零：一条 `inputTokens` 读不出来的记录若被显示成 0，
 * 用户会以为那次调用免费，而实际扣费可能正是最多的那一次。
 * @param value - 一条候选记录。
 * @returns 合法记录，或 `null`。
 */
function entryOf(value: unknown): UsageEntry | null {
  if (!isRecord(value)) return null
  const at = num(value.at)
  const inputTokens = num(value.inputTokens)
  const outputTokens = num(value.outputTokens)
  const sp = num(value.sp)
  const model = typeof value.model === 'string' && value.model.length > 0 ? value.model : null
  if (at === null || inputTokens === null || outputTokens === null || sp === null || model === null) return null
  return { at, model, inputTokens, outputTokens, sp }
}

/**
 * 解析审计正文。
 * @param payload - `response.json()` 的结果。
 * @returns 记录数组（按时间倒序，与服务端一致）；形状不对返回 `null`。
 */
export function parseUsage(payload: unknown): readonly UsageEntry[] | null {
  if (!isRecord(payload)) return null
  if (payload.ok !== true) return null
  if (!Array.isArray(payload.entries)) return null
  return payload.entries.map(entryOf).filter((entry): entry is UsageEntry => entry !== null)
}

/** 读一次用量；任何异常都折叠成一种结果，不抛出。 */
export async function readUsage(signal: AbortSignal): Promise<UsageRead> {
  try {
    const response = await fetch(AI_AUDIT_PATH, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      body: '{}',
      signal,
    })
    if (!response.ok) {
      let message: string | null = null
      try {
        const body: unknown = await response.json()
        if (isRecord(body)) {
          const raw = body.message ?? (isRecord(body.error) ? body.error.message : undefined)
          if (typeof raw === 'string' && raw.length > 0) message = raw
        }
      } catch {
        // 正文不是 JSON：原因留空，界面显示本地兜底文案。
      }
      return { kind: 'rejected', message }
    }
    const entries = parseUsage(await response.json())
    return entries === null ? { kind: 'unavailable' } : { kind: 'ok', entries }
  } catch {
    return { kind: 'unavailable' }
  }
}

/** 汇总数字：把一堆调用折成用户真正想看的三个数。 */
export interface UsageTotals {
  readonly calls: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly sp: number
}

/**
 * 汇总。
 *
 * SP 用**整数微 SP** 累加再加回小数，而不是浮点直接相加：后者会把
 * 0.04 + 0.03 算成 0.07000000000000001，界面上就出现一个像 bug 的数字。
 * 这与服务端账本是同一套精度做法（`MICRO_SP_PER_SP`）。
 * @param entries - 记录数组。
 * @returns 合计；空数组返回全零（这是真实事实，不是缺失）。
 */
export function totalsOf(entries: readonly UsageEntry[]): UsageTotals {
  let inputTokens = 0
  let outputTokens = 0
  let microSp = 0
  for (const entry of entries) {
    inputTokens += entry.inputTokens
    outputTokens += entry.outputTokens
    microSp += Math.round(entry.sp * MICRO_SP_PER_SP)
  }
  return { calls: entries.length, inputTokens, outputTokens, sp: microSp / MICRO_SP_PER_SP }
}
