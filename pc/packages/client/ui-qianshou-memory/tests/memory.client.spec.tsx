// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Context, FiberState } from '@deepseek-ai/cordis'
import type { MemoryDetail, MemoryEntry, MemoryExportPage, MemoryPage as Page, MemoryState } from '@deepseek-ai/dsh-api-remotes/client'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { MemoryController } from '../src/client/controller.ts'
import { MemoryPage, type MemoryPageProps } from '../src/client/MemoryPage.tsx'
import { importText } from '../src/client/files.ts'
import { zh } from '../src/client/locales.ts'
import { apply, inject } from '../src/client/index.ts'

const id = '00000000-0000-4000-8000-000000000001' as MemoryEntry['id']
const record: MemoryEntry = { id, title: '合成资料', content: '原文合成标记', kind: 'knowledge', scope: 'device', workspaceId: null, workspacePath: null, status: 'active', source: '测试文件', evidence: '', origin: null, revision: 1, createdAt: 1, updatedAt: 1, expiresAt: null, contentBytes: 18, snippet: '原文合成标记' }
const metadata: MemoryState = { format: 'qianshou-device-memory-v1', ownerKind: 'local-device-profile', vaultId: 'fixture-vault', revision: 2, workspaces: [] }
const detail: MemoryDetail = { entry: record, revisions: [], revisionCount: 0, nextRevisionOffset: null }
const page: Page = { items: [record], total: 1, stats: { temporary: 0, permanent: 0, knowledge: 1, experience: 0, candidates: 0 } }
const exported: MemoryExportPage = { ...metadata, entries: [record], revisions: [], receipts: [], next: null }
const ok = <T,>(value: T) => ({ ok: true as const, value })
function fixture() {
  const remote = {
    state: vi.fn(async () => ok(metadata)), list: vi.fn(async () => ok(page)), read: vi.fn(async () => ok(detail)),
    save: vi.fn(async () => ok({ ...record,
      revision: 2 })),
    review: vi.fn(async () => ok(record)),
    delete: vi.fn(async () => ok({ deleted: true as const })),
    history: vi.fn(async () => ok({ revisions: [], total: 0, nextOffset: null })), exportPage: vi.fn(async () => ok(exported)),
  }
  const controller = new MemoryController({ remote: { qianshouMemory: remote } } as unknown as Context)
  const props = { controller, useMemory: bindSnapshotSelector(controller.store), t: (key: keyof typeof zh, params?: Record<string, string>) => Object.entries(params ?? {}).reduce((text, [name, value]) => text.replace(`{${name}}`, value), zh[key]) } as MemoryPageProps
  return { remote, controller, props }
}
afterEach(() => { cleanup(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })

describe('owner memory page and request lifetimes', () => {
  it.each([undefined, 'default'])('does not register any feature outside Qianshou: %s', (profile) => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', profile)
    const effect = vi.fn(); const inject = vi.fn(); const register = vi.fn()
    apply({ effect, slots: { inject }, locale: { register } } as unknown as Context)
    expect(effect).not.toHaveBeenCalled(); expect(inject).not.toHaveBeenCalled(); expect(register).not.toHaveBeenCalled()
  })
  it('activates harmlessly in a non-Qianshou Cordis client without a memory Remote namespace', async () => {
    vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', 'default')
    const ctx = new Context()
    ctx.provide('slots', {} as never); ctx.provide('locale', {} as never); ctx.provide('remote', {} as never)
    try {
      const fiber = ctx.plugin({ inject, apply })
      await fiber.await()
      expect(fiber.state).toBe(FiberState.ACTIVE)
      expect(ctx.get('remote.qianshouMemory')).toBeUndefined()
    } finally { await ctx.fiber.dispose() }
  })
  it('renders local ownership and real empty state without invented knowledge', async () => {
    const { props, remote } = fixture(); remote.list.mockResolvedValue(ok({ ...page, items: [], total: 0 }))
    const { container } = render(<MemoryPage {...props} />)
    await screen.findByText(zh.empty)
    expect(screen.getByText(zh.ownershipHint)).toBeTruthy()
    expect(screen.queryByText(record.title)).toBeNull()
    expect(container.textContent).toMatchSnapshot()
  })
  it('commits the draft and keeps it intact on a revision conflict', async () => {
    const { controller, remote, props } = fixture()
    remote.save.mockRejectedValueOnce(new Error('QIANSHOU_MEMORY_conflict'))
    render(<MemoryPage {...props} />); await screen.findByText(record.title)
    fireEvent.click(screen.getByRole('button', { name: new RegExp(record.title) }))
    await screen.findByLabelText('原文')
    fireEvent.change(screen.getByLabelText('原文'), { target: { value: '尚未保存的主人修改' } })
    fireEvent.click(screen.getByRole('button', { name: '保存' }))
    await screen.findByText(zh.conflict)
    expect(controller.store.getSnapshot().draft?.content).toBe('尚未保存的主人修改')
    expect(remote.save).toHaveBeenCalledWith(expect.objectContaining({ id, expectedRevision: 1, content: '尚未保存的主人修改' }))
  })
  it('requires an explicit confirmation before erasing original and history', async () => {
    const { props, remote } = fixture(); render(<MemoryPage {...props} />)
    await screen.findByText(record.title); fireEvent.click(screen.getByRole('button', { name: new RegExp(record.title) })); await screen.findByLabelText('原文')
    fireEvent.click(screen.getByRole('button', { name: '删除资料' }))
    expect(remote.delete).not.toHaveBeenCalled(); expect(screen.getByText(zh.deleteHint)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => { expect(remote.delete).toHaveBeenCalledWith({ id, expectedRevision: 1 }) })
  })
  it('keeps candidates read-only and sends the owner decision with its revision', async () => {
    const { props, remote } = fixture()
    remote.read.mockResolvedValue(ok({ ...detail, entry: { ...record, status: 'candidate' } }))
    render(<MemoryPage {...props} />); await screen.findByText(record.title); fireEvent.click(screen.getByRole('button', { name: new RegExp(record.title) }))
    await screen.findByText(zh.candidateHint)
    expect(screen.getByLabelText('原文').hasAttribute('disabled')).toBe(true)
    expect(screen.queryByRole('button', { name: '保存' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '确认采用' }))
    await waitFor(() => { expect(remote.review).toHaveBeenCalledWith({ id, expectedRevision: 1, action: 'accept' }) })
  })
  it('discards an old detail after changing scope and an old mutation after selecting another draft', async () => {
    const { controller, remote } = fixture()
    const pending = Promise.withResolvers<ReturnType<typeof ok<MemoryDetail>>>()
    remote.read.mockReturnValueOnce(pending.promise)
    const selection = controller.select(id); controller.filter({ scope: 'device' }); pending.resolve(ok(detail)); await selection
    expect(controller.store.getSnapshot().detail).toBeNull()
    controller.create(); controller.edit({ ...controller.store.getSnapshot().draft!, title: 'First', content: 'First' })
    const saved = Promise.withResolvers<ReturnType<typeof ok<MemoryEntry>>>()
    remote.save.mockReturnValueOnce(saved.promise); const saving = controller.save()
    controller.create(); controller.edit({ ...controller.store.getSnapshot().draft!, title: 'New draft', content: 'Keep me' })
    saved.resolve(ok(record)); await saving
    expect(controller.store.getSnapshot().draft?.content).toBe('Keep me')
  })
  it('closing the page invalidates pending load/select and export without downloading a file', async () => {
    const { controller, remote, props } = fixture()
    const delayed = Promise.withResolvers<ReturnType<typeof ok<MemoryExportPage>>>()
    remote.exportPage.mockReturnValueOnce(delayed.promise)
    const objectURL = vi.fn(); vi.stubGlobal('URL', { createObjectURL: objectURL, revokeObjectURL: vi.fn() })
    const { unmount } = render(<MemoryPage {...props} />); await screen.findByText(record.title)
    fireEvent.click(screen.getByRole('button', { name: '导出本机资料' })); unmount(); delayed.resolve(ok(exported))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(objectURL).not.toHaveBeenCalled(); expect(controller.store.getSnapshot().exporting).toBe(false)
    const detach = controller.attach(); const reading = Promise.withResolvers<ReturnType<typeof ok<MemoryDetail>>>()
    remote.read.mockReturnValueOnce(reading.promise); const read = controller.select(id); detach(); reading.resolve(ok(detail)); await read
    expect(controller.store.getSnapshot().detail).toBeNull()
  })
  it('returns no partial export after a changed revision or the explicit byte ceiling', async () => {
    const { controller, remote } = fixture()
    remote.exportPage.mockResolvedValueOnce(ok({ ...exported, next: { stage: 'revisions', offset: 0 } })).mockRejectedValueOnce(new Error('QIANSHOU_MEMORY_export-changed'))
    expect(await controller.export()).toBeNull(); expect(controller.store.getSnapshot().error).toBe('export-changed')
    remote.exportPage.mockResolvedValue(ok({ ...exported, entries: [{ ...record, content: 'x'.repeat(17 * 1024 * 1024) }] }))
    expect(await controller.export()).toBeNull(); expect(controller.store.getSnapshot().error).toBe('export-too-large')
  })
  it('does not replace a newer typed draft when a selected file finishes reading late', async () => {
    const { props, controller } = fixture(); render(<MemoryPage {...props} />)
    fireEvent.click(screen.getByRole('button', { name: '新建资料' }))
    const bytes = Promise.withResolvers<ArrayBuffer>()
    const file = { name: 'fixture.txt', size: 6, arrayBuffer: () => bytes.promise } as File
    fireEvent.change(screen.getByLabelText('导入文本', { selector: 'input' }), { target: { files: [file] } })
    fireEvent.change(screen.getByLabelText('原文'), { target: { value: 'Keep typed draft' } })
    bytes.resolve(new TextEncoder().encode('import').buffer)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(controller.store.getSnapshot().draft?.content).toBe('Keep typed draft')
  })
  it('imports only explicit bounded valid text, preserving original Unicode', async () => {
    const original = '合成文本 🐙'
    const file = { name: 'fixture.md', size: new TextEncoder().encode(original).byteLength, arrayBuffer: async () => new TextEncoder().encode(original).buffer } as File
    expect(await importText(file)).toEqual({ title: 'fixture.md', source: 'fixture.md', content: original })
    await expect(importText({ name: 'legacy.sqlite', size: 1, arrayBuffer: () => file.arrayBuffer() } as File)).rejects.toThrow()
    await expect(importText({ name: 'fixture.txt', size: 600000, arrayBuffer: () => file.arrayBuffer() } as File)).rejects.toThrow()
    await expect(importText({ name: 'fixture.txt', size: 1, arrayBuffer: async () => Uint8Array.of(255).buffer } as File)).rejects.toThrow()
  })
})
