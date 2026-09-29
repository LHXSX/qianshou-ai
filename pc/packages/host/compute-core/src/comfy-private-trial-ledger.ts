/** Durable, owner-local admission and submission facts for one ComfyUI sample at a time. */
import { mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ComputeError } from './errors.ts'

const MAX_STORE_BYTES = 1024 * 1024
const MAX_TRIALS = 128
const TOKEN = /^[A-Za-z0-9._:-]{1,128}$/u
const SHA = /^[a-f0-9]{64}$/u
const ACTIVE = new Set<ComfyTrialStatus>(['reserved', 'sending', 'queued', 'submission-unknown', 'cancel-uncertain'])

export type ComfyTrialStatus = 'reserved' | 'sending' | 'queued' | 'submission-unknown'
  | 'cancel-uncertain' | 'completed' | 'rejected'

export interface ComfyTrialResult {
  readonly sha256: string
  readonly bytes: number
  readonly width: number
  readonly height: number
}

/** No prompt, graph, model filename, local path, lease or charge is persisted here. */
export interface ComfyTrialRecord {
  readonly key: string
  readonly fingerprint: string
  readonly trialId: string
  readonly promptId: string
  readonly draftId: string
  readonly operationId: string
  readonly graphSha256: string
  readonly inputSha256: string
  readonly ownerId: string
  readonly port: number
  /** Older records lack these fields and remain blocked until manually reviewed. */
  readonly outputNodeId?: string
  readonly requestedWidth?: number
  readonly requestedHeight?: number
  readonly status: ComfyTrialStatus
  readonly createdAt: string
  readonly updatedAt: string
  readonly result?: ComfyTrialResult
}

