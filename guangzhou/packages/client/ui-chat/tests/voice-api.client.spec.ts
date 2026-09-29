import { afterEach, describe, expect, it, vi } from 'vitest'
import { transcribeVoice, voiceStatus } from '../src/client/chat/voice/api.ts'

afterEach(() => { vi.unstubAllGlobals() })

describe('same-origin voice endpoint', () => {
  it.each(['VOICE_BUSY', 'VOICE_UNAVAILABLE', 'VOICE_TIMEOUT', 'INVALID_AUDIO'])('preserves the host error %s for localized presentation', async error => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error }, { status: 429 })))
    await expect(transcribeVoice(new Blob(), new AbortController().signal)).rejects.toThrow(error)
  })
  it('sends audio with session credentials and the cancellation signal, then trims recognized text', async () => {
    const audio = new Blob(['pcm'], { type: 'audio/wav' })
    const signal = new AbortController().signal
    const fetch = vi.fn(async () => Response.json({ text: '  修改项目  ' }))
    vi.stubGlobal('fetch', fetch)
    await expect(transcribeVoice(audio, signal)).resolves.toBe('修改项目')
    expect(fetch).toHaveBeenCalledWith('/api/forge/voice/transcribe', {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal,
    })
  })
  it('reports the actual configured engine availability', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ available: false })))
    await expect(voiceStatus(new AbortController().signal)).resolves.toBe(false)
  })
})
