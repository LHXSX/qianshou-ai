/** The PC session gateway: durable command admission with honest delivery receipts.
 *
 * Delivery honesty is the whole point of this component. A command is reported
 * `received` only after the Host Session authority actually admitted it; a command
 * whose outcome the gateway cannot prove stays `uncertain` and is never shown as
 * delivered. The single condition that permits a resend is an explicit
 * non-admission proof, because a command that might have been admitted must not be
 * replayed onto a real conversation.
 */
import type {
  SessionCommandPort, WindowAccess, WindowBinding, WindowCommand, WindowCommandRecord,
  WindowReceipt, WindowSubmitResult, WindowSyncPage,
} from './types.ts'
import { commandKey, originKey, PcWindowStore, type PcWindowState } from './store.ts'
import { MobileSyncError } from '../errors.ts'
import { parseBinding, parseCommand, parseCursor, parseRequestIds } from './validate.ts'

/** Stable machine-readable reasons carried on every receipt. */
export const REASON = {
  /** The Session authority admitted the command. */
  received: 'session-admitted',
  /** The cancellation was admitted to the live turn. */
  cancelAdmitted: 'cancel-admitted',
  /** The gateway cannot prove whether the command reached the Session. */
  unproven: 'outcome-unproven',
  /** The Session authority itself refused the command. */
  adapterRefused: 'session-authority-refused',
} as const

/** Wire cursor prefix; only the gateway's own counter format is accepted back. */
const CURSOR_PREFIX = 'qianshou.pc-window.cursor.v1'

/** One bounded receipt page, matching the client's declared ceiling. */
const MAX_PAGE = 500

/** Revision a conversation starts at; revision 1 is its initial state. */
const INITIAL_REVISION = 1

/** Gateway settings besides storage geometry. */
export interface PcWindowGatewayOptions {
  /** Clock used for expiry and record timestamps; injected so boundaries are testable. */
  readonly now?: () => number
}

/** Serialize one receipt-stream position. */
export function cursorText(sequence: number): string {
  return `${CURSOR_PREFIX}:${String(sequence)}`
}

/** Host-side authority over PC Session admission for paired phones. */
export class PcWindowGateway {
  private closed = false
  private readonly now: () => number

  /**
   * @param store - Durable bindings, commands and receipt sequence.
   * @param port - The existing Host Session authority, reduced to five operations.
   * @param options - Injected clock.
   */
  constructor(
    private readonly store: PcWindowStore,
    private readonly port: SessionCommandPort,
    options: PcWindowGatewayOptions = {},
  ) {
    this.now = options.now ?? (() => Date.now())
  }

  /**
   * Authorize one phone origin for one PC conversation.
   *
   * This is host-side pairing, deliberately absent from the HTTP surface: a phone
   * cannot authorize itself, so bindings are created by the deployment that owns
   * the PC. A repeated registration keeps the conversation's existing revision and
   * receipt sequence, so re-pairing can never rewind a phone's cursor.
   * @param value - Account, PC, original Session and phone to authorize.
   * @returns Whether this call created the binding, for deployment diagnostics.
   */
  registerBinding(value: unknown): Promise<boolean> {
    const binding = parseBinding(value)
    return this.store.mutate((state) => {
      const key = originKey(binding)
      if (state.bindings[key] !== undefined) return { state, result: false }
      return {
        state: {
          ...state,
          bindings: {
            ...state.bindings,
            [key]: { key, binding, revision: INITIAL_REVISION, issuedSequence: 0, registeredAt: this.now() },
          },
        },
        result: true,
      }
    })
  }

  /**
   * Report what this origin may do right now.
   *
   * `online` means this PC can admit commands for that origin; it is not a claim
   * about the phone's network path or the PC's task state.
   * @param value - Untrusted origin from the phone.
   * @returns The access state and the actions currently permitted.
   */
  async access(value: unknown): Promise<WindowAccess> {
    if (this.closed) throw new MobileSyncError('PC_WINDOW_CLOSED', 503)
    const binding = parseBinding(value)
    const state = await this.store.read()
    if (state.bindings[originKey(binding)] === undefined) return { state: 'unauthorized', allowedActions: [] }
    if (!this.port.available()) return { state: 'unavailable', allowedActions: [] }
    return { state: 'online', allowedActions: ['dispatch', 'append', 'cancel'] }
  }

