/** Durable local /prompt submission facts for one resident ComfyUI video attempt. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { ComputeError } from './errors.ts'
import type { ResidentAttempt } from './resident/types.ts'
import type { ComputeTaskStatus } from './task-state.ts'
import type { ComputeTaskStore } from './task-store.ts'

const HASH = /^[a-f0-9]{64}$/u
const DIGEST = /^sha256:[a-f0-9]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const PROMPT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const MAX_BYTES = 4096
const TERMINAL = new Set<ComputeTaskStatus>(['SETTLED', 'FAILED', 'REVOKED', 'EXPIRED', 'REFUSED'])

/** A local submission remains unresolved after an unknown POST; no retry is inferred. */
export interface ComfyVideoAttemptRecord {
  readonly schema: 'qianshou.comfy-video-attempt.v1'
  readonly taskId: string
  readonly attempt: number
  readonly attemptId: string
  readonly envelopeFingerprint: string
  readonly idempotencyKey: string
  readonly leaseExpiresAt: string
  readonly contractDigest: string
  readonly graphSha256: string
  readonly promptId: string | null
  readonly resultSha256: string | null
  /** Terminal evidence is required before reclaiming an attempt that provably never reached /prompt. */
  readonly terminalEvidenceSha256: string | null
  readonly state: 'reserved' | 'submitting' | 'submitted' | 'local-verified' | 'never-submitted'
}

/** A Host-verified authoritative terminal receipt; the ledger does not trust browser state. */
export interface ComfyVideoTerminalEvidence {
  readonly taskId: string
  readonly attempt: number
  readonly status: ComputeTaskStatus
  readonly sha256: string
}

function invalid(): never { throw new ComputeError('COMPUTE_COMFY_VIDEO_ATTEMPT_INVALID', 409) }
function exact(record: Record<string, unknown>): ComfyVideoAttemptRecord {
  if (Object.keys(record).sort().join(',') !== 'attempt,attemptId,contractDigest,envelopeFingerprint,graphSha256,idempotencyKey,leaseExpiresAt,promptId,resultSha256,schema,state,taskId,terminalEvidenceSha256'
    || record.schema !== 'qianshou.comfy-video-attempt.v1'
    || typeof record.taskId !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(record.taskId)
    || !Number.isSafeInteger(record.attempt) || Number(record.attempt) < 1
    || typeof record.attemptId !== 'string' || !UUID.test(record.attemptId)
    || typeof record.envelopeFingerprint !== 'string' || !HASH.test(record.envelopeFingerprint)
    || typeof record.idempotencyKey !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/u.test(record.idempotencyKey)
    || typeof record.leaseExpiresAt !== 'string' || !Number.isFinite(Date.parse(record.leaseExpiresAt))
    || typeof record.contractDigest !== 'string' || !DIGEST.test(record.contractDigest)
    || typeof record.graphSha256 !== 'string' || !HASH.test(record.graphSha256)
    || (record.promptId !== null && (typeof record.promptId !== 'string' || !PROMPT_ID.test(record.promptId)))
    || (record.resultSha256 !== null && (typeof record.resultSha256 !== 'string' || !HASH.test(record.resultSha256)))
    || (record.terminalEvidenceSha256 !== null && (typeof record.terminalEvidenceSha256 !== 'string' || !HASH.test(record.terminalEvidenceSha256)))
    || (record.state !== 'reserved' && record.state !== 'submitting' && record.state !== 'submitted'
      && record.state !== 'local-verified' && record.state !== 'never-submitted')
    || ((record.state === 'reserved' || record.state === 'submitting')
      && (record.promptId !== null || record.resultSha256 !== null || record.terminalEvidenceSha256 !== null))
    || (record.state === 'submitted' && (record.promptId === null || record.resultSha256 !== null))
    || (record.state === 'local-verified' && (record.promptId === null || record.resultSha256 === null))
    || (record.state === 'never-submitted'
      && (record.promptId !== null || record.resultSha256 !== null || record.terminalEvidenceSha256 === null))
    || (record.state !== 'never-submitted' && record.terminalEvidenceSha256 !== null)) invalid()
  return record as unknown as ComfyVideoAttemptRecord
}

/** Owner-private, cross-process one-shot journal. Completion here is local MP4 verification, not order settlement. */
export class ComfyVideoAttemptLedger {
  constructor(private readonly path: string, private readonly taskStore: Pick<ComputeTaskStore, 'get'>) {
    if (!isAbsolute(path)) invalid()
  }

