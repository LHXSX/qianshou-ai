/**
 * 高危操作的**两步确认**。
 *
 * 用户的要求是"高危操作二次确认 + 审计留痕"。把它做成一个纯函数式的令牌机制，
 * 是为了让"确认"这件事**可测**且**不可绕过**：
 *
 * - 第一步 `preflight` 只做两件事：算清 `before → after`，发一个一次性令牌。
 *   它**不产生任何副作用**。
 * - 第二步 `apply` 必须带令牌，服务端校验"同一个人 + 同一个操作 + 同一份载荷"。
 *   预览之后有人改了目标，载荷哈希就对不上，直接拒绝（`confirm_mismatch`）。
 *
 * 为什么令牌绑载荷而不是"再点一次确认"：只点一次确认挡不住"预览时看到的是 A、
 * 真正提交的却是 B"——那正是这类 UI 最容易被骗的地方。绑定载荷之后，
 * 管理员确认过的内容就是被执行的内容。
 */
import { createHash } from 'node:crypto'

/** 签发结果。 */
export interface IssuedConfirm {
  readonly token: string
  readonly expiresAt: number
}

/** 校验结果。 */
export type ConfirmOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: 'confirm_invalid' | 'confirm_expired' | 'confirm_mismatch' }

/** 待确认的操作。 */
interface PendingConfirm {
  readonly actorId: string
  readonly action: string
  readonly payloadHash: string
  readonly expiresAt: number
}

/** 载荷哈希：稳定序列化（键排序），避免同样的内容因为键顺序不同而拒。 */
export function hashPayload(payload: unknown): string {
  const stable = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stable)
    if (value !== null && typeof value === 'object') {
      const source = value as Record<string, unknown>
      const out: Record<string, unknown> = {}
      for (const key of Object.keys(source).sort()) out[key] = stable(source[key])
      return out
    }
    return value
  }
  return createHash('sha256').update(JSON.stringify(stable(payload) ?? null)).digest('hex')
}

/** 确认令牌存储。 */
export interface ConfirmStore {
  /** 签发一个令牌（同一个人 + 同一个动作 + 同一份载荷）。 */
  readonly issue: (input: { readonly actorId: string; readonly action: string; readonly payload: unknown }) => IssuedConfirm
  /** 校验并**消费**令牌。 */
  readonly consume: (input: {
    readonly token: string
    readonly actorId: string
    readonly action: string
    readonly payload: unknown
  }) => ConfirmOutcome
  /** 待确认数量（测试与运维视图）。 */
  readonly size: () => number
}

/**
 * 建确认令牌存储。
 * @param options - 有效期（默认 60 秒）、时钟与令牌生成器。
 * @returns 句柄。
 */
export function createConfirmStore(options: {
  readonly ttlMs?: number
  readonly now?: () => number
  readonly newToken?: () => string
} = {}): ConfirmStore {
  const ttlMs = options.ttlMs ?? 60_000
  const now = options.now ?? (() => Date.now())
  const newToken = options.newToken ?? (() => createHash('sha256')
    .update(`${Date.now()}:${Math.random()}:${process.pid}`)
    .digest('base64url')
    .slice(0, 32))
  const pending = new Map<string, PendingConfirm>()

  /** 顺手清理过期令牌：这个表很小，但过期条目不该无限留着。 */
  const sweep = (): void => {
    const at = now()
    for (const [token, item] of pending) {
      if (at >= item.expiresAt) pending.delete(token)
    }
  }

  return {
    issue: ({ actorId, action, payload }) => {
      sweep()
      const token = newToken()
      const expiresAt = now() + ttlMs
      pending.set(token, { actorId, action, payloadHash: hashPayload(payload), expiresAt })
      return { token, expiresAt }
    },
    consume: ({ token, actorId, action, payload }) => {
      const item = pending.get(token)
      if (item === undefined) return { ok: false, code: 'confirm_invalid' }
      // 一次性：无论校验结果如何都先删掉，避免"猜错还能重试"。
      pending.delete(token)
      if (now() >= item.expiresAt) return { ok: false, code: 'confirm_expired' }
      if (item.actorId !== actorId || item.action !== action) return { ok: false, code: 'confirm_mismatch' }
      if (item.payloadHash !== hashPayload(payload)) return { ok: false, code: 'confirm_mismatch' }
      return { ok: true }
    },
    size: () => pending.size,
  }
}