  /**
   * Admit one command, or return the durable outcome of the identical earlier one.
   *
   * The command is written to durable storage before any Session is touched, so a
   * crash anywhere in this method leaves either no record (nothing was executed) or
   * an `uncertain` record (possibly executed, and reported as such).
   * @param value - Untrusted command from the phone.
   * @returns The delivery receipt, whether it was replayed, and whether a resend is permitted.
   */
  async submit(value: unknown): Promise<WindowSubmitResult> {
    if (this.closed) throw new MobileSyncError('PC_WINDOW_CLOSED', 503)
    const command = parseCommand(value)
    const known = await this.store.read()
    const existing = known.commands[command.requestId]
    // A resubmission never executes again: the durable record is the answer.
    if (existing !== undefined) return await this.replay(existing, command)

    // Everything below is refused before any Session call, which is exactly what
    // makes these refusals explicit non-admission proofs a phone may resend.
    const bindingRecord = this.requireBinding(known, command)
    this.requireTarget(command, bindingRecord.binding)
    this.requireRevision(command, bindingRecord.revision)
    if (command.expiresAt <= this.now()) throw new MobileSyncError('PC_WINDOW_COMMAND_EXPIRED', 409)
    if (!this.port.available()) throw new MobileSyncError('PC_WINDOW_SESSION_UNAVAILABLE', 503)

    await this.recordAttempt(command, bindingRecord.binding)
    return this.execute(command, bindingRecord.binding, bindingRecord.revision)
  }

  /**
   * Read every receipt and non-admission proof this phone has not seen yet.
   * @param value - Untrusted origin from the phone.
   * @param cursor - Cursor the phone last received, or `null` at the start of the stream.
   * @param requestIds - Commands the phone is actively reconciling.
   * @returns One page of receipts, the next cursor, and the ids proven not received.
   */
  async sync(value: unknown, cursor: unknown, requestIds: unknown): Promise<WindowSyncPage> {
    if (this.closed) throw new MobileSyncError('PC_WINDOW_CLOSED', 503)
    const binding = parseBinding(value)
    const from = parseCursor(cursor)
    const state = await this.store.read()
    const record = state.bindings[originKey(binding)]
    if (record === undefined) throw new MobileSyncError('PC_WINDOW_BINDING_UNKNOWN', 403)
    // A cursor ahead of anything this gateway ever issued is refused instead of
    // being treated as progress, which would silently skip unseen receipts.
    if (from > record.issuedSequence) throw new MobileSyncError('PC_WINDOW_CURSOR_FUTURE', 409)
    const wanting = new Set(parseRequestIds(requestIds))

    const mine = Object.values(state.commands)
      .filter(entry => originKey(entry.command.origin) === record.key)
      .sort((left, right) => left.sequence - right.sequence)

    const receipts: WindowReceipt[] = []
    const notReceivedIds: string[] = []
    for (const entry of mine) {
      if (entry.sequence <= from) continue
      if (entry.receipt !== null && receipts.length < MAX_PAGE) receipts.push(entry.receipt)
      // A durable `pending` record is the gateway's own proof that this command was
      // accepted for delivery and has not yet been handed to any Session.
      if (entry.outcome === 'pending' && wanting.has(entry.requestId)) notReceivedIds.push(entry.requestId)
    }

    return {
      binding,
      fromCursor: from === 0 ? null : cursorText(from),
      nextCursor: cursorText(record.issuedSequence),
      receipts,
      notReceivedIds,
    }
  }

  /** Stop accepting submissions before plugin disposal. */
  close(): void { this.closed = true }

