/** Authenticated binary ASR upload; audio never enters typed Remote argument logs. */
import type { VoiceTarget } from './controller.ts'

const ERRORS = new Set(['REQUEST_ABORTED', 'VOICE_BUSY', 'VOICE_UNAVAILABLE', 'INVALID_AUDIO', 'VOICE_TIMEOUT',
  'TRANSCRIPTION_FAILED', 'SESSION_UNAVAILABLE', 'SESSION_MISMATCH', 'RESULT_TOO_LARGE'])

/**
 * Transcribe one bounded WAV against its captured Session and workspace guard.
 * @param target - Original retained Session identity and expected cwd.
 * @param audio - Mono 16 kHz PCM16 WAV.
 * @param signal - Gesture cancellation; cancels both upload and response consumption.
 * @returns Recognized text from the actual Host, never an animation-derived success.
 */
export async function transcribe(target: VoiceTarget, audio: Blob, signal: AbortSignal): Promise<string> {
  const query = new URLSearchParams({ sessionId: target.sessionId, workspaceRoot: target.cwd })
  const response = await fetch(`/api/qianshou/voice/transcribe?${query}`, {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'audio/wav' }, body: audio, signal,
  })
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('TRANSCRIPTION_FAILED')
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const item = await reader.read()
      if (item.done) break
      total += item.value.byteLength
      if (total > 65536) { await reader.cancel(); throw new Error('RESULT_TOO_LARGE') }
      chunks.push(item.value)
    }
  } finally { reader.releaseLock() }
  signal.throwIfAborted()
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  const body: unknown = JSON.parse(new TextDecoder().decode(bytes))
  if (!response.ok) {
    const error = typeof body === 'object' && body !== null && 'error' in body && typeof body.error === 'string' && ERRORS.has(body.error)
      ? body.error : 'TRANSCRIPTION_FAILED'
    throw new Error(error)
  }
  if (typeof body !== 'object' || body === null || !('text' in body) || typeof body.text !== 'string') throw new Error('TRANSCRIPTION_FAILED')
  return body.text.trim()
}
