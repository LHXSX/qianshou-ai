/** Durable PC-window command log: bindings, commands and the phone's receipt cursor.
 *
 * The file is replaced atomically and read back strictly: a corrupt or
 * unknown-version file is refused instead of being partially adopted, because a
 * half-understood command log would misreport whether work already happened.
 */
import { open } from 'node:fs/promises'
import { writePrivateAtomic } from '../atomic-file.ts'
import { MobileSyncError } from '../errors.ts'
import { parseBinding } from './validate.ts'
import {
  PC_WINDOW_STORE_VERSION,
  type PcWindowFile,
  type WindowBinding,
  type WindowBindingRecord,
  type WindowCommand,
  type WindowCommandRecord,
  type WindowReceipt,
} from './types.ts'

/** Bounded capacity settings for one deployment-owned private file. */
export interface PcWindowStoreConfig {
  /** Absolute private path holding every binding and command. */
  readonly path: string
  /** Maximum retained host-authorized bindings. */
  readonly maxBindings: number
  /** Maximum retained command records. */
  readonly maxCommands: number
  /** Maximum accepted file size in bytes. */
  readonly maxBytes: number
}

/** The durable state one transaction reads and may replace. */
export interface PcWindowState {
  readonly bindings: Readonly<Record<string, WindowBindingRecord>>
  readonly commands: Readonly<Record<string, WindowCommandRecord>>
}

/** Durable gateway state with a single in-process transaction serialization point.
 *
 * Every mutation runs through one promise chain, so two concurrent submissions of
 * the same request id cannot both read "not yet attempted" and both then decide to
 * execute; the second observes the first command's record instead.
 */
export class PcWindowStore {
  private closed = false
  private tail: Promise<unknown> = Promise.resolve()
  private readonly pending = new Set<Promise<unknown>>()

  /** @param config - Absolute private path and deployment-owned capacity limits. */
  constructor(private readonly config: PcWindowStoreConfig) {}

  /** Read durable state without mutating it.
   * @returns The current bindings and commands in stable key order.
   */
  read(): Promise<PcWindowState> { return this.enqueue(() => this.load()) }

  /** Apply one transformation and durably publish the result.
   *
   * The transformation runs inside the serialized section, so it observes every
   * earlier committed transaction and its own decision is what gets written.
   * @param transform - Pure state transformation; it must not perform I/O.
   * @returns Whatever the transformation returned, after the write succeeds.
   */
  mutate<T>(transform: (state: PcWindowState) => { readonly state: PcWindowState; readonly result: T }): Promise<T> {
    return this.enqueue(async () => {
      const current = await this.load()
      const { state, result } = transform(current)
      const next: PcWindowFile = {
        version: PC_WINDOW_STORE_VERSION,
        bindings: state.bindings,
        commands: state.commands,
      }
      const content = JSON.stringify(next)
      if (Buffer.byteLength(content) > this.config.maxBytes) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
      if (Object.keys(next.bindings).length > this.config.maxBindings) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
      if (Object.keys(next.commands).length > this.config.maxCommands) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
      await writePrivateAtomic(this.config.path, content, () => new MobileSyncError('PC_WINDOW_STORE_UNAVAILABLE', 503))
      return result
    })
  }

  /** Stop new transactions and drain accepted writes before plugin disposal. */
  async close(): Promise<void> {
    this.closed = true
    await Promise.allSettled(this.pending)
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new MobileSyncError('PC_WINDOW_CLOSED', 503))
    const run = this.tail.then(operation, operation)
    this.tail = run.catch(() => undefined)
    this.pending.add(run)
    void run.finally(() => this.pending.delete(run)).catch(() => undefined)
    return run
  }

  private async load(): Promise<PcWindowState> {
    let text: string
    try {
      const handle = await open(this.config.path, 'r')
      try {
        if ((await handle.stat()).size > this.config.maxBytes) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
        text = await handle.readFile({ encoding: 'utf8' })
      } finally { await handle.close() }
    } catch (error) {
      if (error instanceof MobileSyncError) throw error
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { bindings: {}, commands: {} }
      throw new MobileSyncError('PC_WINDOW_STORE_UNAVAILABLE', 503)
    }
    return parseFile(text)
  }
}

/** Storage key for one origin; every axis participates so accounts cannot collide. */
export function originKey(binding: WindowBinding): string {
  return JSON.stringify([binding.accountId, binding.pcId, binding.sessionId, binding.sourceDeviceId])
}

/** Storage key of one command inside its phone's stream. */
export function commandKey(binding: WindowBinding, sequence: number): string {
  return `${originKey(binding)}#${String(sequence)}`
}

