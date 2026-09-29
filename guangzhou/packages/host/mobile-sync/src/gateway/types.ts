/** Host-side PC session gateway: durable command admission and honest delivery receipts.
 *
 * This module owns no conversation history. The addressed PC Session remains the
 * history authority; the gateway only decides whether a phone command was admitted
 * to that Session, and records whatever it can actually prove about that admission.
 */
import type { PlatformIdentity } from '@deepseek-ai/dsh-host-platform-foundation'

/** Facts a paired phone is authorized to see about the PC it continues. */
export interface PcWindowHostFacts {
  /** Stable identity of the PC holding the bound Sessions. */
  readonly identity: PlatformIdentity
}

/** Durable schema version of the gateway file; a mismatch is corruption, never a silent migration. */
export const PC_WINDOW_STORE_VERSION = 1 as const

/** The authenticated adapter must verify this account's access to this exact PC and conversation. */
export interface WindowBinding {
  /** Account that owns the addressed PC and Session. */
  readonly accountId: string
  /** PC that holds the addressed Session. */
  readonly pcId: string
  /** Original PC Session the phone continues; the conversation-history authority. */
  readonly sessionId: string
  /** Phone presenting the command. */
  readonly sourceDeviceId: string
}

/** Independent input never interrupts the original conversation. Controls need a checked target revision. */
export type WindowAction =
  | { readonly type: 'dispatch'; readonly text: string; readonly label?: string }
  | { readonly type: 'append'; readonly targetSessionId: string; readonly expectedRevision: number; readonly text: string }
  | { readonly type: 'cancel'; readonly targetSessionId: string; readonly expectedRevision: number }

/** Stable admission identity is retained on every retry, so a retry can never execute twice. */
export interface WindowCommand {
  /** Client-minted identity; the idempotency key of the whole gateway. */
  readonly requestId: string
  /** Exact account, PC, original Session and phone this command is authorized for. */
  readonly origin: WindowBinding
  /** Epoch milliseconds the command was created. */
  readonly createdAt: number
  /** Epoch milliseconds after which the command must not be executed. */
  readonly expiresAt: number
  readonly action: WindowAction
}

/** What the gateway can actually prove about one command.
 *
 * `received` is the only state backed by a real Session admission. `rejected` is an
 * explicit non-admission proof, which is the only proof that permits a resend.
 * `uncertain` means the gateway cannot prove either outcome — a crash between
 * recording the attempt and observing the outcome, or a failure whose effect is
 * unknown. It is never silently reported as delivered.
 */
export type DeliveryState = 'received' | 'rejected' | 'cancelled' | 'uncertain'

/** Delivery confirmation is distinct from a task result, acceptance or financial settlement. */
export interface WindowReceipt {
  readonly requestId: string
  readonly origin: WindowBinding
  /** Session revision this observation belongs to. */
  readonly revision: number
  readonly state: DeliveryState
  /** Session the admission actually addressed. */
  readonly childSessionId?: string
  readonly reason: string | null
}

/** Durable intent and outcome of one command; written before any Session is touched. */
export interface WindowCommandRecord {
  readonly requestId: string
  readonly key: string
  readonly command: WindowCommand
  /** Sequence this record occupies in its phone's receipt stream. */
  readonly sequence: number
  /** Revision the caller claimed for a revision-bound control; absent for `dispatch`. */
  readonly expectedRevision?: number
  /** Session revision at admission; absent while the command has no admitted outcome. */
  readonly admissionRevision?: number
  /** `attempting` is persisted before the Session is touched, so a crash is never read as "never sent". */
  readonly outcome: 'pending' | 'attempting' | DeliveryState
  readonly receipt: WindowReceipt | null
  readonly errorCode: string | null
  readonly updatedAt: number
}

/** Host-authorized origin plus the conversation's current gateway revision. */
export interface WindowBindingRecord {
  readonly key: string
  readonly binding: WindowBinding
  /** Current gateway revision of the bound conversation; advances only on admitted mutations. */
  readonly revision: number
  /** Phone-only receipt stream position this binding has issued. */
  readonly issuedSequence: number
  readonly registeredAt: number
}

/** Whole durable gateway file. */
export interface PcWindowFile {
  readonly version: typeof PC_WINDOW_STORE_VERSION
  readonly bindings: Readonly<Record<string, WindowBindingRecord>>
  readonly commands: Readonly<Record<string, WindowCommandRecord>>
}

/** Gateway observation. A browser network signal alone cannot establish that the target PC is online. */
export interface WindowAccess {
  readonly state: 'online' | 'offline' | 'unauthorized' | 'unavailable'
  readonly allowedActions: readonly WindowAction['type'][]
}

/** Cursor response from the authenticated gateway; absence of a receipt does not imply non-delivery. */
export interface WindowSyncPage {
  readonly binding: WindowBinding
  readonly fromCursor: string | null
  readonly nextCursor: string
  readonly receipts: readonly WindowReceipt[]
  /** Only an explicit non-admission proof permits an uncertain command to be sent again. */
  readonly notReceivedIds: readonly string[]
}

/** Result of one command submission, including whether it is safe to send again. */
export interface WindowSubmitResult {
  readonly receipt: WindowReceipt
  /** Whether this submission executed the command or returned the durable earlier outcome. */
  readonly outcome: 'executed' | 'replayed'
  /** True only for an explicit non-admission proof; a client may resend exactly these. */
  readonly mayResend: boolean
}

/** Everything the gateway needs from the PC Session owner, and nothing more. */
export interface SessionCommandPort {
  /** Whether the PC Session authority is reachable at all. */
  readonly available: () => boolean
  /** Whether this exact command identity was already admitted to that Session. */
  readonly alreadyAccepted: (binding: WindowBinding, requestId: string) => Promise<boolean>
  /** Admit one new turn to the bound Session. */
  readonly dispatch: (binding: WindowBinding, command: WindowCommand) => Promise<void>
  /** Admit one follow-up user message to the bound Session without interrupting it. */
  readonly append: (binding: WindowBinding, command: WindowCommand) => Promise<void>
  /** Cancel the active turn of the bound Session. */
  readonly cancel: (binding: WindowBinding, command: WindowCommand) => Promise<void>
}