  /** Durable outcome of an identical earlier command; a changed body is a conflict. */
  private async replay(existing: WindowCommandRecord, command: WindowCommand): Promise<WindowSubmitResult> {
    if (!sameCommand(existing.command, command)) throw new MobileSyncError('PC_WINDOW_REQUEST_CONFLICT', 409)
    if (existing.receipt !== null) {
      return { receipt: existing.receipt, outcome: 'replayed', mayResend: existing.outcome === 'rejected' }
    }
    // No decided outcome exists, which only a crash between the durable attempt
    // write and the Session call can produce. Before repeating that verdict the
    // Session's own log is asked once more: a request id found there is real
    // evidence of admission, and the record is durably upgraded to match. A
    // negative answer proves nothing, so it is never reported as a non-receipt.
    let accepted = false
    try { accepted = await this.port.alreadyAccepted(command.origin, command.requestId) } catch { accepted = false }
    if (accepted) {
      const receipt = this.admitReceipt(command, command.origin, existing.expectedRevision ?? INITIAL_REVISION)
      await this.commitOutcome(command, 'received', receipt, null)
      return { receipt, outcome: 'replayed', mayResend: false }
    }
    return {
      receipt: {
        requestId: command.requestId,
        origin: command.origin,
        revision: existing.expectedRevision ?? INITIAL_REVISION,
        state: 'uncertain',
        reason: existing.errorCode ?? REASON.unproven,
      },
      outcome: 'replayed',
      mayResend: true,
    }
  }

  /** Resolve the host-authorized binding, distinguishing "unknown" from "foreign". */
  private requireBinding(state: PcWindowState, command: WindowCommand): { readonly binding: WindowBinding; readonly revision: number } {
    const record = state.bindings[originKey(command.origin)]
    if (record !== undefined) return { binding: record.binding, revision: record.revision }
    // A binding exists for this phone and conversation under another account or
    // another PC: that is a cross-origin attempt, not an unknown device.
    const foreign = Object.values(state.bindings).some(entry =>
      entry.binding.sourceDeviceId === command.origin.sourceDeviceId
      && entry.binding.sessionId === command.origin.sessionId
      && (entry.binding.accountId !== command.origin.accountId || entry.binding.pcId !== command.origin.pcId))
    throw new MobileSyncError(foreign ? 'PC_WINDOW_FOREIGN_ORIGIN' : 'PC_WINDOW_BINDING_UNKNOWN', 403)
  }

  /** A revision-bound control may only address the origin's own bound conversation. */
  private requireTarget(command: WindowCommand, binding: WindowBinding): void {
    const action = command.action
    if (action.type === 'dispatch') return
    if (action.targetSessionId !== binding.sessionId) throw new MobileSyncError('PC_WINDOW_TARGET_MISMATCH', 409)
  }

  /** Refuse a stale control instead of blindly writing it onto newer conversation state. */
  private requireRevision(command: WindowCommand, revision: number): void {
    const action = command.action
    if (action.type === 'dispatch') return
    if (action.expectedRevision !== revision) {
      throw new MobileSyncError('PC_WINDOW_REVISION_MISMATCH', 409, { expected: action.expectedRevision, actual: revision })
    }
  }

  /** Durably record the attempt and its sequence before any Session is touched. */
  private recordAttempt(command: WindowCommand, binding: WindowBinding): Promise<void> {
    return this.store.mutate((state) => {
      const key = originKey(binding)
      const bindingRecord = state.bindings[key]
      if (bindingRecord === undefined) throw new MobileSyncError('PC_WINDOW_BINDING_UNKNOWN', 403)
      // A duplicate request id can only reach here after the earlier read saw no
      // record, so this transaction is the first to write it; the sequence advances
      // under the same lock, keeping the phone's cursor monotonic.
      const sequence = bindingRecord.issuedSequence + 1
      const action = command.action
      return {
        state: {
          ...state,
          bindings: { ...state.bindings, [key]: { ...bindingRecord, issuedSequence: sequence } },
          commands: {
            ...state.commands,
            [command.requestId]: {
              requestId: command.requestId,
              key: commandKey(binding, sequence),
              command,
              sequence,
              ...(action.type === 'dispatch' ? {} : { expectedRevision: action.expectedRevision }),
              outcome: 'attempting',
              receipt: null,
              errorCode: null,
              updatedAt: this.now(),
            },
          },
        },
        result: undefined,
      }
    })
  }

