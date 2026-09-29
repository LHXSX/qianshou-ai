/** Atomic Host-only ledger for private data-only archive activations. */
import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { dirname, isAbsolute } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { ComputeError } from './errors.ts'

const FORMAT = 'qianshou.private-plugin-activations.v1'
const MAX_ROWS = 100
const MAX_BYTES = 128 * 1024
const SHA256 = /^[a-f0-9]{64}$/u
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const VERSION = /^[0-9A-Za-z][0-9A-Za-z._-]{0,63}$/u

/** Durable identity and operation bindings; availability is evaluated on every read. */
export interface PrivatePluginActivationRecord {
  readonly pluginId: string
  readonly displayName: string
  readonly version: string
  readonly packageSha256: string
  readonly candidateSha256: string
  readonly draftId: string
  readonly draftUpdatedAt: string
  readonly installedAt: string
  readonly operations: readonly {
    readonly operationId: string
    readonly adapterId: string
    readonly adapterVersion: string
  }[]
}

function invalid(): never { throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_LEDGER_INVALID', 503) }
function exact(value: unknown, fields: readonly string[]): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}
function iso(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 40 && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value
}
function parseRow(value: unknown): PrivatePluginActivationRecord {
  if (!exact(value, ['pluginId', 'displayName', 'version', 'packageSha256', 'candidateSha256', 'draftId',
    'draftUpdatedAt', 'installedAt', 'operations'])
    || typeof value.pluginId !== 'string' || !ID.test(value.pluginId)
    || typeof value.displayName !== 'string' || value.displayName.length < 1
    || Buffer.byteLength(value.displayName, 'utf8') > 256
    || typeof value.version !== 'string' || !VERSION.test(value.version)
    || typeof value.packageSha256 !== 'string' || !SHA256.test(value.packageSha256)
    || typeof value.candidateSha256 !== 'string' || !SHA256.test(value.candidateSha256)
    || typeof value.draftId !== 'string' || !/^plugin_draft_[0-9a-f-]{36}$/u.test(value.draftId)
    || !iso(value.draftUpdatedAt) || !iso(value.installedAt)
    || !Array.isArray(value.operations) || value.operations.length < 1 || value.operations.length > 16) invalid()
  const operations = value.operations.map((operation): PrivatePluginActivationRecord['operations'][number] => {
    if (!exact(operation, ['operationId', 'adapterId', 'adapterVersion'])
      || typeof operation.operationId !== 'string' || !ID.test(operation.operationId)
      || typeof operation.adapterId !== 'string' || !ID.test(operation.adapterId)
      || typeof operation.adapterVersion !== 'string' || !VERSION.test(operation.adapterVersion)) invalid()
    return { operationId: operation.operationId, adapterId: operation.adapterId,
      adapterVersion: operation.adapterVersion }
  })
  if (new Set(operations.map(operation => operation.operationId)).size !== operations.length) invalid()
  return { pluginId: value.pluginId, displayName: value.displayName, version: value.version,
    packageSha256: value.packageSha256, candidateSha256: value.candidateSha256,
    draftId: value.draftId, draftUpdatedAt: value.draftUpdatedAt, installedAt: value.installedAt,
    operations }
}
/** Private local installs survive restart but never become market or node dispatch authority. */
export class PrivatePluginActivationLedger {
  constructor(private readonly path: string) {
    if (!isAbsolute(path)) throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_LEDGER_PATH_INVALID', 400)
  }

  /** Read strictly validated rows; a damaged file fails closed. */
  async list(): Promise<readonly PrivatePluginActivationRecord[]> {
    let file
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_LEDGER_UNAVAILABLE', 503)
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
      const rows = document.rows.map(parseRow)
      if (new Set(rows.map(row => `${row.pluginId}\u0000${row.version}`)).size !== rows.length) invalid()
      return rows
    } catch (error) {
      if (error instanceof ComputeError) throw error
      return invalid()
    } finally { await file.close() }
  }

  /** Atomically activate one exact package; replacing a version requires uninstall first. */
  async activate(record: PrivatePluginActivationRecord): Promise<PrivatePluginActivationRecord> {
    const parsed = parseRow(record)
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => {
      const rows = await this.list()
      const existing = rows.find(row => row.pluginId === parsed.pluginId && row.version === parsed.version)
      if (existing !== undefined) {
        if (existing.displayName === parsed.displayName && existing.packageSha256 === parsed.packageSha256
          && existing.candidateSha256 === parsed.candidateSha256
          && existing.draftId === parsed.draftId && existing.draftUpdatedAt === parsed.draftUpdatedAt
          && JSON.stringify(existing.operations) === JSON.stringify(parsed.operations)) return existing
        throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_VERSION_CONFLICT', 409)
      }
      if (rows.length >= MAX_ROWS) throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_CAPACITY', 409)
      await this.write([parsed, ...rows])
      return parsed
    }, { waitMs: 10_000 })
  }

  /** Remove an exact installed package; a later invocation must find no active row. */
  async uninstall(packageSha256: string, candidateSha256: string): Promise<PrivatePluginActivationRecord> {
    if (!SHA256.test(packageSha256) || !SHA256.test(candidateSha256)) {
      throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_DIGEST_INVALID', 400)
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(this.path, async () => {
      const rows = await this.list()
      const existing = rows.find(row => row.packageSha256 === packageSha256
        && row.candidateSha256 === candidateSha256)
      if (existing === undefined) throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_NOT_INSTALLED', 404)
      await this.write(rows.filter(row => row !== existing))
      return existing
    }, { waitMs: 10_000 })
  }

  /** Read one exact activation without granting execution authority. */
  async find(packageSha256: string, candidateSha256: string): Promise<PrivatePluginActivationRecord> {
    const row = (await this.list()).find(item => item.packageSha256 === packageSha256
      && item.candidateSha256 === candidateSha256)
    if (row === undefined) throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_NOT_INSTALLED', 404)
    return row
  }

  /** Serialize execution with uninstall for this exact package, including across Host processes. */
  async withPackageLock<T>(packageSha256: string, candidateSha256: string,
    action: () => Promise<T>): Promise<T> {
    if (!SHA256.test(packageSha256) || !SHA256.test(candidateSha256)) {
      throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_DIGEST_INVALID', 400)
    }
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
    return withFileLock(`${this.path}.${packageSha256}.operation`, action, { waitMs: 180_000 })
  }

  private async write(rows: readonly PrivatePluginActivationRecord[]): Promise<void> {
    const content = JSON.stringify({ format: FORMAT, rows })
    if (Buffer.byteLength(content) > MAX_BYTES) throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_CAPACITY', 409)
    try { await writeFileAtomic(this.path, content, { mode: 0o600, dirMode: 0o700 }) }
    catch { throw new ComputeError('COMPUTE_PRIVATE_PLUGIN_LEDGER_UNAVAILABLE', 503) }
  }
}
