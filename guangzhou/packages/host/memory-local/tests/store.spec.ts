import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { MemoryStore } from '../src/store.ts'
import type { MemoryInput } from '../src/types.ts'

const stores: MemoryStore[] = []; const roots: string[] = []
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
const note = (extra: Partial<MemoryInput> = {}): MemoryInput => ({ title: '开发方法', content: '先读源码，然后实现并测试。', kind: 'permanent', scope: 'personal', source: '用户投喂', ...extra })
async function open(now?: () => number) {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-memory-')); roots.push(root)
  const path = join(root, 'vault.sqlite'); const store = await MemoryStore.open(path, now); stores.push(store)
  return { store, path }
}

describe('durable local knowledge lifecycle', () => {
  it('preserves source text, Chinese retrieval and revisions across restarts', async () => {
    const { store, path } = await open()
    const saved = store.save(note({ content: '# 开发方法\n\n先读源码，再做测试。  保留空格\n' }))
    expect(store.list({ query: '源码' }).items[0]?.id).toBe(saved.id)
    const next = store.save(note({ id: saved.id, expectedRevision: 1, content: '按模块组织代码，验收需要证据。' }))
    expect(next.revision).toBe(2)
    store.close()
    const resumed = await MemoryStore.open(path); stores.push(resumed)
    expect(resumed.read(saved.id).revisions[0]?.content).toBe(saved.content)
    expect(resumed.list({ query: '源码' }).total).toBe(0)
    expect(resumed.list({ query: '证据' }).items[0]?.revision).toBe(2)
    expect((await stat(path)).mode & 0o777).toBe(0o600)
  })
  it('does not expose other projects, candidates or expired notes to employees', async () => {
    let time = 1000
    const { store } = await open(() => time)
    const personal = store.save(note())
    store.save(note({ scope: 'workspace', workspace: '/other', title: '隔离项目' }))
    const pending = store.save(note({ kind: 'experience', scope: 'workspace', workspace: '/work', evidence: '测试记录 output/test.log' }), 'agent', { workspace: '/work' })
    const temp = store.save(note({ kind: 'temporary', scope: 'workspace', workspace: '/work', expiresInDays: 1 }), 'agent', { workspace: '/work' })
    expect(store.list({}, { workspace: '/work' }).items.map(item => item.id).sort()).toEqual([personal.id, temp.id].sort())
    expect(() => store.read(pending.id, { workspace: '/work' })).toThrow('MEMORY_NOT_FOUND')
    expect(store.list({}, { workspace: '/work' }).stats.candidates).toBe(0)
    store.review(pending.id, 1, 'accept')
    expect(store.read(pending.id, { workspace: '/work' }).entry.status).toBe('active')
    time += 86400001
    expect(() => store.read(temp.id)).toThrow('MEMORY_NOT_FOUND')
    expect(store.export().events).toContainEqual(expect.objectContaining({ entry_id: temp.id, action: 'expired' }))
  })
  it('refuses stale edits, unauthorized agent writes and unsupported fields at the actual operation', async () => {
    const { store } = await open()
    const saved = store.save(note())
    store.save(note({ id: saved.id, expectedRevision: 1, title: '新版' }))
    expect(() => store.save(note({ id: saved.id, expectedRevision: 1 }))).toThrow('MEMORY_REVISION_CONFLICT')
    expect(() => store.delete(saved.id, 1)).toThrow('MEMORY_REVISION_CONFLICT')
    expect(() => store.save(note(), 'agent', { workspace: '/work' })).toThrow('MEMORY_WRITE_DENIED')
    expect(() => store.save(note({ kind: 'temporary', scope: 'workspace', workspace: '/other' }), 'agent', { workspace: '/work' })).toThrow('MEMORY_WRITE_DENIED')
    expect(() => store.save({ ...note(), status: 'active', secret: 'do not persist' })).toThrow('UNSUPPORTED_MEMORY_FIELD')
    expect(store.read(saved.id).entry.title).toBe('新版')
  })
  it('deletes all original/history/index content while retaining only a content-free receipt', async () => {
    const { store } = await open()
    const saved = store.save(note({ content: '独有秘密原文标记' }))
    store.save(note({ id: saved.id, expectedRevision: 1, content: '独有秘密修改标记' }))
    store.delete(saved.id, 2)
    expect(store.list({ query: '秘密' }).items).toEqual([])
    expect(JSON.stringify(store.export())).not.toContain('秘密')
    expect(store.export().events.at(-1)).toMatchObject({ action: 'deleted', entry_id: saved.id })
  })
  it('requires evidence for learning and rejection erases the proposal', async () => {
    const { store } = await open()
    expect(() => store.save(note({ kind: 'experience' }))).toThrow('MEMORY_EVIDENCE_REQUIRED')
    const saved = store.save(note({ kind: 'experience', scope: 'workspace', workspace: '/work', evidence: 'test-results.json' }), 'agent', { workspace: '/work' })
    expect(store.list({ status: 'candidate' }).total).toBe(1)
    expect(store.review(saved.id, 1, 'reject')).toEqual({ deleted: true })
    expect(() => store.read(saved.id)).toThrow('MEMORY_NOT_FOUND')
  })
  it('quotes FTS input and bounds multibyte document size and pages', async () => {
    const { store } = await open()
    store.save(note({ content: 'literal OR sqlite query; 中文测试' }))
    expect(store.list({ query: '" OR NOT *' }).items).toHaveLength(1)
    expect(store.list({ query: '***' }).items).toEqual([])
    expect(() => store.list({ limit: 101 })).toThrow('INVALID_MEMORY_PAGE')
    expect(() => store.save(note({ content: '中'.repeat(180000) }))).toThrow('MEMORY_DOCUMENT_TOO_LARGE')
    expect(() => store.save(note({ scope: 'workspace', workspace: '../other' }))).toThrow('WORKSPACE_MUST_BE_ABSOLUTE')
  })
  it('searches matching passages beyond a document opening without returning the entire document', async () => {
    const { store } = await open()
    store.save(note({ kind: 'knowledge', content: '前言。'.repeat(1200) + '\n我们使用云端配对协议连接服务器。\n' + '尾声。'.repeat(500) }))
    const found = store.list({ query: '服务器' })
    expect(found.items[0]?.snippet).toContain('服务器')
    expect(JSON.stringify(found).length).toBeLessThan(3000)
    expect(found.items[0]).not.toHaveProperty('content')
  })
  it('rejects a foreign SQLite database without changing its application schema', async () => {
    const { path, store } = await open(); store.close()
    const other = path + '.other'
    const db = new DatabaseSync(other); db.exec('CREATE TABLE private_data(value TEXT)'); db.close()
    await expect(MemoryStore.open(other)).rejects.toThrow('MEMORY_DATABASE_NOT_EMPTY')
    const check = new DatabaseSync(other)
    expect(check.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([{ name: 'private_data' }]); check.close()
  })
})
