/**
 * Completed child-turn evidence stored under a configured directory so it
 * outlives the Host process: one atomically replaced JSON index per root
 * Session beside content-addressed copies of each listed file's two sides,
 * and one pointer file per child or intermediate Session naming its root.
 * Every read validates the file contents before trusting them.
 */
import { randomBytes } from 'node:crypto'
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { isInside } from './paths.ts'
import type { WorkspaceChangedFile, WorkspaceChangesSummary, WorkspaceChildChange } from './types.ts'

/** Index format generation; a file with another value is refused. */
export const CHILD_EVIDENCE_SCHEMA_VERSION = 1

/** One side of a listed file: no file, or a copy named by the SHA-1 of its bytes with the size recorded at write time. */
export type DurableSide =
  | { kind: 'absent' }
  | { kind: 'object'; sha1: string; size: number }

/** A listed file's comparison inputs: a refusal decided when the turn was recorded, or its two sides. */
export type DurableFileSources =
  | { refusal: 'binary' | 'oversized' }
  | { refusal?: undefined; before: DurableSide; after: DurableSide }

/** One `workspace/changes` event of a child turn with its summary and, index-aligned with `summary.files`, each file's sides. */
export interface DurableEntry {
  seq: number
  summary: WorkspaceChangesSummary
  files: DurableFileSources[]
}

/** One completed child turn under a root Session. */
export interface DurableRecord {
  childSessionId: SessionId
  /** Parent chain from the child's parent to the root, which is always last. */
  ancestors: SessionId[]
  turn: number
  cwd: string
  state: 'available' | 'unavailable'
  reason?: WorkspaceChildChange['reason']
  shared: boolean
  /** Bytes of stored copies charged to the root's budget; zero once released. */
  bytes: number
  /** Unix epoch milliseconds when the turn was sealed. */
  recordedAt: number
  /** Canonical absolute paths the turn's successful write/edit results named. */
  paths: string[]
  entries: DurableEntry[]
}

/** The index file of one root Session; records are oldest first. */
export interface DurableIndex {
  schemaVersion: typeof CHILD_EVIDENCE_SCHEMA_VERSION
  rootSessionId: SessionId
  /** Unix epoch milliseconds of this write. */
  writtenAt: number
  records: DurableRecord[]
}

/** A stored file whose contents fail validation; the message names the file and the first violated rule. */
export class InvalidChildEvidenceError extends Error {
  constructor(readonly file: string, reason: string) {
    super(`workspace-changes: child evidence at ${file} is invalid: ${reason}`)
    this.name = 'InvalidChildEvidenceError'
  }
}

const SHA1 = /^[0-9a-f]{40}$/
const REASONS: ReadonlySet<string> = new Set(['untracked', 'execution-unavailable', 'capture-failed', 'cancelled', 'retention-limit', 'no-change'])
const INDEX_FILE = 'index.json'

