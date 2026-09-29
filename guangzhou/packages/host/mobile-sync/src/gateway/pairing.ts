/**
 * 配对票据：把「手机连电脑」从**手抄令牌**变成**扫一下**。
 *
 * 现状与缺口：手机端现在是让用户把工作台打印的 `http://127.0.0.1:3091/?token=…`
 * 手抄进设置页。而 PC 会话网关那边，`registerBinding` 是 host 侧程序化 API，
 * **故意不暴露成 HTTP**——因为「手机不能自己授权自己」。两端之间缺的就是一个
 * **由人发起的、一次性的**配对动作。本模块提供它：票据由**电脑**签发并显示成二维码，
 * 手机扫码后拿票据换取绑定。
 *
 * 四条安全性质，每条都有对应测试：
 *
 * 1. **一次性**：用掉即作废。二维码会被拍照、被截图转发，能重复用的票据等于长期口令。
 * 2. **短时**：默认 5 分钟。过期即不可用，且过期判定用注入的时钟，便于测试。
 * 3. **常数时间比较**：票据是密钥类材料，逐字符比较会泄露前缀。
 * 4. **限次**：同一来源连续试错超过阈值就拒绝，避免有人拿脚本撞票。
 */
import { randomBytes, timingSafeEqual } from 'node:crypto'

/** 票据长度（字节）；base64url 之后约 22 个字符，扫码容量与强度都够。 */
const TICKET_BYTES = 16

/** 默认有效期：5 分钟。够人拿起手机扫一下，又不至于挂着过夜。 */
export const DEFAULT_TICKET_TTL_MS = 5 * 60 * 1000

/** 同一来源允许的连续失败次数；超过就拒绝，直到窗口过去。 */
export const DEFAULT_MAX_ATTEMPTS = 10

/** 一张待用票据。 */
interface Ticket {
  /** 明文票据值（只存在于内存中；不落盘，重启即失效——这是刻意的）。 */
  readonly value: string
  /** 过期时刻（毫秒）。 */
  readonly expiresAt: number
  /** 失败尝试计数，按来源记账。 */
  readonly attemptsBySource: Map<string, number>
}

/** 兑换结果。 */
export type RedeemResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'unknown' | 'expired' | 'too-many-attempts' }

/** 配对票据的签发与兑换。 */
export interface PairingTickets {
  /**
   * 签发一张新票据；**会作废上一张未用的**。
   *
   * 为什么只留一张：屏幕上同时存在多个有效二维码，用户不知道该扫哪一个，
   * 而且多一张就多一个可被猜中的入口。重新签发的成本只是再点一次按钮。
   * @returns 票据明文，调用方把它编进二维码。
   */
  readonly issue: () => string
  /**
   * 兑换一张票据。
   * @param value - 手机送来的票据明文。
   * @param source - 来源标识（例如手机设备 id）；用于限次记账。
   * @returns 成功，或失败原因。
   */
  readonly redeem: (value: string, source: string) => RedeemResult
  /** 当前是否有一张未过期未使用的票据（界面据此决定是否还显示二维码）。 */
  readonly pending: () => boolean
  /** 当前票据的过期时刻；没有则 `null`。 */
  readonly expiresAt: () => number | null
}

/**
 * 建一个配对票据收发器。
 * @param options - 有效期、时长与时钟，均可注入以便测试。
 * @returns 票据收发器。
 */
export function createPairingTickets(options: {
  readonly ttlMs?: number
  readonly maxAttempts?: number
  readonly now?: () => number
  /** 随机源；省略时用 `node:crypto`。测试可注入确定性来源。 */
  readonly random?: (bytes: number) => Buffer
} = {}): PairingTickets {
  const ttlMs = options.ttlMs ?? DEFAULT_TICKET_TTL_MS
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const now = options.now ?? (() => Date.now())
  const random = options.random ?? ((bytes: number) => randomBytes(bytes))

  /** 只留一张：签发即顶掉上一张。 */
  let current: Ticket | null = null

  const isLive = (ticket: Ticket | null): ticket is Ticket =>
    ticket !== null && ticket.expiresAt > now()

  /** 常数时间比较：长度不同先判负（长度本身不是秘密），长度相同再逐字节比。 */
  const sameValue = (left: string, right: string): boolean => {
    const a = Buffer.from(left, 'utf8')
    const b = Buffer.from(right, 'utf8')
    if (a.byteLength !== b.byteLength) return false
    return timingSafeEqual(a, b)
  }

  return {
    issue: () => {
      const value = random(TICKET_BYTES).toString('base64url')
      current = { value, expiresAt: now() + ttlMs, attemptsBySource: new Map() }
      return value
    },

    redeem: (value, source) => {
      if (!isLive(current)) {
        current = null
        return { ok: false, reason: 'expired' }
      }
      const attempts = current.attemptsBySource.get(source) ?? 0
      if (attempts >= maxAttempts) return { ok: false, reason: 'too-many-attempts' }

      if (!sameValue(value, current.value)) {
        // 失败也记账：否则「试到对为止」的成本为零。
        current.attemptsBySource.set(source, attempts + 1)
        return { ok: false, reason: 'unknown' }
      }
      // 用掉即作废——二维码可能被截图转发，能重复用就等于长期口令。
      current = null
      return { ok: true }
    },

    pending: () => isLive(current),
    expiresAt: () => (isLive(current) ? current.expiresAt : null),
  }
}
