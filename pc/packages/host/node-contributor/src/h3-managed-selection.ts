/** Private active-variant selection; neither configuration existence nor mtime selects an execution runtime. */
import { createHash, randomUUID } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, normalize, parse } from 'node:path'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import { canonicalNativeH3ReviewJson } from '@deepseek-ai/dsh-compute-core/native-h3-review'
import type { H3TrialTransaction } from './h3-execution-coordinator.ts'
import type { H3OwnerSetupScope } from './h3-owner-setup.ts'
import type { H3OwnerManagedConfigState } from './h3-owner-setup-types.ts'
import { readH3BoundedFile } from './h3-video.ts'

/** Explicit saved runtime; this Host-only selector does not grant new execution. */
export type H3ManagedRuntime = 'v2' | 'canonical'

/** Stable private resolver facts, including an independent selection revision for runtime ABA changes. */
export interface H3ManagedCurrent extends H3OwnerManagedConfigState {
  readonly runtime: H3ManagedRuntime
  readonly selectionRevision: number
  readonly configSha256: string
}

/** Normal account and both real helper readers; no browser-supplied owner or destination is accepted. */
export interface H3ManagedSelectionOptions {
  readonly homePath: string
  readonly readScope: () => Promise<H3OwnerSetupScope | null>
  readonly readV2Current: () => Promise<H3OwnerManagedConfigState | null>
  readonly readCanonicalCurrent: () => Promise<H3OwnerManagedConfigState | null>
}

interface Scope { ownerId: number; scopeId: string; root: string }
interface Selection {
  schema: 'qianshou.h3-managed-selection.v1'
  scopeId: string
  runtime: H3ManagedRuntime
  selectionRevision: number
  revision: number
  configSha256: string
}
interface FileSnapshot { bytes: Buffer; stat: Stats }
interface ConfigSnapshot { state: H3OwnerManagedConfigState; pointer: FileSnapshot; config: FileSnapshot }
interface Both { v2: ConfigSnapshot | null; canonical: ConfigSnapshot | null }
const HASH = /^[0-9a-f]{64}$/u
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const sha = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex')
const encode = (value: unknown): Buffer => Buffer.from(canonicalNativeH3ReviewJson(value))
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT'
const statId = (stat: Stats): string => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.nlink].join(':')
const samePath = (a: string, b: string): boolean => process.platform === 'win32'
  ? normalize(a).toLowerCase() === normalize(b).toLowerCase() : normalize(a) === normalize(b)
function fail(code = 'H3_MANAGED_SELECTION_INVALID'): never { throw new ComputeError(code, 409) }

async function privateDirectory(path: string, create: boolean): Promise<void> {
  if (!isAbsolute(path) || path.includes('\0')) fail('H3_SETUP_UNSAFE_PATH')
  let current = parse(path).root
  for (const piece of path.slice(current.length).split(/[\\/]/u).filter(Boolean)) {
    current = join(current, piece)
    if (create) {
      try { await mkdir(current, { mode: 0o700 }) }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
    }
    const stat = await lstat(current)
    if (!stat.isDirectory() || stat.isSymbolicLink() || !samePath(await realpath(current), current)) fail('H3_SETUP_UNSAFE_PATH')
  }
  const stat = await lstat(path)
  if (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail('H3_SETUP_UNSAFE_PATH')
}

async function snapshot(path: string): Promise<FileSnapshot> {
  await privateDirectory(dirname(path), false)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0)) fail('H3_SETUP_UNSAFE_PATH')
  const bytes = await readH3BoundedFile(path, 32 * 1024)
  if (statId(await lstat(path)) !== statId(stat)) fail('H3_SETUP_CONFIG_CHANGED')
  return { bytes, stat }
}

function object(bytes: Buffer): Record<string, unknown> {
  const parsed: unknown = JSON.parse(bytes.toString('utf8'))
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed) || !encode(parsed).equals(bytes)) fail()
  return parsed as Record<string, unknown>
}

function equalFile(a: FileSnapshot | null, b: FileSnapshot | null): boolean {
  return a === null ? b === null : b !== null && statId(a.stat) === statId(b.stat) && a.bytes.equals(b.bytes)
}

