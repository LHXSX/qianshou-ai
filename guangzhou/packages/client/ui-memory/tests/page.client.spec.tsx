// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { MemoryPage, type MemoryPageProps } from '../src/client/MemoryPage.tsx'
import type { MemoryState } from '../src/client/controller.ts'
import type { MemoryEntry } from '../src/client/contracts.ts'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const entry: MemoryEntry = {
  id: 'record', title: '验收经验', content: '原始验证结果', kind: 'experience', status: 'active', scope: 'personal', workspace: null,
  source: 'test.log', evidence: '3 项通过', revision: 2, createdAt: 1, updatedAt: 2, expiresAt: null, contentBytes: 18, snippet: '原始验证结果',
}
function bench(selected: MemoryEntry | null = null) {
  const store = createSnapshotStore<MemoryState>({
    items: selected ? [selected] : [], total: selected ? 1 : 0,
    stats: { temporary: 0, permanent: 0, knowledge: 0, experience: selected ? 1 : 0, candidates: selected?.status === 'candidate' ? 1 : 0 },
    storage: 'sqlite', search: 'keyword', loading: false, detailLoading: false, busy: false, error: null, selected,
    revisions: selected ? [{ ...selected, revision: 1, content: '第一版原文' }] : [],
    filters: { query: '', kind: '', status: 'active', workspace: '', offset: 0 },
  })
  const actions = {
    refresh: vi.fn(async () => {}), filter: vi.fn(), select: vi.fn(async () => {}),
    mutate: vi.fn(async () => true), exportData: vi.fn(async () => '{}'),
  }
  const props = { ...actions, t: (key: keyof typeof zh) => zh[key], useMemory: bindSnapshotSelector(store) } as unknown as MemoryPageProps
  render(<MemoryPage {...props} />)
  return { store, actions }
}

describe('memory source workspace', () => {
  it('creates only after explicit save and sends user-authored source unchanged', async () => {
    const { actions } = bench()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '新建条目' })) })
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '工作说明' } })
    fireEvent.change(screen.getByLabelText('原文'), { target: { value: '必须保留\n原文内容' } })
    expect(actions.mutate).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存条目' })) })
    expect(actions.mutate).toHaveBeenCalledWith('save', {
      title: '工作说明', content: '必须保留\n原文内容', kind: 'knowledge', scope: 'personal', source: '', evidence: '',
    })
  })

  it('shows candidate evidence and requires a distinct acceptance action', async () => {
    const { actions } = bench({ ...entry, status: 'candidate' })
    expect(screen.getByText(zh.candidateHint)).toBeTruthy()
    expect(screen.getByLabelText('原文')).toHaveProperty('readOnly', true)
    expect(screen.queryByRole('button', { name: '保存条目' })).toBeNull()
    expect(screen.getByText('第一版原文')).toBeTruthy()
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认这条经验' })) })
    expect(actions.mutate).toHaveBeenCalledWith('review', { id: 'record', expectedRevision: 2, action: 'accept' })
  })

  it('cancels permanent deletion unless the user confirms the exact consequence', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { actions } = bench(entry)
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }))
    expect(confirm).toHaveBeenCalledWith(zh.deleteConfirm)
    expect(actions.mutate).not.toHaveBeenCalled()
    confirm.mockReturnValue(true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '永久删除' })) })
    expect(actions.mutate).toHaveBeenCalledWith('delete', { id: 'record', expectedRevision: 2 })
  })

  it('keeps a failed save draft available for correction', async () => {
    const { actions } = bench(entry)
    actions.mutate.mockResolvedValue(false)
    fireEvent.change(screen.getByLabelText('标题'), { target: { value: '我的修改' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '保存条目' })) })
    expect(screen.getByLabelText('标题')).toHaveProperty('value', '我的修改')
  })
})
