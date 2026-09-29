/** Account-scoped agent sessions and authorized PC discovery supplied by the embedding host. */
import type { PcWindowPort, WindowJournalStore, WindowTranscript, WindowBinding } from '@deepseek-ai/dsh-client-pc-window-bridge'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import type { TriggerDecision } from '@deepseek-ai/dsh-client-compute-trigger'

/** A cloud agent Session belongs to exactly one authenticated account. */
export interface AgentSessionBinding {
  readonly accountId: string
  readonly sessionId: WindowBinding['sessionId']
}

/** Original agent events projected by the Session authority; admission is not a generated answer. */
export interface AgentSessionTranscript {
  readonly binding: AgentSessionBinding
  readonly status: 'idle' | 'running' | 'unavailable'
  readonly turns: WindowTranscript['turns']
}

/** Agent runtime adapter, never a raw model completion adapter. */
export interface MobileAgentSessionPort {
  /** Create a new independent Session for this account; the server verifies ownership. */
  readonly open: (accountId: string, sourceDeviceId: string, signal: AbortSignal) => Promise<AgentSessionBinding>
  /** List ready Sessions for this account, oldest first. Absent means this host cannot resume. */
  readonly list?: (accountId: string, signal: AbortSignal) => Promise<readonly AgentSessionBinding[]>
  /** Read the authoritative Session projection, including pending work. */
  readonly inspect: (binding: AgentSessionBinding, signal: AbortSignal) => Promise<AgentSessionTranscript>
  /** Admit one user turn to the agent loop with a stable request id. No inferred retries. */
  readonly submit: (
    binding: AgentSessionBinding, command: { readonly requestId: SessionRequestId; readonly text: string }, signal: AbortSignal,
  ) => Promise<{
    readonly binding: AgentSessionBinding
    readonly requestId: SessionRequestId
    readonly state: 'received' | 'uncertain' | 'rejected'
  }>
}

/** Same-account PC facts from an authenticated directory, not phone-supplied connection addresses. */
export interface AccountPc {
  readonly accountId: string
  readonly pcId: string
  readonly label: string
  readonly platform: 'windows' | 'macos'
  readonly online: boolean
}

/** Directory and relay adapters independently verify account/device ownership. */
export interface AccountPcDirectoryPort {
  readonly list: (accountId: string, signal: AbortSignal) => Promise<readonly AccountPc[]>
  readonly connect: (pc: AccountPc, signal: AbortSignal) => Promise<PcWindowPort>
}

/** Embedding dependencies; absent adapters remain visibly unavailable. */
export interface MobileWorkspaceOptions {
  readonly account: () => string | null
  /** Notify on login, logout or account replacement; disposer removes the listener. */
  readonly subscribeAccount: (listener: () => void) => () => void
  readonly deviceId: string
  readonly requestId: () => SessionRequestId
  readonly now: () => number
  readonly commandTtlMs: number
  readonly foregroundRefreshMs: number
  readonly foregroundRefreshWindowMs: number
  readonly agent?: MobileAgentSessionPort
  readonly directory?: AccountPcDirectoryPort
  readonly pcStore: WindowJournalStore
  readonly locale?: 'zh-CN' | 'en'
}

/** The original execution target survives a disconnect. */
export type MobileConversationTarget =
  | { readonly kind: 'agent'; readonly binding: AgentSessionBinding }
  | { readonly kind: 'pc'; readonly binding: WindowBinding; readonly label: string }

/** Visible admission records do not claim a completed agent task. */
export interface MobileAdmission {
  readonly requestId: SessionRequestId
  readonly text: string
  readonly state: string
}

/** Detached view consumed by the window painter. */
export interface MobileWorkspaceSnapshot {
  readonly accountId: string | null
  readonly directoryState: 'unconfigured' | 'idle' | 'loading' | 'ready' | 'error'
  readonly devices: readonly AccountPc[]
  readonly target: MobileConversationTarget | null
  readonly conversations: readonly MobileConversationTarget[]
  readonly turns: WindowTranscript['turns']
  readonly admissions: readonly MobileAdmission[]
  readonly status: 'idle' | 'running' | 'offline' | 'unavailable'
  readonly pending: boolean
  readonly error: 'signed-out' | 'agent-unavailable' | 'directory-error' | 'pc-offline' | 'target-error' | 'send-error' | null
  readonly draft: TriggerDecision | null
}