/** Filesystem-safe spelling of a Session id: alphanumerics, `-`, `_`, and `%` escapes, never `.` or an empty name. */
function encodeId(id: string): string {
  const encoded = encodeURIComponent(id).replace(/[.!~*'()]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)
  return encoded === '' ? '%' : encoded
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

/** Throws the first violated rule of a parsed index. */
class Validator {
  constructor(private readonly file: string) {}

  require(condition: boolean, reason: string): asserts condition {
    if (!condition) throw new InvalidChildEvidenceError(this.file, reason)
  }

  index(value: unknown, rootSessionId: SessionId): DurableIndex {
    this.require(isRecord(value), 'not a JSON object')
    this.require(value.schemaVersion === CHILD_EVIDENCE_SCHEMA_VERSION, `schemaVersion ${String(value.schemaVersion)} is not ${CHILD_EVIDENCE_SCHEMA_VERSION}`)
    this.require(value.rootSessionId === rootSessionId, 'rootSessionId names another Session')
    this.require(isCount(value.writtenAt), 'writtenAt is not a timestamp')
    this.require(Array.isArray(value.records), 'records is not a list')
    return { schemaVersion: CHILD_EVIDENCE_SCHEMA_VERSION, rootSessionId, writtenAt: value.writtenAt, records: value.records.map((record, position) => this.record(record, position, rootSessionId)) }
  }

  private record(value: unknown, position: number, rootSessionId: SessionId): DurableRecord {
    const at = `records[${position}]`
    this.require(isRecord(value), `${at} is not an object`)
    this.require(typeof value.childSessionId === 'string' && value.childSessionId !== '', `${at}.childSessionId is not a Session id`)
    this.require(isStringList(value.ancestors) && value.ancestors.at(-1) === rootSessionId, `${at}.ancestors does not end with the root`)
    this.require(isCount(value.turn) && value.turn >= 1, `${at}.turn is not a turn number`)
    this.require(typeof value.cwd === 'string', `${at}.cwd is not a path`)
    this.require(value.state === 'available' || value.state === 'unavailable', `${at}.state is not a completed state`)
    this.require(value.reason === undefined || (typeof value.reason === 'string' && REASONS.has(value.reason)), `${at}.reason is unknown`)
    this.require(typeof value.shared === 'boolean', `${at}.shared is not a boolean`)
    this.require(isCount(value.bytes), `${at}.bytes is not a byte count`)
    this.require(isCount(value.recordedAt), `${at}.recordedAt is not a timestamp`)
    this.require(isStringList(value.paths), `${at}.paths is not a path list`)
    this.require(Array.isArray(value.entries), `${at}.entries is not a list`)
    return {
      childSessionId: value.childSessionId as SessionId, ancestors: value.ancestors as SessionId[], turn: value.turn, cwd: value.cwd,
      state: value.state, ...value.reason === undefined ? {} : { reason: value.reason as WorkspaceChildChange['reason'] },
      shared: value.shared, bytes: value.bytes, recordedAt: value.recordedAt, paths: value.paths,
      entries: value.entries.map((entry, index) => this.entry(entry, `${at}.entries[${index}]`)),
    }
  }

  private entry(value: unknown, at: string): DurableEntry {
    this.require(isRecord(value), `${at} is not an object`)
    this.require(isCount(value.seq), `${at}.seq is not a sequence`)
    const summary = this.summary(value.summary, `${at}.summary`)
    this.require(Array.isArray(value.files) && value.files.length === summary.files.length, `${at}.files is not aligned with the summary`)
    return { seq: value.seq, summary, files: value.files.map((file, index) => this.sources(file, `${at}.files[${index}]`)) }
  }

  private summary(value: unknown, at: string): WorkspaceChangesSummary {
    this.require(isRecord(value), `${at} is not an object`)
    this.require(isCount(value.turn) && value.turn >= 1, `${at}.turn is not a turn number`)
    this.require(typeof value.cwd === 'string', `${at}.cwd is not a path`)
    this.require(Array.isArray(value.files), `${at}.files is not a list`)
    this.require(isCount(value.total) && isCount(value.added) && isCount(value.deleted), `${at} counts are not numbers`)
    const files = value.files.map((file, index): WorkspaceChangedFile => {
      const where = `${at}.files[${index}]`
      this.require(isRecord(file), `${where} is not an object`)
      this.require(typeof file.path === 'string' && typeof file.display === 'string', `${where} paths are not strings`)
      this.require(isCount(file.added) && isCount(file.deleted), `${where} counts are not numbers`)
      this.require(file.binary === undefined || file.binary === true, `${where}.binary is not true`)
      this.require(file.oversized === undefined || file.oversized === true, `${where}.oversized is not true`)
      return {
        path: file.path, display: file.display, added: file.added, deleted: file.deleted,
        ...file.binary === true ? { binary: true as const } : {}, ...file.oversized === true ? { oversized: true as const } : {},
      }
    })
    return { turn: value.turn, cwd: value.cwd, files, total: value.total, added: value.added, deleted: value.deleted }
  }

  private sources(value: unknown, at: string): DurableFileSources {
    this.require(isRecord(value), `${at} is not an object`)
    if (value.refusal !== undefined) {
      this.require(value.refusal === 'binary' || value.refusal === 'oversized', `${at}.refusal is unknown`)
      return { refusal: value.refusal }
    }
    return { before: this.side(value.before, `${at}.before`), after: this.side(value.after, `${at}.after`) }
  }

  private side(value: unknown, at: string): DurableSide {
    this.require(isRecord(value), `${at} is not an object`)
    if (value.kind === 'absent') return { kind: 'absent' }
    this.require(value.kind === 'object', `${at}.kind is unknown`)
    this.require(typeof value.sha1 === 'string' && SHA1.test(value.sha1), `${at}.sha1 is not a SHA-1`)
    this.require(isCount(value.size), `${at}.size is not a byte count`)
    return { kind: 'object', sha1: value.sha1, size: value.size }
  }
}

/** Write `bytes` to `file` through a private temporary name and one rename, so a reader sees the old file or the new one. */
async function writeAtomic(file: string, bytes: string | Uint8Array): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 })
  const temp = `${file}.${randomBytes(6).toString('hex')}.tmp`
  try {
    await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 })
    await rename(temp, file)
  } catch (error: unknown) {
    await rm(temp, { force: true })
    throw error
  }
}

