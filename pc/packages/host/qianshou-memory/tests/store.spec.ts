import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../src/store.ts'
import { parseInput, parseQuery, parseReview } from '../src/validation.ts'
import type { MemoryAccess, MemoryExportPage, MemoryOrigin } from '../src/types.ts'

const a = '00000000-0000-4000-8000-000000000001' as MemoryAccess['workspaceId']
const b = '00000000-0000-4000-8000-000000000002' as MemoryAccess['workspaceId']
const accessA: MemoryAccess = { workspaceId: a, workspacePath: '/synthetic/a' }
const accessB: MemoryAccess = { workspaceId: b, workspacePath: '/synthetic/b' }
const origin = { sessionId: 'qa-session', callId: 'qa-call' } as MemoryOrigin
const dirs: string[] = []; const stores: MemoryStore[] = []
async function setup(capacity = 128 * 1024 * 1024, now = Date.now) {
  const dir = await mkdtemp(join(tmpdir(), 'qianshou-device-memory-')); dirs.push(dir)
  const path = join(dir, 'new-vault', 'v1.sqlite')
  const store = await MemoryStore.open(path, capacity, now); stores.push(store)
  return { store, path }
}
function draft(content = '合成检索 唯一内容', extra: Record<string, unknown> = {}) { return parseInput({ title: '合成资料', content, kind: 'knowledge', scope: 'device', ...extra }) }
function exported(store: MemoryStore) {
  const pages: MemoryExportPage[] = []; let page = store.exportPage({}); pages.push(page)
  while (page.next) { page = store.exportPage({ revision: page.revision, ...page.next }); pages.push(page) }
  return pages
}
afterEach(async () => { for (const store of stores.splice(0)) store.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })

