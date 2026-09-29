// @vitest-environment jsdom
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { ChildFileChanges } from '../src/client/ChildFileChanges.tsx'
import { zh } from '../src/client/locales.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const rows = [{ kind: 'child' as const, id: 'child', label: '前端 · 文件验证', activity: 'inactive' }]
const props = () => ({ parent: 'parent', entries: rows, open: vi.fn(), t: makeTranslate(zh) })
const address = 'dsh-resource://changes-review/session/child/19/2'

it('opens the real source record and distinguishes availability from acceptance', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ available: true, entries: [{
    sessionId: 'child', turn: 2, cwd: '/child-workspace', seq: 19, total: 1, state: 'available', shared: true, reviewAddress: address,
  }] })))
  const p = props(), view = render(<ChildFileChanges {...p} />)
  fireEvent.click(await view.findByRole('button', { name: '查看 1 个文件的差异 →' }))
  expect(p.open).toHaveBeenCalledWith(address)
  expect(view.getByText(/共享文件有其他子任务/)).toBeTruthy()
  expect(view.queryByText('已验收')).toBeNull()
})

it('keeps released evidence unavailable without creating a clickable empty diff', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ available: true, entries: [{
    sessionId: 'child', turn: 1, cwd: '/child', state: 'unavailable', shared: false, reason: 'retention-limit',
  }] })))
  const view = render(<ChildFileChanges {...props()} />)
  expect(await view.findByText(/差异副本已达到保留上限/)).toBeTruthy()
  expect(view.queryByRole('button', { name: /查看.*文件/ })).toBeNull()
})

it('cancels an old parent request and ignores its late answer after navigation', async () => {
  const old = Promise.withResolvers<Response>()
  const fetcher = vi.fn<typeof fetch>().mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(Response.json({ available: true, entries: [] }))
  vi.stubGlobal('fetch', fetcher)
  const p = props(), view = render(<ChildFileChanges {...p} />)
  const firstSignal = fetcher.mock.calls[0]![1]?.signal
  view.rerender(<ChildFileChanges {...p} parent="other-parent" />)
  expect(firstSignal?.aborted).toBe(true)
  old.resolve(Response.json({ available: true, entries: [{ sessionId: 'child', turn: 2, cwd: '/child', seq: 19, total: 1, state: 'available', shared: false, reviewAddress: address }] }))
  await waitFor(() => { expect(view.getByText(/尚无本次运行的文件差异记录/)).toBeTruthy() })
  expect(view.queryByRole('button', { name: /查看.*文件/ })).toBeNull()
})