/** Pointer file contents naming a root; written and compared as this exact text. */
function pointerText(root: SessionId): string {
  return JSON.stringify({ schemaVersion: CHILD_EVIDENCE_SCHEMA_VERSION, rootSessionId: root })
}

/** SHA-1 names of the copies one record's sides reference. */
function objectNames(record: DurableRecord): Set<string> {
  const names = new Set<string>()
  for (const entry of record.entries) for (const file of entry.files) {
    if (file.refusal !== undefined) continue
    for (const side of [file.before, file.after]) if (side.kind === 'object') names.add(side.sha1)
  }
  return names
}

/** Every child and intermediate Session an index names; the root itself resolves through its index. */
function pointedSessions(index: DurableIndex): Set<SessionId> {
  const pointed = new Set<SessionId>()
  for (const record of index.records) {
    pointed.add(record.childSessionId)
    for (const ancestor of record.ancestors) if (ancestor !== index.rootSessionId) pointed.add(ancestor)
  }
  return pointed
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error: unknown) {
    if ((error as { code?: unknown }).code === 'ENOENT') return false
    /* v8 ignore next -- a stat failure other than absence needs permissions the tests cannot revoke on every host. */
    throw error
  }
}

/**
 * Root-scoped evidence directory under one configured base. The caller
 * serializes writes and removals per root; reads may run concurrently.
 */
export class ChildEvidenceStore {
  constructor(private readonly base: string) {}

  /** Directory holding one root Session's index and copies.
   * @param root - root Session id.
   * @returns the absolute directory path, whether or not it exists.
   */
  rootDir(root: SessionId): string {
    return join(this.base, 'roots', encodeId(root))
  }

  private objectsDir(root: SessionId): string {
    return join(this.rootDir(root), 'objects')
  }

  private pointerFile(id: SessionId): string {
    return join(this.base, 'sessions', encodeId(id))
  }

