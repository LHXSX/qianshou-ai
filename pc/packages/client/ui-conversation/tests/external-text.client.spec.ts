/** External edits preserve owned draft structure and report the existing sink's actual admission. */
import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { DraftAttachmentId, ExternalTextRequest, SubmitOutcome } from '../src/client/contract/input.ts'
import { SessionInputShell } from '../src/client/input/facade.ts'

function setup() {
  let available = true
  const sink = vi.fn(() => Promise.resolve<SubmitOutcome>({ kind: 'success' }))
  const shell = new SessionInputShell({ actx: {} as Context, canAcceptExternalText: () => available,
    defaultSink: sink, commandAttachments: { serialize: async () => [], release: () => {}, unsupportedNotice: () => 'unsupported' } })
  const request = (text: string, intent: ExternalTextRequest['intent'] = 'insert'): ExternalTextRequest => ({
    text, intent, expectedDraftRev: shell.snapshot.draftRev, expectedAttachmentIds: [...shell.snapshot.attachmentIds],
  })
  return { shell, sink, request, block: () => { available = false } }
}

describe('external text admission', () => {
  it('appends text without flattening a reference chip', async () => {
    const { shell, request, sink } = setup()
    shell.setDraft('@ref')
    expect(shell.insertReference({ source: 'file', ref: 'file:x', label: 'x', clipboardText: '@[x](file:x)' },
      { start: 0, end: 4, draftRev: shell.snapshot.draftRev })).toBe(true)
    const chip = shell.snapshot.occurrences[0]
    expect(await shell.commitExternalText(request('请阅读'))).toEqual({ kind: 'inserted' })
    expect(shell.snapshot.draft).toBe('@[x](file:x) 请阅读')
    expect(shell.snapshot.occurrences).toEqual([chip])
    expect(sink).not.toHaveBeenCalled()
    shell.dispose()
  })

  it('rejects a changed revision even when the visible draft returns to its earlier text', async () => {
    const { shell, request } = setup()
    const original = request('voice')
    shell.setDraft('typing'); shell.setDraft('')
    expect(await shell.commitExternalText(original)).toEqual({ kind: 'rejected', reason: 'conflict' })
    expect(shell.snapshot.draft).toBe('')
    shell.dispose()
  })

  it('rejects changed attachments, nonempty sends, unavailable scopes and disposed bindings', async () => {
    const { shell, request, block } = setup()
    const original = request('voice')
    shell.addAttachments(['a' as DraftAttachmentId])
    expect(await shell.commitExternalText(original)).toEqual({ kind: 'rejected', reason: 'conflict' })
    expect(await shell.commitExternalText(request('voice', 'send'))).toEqual({ kind: 'rejected', reason: 'nonempty' })
    block()
    expect(await shell.commitExternalText(request('voice'))).toEqual({ kind: 'rejected', reason: 'blocked' })
    shell.dispose()
    expect(await shell.commitExternalText(request('voice'))).toEqual({ kind: 'rejected', reason: 'disposed' })
  })

  it('reports acceptance only after the same queued sink succeeds', async () => {
    const { shell, request, sink } = setup()
    const accepted = Promise.withResolvers<SubmitOutcome>()
    sink.mockReturnValueOnce(accepted.promise)
    const settled = vi.fn()
    const result = shell.commitExternalText(request('one voice message', 'send')).then(settled)
    expect(shell.snapshot.draft).toBe('')
    expect(sink).toHaveBeenCalledExactlyOnceWith('one voice message', [], 'queue', expect.any(AbortSignal))
    await Promise.resolve(); expect(settled).not.toHaveBeenCalled()
    accepted.resolve({ kind: 'success' }); await result
    expect(settled).toHaveBeenCalledWith({ kind: 'accepted' })
    shell.dispose()
  })

  it('retains failed text and never overwrites newer typing while reporting failure', async () => {
    const { shell, request, sink } = setup()
    const accepted = Promise.withResolvers<SubmitOutcome>()
    sink.mockReturnValueOnce(accepted.promise)
    const result = shell.commitExternalText(request('voice', 'send'))
    shell.setDraft('new typing')
    accepted.resolve({ kind: 'error' })
    expect(await result).toEqual({ kind: 'rejected', reason: 'failed' })
    expect(shell.snapshot.draft).toBe('new typing')
    shell.dispose()
  })

  it('settles a disposed flight without claiming acceptance and suppresses its late reply', async () => {
    const { shell, request, sink } = setup()
    const accepted = Promise.withResolvers<SubmitOutcome>(); sink.mockReturnValueOnce(accepted.promise)
    const result = shell.commitExternalText(request('voice', 'send'))
    shell.dispose()
    expect(await result).toEqual({ kind: 'rejected', reason: 'disposed' })
    accepted.resolve({ kind: 'success' })
    expect(await result).toEqual({ kind: 'rejected', reason: 'disposed' })
  })

  it('keeps slash commands for explicit review and rejects empty placeholder-only text', async () => {
    const { shell, request, sink } = setup()
    expect(await shell.commitExternalText(request('\uFFFC'))).toEqual({ kind: 'rejected', reason: 'empty' })
    expect(await shell.commitExternalText(request('/danger', 'send'))).toEqual({ kind: 'review' })
    expect(shell.snapshot.draft).toBe('/danger'); expect(sink).not.toHaveBeenCalled()
    shell.dispose()
  })
})
