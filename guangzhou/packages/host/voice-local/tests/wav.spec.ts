import { describe, expect, it } from 'vitest'
import { MAX_AUDIO_BYTES, validVoiceWav } from '../src/wav.ts'

function wav(samples = 16000): Buffer {
  const bytes = Buffer.alloc(44 + samples * 2)
  bytes.write('RIFF'); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write('WAVEfmt ', 8)
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22)
  bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28)
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34)
  bytes.write('data', 36); bytes.writeUInt32LE(samples * 2, 40)
  return bytes
}

describe('local microphone upload boundary', () => {
  it('accepts one second of PCM16 mono 16kHz', () => expect(validVoiceWav(wav())).toBe(true))
  it('refuses truncation, oversized clips, and non-wave uploads', () => {
    expect(validVoiceWav(wav().subarray(0, 50))).toBe(false)
    expect(validVoiceWav(Buffer.alloc(MAX_AUDIO_BYTES + 1))).toBe(false)
    expect(validVoiceWav(Buffer.from('not an audio recording'))).toBe(false)
  })
  it('refuses stereo, alternate sample rates, and non-PCM data', () => {
    for (const [offset, value] of [[20, 3], [22, 2], [24, 8000], [34, 32]] as const) {
      const bytes = wav(); bytes.writeUInt16LE(value, offset)
      expect(validVoiceWav(bytes)).toBe(false)
    }
  })
  it('refuses malformed chunk lengths and too-short speech', () => {
    const bytes = wav(); bytes.writeUInt32LE(0xffffffff, 40)
    expect(validVoiceWav(bytes)).toBe(false)
    expect(validVoiceWav(wav(100))).toBe(false)
  })
})
