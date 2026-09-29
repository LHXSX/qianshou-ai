/** Real Loader, file tools, Session lifetimes, and child evidence; no model or network dependency. */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { InvalidChildEvidenceError } from '../src/durable.ts'
import { TurnRecorder } from '../src/recorder.ts'
import { makeBoot } from './child-loader.ts'
import { endTurn, startTurn } from './support.ts'

const cleanups: Array<() => unknown> = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); vi.restoreAllMocks() })
const signal = new AbortController().signal
const boot = makeBoot(cleanups)

describe('child evidence through real Loader and file tools', () => {
  it('keeps a one-shot child diff after its real Session detaches, and releases it with the root', async () => {
    const b = await boot()
    const parent = b.make('parent')
    const child = b.make('one-shot', b.root, parent.session)
    startTurn(child.session, 1)
    expect((await b.write(child.session, 1, 'write', { file_path: 'actual.txt', content: 'first\n' })).isError).toBe(false)
    await b.finish(child.session, 1)
    const [record] = b.ctx.workspaceChanges.children(parent.session.id).entries
    expect(record).toMatchObject({ sessionId: child.session.id, turn: 1, state: 'available', total: 1 })
    expect(child.session.snapshotEvents().find(event => event.seq === record!.seq)).toMatchObject({ type: 'workspace/changes', data: { turn: 1 } })
    child.detach()
    await writeFile(join(b.root, 'actual.txt'), 'user later\n')
    expect(await b.ctx.workspaceChanges.diff(child.session.id, record!.seq!, 0, signal)).toMatchObject({
      before: false, after: true, hunks: [{ lines: ['+first'] }],
    })
    expect(await readFile(join(b.root, 'actual.txt'), 'utf8')).toBe('user later\n')
    parent.detach()
    expect(b.ctx.workspaceChanges.summary(child.session.id, record!.seq!)).toBeUndefined()
    expect(b.ctx.workspaceChanges.children(parent.session.id)).toEqual({ available: false, entries: [] })
  })

  it('keeps continuous turns and independent workspaces separate even when roots share paths', async () => {
    const b = await boot()
    const parent = b.make('p'), other = b.make('other')
    const independent = join(b.root, 'independent')
    await mkdir(independent)
    const child = b.make('child', independent, parent.session)
    startTurn(child.session, 1)
    await b.write(child.session, 1, 'write', { file_path: 'same.txt', content: 'first\n' })
    await b.finish(child.session, 1)
    startTurn(child.session, 2)
    await b.write(child.session, 2, 'edit', { file_path: 'same.txt', old_string: 'first', new_string: 'second' })
    await b.finish(child.session, 2)
    const rows = b.ctx.workspaceChanges.children(parent.session.id).entries
    expect(rows.map(row => row.turn)).toEqual([1, 2])
    expect(b.ctx.workspaceChanges.children(other.session.id).entries).toEqual([])
    expect(b.ctx.workspaceChanges.summary(child.session.id, rows[1]!.seq!)?.cwd).toBe(independent)
    expect(await b.ctx.workspaceChanges.diff(child.session.id, rows[0]!.seq!, 0, signal)).toMatchObject({ hunks: [{ lines: ['+first'] }] })
    expect(await b.ctx.workspaceChanges.diff(child.session.id, rows[1]!.seq!, 0, signal)).toMatchObject({ hunks: [{ lines: ['-first', '+second'] }] })
  })

  it('does not read before a refused or cancelled call, and preserves the original tool failure', async () => {
    const b = await boot()
    const parent = b.make('p'), child = b.make('c', b.root, parent.session)
    startTurn(child.session, 1)
    const reads = vi.spyOn(b.ctx.fs, 'readBytes')
    const failed = await b.write(child.session, 1, 'edit', { file_path: 'missing.txt', old_string: 'old', new_string: 'new' })
    expect(failed.isError).toBe(true)
    const cancelled = AbortSignal.abort()
    expect((await b.write(child.session, 1, 'write', { file_path: 'cancelled.txt', content: 'never' }, cancelled)).isError).toBe(true)
    await b.finish(child.session, 1)
    expect(reads).not.toHaveBeenCalled()
    expect(b.ctx.workspaceChanges.children(parent.session.id).entries).toMatchObject([{ state: 'unavailable', reason: 'capture-failed' }])
    expect(child.session.snapshotEvents().filter(event => event.type === 'workspace/changes')).toEqual([])
  })

  it('marks interleaved same-file work without exposing the other root or replacing historical sides', async () => {
    const b = await boot()
    const p1 = b.make('p1'), p2 = b.make('p2')
    const a = b.make('a', b.root, p1.session), c = b.make('c', b.root, p2.session)
    startTurn(a.session, 1); startTurn(c.session, 1)
    await b.write(a.session, 1, 'write', { file_path: 'shared.txt', content: 'a\n' })
    await b.write(c.session, 1, 'write', { file_path: 'shared.txt', content: 'c\n' })
    await b.finish(a.session, 1); await b.finish(c.session, 1)
    expect(b.ctx.workspaceChanges.children(p1.session.id).entries).toMatchObject([{ sessionId: a.session.id, shared: true }])
    expect(b.ctx.workspaceChanges.children(p2.session.id).entries).toMatchObject([{ sessionId: c.session.id, shared: true }])
    const seq = b.ctx.workspaceChanges.children(p1.session.id).entries[0]!.seq!
    expect(await b.ctx.workspaceChanges.diff(a.session.id, seq, 0, signal)).toMatchObject({ hunks: [{ lines: ['+a'] }] })
  })

  it('bounds retained bytes and records while preserving source files', async () => {
    const b = await boot({ childMaxRecords: 2, childMaxBytes: 8 })
    const parent = b.make('p'), child = b.make('c', b.root, parent.session)
    for (let turn = 1; turn <= 3; turn++) {
      startTurn(child.session, turn)
      await b.write(child.session, turn, 'write', { file_path: `${turn}.txt`, content: `value${turn}\n` })
      await b.finish(child.session, turn)
    }
    const rows = b.ctx.workspaceChanges.children(parent.session.id).entries
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ turn: 2, state: 'unavailable', reason: 'retention-limit' })
    expect(rows[1]).toMatchObject({ turn: 3, state: 'available' })
    expect(await readFile(join(b.root, '1.txt'), 'utf8')).toBe('value1\n')
  })

  it('ignores a late result after detach and keeps a resumed same-ID generation independent', async () => {
    const b = await boot()
    const parent = b.make('p'), old = b.make('child', b.root, parent.session)
    const settled = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let hold = true
    b.ctx.on('tools/execute', async (_exec, next) => {
      const result = await next()
      if (hold) { hold = false; settled.resolve(undefined); await release.promise }
      return result
    })
    startTurn(old.session, 1)
    const late = b.write(old.session, 1, 'write', { file_path: 'late.txt', content: 'old operation\n' })
    await settled.promise
    endTurn(old.session, 1)
    old.detach()
    const resumed = b.ctx.sessions.prepare(old.session.id, { meta: old.session.header, seed: old.session.snapshotEvents() })
    const detach = b.ctx.sessions.enter(resumed)
    b.ctx.sessions.announce(resumed)
    cleanups.push(detach)
    startTurn(resumed, 2)
    release.resolve(undefined)
    await late
    await b.write(resumed, 2, 'edit', { file_path: 'late.txt', old_string: 'old operation', new_string: 'resumed operation' })
    await b.finish(resumed, 2)
    const rows = b.ctx.workspaceChanges.children(parent.session.id).entries
    expect(rows.find(row => row.turn === 1)?.state).toBe('unavailable')
    const current = rows.find(row => row.turn === 2)!
    expect(await b.ctx.workspaceChanges.diff(resumed.id, current.seq!, 0, signal)).toMatchObject({
      hunks: [{ lines: ['-old operation', '+resumed operation'] }],
    })
    expect(resumed.snapshotEvents().filter(event => event.type === 'workspace/changes')).toHaveLength(1)
  })

  it('keeps disposing copies charged while another child tries to reserve the same byte budget', async () => {
    const b = await boot({ childMaxBytes: 8 })
    const parent = b.make('p'), first = b.make('first', b.root, parent.session)
    startTurn(first.session, 1)
    await b.write(first.session, 1, 'write', { file_path: 'first.txt', content: '12345678' })
    await b.finish(first.session, 1)
    const disposing = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    const disposal = vi.spyOn(TurnRecorder.prototype, 'dispose')
    disposal.mockImplementationOnce(async function (this: TurnRecorder) {
      disposing.resolve(undefined)
      await release.promise
      disposal.mockRestore()
      return this.dispose()
    })
    const second = b.make('second', b.root, parent.session), third = b.make('third', b.root, parent.session)
    startTurn(second.session, 1); startTurn(third.session, 1)
    const secondWrite = b.write(second.session, 1, 'write', { file_path: 'second.txt', content: 'abcdefgh' })
    await disposing.promise
    await b.write(third.session, 1, 'write', { file_path: 'third.txt', content: 'ABCDEFGH' })
    await b.finish(third.session, 1)
    const thirdRecord = b.ctx.workspaceChanges.children(parent.session.id).entries.find(row => row.sessionId === third.session.id)!
    expect(thirdRecord.reason).toBe('retention-limit')
    expect(await b.ctx.workspaceChanges.diff(third.session.id, thirdRecord.seq!, 0, signal)).toMatchObject({ kind: 'oversized' })
    release.resolve(undefined)
    await secondWrite
    await b.finish(second.session, 1)
    expect(await readFile(join(b.root, 'third.txt'), 'utf8')).toBe('ABCDEFGH')
  })

  it('does not aggregate an unverifiable parent or interpret an overwritten binary as a new file', async () => {
    const b = await boot()
    const parent = b.make('p'), child = b.make('c', b.root, parent.session)
    await writeFile(join(b.root, 'binary'), Buffer.from([0, 1, 2]))
    startTurn(child.session, 1)
    await b.write(child.session, 1, 'write', { file_path: 'binary', content: 'text\n' })
    await b.finish(child.session, 1)
    const row = b.ctx.workspaceChanges.children(parent.session.id).entries[0]!
    expect(await b.ctx.workspaceChanges.diff(child.session.id, row.seq!, 0, signal)).toMatchObject({ kind: 'oversized' })
    const detached = b.ctx.sessions.create(SessionId('unknown-child'), { meta: { cwd: b.root, origin: 'subagent', parentSession: SessionId('missing') } })
    startTurn(detached, 1)
    await b.write(detached, 1, 'write', { file_path: 'not-owned.txt', content: 'real file\n' })
    expect(b.ctx.workspaceChanges.children(parent.session.id).entries).toHaveLength(1)
  })
})