function parseFile(text: string): PcWindowState {
  let value: unknown
  try { value = JSON.parse(text) } catch { throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503) }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  const file = value as { version?: unknown; bindings?: unknown; commands?: unknown }
  if (file.version !== PC_WINDOW_STORE_VERSION) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  return { bindings: parseBindings(file.bindings), commands: parseCommands(file.commands) }
}

function parseBindings(value: unknown): Record<string, WindowBindingRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  const rows = value as Record<string, unknown>
  return Object.fromEntries(Object.entries(rows).map(([key, raw]) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
    const row = raw as Record<string, unknown>
    const binding = parseStoredBinding(row.binding)
    if (key !== originKey(binding)) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
    return [key, {
      key,
      binding,
      revision: storedRevision(row.revision),
      issuedSequence: storedSequence(row.issuedSequence),
      registeredAt: storedInstant(row.registeredAt),
    } satisfies WindowBindingRecord]
  }))
}

function parseCommands(value: unknown): Record<string, WindowCommandRecord> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  const rows = value as Record<string, unknown>
  return Object.fromEntries(Object.entries(rows).map(([key, raw]) => {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
    const row = raw as Record<string, unknown>
    const requestId = storedId(row.requestId)
    if (key !== requestId) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
    const command = parseStoredCommand(row.command)
    if (command.requestId !== requestId) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
    const outcome = storedOutcome(row.outcome)
    const receipt = row.receipt === null || row.receipt === undefined ? null : parseStoredReceipt(row.receipt)
    if (receipt !== null && receipt.requestId !== requestId) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
    return [key, {
      requestId,
      key: storedId(row.key),
      command,
      sequence: storedSequence(row.sequence),
      ...(row.expectedRevision === undefined ? {} : { expectedRevision: storedRevision(row.expectedRevision) }),
      ...(row.admissionRevision === undefined ? {} : { admissionRevision: storedRevision(row.admissionRevision) }),
      // A process that died between recording the attempt and observing its outcome
      // cannot prove either result. Reloading it as `uncertain` is what keeps a
      // crash from being reported as "never sent" (or as delivered).
      outcome: outcome === 'attempting' ? 'uncertain' : outcome,
      receipt,
      errorCode: row.errorCode === null || row.errorCode === undefined ? null : storedId(row.errorCode),
      updatedAt: storedInstant(row.updatedAt),
    } satisfies WindowCommandRecord]
  }))
}

function parseStoredCommand(value: unknown): WindowCommand {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  const row = value as Record<string, unknown>
  const raw = row.action
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  const action = raw as Record<string, unknown>
  let parsed: WindowCommand['action']
  if (action.type === 'dispatch') {
    parsed = {
      type: 'dispatch',
      text: storedText(action.text, 16_000),
      ...(action.label === undefined ? {} : { label: storedText(action.label, 200) }),
    }
  } else if (action.type === 'append') {
    parsed = {
      type: 'append',
      targetSessionId: storedId(action.targetSessionId),
      expectedRevision: storedRevision(action.expectedRevision),
      text: storedText(action.text, 16_000),
    }
  } else if (action.type === 'cancel') {
    parsed = {
      type: 'cancel',
      targetSessionId: storedId(action.targetSessionId),
      expectedRevision: storedRevision(action.expectedRevision),
    }
  } else {
    throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  }
  return {
    requestId: storedId(row.requestId),
    origin: parseStoredBinding(row.origin),
    createdAt: storedInstant(row.createdAt),
    expiresAt: storedInstant(row.expiresAt),
    action: parsed,
  }
}

function parseStoredReceipt(value: unknown): WindowReceipt {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  const row = value as Record<string, unknown>
  const state = row.state
  if (state !== 'received' && state !== 'rejected' && state !== 'cancelled' && state !== 'uncertain') throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  return {
    requestId: storedId(row.requestId),
    origin: parseStoredBinding(row.origin),
    revision: storedRevision(row.revision),
    state,
    ...(row.childSessionId === undefined ? {} : { childSessionId: storedId(row.childSessionId) }),
    reason: row.reason === null || row.reason === undefined ? null : storedText(row.reason, 1000),
  }
}

/** A stored binding keeps the same bounds as the wire form, so neither can smuggle a wider origin. */
function parseStoredBinding(value: unknown): WindowBinding {
  try { return parseBinding(value) } catch { throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503) }
}

function storedId(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > 512 || value.includes('\0')) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  return value
}

function storedText(value: unknown, max: number): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > max || value.includes('\0')) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  return value
}

function storedRevision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  return value as number
}

function storedSequence(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  return value as number
}

function storedInstant(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  return value as number
}

function storedOutcome(value: unknown): WindowCommandRecord['outcome'] {
  if (value !== 'pending' && value !== 'attempting' && value !== 'received' && value !== 'rejected' && value !== 'cancelled' && value !== 'uncertain') {
    throw new MobileSyncError('PC_WINDOW_STORE_INVALID', 503)
  }
  return value
}
