/**
 * PC window port: owner-checked bootstrap, access, transcript, sync and idempotent submit. Every operation names
 * the account the relay verified and compares it with the account currently signed in on this PC before and after
 * touching the Session; a changed owner is an explicit `PC_WINDOW_OWNER_CHANGED` refusal, never a silent pass.
 */
import { MobileSyncFailure, safeFailure } from './failure.ts'
import type { MobileSessionPort } from './session-port.ts'
import { digest, MobileSyncStore } from './store.ts'
import type { BindingRecord, StoredReceipt } from './store.ts'
import type { PcWindowAction, RelayReply, RelayRequest, WindowAccess, WindowBinding, WindowBootstrap, WindowCommand, WindowReceipt,
  WindowSubmitResult, WindowSyncPage, WindowTranscript } from './types.ts'
import { isOpaqueId, parseBinding, parseCommand, parseRequestIds, parseSyncCursor, parseTranscriptCursor, record, syncCursor } from './validation.ts'

/** Text actions this PC admits; `cancel` is refused with `PC_WINDOW_ACTION_UNSUPPORTED` until a cancel port exists. */
const ALLOWED_ACTIONS: readonly WindowAccess['allowedActions'][number][] = ['dispatch', 'append']
const MAX_SYNC_PAGE = 500

/** Deployment limits and the current-owner source. */
export interface PcWindowServiceOptions {
  readonly pcId: string
  /**
   * Live PC id when it arrives after construction. The Shanghai worker id is the
   * phone's pcId; an empty result refuses with `PC_WINDOW_PC_ID_INVALID`.
   */
  readonly pcIdOf?: () => string
  /** Account currently signed in on this PC, or `null`; read at every check, never cached across operations. */
  readonly currentAccount: () => string | null
  readonly maxRequests: number
  readonly timeoutMs: number
  readonly now?: () => number
}

