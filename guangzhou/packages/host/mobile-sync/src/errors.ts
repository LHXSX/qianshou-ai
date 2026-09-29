/** Bounded failure vocabulary for the owner-authenticated mobile routes. */
export type MobileSyncErrorCode =
  | 'MOBILE_SYNC_JSON_REQUIRED'
  | 'MOBILE_SYNC_REQUEST_TOO_LARGE'
  | 'MOBILE_SYNC_REQUEST_INVALID'
  | 'MOBILE_SYNC_HEARTBEAT_INVALID'
  | 'MOBILE_SYNC_CURSOR_INVALID'
  | 'MOBILE_SYNC_CURSOR_FUTURE'
  | 'MOBILE_SYNC_STORE_UNAVAILABLE'
  | 'MOBILE_SYNC_STORE_INVALID'
  | 'MOBILE_SYNC_CLOSED'
  | 'MOBILE_SYNC_FAILED'
  // ── PC session gateway (P0-4) ────────────────────────────────────────────
  // Refusals the phone can act on are separated by cause, because the remedy
  // differs: a re-pair, a fresh revision, or a plain resend.
  /** The command is not shaped like a command this gateway accepts. */
  | 'PC_WINDOW_COMMAND_INVALID'
  // ── 引导（配对）失败 ──────────────────────────────────────────────────────
  // 三类票据失败分开：拿错票要重扫、票过期要重新生成、撞太多次要等或换设备，
  // 用户的处置完全不同，合成一个"配对失败"等于把这三件事都藏起来。
  /** 引导请求里没有设备标识。 */
  | 'PC_WINDOW_BOOTSTRAP_DEVICE_REQUIRED'
  /** 票据对不上：通常是扫了旧的二维码或串被人改过。 */
  | 'PC_WINDOW_PAIR_UNKNOWN'
  /** 票据已过期（默认 5 分钟），需要重新生成二维码。 */
  | 'PC_WINDOW_PAIR_EXPIRED'
  /** 同一台设备连续试错太多次，先拒绝一段时间。 */
  | 'PC_WINDOW_PAIR_TOO_MANY_ATTEMPTS'
  /** 电脑侧还没登录：没有账号就没有可授权的身份。 */
  | 'PC_WINDOW_NOT_SIGNED_IN'
  /** 电脑侧没有打开的会话：没有会话就没有可继续的上下文。 */
  | 'PC_WINDOW_NO_SESSION'
  /** No host-authorized binding covers this account + PC + Session + phone origin. */
  | 'PC_WINDOW_BINDING_UNKNOWN'
  /** The command's origin contradicts the binding it claims; never re-bound implicitly. */
  | 'PC_WINDOW_BINDING_MISMATCH'
  /** The bound Session belongs to a different account or a different PC. */
  | 'PC_WINDOW_FOREIGN_ORIGIN'
  /** A revision-bound control named a Session other than its own bound target. */
  | 'PC_WINDOW_TARGET_MISMATCH'
  /** `expectedRevision` is not the conversation revision the gateway holds. */
  | 'PC_WINDOW_REVISION_MISMATCH'
  /** The receipt cursor is ahead of anything this gateway issued. */
  | 'PC_WINDOW_CURSOR_FUTURE'
  /** The command's lifetime already elapsed; it is never executed late. */
  | 'PC_WINDOW_COMMAND_EXPIRED'
  /** The same request id was submitted with a different command body. */
  | 'PC_WINDOW_REQUEST_CONFLICT'
  /** The PC Session authority is not reachable, so nothing can be admitted. */
  | 'PC_WINDOW_SESSION_UNAVAILABLE'
  /** The owning PC is not online, so no command can be admitted right now. */
  | 'PC_WINDOW_OFFLINE'
  /** The gateway's durable command file cannot be read or written. */
  | 'PC_WINDOW_STORE_UNAVAILABLE'
  /** The gateway's durable command file is corrupt or from an unknown version. */
  | 'PC_WINDOW_STORE_INVALID'
  /** The gateway is shutting down. */
  | 'PC_WINDOW_CLOSED'

/** One refusal carrying the HTTP status the carrier must return. */
export class MobileSyncError extends Error {
  /** @param code - Stable machine-readable refusal code.
   * @param status - HTTP status the route returns for this refusal.
   * @param details - Optional bounded facts the caller needs to act on the refusal,
   *   such as the revision the gateway actually holds. Never free-form error text.
   */
  constructor(
    readonly code: MobileSyncErrorCode,
    readonly status: number = 400,
    readonly details: Readonly<Record<string, string | number | boolean>> = {},
  ) {
    super(code)
    this.name = 'MobileSyncError'
  }
}