  /**
   * The root whose evidence covers `id`: `id` itself when it has an index,
   * otherwise the root its pointer file names. A pointer to a root without an
   * index is stale and removed.
   * @param id - root, intermediate, or child Session id.
   * @returns the root id, or undefined when no evidence names `id`.
   * @throws {InvalidChildEvidenceError} for a pointer file with unexpected contents.
   */
  async resolveRoot(id: SessionId): Promise<SessionId | undefined> {
    if (await exists(join(this.rootDir(id), INDEX_FILE))) return id
    const file = this.pointerFile(id)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code === 'ENOENT') return undefined
      /* v8 ignore next -- an unreadable pointer needs permissions the tests cannot revoke on every host. */
      throw error
    }
    const validator: Validator = new Validator(file)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      validator.require(false, 'not JSON')
    }
    validator.require(isRecord(parsed) && parsed.schemaVersion === CHILD_EVIDENCE_SCHEMA_VERSION, 'schemaVersion is not current')
    validator.require(typeof parsed.rootSessionId === 'string' && parsed.rootSessionId !== '', 'rootSessionId is not a Session id')
    const root = parsed.rootSessionId as SessionId
    if (await exists(join(this.rootDir(root), INDEX_FILE))) return root
    await rm(file, { force: true })
    return undefined
  }

  /**
   * Read and validate one root's index.
   * @param root - root Session id.
   * @returns the index, or undefined when the root has none.
   * @throws {InvalidChildEvidenceError} when the file exists but fails validation.
   */
  async readIndex(root: SessionId): Promise<DurableIndex | undefined> {
    const file = join(this.rootDir(root), INDEX_FILE)
    let text: string
    try {
      text = await readFile(file, 'utf8')
    } catch (error: unknown) {
      if ((error as { code?: unknown }).code === 'ENOENT') return undefined
      /* v8 ignore next -- an unreadable index needs permissions the tests cannot revoke on every host. */
      throw error
    }
    const validator: Validator = new Validator(file)
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      validator.require(false, 'not JSON')
    }
    return validator.index(parsed, root)
  }

  /**
   * Store the copies the index references, replace the index in one rename,
   * remove copies no record references, and point every child and
   * intermediate Session at the root. A copy already present is kept as is. A
   * record whose copy is neither stored nor supplied is written as
   * unavailable with reason `capture-failed`; the record object is updated in place.
   * @param index - the complete record list of the root.
   * @param sources - Host paths of copies not yet stored, by SHA-1 name.
   * @throws when a copy or the index cannot be written; the previous index then stays in place.
   */
  async writeIndex(index: DurableIndex, sources: ReadonlyMap<string, string>): Promise<void> {
    const objects = this.objectsDir(index.rootSessionId)
    await mkdir(objects, { recursive: true, mode: 0o700 })
    const stored = new Set<string>()
    for (const record of index.records) {
      let complete = true
      for (const sha1 of objectNames(record)) {
        const target = join(objects, sha1)
        if (stored.has(sha1) || await exists(target)) { stored.add(sha1); continue }
        const source = sources.get(sha1)
        if (source === undefined || !await exists(source)) { complete = false; continue }
        const temp = `${target}.${randomBytes(6).toString('hex')}.tmp`
        try {
          await copyFile(source, temp)
          await rename(temp, target)
        } catch (error: unknown) {
          await rm(temp, { force: true })
          throw error
        }
        stored.add(sha1)
      }
      if (!complete) {
        record.state = 'unavailable'
        record.reason = 'capture-failed'
        record.bytes = 0
        record.entries = []
      }
    }
    await writeAtomic(join(this.rootDir(index.rootSessionId), INDEX_FILE), JSON.stringify(index))
    const referenced = new Set(index.records.flatMap(record => [...objectNames(record)]))
    for (const name of await readdir(objects)) {
      if (!referenced.has(name)) await rm(join(objects, name), { force: true })
    }
    const pointer = pointerText(index.rootSessionId)
    for (const id of pointedSessions(index)) {
      const file = this.pointerFile(id)
      const current = await readFile(file, 'utf8').catch(() => undefined)
      if (current !== pointer) await writeAtomic(file, pointer)
    }
  }

  /**
   * Remove one root's directory and the pointers its index named.
   * @param root - root Session id.
   * @param index - the root's last readable index, whose Sessions' pointers are removed; undefined leaves unknown pointers to expire on lookup.
   */
  async removeRoot(root: SessionId, index: DurableIndex | undefined): Promise<void> {
    const dir = this.rootDir(root)
    const info = await lstat(dir).catch(() => undefined)
    if (info?.isSymbolicLink() === true) await unlink(dir)
    else if (info !== undefined) await rm(dir, { recursive: true, force: true })
    if (index === undefined) return
    const pointer = pointerText(root)
    for (const id of pointedSessions(index)) {
      const file = this.pointerFile(id)
      const current = await readFile(file, 'utf8').catch(() => undefined)
      if (current === pointer) await rm(file, { force: true })
    }
  }

  /**
   * Read one side's text from its stored copy.
   * @param root - root Session id.
   * @param side - the side named by a validated index.
   * @param signal - cancels the read.
   * @returns the text, or null for an absent side.
   * @throws {InvalidChildEvidenceError} when the copy is missing, lies outside the root's directory, or its size differs from the index.
   */
  async readSide(root: SessionId, side: DurableSide, signal: AbortSignal): Promise<string | null> {
    if (side.kind === 'absent') return null
    const objects = this.objectsDir(root)
    const file = join(objects, side.sha1)
    if (!SHA1.test(side.sha1) || !isInside(objects, file)) throw new InvalidChildEvidenceError(file, 'copy name is not a SHA-1 inside the root directory')
    const info = await stat(file).catch((error: unknown) => {
      if ((error as { code?: unknown }).code === 'ENOENT') return undefined
      /* v8 ignore next -- an unreadable copy needs permissions the tests cannot revoke on every host. */
      throw error
    })
    if (info === undefined || !info.isFile()) throw new InvalidChildEvidenceError(file, 'copy is missing')
    if (info.size !== side.size) throw new InvalidChildEvidenceError(file, `copy holds ${info.size} bytes, the index records ${side.size}`)
    return readFile(file, { encoding: 'utf8', signal })
  }
}