/** Request coordinator over the store and the shared Session port. */
export class PcWindowService {
  private readonly lifetime = new AbortController()
  private readonly active = new Set<AbortController>()
  private readonly pending = new Set<Promise<unknown>>()
  private readonly sending = new Map<string, { hash: string; promise: Promise<WindowSubmitResult> }>()
  private readonly now: () => number
  constructor(private readonly store: MobileSyncStore, private readonly port: MobileSessionPort, private readonly options: PcWindowServiceOptions) {
    this.now = options.now ?? Date.now
  }
  private live(): void { if (this.lifetime.signal.aborted) throw new MobileSyncFailure('CLOSED') }
  /** Shanghai worker id once this PC is online; a missing id is not a binding. */
  private pcId(): string {
    const value = this.options.pcIdOf?.() ?? this.options.pcId
    if (!isOpaqueId(value)) throw new MobileSyncFailure('PC_ID_INVALID')
    return value
  }
  /** Current account after refusing a signed-out PC or a relay principal that differs from it. */
  private owner(claimed: string): string {
    const current = this.options.currentAccount()
    if (current === null) throw new MobileSyncFailure('NOT_SIGNED_IN')
    if (claimed !== current) throw new MobileSyncFailure('OWNER_CHANGED')
    return current
  }
  /** Live binding for the claimed account and this PC; distinguishes foreign, unknown and revoked bindings. */
  private bound(claimed: string, binding: WindowBinding): BindingRecord {
    const current = this.owner(claimed)
    if (binding.accountId !== current) throw new MobileSyncFailure('OWNER_CHANGED')
    if (binding.pcId !== this.pcId()) throw new MobileSyncFailure('BINDING_UNKNOWN')
    const found = this.store.binding(binding)
    if (!found) throw new MobileSyncFailure('BINDING_UNKNOWN')
    if (found.revoked) throw new MobileSyncFailure('BINDING_REVOKED')
    return found
  }
  /**
   * Create or refresh the phone's binding to one continuable Session of the signed-in account.
   * @param claimed - Account the relay verified for the phone.
   * @param payload - `{ deviceId, sessionId? }` (pc-relay.ts bootstrap forwarding).
   * @returns Binding, access and the continuable Session list.
   */
  bootstrap(claimed: string, payload: unknown): Promise<WindowBootstrap> {
    this.live()
    const input = record(payload)
    if (!isOpaqueId(input.deviceId) || (input.sessionId !== undefined && !isOpaqueId(input.sessionId))) throw new MobileSyncFailure('BAD_REQUEST')
    const deviceId = input.deviceId, named = input.sessionId
    const accountId = this.owner(claimed)
    return this.run(async (signal) => {
      const sessions = await this.port.listContinuable(signal)
      let sessionId: string
      if (named !== undefined) { await this.port.requireContinuable(named, signal); sessionId = named }
      else {
        const first = sessions[0]
        if (first === undefined) throw new MobileSyncFailure('NO_SESSION')
        sessionId = first.sessionId
      }
      signal.throwIfAborted(); this.owner(claimed)
      const binding: WindowBinding = { accountId, pcId: this.pcId(), sessionId, sourceDeviceId: deviceId }
      this.store.register(binding, this.now())
      return { binding, access: { state: 'online', allowedActions: ALLOWED_ACTIONS }, sessions }
    })
  }
  /**
   * Report what a binding may do now. Unknown or revoked bindings answer `unauthorized` rather than an error so the
   * phone can offer re-bootstrap; a changed owner still refuses.
   * @param claimed - Relay-verified account.
   * @param payload - `{ binding }`.
   * @returns Access state and permitted actions.
   */
  async access(claimed: string, payload: unknown): Promise<WindowAccess> {
    this.live()
    const binding = parseBinding(record(payload).binding)
    try { this.bound(claimed, binding) }
    catch (error) {
      if (error instanceof MobileSyncFailure && (error.kind === 'BINDING_UNKNOWN' || error.kind === 'BINDING_REVOKED')) return { state: 'unauthorized', allowedActions: [] }
      throw error
    }
    return { state: 'online', allowedActions: ALLOWED_ACTIONS }
  }
  /**
   * Read a bounded increment of the bound Session's committed text.
   * @param claimed - Relay-verified account.
   * @param payload - `{ binding, cursor? }`.
   * @returns Text page with the binding echo.
   */
  transcript(claimed: string, payload: unknown): Promise<WindowTranscript> {
    this.live()
    const input = record(payload), binding = parseBinding(input.binding), cursor = parseTranscriptCursor(input.cursor)
    const found = this.bound(claimed, binding)
    return this.run(async (signal) => {
      const page = await this.port.transcript(binding, cursor, signal)
      signal.throwIfAborted(); this.bound(claimed, binding)
      this.store.touch(found.key, this.now())
      return { binding, ...page }
    })
  }
  /**
   * Read receipts after the phone's cursor and name the reconciled ids this PC never claimed.
   * @param claimed - Relay-verified account.
   * @param payload - `{ binding, cursor, requestIds }`.
   * @returns One receipt page.
   */
  async sync(claimed: string, payload: unknown): Promise<WindowSyncPage> {
    this.live()
    const input = record(payload), binding = parseBinding(input.binding)
    const from = parseSyncCursor(input.cursor), requestIds = parseRequestIds(input.requestIds)
    const found = this.bound(claimed, binding)
    if (from > found.issuedSequence) throw new MobileSyncFailure('CURSOR_FUTURE')
    const receipts = this.store.receiptsAfter(found.key, from, MAX_SYNC_PAGE).map(receipt => this.receiptOf(binding, receipt))
    const notReceivedIds = requestIds.filter(requestId => this.store.receipt(found.key, requestId) === undefined)
    this.bound(claimed, binding)
    return { binding, fromCursor: from === 0 ? null : syncCursor(from), nextCursor: syncCursor(found.issuedSequence), receipts, notReceivedIds }
  }
  /**
   * Admit one text command once, or return the durable outcome of the identical earlier one.
   * @param claimed - Relay-verified account.
   * @param payload - `{ command }`.
   * @returns Receipt, whether it executed now, and whether an explicit non-admission permits resend.
   */
  submit(claimed: string, payload: unknown): Promise<WindowSubmitResult> {
    this.live()
    const command = parseCommand(record(payload).command)
    const found = this.bound(claimed, command.origin)
    const key = found.key, hash = digest(JSON.stringify([command.origin, command.createdAt, command.expiresAt, command.action]))
    const existing = this.store.receipt(key, command.requestId)
    if (existing && existing.bodyHash !== hash) throw new MobileSyncFailure('REQUEST_CONFLICT')
    const admit = existing === undefined ? this.admission(command) : null
    const single = `${key}:${command.requestId}`, activeSend = this.sending.get(single)
    if (activeSend) { if (activeSend.hash !== hash) throw new MobileSyncFailure('REQUEST_CONFLICT'); return activeSend.promise }
    const promise = this.run(async (signal) => {
      const receipt = this.store.claim(key, command.requestId, hash)
      const check = (): void => { signal.throwIfAborted(); this.live(); this.bound(claimed, command.origin) }
      if (admit === null) {
        if (receipt.state === 'received') return this.result(command, receipt, 'replayed')
        if (!await this.port.admitted(command.origin.sessionId, receipt.rpcId, signal)) return this.result(command, receipt, 'replayed')
      } else {
        check()
        try { await this.port.submit(command.origin.sessionId, receipt.rpcId, admit.text, signal, check) }
        catch (error) {
          const failure = safeFailure(error)
          // Admission may already have happened before the failure; the Session log is the only proof either way.
          const admitted = await this.port.admitted(command.origin.sessionId, receipt.rpcId, this.lifetime.signal).catch(() => false)
          if (!admitted) { this.store.unproven(key, command.requestId, failure.code); throw failure }
        }
      }
      return this.result(command, this.store.received(key, command.requestId, this.now()), admit === null ? 'replayed' : 'executed')
    }).finally(() => { this.sending.delete(single) })
    this.sending.set(single, { hash, promise })
    return promise
  }
  /**
   * Text one first admission will queue. Only an unclaimed request reaches this, so every non-text action and an
   * expired lifetime is refused here, before any claim exists.
   */
  private admission(command: WindowCommand): { readonly text: string } {
    if (command.action.type === 'cancel') throw new MobileSyncFailure('ACTION_UNSUPPORTED')
    if (command.action.type === 'append' && command.action.targetSessionId !== command.origin.sessionId) throw new MobileSyncFailure('TARGET_MISMATCH')
    if (command.expiresAt <= this.now()) throw new MobileSyncFailure('COMMAND_EXPIRED')
    return { text: command.action.text }
  }
  /**
   * Dispatch one forwarded relay request and project any refusal as a stable error body.
   * @param request - Validated relay envelope.
   * @returns Reply with the owner-bound proof when the owner check ran for this request.
   */
  async handle(request: RelayRequest): Promise<RelayReply> {
    try {
      const body = await this.dispatch(request.action, request.accountId, request.payload)
      return { id: request.id, status: 200, body, ownerBound: { version: 'v1', accountId: request.accountId } }
    } catch (error) {
      const failure = safeFailure(error)
      return { id: request.id, status: failure.status, body: { error: { code: failure.code, message: failure.code } }, ownerBound: null }
    }
  }
  private dispatch(action: PcWindowAction, accountId: string, payload: unknown): Promise<unknown> {
    switch (action) {
      case 'bootstrap': return this.bootstrap(accountId, payload)
      case 'access': return this.access(accountId, payload)
      case 'transcript': return this.transcript(accountId, payload)
      case 'sync': return this.sync(accountId, payload)
      case 'submit': return this.submit(accountId, payload)
      default: return Promise.reject(unreachable(action))
    }
  }
  /**
   * Revoke every binding after a sign-out or account switch; already admitted commands are not rolled back.
   * @returns Number of bindings revoked.
   */
  revokeAll(): number { this.live(); return this.store.revokeAll() }
  /**
   * Live binding count for diagnostics.
   * @returns Number of bindings that are not revoked.
   */
  activeBindings(): number { this.live(); return this.store.activeBindings() }
  private receiptOf(binding: WindowBinding, receipt: StoredReceipt): WindowReceipt {
    // A receipt keeps a null reason only between its claim and any outcome, which is exactly the unproven window.
    return { requestId: receipt.requestId, origin: binding, revision: receipt.sequence, state: receipt.state,
      reason: receipt.reason ?? 'outcome-unproven',
      ...(receipt.state === 'received' ? { childSessionId: binding.sessionId } : {}) }
  }
  private result(command: WindowCommand, receipt: StoredReceipt, outcome: WindowSubmitResult['outcome']): WindowSubmitResult {
    return { receipt: this.receiptOf(command.origin, receipt), outcome, mayResend: receipt.state === 'rejected' }
  }
  private run<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.live()
    if (this.active.size >= this.options.maxRequests) throw new MobileSyncFailure('CAPACITY')
    const controller = new AbortController()
    const timer = setTimeout(() => { controller.abort(new MobileSyncFailure('TIMEOUT')) }, this.options.timeoutMs)
    timer.unref()
    const signal = AbortSignal.any([controller.signal, this.lifetime.signal])
    this.active.add(controller)
    const promise = Promise.resolve().then(() => { signal.throwIfAborted(); return operation(signal) })
      .catch((error: unknown) => { throw safeFailure(signal.aborted && signal.reason instanceof MobileSyncFailure ? signal.reason : error) })
      .finally(() => { clearTimeout(timer); this.active.delete(controller); this.pending.delete(promise) })
    this.pending.add(promise)
    return promise
  }
  /** Reject new operations, abort current work and close the store once nothing can touch it. */
  async dispose(): Promise<void> {
    this.lifetime.abort(new MobileSyncFailure('CLOSED'))
    await Promise.allSettled([...this.pending, ...[...this.sending.values()].map(value => value.promise)])
    this.store.close()
  }
}
function unreachable(_action: never): MobileSyncFailure { return new MobileSyncFailure('BAD_REQUEST') }
