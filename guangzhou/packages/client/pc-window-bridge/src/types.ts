/** Local mobile-window contracts. These types define no deployed network route. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'

/** The authenticated adapter must verify this account's access to this exact PC and conversation. */
export interface WindowBinding {
  readonly accountId: string
  readonly pcId: string
  readonly sessionId: SessionId
  readonly sourceDeviceId: string
}

/** Independent input never interrupts the original conversation. Controls need a checked target revision. */
export type WindowAction =
  | { readonly type: 'dispatch'; readonly text: string; readonly label?: string }
  | { readonly type: 'append'; readonly targetSessionId: SessionId; readonly expectedRevision: number; readonly text: string }
  | { readonly type: 'cancel'; readonly targetSessionId: SessionId; readonly expectedRevision: number }

/** Stable admission identity is retained on every retry; expiry must also be checked by the PC adapter. */
export interface WindowCommand {
  readonly requestId: SessionRequestId
  readonly origin: WindowBinding
  readonly createdAt: number
  readonly expiresAt: number
  readonly action: WindowAction
}

/** Delivery confirmation is distinct from a task result, acceptance or financial settlement. */
export type DeliveryState = 'queued' | 'delivering' | 'uncertain' | 'received' | 'rejected' | 'expired' | 'withdrawn' | 'cancelled' | 'already-finished'

/** A PC-origin receipt must match the command's complete origin and stable request id. */
export interface WindowReceipt {
  readonly requestId: SessionRequestId
  readonly origin: WindowBinding
  readonly revision: number
  readonly state: 'received' | 'rejected' | 'cancelled' | 'already-finished'
  readonly childSessionId?: SessionId
  readonly reason: string | null
}

/** Durable local echo and its last verified PC receipt; not a copied conversation log. */
export interface WindowCommandRecord {
  readonly command: WindowCommand
  readonly state: DeliveryState
  readonly receipt: WindowReceipt | null
}

/** Per-origin journal; the original PC Session remains the conversation-history authority. */
export interface WindowJournal {
  readonly version: 'qianshou.pc-window.v1'
  readonly binding: WindowBinding
  readonly revision: number
  readonly cursor: string | null
  readonly records: readonly WindowCommandRecord[]
}

/** Storage commits atomically and rejects a stale expected revision; keys include the full origin. */
export interface WindowJournalStore {
  readonly load: (binding: WindowBinding) => Promise<unknown>
  readonly save: (journal: WindowJournal, expectedRevision: number) => Promise<void>
  readonly remove: (binding: WindowBinding) => Promise<void>
}

/** Gateway observation. A browser network signal alone cannot establish that the target PC is online. */
export interface WindowAccess {
  readonly state: 'online' | 'offline' | 'unauthorized' | 'unavailable'
  readonly allowedActions: readonly WindowAction['type'][]
}

/** Cursor response from the authenticated adapter; absence of a receipt does not imply non-delivery. */
export interface WindowSyncPage {
  readonly binding: WindowBinding
  readonly fromCursor: string | null
  readonly nextCursor: string
  readonly receipts: readonly WindowReceipt[]
  /** Only a gateway's explicit non-admission proof permits an uncertain command to be sent again. */
  readonly notReceivedIds: readonly SessionRequestId[]
}

/** The transport face this package needs from the authenticated PC gateway.
 *
 * `PcWindowHttpPort` implements it against that gateway, but the port itself stays
 * an injection point: identity, PC revision and admission dedup belong to the host
 * gateway, never here, so no connector may be substituted without one.
 */
/** 引导结果：这台手机被授权到哪个源，以及该源当前允许的动作。 */
export interface PcWindowBootstrap {
  readonly binding: WindowBinding
  readonly access: WindowAccess
}

export interface PcWindowPort {
  /**
   * 换取本机被授权到的源。
   *
   * 手机启动时**必须先引导**：它无从自行编造"我是哪个账号、哪台 PC、哪个会话"。
   * 设备的稳定标识与目标会话由调用方给出，绑定关系由网关确定。
   * @param deviceId - 这台手机的稳定设备标识。
   * @param signal - 调用方取消。
   * @param sessionId - 可选的目标会话；省略则用网关的默认会话。
   * @returns 绑定与访问状态。
   */
  readonly bootstrap: (deviceId: string, signal: AbortSignal, sessionId?: string) => Promise<PcWindowBootstrap>
  readonly access: (binding: WindowBinding, signal: AbortSignal) => Promise<WindowAccess>
  readonly submit: (command: WindowCommand, signal: AbortSignal) => Promise<unknown>
  readonly sync: (
    binding: WindowBinding, cursor: string | null, requestIds: readonly SessionRequestId[], signal: AbortSignal,
  ) => Promise<unknown>
}

/** View state contains no account credentials, model quota, balance or executable phone capability. */
export interface PcWindowSnapshot {
  readonly binding: WindowBinding | null
  readonly access: WindowAccess['state']
  readonly records: readonly WindowCommandRecord[]
  readonly cursor: string | null
  readonly error: string | null
}
