/** Wire views shared by the relay link, the PC window service and the owner status Remote; no credential is part of any view. */

/** The five operations the relay may forward to this PC (pc-relay.ts `ACTIONS`). */
export type PcWindowAction = 'bootstrap' | 'access' | 'transcript' | 'sync' | 'submit'

/** Exact account, PC, original Session and phone a command is authorized for. */
export interface WindowBinding {
  readonly accountId: string
  /** Must equal the id this PC registered at the relay; a different id is a binding mismatch there. */
  readonly pcId: string
  readonly sessionId: string
  readonly sourceDeviceId: string
}

/** Text admission never interrupts the original conversation; `cancel` is parsed but refused by this PC. */
export type WindowActionInput =
  | { readonly type: 'dispatch'; readonly text: string; readonly label?: string }
  | { readonly type: 'append'; readonly targetSessionId: string; readonly expectedRevision: number; readonly text: string }
  | { readonly type: 'cancel'; readonly targetSessionId: string; readonly expectedRevision: number }

/** Stable client-minted identity retained on every retry; the idempotency key of the whole port. */
export interface WindowCommand {
  readonly requestId: string
  readonly origin: WindowBinding
  readonly createdAt: number
  readonly expiresAt: number
  readonly action: WindowActionInput
}

/** `received` is the only state backed by a Session durability barrier. */
export type DeliveryState = 'received' | 'rejected' | 'cancelled' | 'uncertain'

/** Admission proof distinct from task completion. */
export interface WindowReceipt {
  readonly requestId: string
  readonly origin: WindowBinding
  /** Position in this binding's receipt stream; starts at 1. */
  readonly revision: number
  readonly state: DeliveryState
  readonly reason: string | null
  readonly childSessionId?: string
}

/** What this binding may do right now; not a statement about the phone's network. */
export interface WindowAccess {
  readonly state: 'online' | 'offline' | 'unauthorized' | 'unavailable'
  readonly allowedActions: readonly WindowActionInput['type'][]
}

/** One Session the signed-in account may continue from a phone. */
export interface WindowSessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
}

/** Bootstrap answer: the created or refreshed binding and every continuable Session. */
export interface WindowBootstrap {
  readonly binding: WindowBinding
  readonly access: WindowAccess
  readonly sessions: readonly WindowSessionSummary[]
}

/** One phone-visible committed text turn. */
export interface WindowTurn {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly at: number
  readonly truncated: boolean
}

/** Incremental committed-text projection with an explicit reset after replaced history. */
export interface WindowTranscript {
  readonly binding: WindowBinding
  readonly status: 'idle' | 'running' | 'unavailable'
  readonly turns: readonly WindowTurn[]
  readonly cursor: string
  readonly reset: boolean
  readonly hasMore: boolean
  readonly earlierOmitted: boolean
}

/** Receipt stream page; a missing receipt never implies non-delivery. */
export interface WindowSyncPage {
  readonly binding: WindowBinding
  readonly fromCursor: string | null
  readonly nextCursor: string
  readonly receipts: readonly WindowReceipt[]
  /** Ids the phone asked about that this PC never claimed; only these may be sent again. */
  readonly notReceivedIds: readonly string[]
}

/** Result of one submission, including whether it executed now or replayed a durable outcome. */
export interface WindowSubmitResult {
  readonly receipt: WindowReceipt
  readonly outcome: 'executed' | 'replayed'
  readonly mayResend: boolean
}

/** One forwarded phone request as delivered by the relay to this PC. */
export interface RelayRequest {
  /** Relay-minted delivery id; a redelivery after a lost reply carries the same id. */
  readonly id: string
  readonly action: PcWindowAction
  /** Account the relay verified for the phone; must equal this PC's signed-in account. */
  readonly accountId: string
  readonly payload: Readonly<Record<string, unknown>>
}

/** Reply returned to the relay for one forwarded request. */
export interface RelayReply {
  readonly id: string
  readonly status: number
  readonly body: unknown
  /** Proof that the owner was rechecked at execution time (pc-relay.ts expects the `x-qianshou-pc-owner-bound` pair). */
  readonly ownerBound: { readonly version: 'v1'; readonly accountId: string } | null
}

/** Link lifecycle as reported to the owner and `qianshou:doctor`. */
export type RegistrationState = 'signed-out' | 'registering' | 'registered' | 'disconnected' | 'stopped'

/** Whitelisted diagnostics; never a token, cookie, lease secret or message text. */
export interface MobileSyncStatus {
  readonly pcId: string
  readonly pcIdSource: 'configured' | 'persisted' | 'generated'
  readonly relayUrl: string
  readonly accountId: string | null
  readonly registration: RegistrationState
  readonly registeredAt: number | null
  readonly lastHeartbeatAt: number | null
  readonly lastFailure: string | null
  readonly activeBindings: number
}
