/** The server binds this tuple to an authenticated socket and its opaque lease token. */
export interface EdgeTaskIdentity {
  readonly workerId: string
  readonly workloadId: string
  readonly shardId: string
  readonly attempt: number
}

/** Task data from an authenticated test connection, requiring separate Host execution authorization. */
export interface EdgeTaskOffer extends EdgeTaskIdentity {
  readonly taskType: string
  readonly runtime: string
  readonly inputKind: string
  readonly inlineInput: string | null
  readonly inputRef: string
  readonly inputRefs: readonly string[]
  readonly codeUrl: string
  readonly codeSha256: string
  readonly timeoutSeconds: number
  readonly verificationPolicy: 'semantic' | 'artifact' | 'quarantine'
  readonly executionModel: string
  readonly capability: string
  readonly capabilityVersion: string
}

/** Existing inline_output result form. Session/tool provenance remains in the Host's own evidence. */
export interface EdgeInlineResult {
  readonly inlineOutputUtf8: string
  readonly elapsedMs: number
}

/** A local send receipt, never a server result acceptance or settlement receipt. */
export interface EdgeResultSent {
  readonly state: 'sent-awaiting-verification'
}

/** Safe connection events omit raw network messages and lease credentials. */
export type EdgeWorkerEvent =
  | { readonly type: 'authenticated'; readonly workerId: string; readonly ownerId: number }
  | { readonly type: 'heartbeat-acknowledged' }
  | { readonly type: 'closed'; readonly reason: string }

/** Transport-only operations. The Host owns task policy, autonomous sessions and outcome reconciliation. */
export interface EdgeWorkerPort {
  connect(signal?: AbortSignal): Promise<void>
  updateMode(mode: 'running' | 'paused'): void
  reportProgress(identity: EdgeTaskIdentity, fraction: number): void
  complete(identity: EdgeTaskIdentity, result: EdgeInlineResult): EdgeResultSent
  close(): Promise<void>
}
