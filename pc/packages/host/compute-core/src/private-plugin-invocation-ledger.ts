/** Durable fail-closed reservation for owner-approved private callback calls. */
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ComputeError } from './errors.ts'
import { offlinePluginSampleSha256 } from './offline-plugin-artifact.ts'

const FORMAT = 'qianshou.private-plugin-invocations.v1'
const SHA256 = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MAX_ROWS = 256
const MAX_BYTES = 1024 * 1024

/** A pending row means the callback may have produced effects; no automatic retry is permitted. */
export interface PrivatePluginInvocationRecord {
  readonly callId: string
  readonly packageSha256: string
  readonly candidateSha256: string
  readonly operationId: string
  readonly inputSha256: string
  readonly createdAt: string
  readonly status: 'reserved' | 'completed'
  readonly output?: unknown
  readonly outputSha256?: string
}

function invalid(): never { throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_INVOCATION_LEDGER_INVALID', 503) }
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
}
function parse(value: unknown): PrivatePluginInvocationRecord {
  if (!exact(value, ['callId', 'packageSha256', 'candidateSha256', 'operationId', 'inputSha256',
    'createdAt', 'status', ...(value !== null && typeof value === 'object'
      && Object.hasOwn(value, 'output') ? ['output', 'outputSha256'] : [])])
    || typeof value.callId !== 'string' || value.callId.length < 1 || value.callId.length > 128
    || /[\u0000-\u001f\u007f]/u.test(value.callId)
    || typeof value.packageSha256 !== 'string' || !SHA256.test(value.packageSha256)
    || typeof value.candidateSha256 !== 'string' || !SHA256.test(value.candidateSha256)
    || typeof value.operationId !== 'string' || !ID.test(value.operationId)
    || typeof value.inputSha256 !== 'string' || !SHA256.test(value.inputSha256)
    || typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))
    || !['reserved', 'completed'].includes(String(value.status))) invalid()
  if (value.status === 'completed') {
    if (!Object.hasOwn(value, 'output') || typeof value.outputSha256 !== 'string'
      || !SHA256.test(value.outputSha256) || offlinePluginSampleSha256(value.output) !== value.outputSha256) invalid()
  } else if (Object.hasOwn(value, 'output') || Object.hasOwn(value, 'outputSha256')) invalid()
  return value as unknown as PrivatePluginInvocationRecord
}

/** One Host profile owns this file; cross-process writers reserve before any callback starts. */
export class PrivatePluginInvocationLedger {
  constructor(private readonly path: string) {
    if (!isAbsolute(path)) throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_INVOCATION_PATH_INVALID', 400)
  }

  private async read(): Promise<PrivatePluginInvocationRecord[]> {
    let file
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      invalid()
    }
    try {
      const stat = await file.stat()
      if (!stat.isFile() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600
        || (process.getuid !== undefined && stat.uid !== process.getuid())
        || stat.size < 2 || stat.size > MAX_BYTES) invalid()
      const text = await file.readFile({ encoding: 'utf8' })
      if (Buffer.byteLength(text) !== stat.size) invalid()
      const document = JSON.parse(text) as unknown
      if (!exact(document, ['format', 'rows']) || document.format !== FORMAT
        || !Array.isArray(document.rows) || document.rows.length > MAX_ROWS) invalid()
      const rows = document.rows.map(parse)
      if (new Set(rows.map(row => row.callId)).size !== rows.length) invalid()
      return rows
    } catch { return invalid() }
    finally { await file.close() }
  }

  /** Reserve one Host call ID and exact input. A completed retry reuses its result; uncertainty blocks the operation. */
  async reserve(input: Omit<PrivatePluginInvocationRecord, 'createdAt' | 'status' | 'output' | 'outputSha256'>):
  Promise<{ readonly created: boolean; readonly record: PrivatePluginInvocationRecord }> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => {
      const rows = await this.read()
      const candidate = parse({ ...input, createdAt: new Date().toISOString(), status: 'reserved' })
      const sameCall = rows.find(row => row.callId === candidate.callId)
      if (sameCall !== undefined) {
        if (sameCall.packageSha256 !== candidate.packageSha256
          || sameCall.candidateSha256 !== candidate.candidateSha256
          || sameCall.operationId !== candidate.operationId
          || sameCall.inputSha256 !== candidate.inputSha256) {
          throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_INVOCATION_CONFLICT', 409)
        }
        if (sameCall.status === 'reserved') throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_INVOCATION_UNCERTAIN', 409)
        return { created: false, record: sameCall }
      }
      if (rows.some(row => row.packageSha256 === candidate.packageSha256
        && row.operationId === candidate.operationId && row.status === 'reserved')) {
        throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_INVOCATION_UNCERTAIN', 409)
      }
      if (rows.length >= MAX_ROWS) throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_INVOCATION_CAPACITY', 409)
      await this.write([candidate, ...rows])
      return { created: true, record: candidate }
    }, { waitMs: 10_000 })
  }

  /** Persist output before returning it; a failed write leaves the reservation unresolved. */
  async complete(reserved: PrivatePluginInvocationRecord, output: unknown): Promise<PrivatePluginInvocationRecord> {
    const outputSha256 = offlinePluginSampleSha256(output)
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => {
      const rows = await this.read()
      const index = rows.findIndex(row => row.callId === reserved.callId)
      const current = rows[index]
      if (index < 0 || current?.status !== 'reserved' || current.callId !== reserved.callId
        || current.packageSha256 !== reserved.packageSha256
        || current.candidateSha256 !== reserved.candidateSha256
        || current.operationId !== reserved.operationId || current.inputSha256 !== reserved.inputSha256) {
        throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_INVOCATION_CONFLICT', 409)
      }
      const completed = parse({ ...current, status: 'completed', output, outputSha256 })
      rows[index] = completed
      await this.write(rows)
      return completed
    }, { waitMs: 10_000 })
  }

  private async write(rows: readonly PrivatePluginInvocationRecord[]): Promise<void> {
    const content = JSON.stringify({ format: FORMAT, rows })
    if (Buffer.byteLength(content) > MAX_BYTES) throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_INVOCATION_CAPACITY', 409)
    try { await writeFileAtomic(this.path, content, { mode: 0o600, dirMode: 0o700 }) }
    catch { throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_INVOCATION_LEDGER_UNAVAILABLE', 503) }
  }
}