  private async read(): Promise<ComfyVideoAttemptRecord | null> {
    let handle
    try { handle = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      return invalid()
    }
    try {
      const before = await handle.stat()
      const named = await lstat(this.path)
      if (!before.isFile() || before.nlink !== 1 || before.size < 2 || before.size > MAX_BYTES
        || named.isSymbolicLink() || before.dev !== named.dev || before.ino !== named.ino
        || process.getuid && (before.uid !== process.getuid() || (before.mode & 0o077) !== 0)) invalid()
      const bytes = await handle.readFile()
      const after = await handle.stat()
      if (bytes.length !== before.size || after.size !== before.size || after.ino !== before.ino) invalid()
      const parsed: unknown = JSON.parse(bytes.toString('utf8'))
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
        || JSON.stringify(parsed) !== bytes.toString('utf8')) invalid()
      return exact(parsed as Record<string, unknown>)
    } catch { return invalid() }
    finally { await handle.close() }
  }

  private async write(record: ComfyVideoAttemptRecord): Promise<void> {
    const bytes = JSON.stringify(record)
    if (Buffer.byteLength(bytes) > MAX_BYTES) invalid()
    // Node does not provide a verified durable parent-directory flush on Windows.
    // A one-shot /prompt claim must fail closed there until a platform-specific
    // durable journal is proven on the actual target filesystem.
    if (process.platform === 'win32') throw new ComputeError('COMPUTE_COMFY_VIDEO_DURABILITY_UNAVAILABLE', 503)
    const parent = dirname(this.path)
    const directory = await lstat(parent).catch(() => invalid())
    if (!directory.isDirectory() || directory.isSymbolicLink()
      || process.getuid && (directory.uid !== process.getuid() || (directory.mode & 0o077) !== 0)) invalid()
    const temporary = `${this.path}.${randomUUID()}.tmp`
    let handle
    let renamed = false
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600)
      await handle.writeFile(bytes)
      await handle.sync()
      await handle.close()
      handle = undefined
      await rename(temporary, this.path)
      renamed = true
      const dirHandle = await open(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
      try { await dirHandle.sync() } finally { await dirHandle.close() }
    } catch {
      throw new ComputeError('COMPUTE_COMFY_VIDEO_DURABILITY_UNAVAILABLE', 503)
    } finally {
      if (handle) await handle.close().catch(() => {})
      if (!renamed) await unlink(temporary).catch(() => {})
    }
    const readback = await this.read()
    if (JSON.stringify(readback) !== bytes) invalid()
  }

  private async executing(binding: Pick<ResidentAttempt, 'taskId' | 'attempt' | 'envelopeFingerprint' | 'idempotencyKey' | 'leaseExpiresAt'>): Promise<void> {
    const state = await this.taskStore.get(binding.taskId, binding.attempt)
    if (state?.status !== 'EXECUTING' || state.envelopeFingerprint !== binding.envelopeFingerprint
      || state.idempotencyKey !== binding.idempotencyKey || state.leaseExpiresAt !== binding.leaseExpiresAt
      || Date.parse(binding.leaseExpiresAt) <= Date.now()) invalid()
  }

  /** Reserve one accepted resident task before any image upload or GPU request.
   * @param binding - Verified and started resident assignment.
   * @param contractDigest - Reviewed public declaration digest.
   * @param graphSha256 - Exact owner-private graph digest.
   * @returns Host-minted attempt ID for this one submission.
   */
  async reserve(binding: ResidentAttempt, contractDigest: string, graphSha256: string): Promise<ComfyVideoAttemptRecord> {
    if (!DIGEST.test(contractDigest) || !HASH.test(graphSha256)) invalid()
    if (process.platform === 'win32') throw new ComputeError('COMPUTE_COMFY_VIDEO_DURABILITY_UNAVAILABLE', 503)
    await this.executing(binding)
    // The owner-private directory must be provisioned and synced by the Host.
    // Creating it here would require syncing each new ancestor before a POST.
    const parent = await lstat(dirname(this.path)).catch(() => invalid())
    if (!parent.isDirectory() || parent.isSymbolicLink()
      || process.getuid && (parent.uid !== process.getuid() || (parent.mode & 0o077) !== 0)) invalid()
    return withFileLock(this.path, async () => {
      const old = await this.read()
      if (old !== null && (!['local-verified', 'never-submitted'].includes(old.state)
        || old.taskId === binding.taskId && old.attempt === binding.attempt)) invalid()
      if (old?.state === 'local-verified'
        && (await this.taskStore.get(old.taskId, old.attempt))?.status !== 'SETTLED') invalid()
      if (old?.state === 'never-submitted'
        && !TERMINAL.has((await this.taskStore.get(old.taskId, old.attempt))?.status as ComputeTaskStatus)) invalid()
      await this.executing(binding)
      const record: ComfyVideoAttemptRecord = exact({ schema: 'qianshou.comfy-video-attempt.v1',
        taskId: binding.taskId, attempt: binding.attempt, attemptId: randomUUID(),
        envelopeFingerprint: binding.envelopeFingerprint, idempotencyKey: binding.idempotencyKey,
        leaseExpiresAt: binding.leaseExpiresAt, contractDigest, graphSha256,
        promptId: null, resultSha256: null, terminalEvidenceSha256: null, state: 'reserved' })
      await this.write(record)
      return record
    })
  }

  /** Recheck the original Host attempt immediately before /prompt and before accepting local output.
   * @param reserved - Exact record returned by reserve.
   * @returns When both the journal and task lease still match.
   */
  async assertReserved(reserved: ComfyVideoAttemptRecord): Promise<void> {
    const current = await this.read()
    if (current === null || current.attemptId !== reserved.attemptId
      || current.taskId !== reserved.taskId || current.attempt !== reserved.attempt
      || current.contractDigest !== reserved.contractDigest || current.graphSha256 !== reserved.graphSha256
      || current.state === 'local-verified' || current.state === 'never-submitted') invalid()
    await this.executing(reserved)
  }

  /** Atomically spend a reserved attempt before the network POST. Every later state forbids a second POST. */
  async beforePromptSubmit(reserved: ComfyVideoAttemptRecord): Promise<void> {
    await withFileLock(this.path, async () => {
      const current = await this.read()
      if (current?.attemptId !== reserved.attemptId || current.state !== 'reserved') invalid()
      await this.executing(reserved)
      await this.write(exact({ ...current, state: 'submitting' }))
      // If the lease expired during a slow disk sync, the spent attempt stays
      // unresolved but no network POST is authorized.
      await this.executing(reserved)
    })
  }

  /** Explicitly reclaim only a reservation that never entered the POST window and has authoritative terminal proof. */
  async releaseNeverSubmitted(reserved: ComfyVideoAttemptRecord,
    assertAuthoritativeTerminal: () => Promise<ComfyVideoTerminalEvidence>): Promise<void> {
    await withFileLock(this.path, async () => {
      const current = await this.read()
      if (current?.attemptId !== reserved.attemptId || current.state !== 'reserved') invalid()
      const evidence = await assertAuthoritativeTerminal()
      const state = await this.taskStore.get(reserved.taskId, reserved.attempt)
      if (evidence.taskId !== reserved.taskId || evidence.attempt !== reserved.attempt
        || !TERMINAL.has(evidence.status) || !HASH.test(evidence.sha256)
        || state?.status !== evidence.status) invalid()
      await this.write(exact({ ...current, state: 'never-submitted', terminalEvidenceSha256: evidence.sha256 }))
    })
  }

  /** Bind ComfyUI's returned ID durably; a lost POST response leaves the reservation unresolved.
   * @param reserved - Original Host-minted attempt.
   * @param promptId - Server-issued ComfyUI prompt identity.
   * @returns The submitted record, never authority to repeat /prompt.
   */
  async recordPromptId(reserved: ComfyVideoAttemptRecord, promptId: string): Promise<ComfyVideoAttemptRecord> {
    if (!PROMPT_ID.test(promptId)) invalid()
    return withFileLock(this.path, async () => {
      const current = await this.read()
      if (current?.attemptId !== reserved.attemptId || current.state !== 'submitting') invalid()
      const next = exact({ ...current, promptId, state: 'submitted' })
      await this.write(next)
      return next
    })
  }

  /** Retain the verified local MP4 digest; upload and platform acceptance remain separate.
   * @param reserved - Original Host-minted attempt.
   * @param resultSha256 - Digest verified after local download and ffprobe.
   * @returns A local-only receipt.
   */
  async recordLocalResult(reserved: ComfyVideoAttemptRecord, resultSha256: string): Promise<ComfyVideoAttemptRecord> {
    if (!HASH.test(resultSha256)) invalid()
    return withFileLock(this.path, async () => {
      const current = await this.read()
      if (current?.attemptId !== reserved.attemptId || current.state !== 'submitted') invalid()
      const next = exact({ ...current, resultSha256, state: 'local-verified' })
      await this.write(next)
      return next
    })
  }

  /** Inspect submission state for owner-controlled reconciliation without exposing graph or media bytes.
   * @returns Latest local record, or null before the first attempt.
   */
  latest(): Promise<ComfyVideoAttemptRecord | null> { return this.read() }
}
