/** Content-addressed child evidence: atomic index writes, validated reads, and root removal. */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  CHILD_EVIDENCE_SCHEMA_VERSION, ChildEvidenceStore, InvalidChildEvidenceError, type DurableIndex, type DurableRecord,
} from '../src/durable.ts'

const cleanups: Array<() => Promise<unknown>> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })

const signal = AbortSignal.timeout(5_000)
const root = SessionId('parent')
const child = SessionId('child')

async function base(): Promise<{ dir: string; store: ChildEvidenceStore }> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-child-evidence-'))
  cleanups.push(() => rm(dir, { recursive: true, force: true }))
  return { dir, store: new ChildEvidenceStore(dir) }
}

function digest(bytes: string): string {
  return createHash('sha1').update(bytes).digest('hex')
}

function record(after: string, sha1: string): DurableRecord {
  return {
    childSessionId: child, ancestors: [root], turn: 1, cwd: '/tmp/ws', state: 'available', shared: false,
    bytes: Buffer.byteLength(after), recordedAt: 1, paths: ['/tmp/ws/actual.txt'],
    entries: [{
      seq: 7,
      summary: { turn: 1, cwd: '/tmp/ws', files: [{ path: 'actual.txt', display: 'actual.txt', added: 1, deleted: 0 }], total: 1, added: 1, deleted: 0 },
      files: [{ before: { kind: 'absent' }, after: { kind: 'object', sha1, size: Buffer.byteLength(after) } }],
    }],
  }
}

function indexOf(records: DurableRecord[]): DurableIndex {
  return { schemaVersion: CHILD_EVIDENCE_SCHEMA_VERSION, rootSessionId: root, writtenAt: 1, records }
}

describe('ChildEvidenceStore', () => {
  it('replaces an index atomically and serves validated sides and pointers', async () => {
    const { dir, store } = await base()
    const after = 'first\n'
    const sha1 = digest(after)
    const source = join(dir, 'source.txt')
    await writeFile(source, after)
    await store.writeIndex(indexOf([record(after, sha1)]), new Map([[sha1, source]]))
    expect(await store.readIndex(root)).toMatchObject({ rootSessionId: root, records: [{ childSessionId: child, turn: 1 }] })
    expect(await store.readSide(root, { kind: 'object', sha1, size: Buffer.byteLength(after) }, signal)).toBe(after)
    expect(await store.resolveRoot(root)).toBe(root)
    expect(await store.resolveRoot(child)).toBe(root)
  })

  it('refuses a malformed index and a copy whose size disagrees with the index', async () => {
    const { dir, store } = await base()
    await mkdir(store.rootDir(root), { recursive: true, mode: 0o700 })
    await writeFile(join(store.rootDir(root), 'index.json'), '{')
    await expect(store.readIndex(root)).rejects.toBeInstanceOf(InvalidChildEvidenceError)
    const after = 'first\n'
    const sha1 = digest(after)
    const source = join(dir, 'source.txt')
    await writeFile(source, after)
    await store.writeIndex(indexOf([record(after, sha1)]), new Map([[sha1, source]]))
    await expect(store.readSide(root, { kind: 'object', sha1, size: Buffer.byteLength(after) + 10 }, signal))
      .rejects.toBeInstanceOf(InvalidChildEvidenceError)
  })

  it('marks a record unavailable when its copy is neither stored nor supplied', async () => {
    const { store } = await base()
    const after = 'missing\n'
    const sha1 = digest(after)
    await store.writeIndex(indexOf([record(after, sha1)]), new Map())
    expect(await store.readIndex(root)).toMatchObject({ records: [{ state: 'unavailable', reason: 'capture-failed', entries: [] }] })
  })

  it('removes a root directory and the pointers that still name it', async () => {
    const { dir, store } = await base()
    const after = 'first\n'
    const sha1 = digest(after)
    const source = join(dir, 'source.txt')
    await writeFile(source, after)
    const written = indexOf([record(after, sha1)])
    await store.writeIndex(written, new Map([[sha1, source]]))
    await store.removeRoot(root, written)
    expect(await store.readIndex(root)).toBeUndefined()
    expect(await store.resolveRoot(child)).toBeUndefined()
    await expect(readFile(join(store.rootDir(root), 'index.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('drops a pointer whose named root no longer has an index', async () => {
    const { dir, store } = await base()
    const pointer = join(dir, 'sessions', encodeURIComponent(child))
    await mkdir(join(dir, 'sessions'), { recursive: true, mode: 0o700 })
    await writeFile(pointer, JSON.stringify({ schemaVersion: CHILD_EVIDENCE_SCHEMA_VERSION, rootSessionId: root }))
    expect(await store.resolveRoot(child)).toBeUndefined()
    await expect(readFile(pointer)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