describe('child evidence across a later Host process', () => {
  async function durableDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-child-durable-'))
    cleanups.push(() => rm(dir, { recursive: true, force: true }))
    return dir
  }

  async function waitIndex(dir: string, root = 'parent'): Promise<string> {
    const file = join(dir, 'roots', root, 'index.json')
    await vi.waitFor(async () => { expect(await readFile(file, 'utf8')).toContain('"schemaVersion":1') })
    return file
  }

  it('serves a completed child diff after the first Host process is gone', async () => {
    const childDurableDir = await durableDir()
    const first = await boot({ childDurableDir })
    const parent = first.make('parent')
    const child = first.make('one-shot', first.root, parent.session)
    startTurn(child.session, 1)
    expect((await first.write(child.session, 1, 'write', { file_path: 'actual.txt', content: 'first\n' })).isError).toBe(false)
    await first.finish(child.session, 1)
    const [record] = first.ctx.workspaceChanges.children(parent.session.id).entries
    expect(record).toMatchObject({ sessionId: child.session.id, turn: 1, state: 'available', total: 1 })
    await waitIndex(childDurableDir)
    await first.ctx.fiber.dispose()
    const second = await boot({ childDurableDir }, { stored: new Set(['parent']) })
    await vi.waitFor(() => {
      expect(second.ctx.workspaceChanges.children(SessionId('parent'))).toMatchObject({
        available: true, entries: [{ sessionId: child.session.id, turn: 1, state: 'available', total: 1 }],
      })
    })
    expect(await second.ctx.workspaceChanges.diff(child.session.id, record!.seq!, 0, signal)).toMatchObject({
      before: false, after: true, hunks: [{ lines: ['+first'] }],
    })
  })

  it('removes stored evidence when the root Session is no longer stored', async () => {
    const childDurableDir = await durableDir()
    const first = await boot({ childDurableDir })
    const parent = first.make('parent')
    const child = first.make('c', first.root, parent.session)
    startTurn(child.session, 1)
    await first.write(child.session, 1, 'write', { file_path: 'gone.txt', content: 'x\n' })
    await first.finish(child.session, 1)
    const index = await waitIndex(childDurableDir)
    await first.ctx.fiber.dispose()
    const second = await boot({ childDurableDir }, { stored: new Set() })
    second.ctx.workspaceChanges.children(SessionId('parent'))
    await vi.waitFor(async () => { await expect(readFile(index)).rejects.toMatchObject({ code: 'ENOENT' }) })
    expect(second.ctx.workspaceChanges.children(SessionId('parent'))).toEqual({ available: false, entries: [] })
  })

  it('refuses a comparison when the stored index fails validation', async () => {
    const childDurableDir = await durableDir()
    await mkdir(join(childDurableDir, 'roots', 'parent'), { recursive: true, mode: 0o700 })
    await writeFile(join(childDurableDir, 'roots', 'parent', 'index.json'), '{')
    const later = await boot({ childDurableDir }, { stored: new Set(['parent']) })
    await expect(later.ctx.workspaceChanges.diff(SessionId('parent'), 1, 0, signal)).rejects.toBeInstanceOf(InvalidChildEvidenceError)
  })

  it('keeps the same record budget after a later Host reads the index', async () => {
    const childDurableDir = await durableDir()
    const first = await boot({ childDurableDir, childMaxRecords: 2, childMaxBytes: 8 })
    const parent = first.make('p'), child = first.make('c', first.root, parent.session)
    for (let turn = 1; turn <= 3; turn++) {
      startTurn(child.session, turn)
      await first.write(child.session, turn, 'write', { file_path: `${turn}.txt`, content: `value${turn}\n` })
      await first.finish(child.session, turn)
    }
    expect(first.ctx.workspaceChanges.children(parent.session.id).entries).toMatchObject([
      { turn: 2, state: 'unavailable', reason: 'retention-limit' },
      { turn: 3, state: 'available' },
    ])
    await waitIndex(childDurableDir, 'p')
    await first.ctx.fiber.dispose()
    const second = await boot({ childDurableDir, childMaxRecords: 2, childMaxBytes: 8 }, { stored: new Set(['p']) })
    await vi.waitFor(() => {
      expect(second.ctx.workspaceChanges.children(SessionId('p')).entries).toMatchObject([
        { turn: 2, state: 'unavailable', reason: 'retention-limit' },
        { turn: 3, state: 'available' },
      ])
    })
  })

  it('writes under $DSH_HOME/qianshou/child-changes when includeChildren is on and no directory is configured', async () => {
    const home = await durableDir()
    const first = await boot({}, { home })
    const parent = first.make('parent')
    const child = first.make('c', first.root, parent.session)
    startTurn(child.session, 1)
    await first.write(child.session, 1, 'write', { file_path: 'home.txt', content: 'home\n' })
    await first.finish(child.session, 1)
    await waitIndex(join(home, 'qianshou', 'child-changes'))
  })
})