function equalConfig(a: ConfigSnapshot | null, b: ConfigSnapshot | null): boolean {
  return a === null ? b === null : b !== null && a.state.scopeId === b.state.scopeId
    && a.state.revision === b.state.revision && samePath(a.state.configPath, b.state.configPath)
    && equalFile(a.pointer, b.pointer) && equalFile(a.config, b.config)
}

async function syncDirectory(path: string): Promise<void> {
  // Node cannot sync directory handles on Windows; file sync and exact-byte CAS are still mandatory.
  if (process.platform === 'win32') return
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() } finally { await handle.close() }
}

/** Select only the exact saved owner/profile variant; pure observations preserve existing lease identity checks. */
export class H3ManagedSelection {
  /** Capture trusted Host readers without executing programs or touching configuration.
   * @param options - Normal home, current account/profile and both existing pure helper readers.
   */
  constructor(private readonly options: H3ManagedSelectionOptions) {
    if (!isAbsolute(options.homePath) || options.homePath.includes('\0')) fail('H3_SETUP_UNSAFE_PATH')
  }

  private async scope(): Promise<Scope> {
    const value = await this.options.readScope()
    if (value === null || !Number.isSafeInteger(value.ownerId) || value.ownerId < 1
      || !isAbsolute(value.profileDir) || value.profileDir.includes('\0')) fail('H3_SETUP_LOGIN_REQUIRED')
    const scopeId = sha(encode({ ownerId: value.ownerId, profileDir: normalize(value.profileDir) }))
    return { ownerId: value.ownerId, scopeId,
      root: join(this.options.homePath, 'qianshou-h3-owner', 'selection', String(value.ownerId), scopeId) }
  }

  private async assertScope(scope: Scope): Promise<void> {
    if ((await this.scope()).scopeId !== scope.scopeId) fail('H3_SETUP_OWNER_CHANGED')
  }

  private async config(scope: Scope, runtime: H3ManagedRuntime): Promise<ConfigSnapshot | null> {
    const state = await (runtime === 'v2' ? this.options.readV2Current() : this.options.readCanonicalCurrent())
    if (state === null) return null
    const root = join(this.options.homePath, 'qianshou-h3-owner', runtime, String(scope.ownerId), scope.scopeId)
    const directory = dirname(state.configPath).slice(root.length + 1)
    if (state.scopeId !== scope.scopeId || !Number.isSafeInteger(state.revision) || state.revision < 1
      || !UUID.test(directory) || !samePath(state.configPath, join(root, directory, 'owner.json'))) fail()
    const pointer = await snapshot(join(root, 'current.json'))
    const config = await snapshot(state.configPath)
    const row = object(pointer.bytes)
    if (Object.keys(row).sort().join(',') !== 'configSha256,directory,revision,schema,scopeId'
      || row.schema !== (runtime === 'v2' ? 'qianshou.h3-managed-owner.v2' : 'qianshou.h3-managed-owner.canonical.v1')
      || row.scopeId !== scope.scopeId || row.revision !== state.revision || row.directory !== directory
      || row.configSha256 !== sha(config.bytes)) fail('H3_SETUP_CONFIG_CHANGED')
    return { state, pointer, config }
  }

  private async both(scope: Scope): Promise<Both> {
    const v2 = await this.config(scope, 'v2')
    const canonical = await this.config(scope, 'canonical')
    await this.assertScope(scope)
    return { v2, canonical }
  }

  private async record(scope: Scope): Promise<FileSnapshot | null> {
    try { return await snapshot(join(scope.root, 'current.json')) }
    catch (error) { if (missing(error)) return null; throw error }
  }

  private parse(record: FileSnapshot, scope: Scope): Selection {
    const row = object(record.bytes)
    if (Object.keys(row).sort().join(',') !== 'configSha256,revision,runtime,schema,scopeId,selectionRevision'
      || row.schema !== 'qianshou.h3-managed-selection.v1' || row.scopeId !== scope.scopeId
      || (row.runtime !== 'v2' && row.runtime !== 'canonical')
      || typeof row.selectionRevision !== 'number' || !Number.isSafeInteger(row.selectionRevision) || row.selectionRevision < 1
      || typeof row.revision !== 'number' || !Number.isSafeInteger(row.revision) || row.revision < 1
      || typeof row.configSha256 !== 'string' || !HASH.test(row.configSha256)) fail()
    return { schema: 'qianshou.h3-managed-selection.v1', scopeId: scope.scopeId, runtime: row.runtime,
      selectionRevision: row.selectionRevision, revision: row.revision, configSha256: row.configSha256 }
  }

