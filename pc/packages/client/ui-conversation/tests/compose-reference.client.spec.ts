import type { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import { SessionInputShell } from '../src/client/input/facade.ts'

function bench() {
  const sink = vi.fn(() => new Promise<never>(() => {}))
  const shell = new SessionInputShell({ actx: {} as Context, defaultSink: sink,
    commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: token => token } })
  const insert = vi.spyOn(shell, 'insertText')
  return { shell, sink, insert }
}

it('preserves real reference chips and unsent text when selecting a skill', () => {
  const b = bench()
  b.shell.setDraft('@file')
  expect(b.shell.insertReference({ source: 'file', ref: 'input-1', label: '资料', clipboardText: '@[资料](file:input-1)' },
    { start: 0, end: 5, draftRev: b.shell.snapshot.draftRev })).toBe(true)
  const original = b.shell.snapshot.occurrences[0]!
  expect(b.shell.composeReference('/office-pptx', b.shell.snapshot.draftRev)).toBe(true)
  expect(b.shell.snapshot.draft).toBe('/office-pptx @[资料](file:input-1) ')
  expect(b.shell.snapshot.occurrences).toEqual([{ ...original, offset: '/office-pptx '.length }])
  expect(b.sink).not.toHaveBeenCalled()
  b.shell.dispose()
})

it('replaces an unsent market command and preserves its business request', () => {
  const b = bench()
  b.shell.setDraft('@官方出图 小狗\n保留这些要求')
  expect(b.shell.beginCommand({ name: 'image.generate', token: '@官方出图 ', submit: vi.fn() },
    { start: 0, end: 6, draftRev: b.shell.snapshot.draftRev })).toBe(true)
  expect(b.shell.snapshot.phase).toBe('claimed')
  expect(b.shell.composeReference('/office-pptx', b.shell.snapshot.draftRev)).toBe(true)
  expect(b.shell.snapshot.draft).toBe('/office-pptx 小狗\n保留这些要求')
  expect(b.shell.snapshot.phase).toBe('plain')
  expect(b.sink).not.toHaveBeenCalled()
  b.shell.dispose()
})

it('allows a new selection while an ordinary earlier message remains in flight', () => {
  const b = bench()
  b.shell.setDraft('前一个任务'); b.shell.submit()
  expect(b.shell.snapshot.phase).toBe('plain')
  expect(b.shell.composeReference('@官方出图', b.shell.snapshot.draftRev)).toBe(true)
  expect(b.shell.snapshot.draft).toBe('@官方出图 ')
  expect(b.sink).toHaveBeenCalledTimes(1)
  b.shell.dispose()
})

it('does not duplicate a selected prefix or send it automatically', () => {
  const b = bench(); b.shell.setDraft('/office-pptx 项目')
  expect(b.shell.composeReference('/office-pptx', b.shell.snapshot.draftRev)).toBe(true)
  expect(b.shell.snapshot.draft).toBe('/office-pptx 项目')
  expect(b.insert).not.toHaveBeenCalled(); expect(b.sink).not.toHaveBeenCalled()
  b.shell.dispose()
})

it('refuses a stale revision without overwriting a newer draft', () => {
  const b = bench(); b.shell.setDraft('原始要求')
  const revision = b.shell.snapshot.draftRev
  b.shell.setDraft('用户刚输入的要求')
  expect(b.shell.composeReference('/office-pptx', revision)).toBe(false)
  expect(b.shell.snapshot.draft).toBe('用户刚输入的要求')
  b.shell.dispose()
})

it('does not edit a command while its admission transaction is frozen', async () => {
  const b = bench(); b.shell.setDraft('@官方出图 小狗')
  b.shell.beginCommand({ name: 'image.generate', token: '@官方出图 ', submit: () => new Promise<never>(() => {}) },
    { start: 0, end: 6, draftRev: b.shell.snapshot.draftRev })
  b.shell.submit()
  expect(b.shell.snapshot.phase).toBe('submitting')
  expect(b.shell.composeReference('/office-pptx', b.shell.snapshot.draftRev)).toBe(false)
  expect(b.shell.insertText('/office-pptx ', { start: 0, end: 0, draftRev: b.shell.snapshot.draftRev })).toBe(false)
  expect(b.shell.snapshot.draft).toBe('@官方出图 小狗')
  b.shell.dispose()
})


it('does not confuse a leading atomic reference projection with a selected skill prefix', () => {
  const b = bench(); b.shell.setDraft('@file')
  b.shell.insertReference({ source: 'file', ref: 'input-2', label: '文件', clipboardText: '/office-pptx 文件内容' },
    { start: 0, end: 5, draftRev: b.shell.snapshot.draftRev })
  const original = b.shell.snapshot.occurrences[0]!
  expect(b.shell.composeReference('/office-pptx', b.shell.snapshot.draftRev)).toBe(true)
  expect(b.insert).toHaveBeenCalledOnce()
  expect(b.shell.snapshot.occurrences).toEqual([{ ...original, offset: '/office-pptx '.length }])
  b.shell.dispose()
})