function invalid(): ComputeError { return new ComputeError('COMPUTE_COMFY_TRIAL_LEDGER_INVALID', 503) }
function validate(record: ComfyTrialRecord): void {
  if (![record.key, record.trialId, record.promptId, record.draftId, record.operationId, record.ownerId].every(value => TOKEN.test(value))
    || ![record.fingerprint, record.graphSha256, record.inputSha256].every(value => SHA.test(value))
    || !Number.isSafeInteger(record.port) || record.port < 1024 || record.port > 65535
    || (record.outputNodeId !== undefined && !/^[0-9]{1,12}$/u.test(record.outputNodeId))
    || (record.requestedWidth !== undefined && (!Number.isSafeInteger(record.requestedWidth)
      || record.requestedWidth < 256 || record.requestedWidth > 1024 || record.requestedWidth % 64 !== 0))
    || (record.requestedHeight !== undefined && (!Number.isSafeInteger(record.requestedHeight)
      || record.requestedHeight < 256 || record.requestedHeight > 1024 || record.requestedHeight % 64 !== 0))
    || !['reserved', 'sending', 'queued', 'submission-unknown', 'cancel-uncertain', 'completed', 'rejected'].includes(record.status)
    || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw invalid()
  if ((record.status === 'completed') !== (record.result !== undefined)) throw invalid()
  if (record.result !== undefined && (!SHA.test(record.result.sha256)
    || !Number.isSafeInteger(record.result.bytes) || record.result.bytes < 1 || record.result.bytes > 16 * 1024 * 1024
    || !Number.isSafeInteger(record.result.width) || record.result.width < 1 || record.result.width > 1024
    || !Number.isSafeInteger(record.result.height) || record.result.height < 1 || record.result.height > 1024)) throw invalid()
}

/** Cross-process serialized; a pending POST stays pending after a crash, never retried blindly. */
export class ComfyPrivateTrialLedger {
  constructor(private readonly path: string) {
    if (!isAbsolute(path)) throw invalid()
  }

  private async read(): Promise<ComfyTrialRecord[]> {
    let file
    try { file = await open(this.path, 'r') }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw invalid()
    }
    try {
      const stat = await file.stat()
      if (stat.size > MAX_STORE_BYTES) throw invalid()
      const text = await file.readFile({ encoding: 'utf8' })
      if (Buffer.byteLength(text) > MAX_STORE_BYTES) throw invalid()
      const data = JSON.parse(text) as unknown
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw invalid()
      const object = data as Record<string, unknown>
      if (object.version !== 1 || !Array.isArray(object.trials) || object.trials.length > MAX_TRIALS) throw invalid()
      const records = object.trials as ComfyTrialRecord[]
      for (const record of records) validate(record)
      if (new Set(records.map(record => record.key)).size !== records.length
        || new Set(records.map(record => record.trialId)).size !== records.length
        || new Set(records.map(record => record.promptId)).size !== records.length) throw invalid()
      return records
    } catch { throw invalid() }
    finally { await file.close() }
  }

  private async write(records: readonly ComfyTrialRecord[]): Promise<void> {
    const content = JSON.stringify({ version: 1, trials: records })
    if (records.length > MAX_TRIALS || Buffer.byteLength(content) > MAX_STORE_BYTES) {
      throw new ComputeError('COMPUTE_COMFY_TRIAL_LEDGER_FULL', 409)
    }
    await writeFileAtomic(this.path, content, { mode: 0o600, dirMode: 0o700 })
  }

  get(key: string): Promise<ComfyTrialRecord | null> {
    if (!TOKEN.test(key)) return Promise.reject(invalid())
    return this.read().then(records => records.find(record => record.key === key) ?? null)
  }

  /** Resolve a Host-minted trial ID for an owner-only image read; no path is accepted. */
  getByTrialId(trialId: string): Promise<ComfyTrialRecord | null> {
    if (!TOKEN.test(trialId)) return Promise.reject(invalid())
    return this.read().then(records => records.find(record => record.trialId === trialId) ?? null)
  }

  /** Return bounded owner-local status metadata, never stored prompt or transport keys. */
  async recent(ownerId: string): Promise<readonly Pick<ComfyTrialRecord, 'trialId' | 'status' | 'updatedAt' | 'result'>[]> {
    if (!TOKEN.test(ownerId)) throw invalid()
    return (await this.read()).filter(record => record.ownerId === ownerId).slice(0, 20).map(record => ({
      trialId: record.trialId, status: record.status, updatedAt: record.updatedAt,
      ...(record.result ? { result: record.result } : {}),
    }))
  }

  reserve(input: Omit<ComfyTrialRecord, 'status' | 'createdAt' | 'updatedAt' | 'result'>): Promise<{ created: boolean; record: ComfyTrialRecord }> {
    return (async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      return withFileLock(this.path, async () => {
        const records = await this.read()
        const now = new Date().toISOString()
        const candidate: ComfyTrialRecord = { ...input, status: 'reserved', createdAt: now, updatedAt: now }
        validate(candidate)
        const existing = records.find(record => record.key === input.key)
        if (existing) {
          if (existing.fingerprint !== input.fingerprint) throw new ComputeError('COMPUTE_COMFY_TRIAL_KEY_CONFLICT', 409)
          return { created: false, record: existing }
        }
        if (records.some(record => record.port === input.port && ACTIVE.has(record.status))) {
          throw new ComputeError('COMPUTE_COMFY_TRIAL_PORT_BUSY', 409)
        }
        await this.write([candidate, ...records])
        return { created: true, record: candidate }
      })
    })()
  }

  advance(key: string, expected: readonly ComfyTrialStatus[], status: ComfyTrialStatus,
    result?: ComfyTrialResult): Promise<ComfyTrialRecord> {
    return (async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
      return withFileLock(this.path, async () => {
        const records = await this.read()
        const index = records.findIndex(record => record.key === key)
        if (index < 0) throw new ComputeError('COMPUTE_COMFY_TRIAL_NOT_FOUND', 404)
        const current = records[index]
        if (!current) throw new ComputeError('COMPUTE_COMFY_TRIAL_NOT_FOUND', 404)
        if (!expected.includes(current.status)) throw new ComputeError('COMPUTE_COMFY_TRIAL_STATE_CONFLICT', 409)
        const next = { ...current, status, updatedAt: new Date().toISOString(), ...(result ? { result } : {}) }
        validate(next)
        records[index] = next
        await this.write(records)
        return next
      })
    })()
  }
}