  /** Perform the admitted mutation and durably record whatever can be proven. */
  private async execute(command: WindowCommand, binding: WindowBinding, revision: number): Promise<WindowSubmitResult> {
    try {
      const action = command.action
      if (action.type === 'dispatch') await this.port.dispatch(binding, command)
      else if (action.type === 'append') await this.port.append(binding, command)
      else await this.port.cancel(binding, command)
    } catch (error) {
      return await this.proveFailure(command, binding, revision, error)
    }
    const receipt = this.admitReceipt(command, binding, revision)
    await this.commitOutcome(command, 'received', receipt, null)
    return { receipt, outcome: 'executed', mayResend: false }
  }

  /**
   * Turn a failed attempt into the strongest statement the gateway can support.
   *
   * The Session authority is asked whether this exact request id is already in the
   * durable conversation, because that alone separates "admitted but the answer was
   * lost" from "never admitted". When neither can be proven the command is recorded
   * `uncertain` and refused as `admitted: false`, never reported as delivered.
   */
  private async proveFailure(
    command: WindowCommand,
    binding: WindowBinding,
    revision: number,
    error: unknown,
  ): Promise<WindowSubmitResult> {
    const reason = error instanceof MobileSyncError ? error.code : REASON.adapterRefused
    let accepted = false
    try { accepted = await this.port.alreadyAccepted(binding, command.requestId) } catch { accepted = false }
    if (accepted) {
      const receipt = this.admitReceipt(command, binding, revision)
      await this.commitOutcome(command, 'received', receipt, null)
      return { receipt, outcome: 'executed', mayResend: false }
    }
    await this.commitOutcome(command, 'uncertain', null, reason)
    throw new MobileSyncError('PC_WINDOW_SESSION_UNAVAILABLE', 503, { admitted: false, reason, requestId: command.requestId })
  }

  /** Durably record one outcome and advance the conversation revision it was admitted against.
   *
   * The revision advance lives in the same transaction as the recorded outcome, so a
   * crash can never leave an admitted command whose revision advance was lost — which
   * would let a stale control overwrite newer conversation state after a restart.
   */
  private commitOutcome(
    command: WindowCommand,
    outcome: WindowCommandRecord['outcome'],
    receipt: WindowReceipt | null,
    errorCode: string | null,
  ): Promise<void> {
    const key = originKey(command.origin)
    return this.store.mutate((state) => {
      const existing = state.commands[command.requestId]
      const binding = state.bindings[key]
      if (existing === undefined || binding === undefined) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
      // Only an admitted command moves the conversation forward; an unproven or
      // rejected one leaves the revision exactly where a caller still expects it.
      const advances = receipt !== null && binding.revision <= receipt.revision
      return {
        state: {
          ...state,
          bindings: advances ? { ...state.bindings, [key]: { ...binding, revision: receipt.revision + 1 } } : state.bindings,
          commands: { ...state.commands, [command.requestId]: { ...existing, outcome, receipt, errorCode, updatedAt: this.now() } },
        },
        result: undefined,
      }
    })
  }

  /** Build the receipt for one admitted command. */
  private admitReceipt(command: WindowCommand, binding: WindowBinding, revision: number): WindowReceipt {
    const base = { requestId: command.requestId, origin: binding, revision }
    switch (command.action.type) {
      case 'dispatch':
        // A dispatch starts a new turn on the addressed conversation; the receipt
        // names that conversation so the phone can follow the new work.
        return { ...base, state: 'received', childSessionId: binding.sessionId, reason: REASON.received }
      case 'append':
        return { ...base, state: 'received', reason: REASON.received }
      case 'cancel':
        // `cancelled` means the cancellation was admitted to the live turn; it is not
        // a claim that the PC's work had already stopped when the receipt was written.
        return { ...base, state: 'cancelled', reason: REASON.cancelAdmitted }
      /* v8 ignore next 2 -- closed-union exhaustiveness guard */
      default: throw new MobileSyncError('PC_WINDOW_COMMAND_INVALID')
    }
  }
}

/** Whether two commands are the same submission, compared field by field. */
function sameCommand(left: WindowCommand, right: WindowCommand): boolean {
  return left.requestId === right.requestId
    && left.createdAt === right.createdAt
    && left.expiresAt === right.expiresAt
    && originKey(left.origin) === originKey(right.origin)
    && JSON.stringify(left.action) === JSON.stringify(right.action)
}