describe('new device vault with real temporary SQLite', () => {
  it('restores original Unicode text, versions, vault identity and owner-only files after closing', async () => {
    const { store, path } = await setup()
    const initial = store.save(draft('原文第一版 🐙'), null)
    store.save(draft('原文第二版 🐙', { id: initial.id, expectedRevision: 1 }), null)
    const identity = store.identity(); store.close()
    const restored = await MemoryStore.open(path, 128 * 1024 * 1024); stores.push(restored)
    expect(restored.identity()).toEqual(identity)
    expect(restored.read(initial.id).entry.content).toBe('原文第二版 🐙')
    expect(restored.read(initial.id).revisions[0]?.content).toBe('原文第一版 🐙')
    expect((await stat(path)).mode & 0o777).toBe(0o600)
    expect((await stat(join(path, '..'))).mode & 0o777).toBe(0o700)
    expect(JSON.stringify(identity)).not.toMatch(/account|username|token/)
  })
  it('rejects legacy/foreign databases without modifying their schema', async () => {
    const { store, path } = await setup(); store.close()
    const foreign = new DatabaseSync(path); foreign.exec('PRAGMA application_id=0x51534d45'); foreign.close()
    await expect(MemoryStore.open(path, 99999)).rejects.toThrow('storage-failed')
    const check = new DatabaseSync(path)
    expect(check.prepare('PRAGMA application_id').get()?.application_id).toBe(0x51534d45); check.close()
  })
  it('keeps confirmed device and current workspace visible while hiding other workspaces and candidates, including counts', async () => {
    const { store } = await setup()
    const common = store.save(draft('共享标记 shared'), null)
    const localA = store.save(draft('甲域标记 scoped', { scope: 'workspace', workspaceId: a }), accessA.workspacePath)
    const localB = store.save(draft('乙域标记 scoped', { scope: 'workspace', workspaceId: b }), accessB.workspacePath)
    const candidate = store.propose({ title: '候选', content: '候选标记 scoped', evidence: '合成测试结果' }, accessA, origin)
    expect(store.list({}, accessA).items.map(v => v.id).sort()).toEqual([common.id, localA.id].sort())
    expect(store.list({}, accessB).items.map(v => v.id).sort()).toEqual([common.id, localB.id].sort())
    expect(store.list({}, accessA).stats).toEqual({ temporary: 0, permanent: 0, knowledge: 2, experience: 0, candidates: 0 })
    expect(() => store.read(localB.id, accessA)).toThrow('not-found')
    expect(() => store.read(candidate.id, accessA)).toThrow('not-found')
    expect(store.read(localA.id, accessA).revisions).toEqual([])
    expect(store.list({}, { workspaceId: null, workspacePath: null }).items.map(v => v.id)).toEqual([common.id])
  })
  it('requires owner review, preserves tool-call idempotence and cannot revive a rejected proposal', async () => {
    const { store } = await setup()
    const input = { title: '经验', content: '候选关键字 candidate', evidence: '工作区合成测试' }
    const proposed = store.propose(input, accessA, origin)
    expect(store.propose(input, accessA, origin).id).toBe(proposed.id)
    expect(() => store.save(draft('偷改候选', { id: proposed.id, expectedRevision: 1 }), null)).toThrow('candidate-readonly')
    expect(() => store.review(proposed.id, 2, 'accept')).toThrow('conflict')
    store.review(proposed.id, 1, 'accept')
    expect(store.list({ query: 'candidate' }, accessA).items[0]?.id).toBe(proposed.id)
    const rejected = store.propose(input, accessA, { ...origin, callId: 'qa-rejected' as MemoryOrigin['callId'] })
    store.review(rejected.id, 1, 'reject')
    expect(() => store.propose(input, accessA, { ...origin, callId: 'qa-rejected' as MemoryOrigin['callId'] })).toThrow('proposal-removed')
  })
  it('erases original, versions and FTS while leaving only content-free receipts', async () => {
    const { store, path } = await setup()
    const first = store.save(draft('SecretSyntheticMarkerOne'), null)
    const next = store.save(draft('SecretSyntheticMarkerTwo', { id: first.id, expectedRevision: 1 }), null)
    expect(() => store.delete(first.id, 1)).toThrow('conflict')
    store.delete(next.id, 2)
    expect(() => store.read(next.id)).toThrow('not-found')
    expect(JSON.stringify(exported(store))).not.toMatch(/SecretSyntheticMarker/)
    const check = new DatabaseSync(path)
    for (const table of ['entries', 'revisions', 'chunks', 'chunk_search']) expect(check.prepare(`SELECT count(*) AS n FROM ${table}`).get()?.n).toBe(0)
    expect(check.prepare('SELECT action FROM receipts ORDER BY seq DESC').get()?.action).toBe('deleted'); check.close()
  })
  it('does not overwrite on stale revision and accounts for serialized previous revisions', async () => {
    const { store } = await setup(1600)
    const first = store.save(draft('x'.repeat(700)), null)
    expect(() => store.save(draft('short', { id: first.id, expectedRevision: 99 }), null)).toThrow('conflict')
    expect(() => store.save(draft('y'.repeat(700), { id: first.id, expectedRevision: 1 }), null)).toThrow('capacity')
    expect(store.read(first.id).entry.content).toBe('x'.repeat(700))
    expect(store.read(first.id).revisions).toHaveLength(0)
  })
  it('physically expires temporary records on read and after restart', async () => {
    let now = 1000; const { store, path } = await setup(100000, () => now)
    const first = store.save(draft('过期标记', { kind: 'temporary', expiresInDays: 1 }), null)
    store.close(); now += 86400000
    const restored = await MemoryStore.open(path, 100000, () => now); stores.push(restored)
    expect(() => restored.read(first.id)).toThrow('not-found')
    expect(JSON.stringify(exported(restored))).not.toContain('过期标记')
  })
  it('exports all pages of one revision and rejects mutation during export', async () => {
    const { store } = await setup()
    for (let i = 0; i < 5; i++) store.save(draft(`原文 ${i}`), null)
    const pages = exported(store)
    expect(pages.flatMap(p => p.entries)).toHaveLength(5)
    expect(pages.flatMap(p => p.receipts)).toHaveLength(5)
    expect(new Set(pages.map(p => p.revision)).size).toBe(1)
    const first = store.exportPage({}); store.save(draft('新增资料'), null)
    expect(() => store.exportPage({ revision: first.revision, ...first.next! })).toThrow('export-changed')
  })
  it('bounds initial history and every additional page, rejecting changed revision while paging', async () => {
    const { store } = await setup()
    let record = store.save(draft('v1'), null)
    for (let revision = 2; revision <= 7; revision++) record = store.save(draft(`v${revision}`, { id: record.id, expectedRevision: record.revision }), null)
    const detail = store.read(record.id)
    expect(detail.revisions.map(item => item.revision)).toEqual([6, 5])
    expect(detail.revisionCount).toBe(6)
    expect(detail.nextRevisionOffset).toBe(2)
    expect(store.historyPage(record.id, 7, 2).revisions.map(item => item.revision)).toEqual([4, 3])
    expect(store.historyPage(record.id, 7, 4).nextOffset).toBeNull()
    store.save(draft('v8', { id: record.id, expectedRevision: 7 }), null)
    expect(() => store.historyPage(record.id, 7, 4)).toThrow('conflict')
  })
  it('rejects unknown fields, invalid destinations and oversize UTF-8 before storage', () => {
    expect(() => draft('a', { cloudAccount: 'untrusted' })).toThrow('invalid-request')
    expect(() => draft('🐙'.repeat(140000))).toThrow('invalid-request')
    expect(() => draft('a', { scope: 'workspace' })).toThrow('invalid-request')
    expect(() => parseQuery({ limit: 1000 })).toThrow('invalid-request')
    expect(() => parseReview({ id: 'fake', expectedRevision: 1, action: 'accept' })).toThrow('invalid-request')
  })
})
