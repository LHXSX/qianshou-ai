// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import type { SessionListState } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { TeamRemovalDialog } from '../src/client/TeamRemovalDialog.tsx'
import { teamRemovalBlocker, type TeamRemovalTarget } from '../src/client/team-removal.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)
const parent = 'parent' as SessionId
const child = 'child' as SessionId
const grandchild = 'grandchild' as SessionId
const target: TeamRemovalTarget = { label: '写作员工', address: { parentSessionId: parent, childSessionId: child, mode: 'continuable' } }
const t = makeTranslate(zh)
function state(): Pick<SessionListState, 'phase' | 'byId' | 'subagentsByParent'> {
  return { phase: 'ready', byId: {}, subagentsByParent: {
    [parent]: { state: 'ready', error: null, parentAvailable: true, entries: [
      { kind: 'child', id: child, mode: 'continuable', label: target.label, activity: 'inactive', hasChildren: true },
    ] },
  } }
}

describe('team removal eligibility', () => {
  it('uses explicit Host queue and unavailable checks even when the child looks inactive', () => {
    const snapshot = state()
    expect(teamRemovalBlocker(target.address, snapshot)).toBeUndefined()
    const entry = snapshot.subagentsByParent[parent]!.entries[0]!
    if (entry.kind !== 'child') throw new Error('fixture requires a healthy child')
    expect(teamRemovalBlocker(target.address, { ...snapshot, subagentsByParent: { [parent]: {
      ...snapshot.subagentsByParent[parent]!, entries: [{ ...entry, retireBlocked: 'busy' }],
    } } })).toBe('busy')
    expect(teamRemovalBlocker(target.address, { ...snapshot, subagentsByParent: { [parent]: {
      ...snapshot.subagentsByParent[parent]!, entries: [{ ...entry, retireBlocked: 'unavailable' }],
    } } })).toBe('unavailable')
    expect(teamRemovalBlocker(target.address, { ...snapshot, phase: 'pending' })).toBe('sync')
  })
  it('blocks a newly running descendant before the parent catalog refresh catches up', () => {
    const snapshot = state()
    snapshot.byId = {
      [child]: { id: child, origin: 'subagent', parentId: parent, displayTitle: 'child', running: false, blank: false, updatedAt: 1 },
      [grandchild]: { id: grandchild, origin: 'subagent', parentId: child, displayTitle: 'grandchild', running: true, blank: false, updatedAt: 2 },
    }
    expect(teamRemovalBlocker(target.address, snapshot)).toBe('busy')
  })
})

describe('team removal confirmation', () => {
  it('describes the whole branch and retained records, and cancels without a request', () => {
    const removeChild = vi.fn(() => Promise.resolve())
    const onClose = vi.fn()
    render(<TeamRemovalDialog target={target} blocked={undefined} removeChild={removeChild} onClose={onClose} t={t} />)
    const dialog = screen.getByRole('dialog', { name: '将“写作员工”移出团队？' })
    expect(within(dialog).getByText(zh['remove.description'])).toBeTruthy()
    expect(within(dialog).getByText(zh['remove.history'])).toBeTruthy()
    fireEvent.click(within(dialog).getAllByRole('button', { name: '取消' })[1]!)
    expect(onClose).toHaveBeenCalledOnce()
    expect(removeChild).not.toHaveBeenCalled()
  })
  it('awaits one acknowledgement, blocks duplicate clicks, and preserves a retry after refusal', async () => {
    const failure = Promise.withResolvers<void>()
    const removeChild = vi.fn(() => failure.promise)
    const onClose = vi.fn()
    render(<TeamRemovalDialog target={target} blocked={undefined} removeChild={removeChild} onClose={onClose} t={t} />)
    fireEvent.click(screen.getByRole('button', { name: '确认移出团队' }))
    const pending = screen.getByRole('button', { name: '正在移出…' }) as HTMLButtonElement
    expect(pending.disabled).toBe(true)
    fireEvent.click(pending)
    expect(removeChild).toHaveBeenCalledExactlyOnceWith(target.address)
    await act(async () => { failure.reject({ code: 'subagent/busy', message: 'Queued work appeared', details: { childSessionIds: [grandchild] } }); await failure.promise.catch(() => {}) })
    expect(screen.getByRole('alert').textContent).toBe(zh['remove.racedBusy'])
    expect(screen.getByRole('alert').textContent).not.toContain('Queued work appeared')
    expect(onClose).not.toHaveBeenCalled()
    removeChild.mockImplementation(() => Promise.resolve())
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: '确认移出团队' })) })
    expect(onClose).toHaveBeenCalledOnce()
  })
  it('responds to fresh busy state while the confirmation is already open', () => {
    const removeChild = vi.fn(() => Promise.resolve())
    const view = render(<TeamRemovalDialog target={target} blocked={undefined} removeChild={removeChild} onClose={vi.fn()} t={t} />)
    view.rerender(<TeamRemovalDialog target={target} blocked="busy" removeChild={removeChild} onClose={vi.fn()} t={t} />)
    const button = screen.getByRole('button', { name: '确认移出团队' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toBe(zh['remove.blocked.busy'])
    fireEvent.click(button)
    expect(removeChild).not.toHaveBeenCalled()
  })
})
