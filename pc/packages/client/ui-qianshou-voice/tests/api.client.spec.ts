/** Binary upload tests inspect the request and bounded response, without a live Host or microphone. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VoiceTarget } from '../src/client/controller.ts'
import { transcribe } from '../src/client/api.ts'

afterEach(() => vi.unstubAllGlobals())
const target = { sessionId: 'actual/session', cwd: '/workspace with space' } as VoiceTarget
describe('voice binary transport', () => {
  it('posts raw WAV with the original Session and workspace guard and forwards cancellation', async () => {
    const fetcher = vi.fn(async () => Response.json({ text: '  hello  ' })); vi.stubGlobal('fetch', fetcher)
    const audio = new Blob(['WAV'], { type: 'audio/wav' }); const controller = new AbortController()
    expect(await transcribe(target, audio, controller.signal)).toBe('hello')
    expect(fetcher).toHaveBeenCalledWith('/api/qianshou/voice/transcribe?sessionId=actual%2Fsession&workspaceRoot=%2Fworkspace+with+space', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal: controller.signal,
    })
  })
  it('rejects malformed and oversized results without treating HTTP success as transcription success', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ done: true }))
      .mockResolvedValueOnce(Response.json({ text: 'x'.repeat(70000) }))
    vi.stubGlobal('fetch', fetcher)
    await expect(transcribe(target, new Blob(), new AbortController().signal)).rejects.toThrow('TRANSCRIPTION_FAILED')
    await expect(transcribe(target, new Blob(), new AbortController().signal)).rejects.toThrow('RESULT_TOO_LARGE')
  })
  it('surfaces only known failure codes and discards a result after cancellation', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ error: 'VOICE_BUSY' }, { status: 409 }))
      .mockResolvedValueOnce(Response.json({ error: 'private-server-detail' }, { status: 500 }))
      .mockResolvedValueOnce(Response.json({ text: 'late text' }))
    vi.stubGlobal('fetch', fetcher)
    await expect(transcribe(target, new Blob(), new AbortController().signal)).rejects.toThrow('VOICE_BUSY')
    await expect(transcribe(target, new Blob(), new AbortController().signal)).rejects.toThrow('TRANSCRIPTION_FAILED')
    const aborter = new AbortController(); aborter.abort()
    await expect(transcribe(target, new Blob(), aborter.signal)).rejects.toMatchObject({ name: 'AbortError' })
  })
})