  private current(scope: Scope, facts: Both, record: FileSnapshot | null): H3ManagedCurrent | null {
    if (record === null) {
      if (facts.canonical !== null) fail('H3_MANAGED_SELECTION_REQUIRED')
      return facts.v2 === null ? null : { ...facts.v2.state, runtime: 'v2', selectionRevision: 0,
        configSha256: sha(facts.v2.config.bytes) }
    }
    const selected = this.parse(record, scope)
    const actual = facts[selected.runtime]
    if (actual === null || actual.state.revision !== selected.revision
      || sha(actual.config.bytes) !== selected.configSha256) fail('H3_MANAGED_SELECTION_STALE')
    return { ...actual.state, runtime: selected.runtime, selectionRevision: selected.selectionRevision,
      configSha256: selected.configSha256 }
  }

  /** Read stable selection and both actual configurations without changing readiness, locks or admission.
   * @returns Private selected facts, legacy V2 only when canonical is truly absent, or no configuration.
   */
  async readCurrent(): Promise<H3ManagedCurrent | null> {
    const scope = await this.scope()
    const record = await this.record(scope)
    const facts = await this.both(scope)
    const result = this.current(scope, facts, record)
    const after = await this.both(scope)
    if (!equalConfig(facts.v2, after.v2) || !equalConfig(facts.canonical, after.canonical)
      || !equalFile(record, await this.record(scope))) fail('H3_MANAGED_SELECTION_STALE')
    await this.assertScope(scope)
    return result
  }

  /** Publish one explicit saved variant within the helpers' actual shared short transaction.
   * @param runtime - Explicit helper variant, never inferred from file timestamps.
   * @param state - Actual saved helper scope/revision/path; file and pointer digests are measured here.
   * @param transaction - Original live same-home mutex capability, supplied only by the save callback.
   * @returns Stable private selection after exact-byte CAS and sync; any failure retains the owning mutex.
   */
  async selectSaved(runtime: H3ManagedRuntime, state: H3OwnerManagedConfigState,
    transaction: H3TrialTransaction): Promise<H3ManagedCurrent> {
    try {
      await transaction.assertOwned()
      const scope = await this.scope()
      const before = await this.record(scope)
      const previous = before === null ? null : this.parse(before, scope)
      const facts = await this.both(scope)
      const actual = facts[runtime]
      if (actual === null || state.scopeId !== scope.scopeId || state.revision !== actual.state.revision
        || !samePath(state.configPath, actual.state.configPath)) fail('H3_MANAGED_SELECTION_STALE')
      const revision = (previous?.selectionRevision ?? 0) + 1
      if (!Number.isSafeInteger(revision)) fail()
      const selected: Selection = { schema: 'qianshou.h3-managed-selection.v1', runtime, scopeId: scope.scopeId,
        selectionRevision: revision, revision: state.revision, configSha256: sha(actual.config.bytes) }
      await privateDirectory(scope.root, true)
      const temporary = join(scope.root, '.selection-' + randomUUID())
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
      const owned = await (async (): Promise<Stats> => {
        try { await handle.writeFile(encode(selected)); await handle.sync(); return await handle.stat() }
        finally { await handle.close() }
      })()
      try {
        await transaction.assertOwned(); await this.assertScope(scope)
        const after = await this.both(scope)
        if (!equalConfig(facts.v2, after.v2) || !equalConfig(facts.canonical, after.canonical)
          || !equalFile(before, await this.record(scope))) fail('H3_MANAGED_SELECTION_STALE')
        await rename(temporary, join(scope.root, 'current.json')); await syncDirectory(scope.root)
        await transaction.assertOwned(); await this.assertScope(scope)
        return await this.readCurrent()
          ?? fail('H3_MANAGED_SELECTION_STALE')
      } finally {
        try {
          if (statId(await lstat(temporary)) === statId(owned)) await unlink(temporary)
        } catch (error) { if (!missing(error)) throw error }
      }
    } catch (error) { transaction.retain(); throw error }
  }
}
