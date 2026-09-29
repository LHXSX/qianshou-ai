import { describe, expect, it } from 'vitest'
import { MAX_AUDIO_BYTES, voicePcm } from '../src/wav.ts'
import { wav } from './support.ts'
const validVoiceWav = (bytes: Buffer) => voicePcm(bytes) !== undefined

function chunk(tag: string, size: number) {
  const data = Buffer.alloc(8 + size + size % 2)
  data.write(tag); data.writeUInt32LE(size, 4)
  return data
}
function append(audio: Buffer, extra: Buffer) {
  const result = Buffer.concat([audio, extra]); result.writeUInt32LE(result.length - 8, 4); return result
}
describe('complete PCM WAV admission', () => {
  it('accepts exact duration endpoints and bounded complete metadata chunks', () => {
    expect(validVoiceWav(wav())).toBe(true)
    expect(validVoiceWav(wav(16000 * 120))).toBe(true)
    expect(validVoiceWav(append(wav(), chunk('LIST', 3)))).toBe(true)
  })
  it.each([
    ['short duration', () => wav(1599)], ['long duration', () => wav(16000 * 120 + 1)],
    ['trailing byte', () => append(wav(), Buffer.from([0]))],
    ['duplicate format', () => append(wav(), wav().subarray(12, 36))],
    ['duplicate audio', () => append(wav(), chunk('data', 3200))],
    ['metadata missing pad', () => append(wav(), chunk('LIST', 3).subarray(0, -1))],
    ['chunk overflow', () => { const b = wav(); b.writeUInt32LE(0xffffffff, 40); return b }],
    ['invalid byte rate', () => { const b = wav(); b.writeUInt32LE(64000, 28); return b }],
    ['stereo', () => { const b = wav(); b.writeUInt16LE(2, 22); return b }],
    ['odd data', () => { const b = append(wav(), Buffer.from([0, 0])); b.writeUInt32LE(3201, 40); return b }],
    ['wrong RIFF size', () => { const b = wav(); b.writeUInt32LE(10, 4); return b }],
    ['metadata exceeds byte ceiling', () => append(wav(), chunk('JUNK', MAX_AUDIO_BYTES))],
  ] as const)('rejects %s', (_name, make) => { expect(validVoiceWav(make())).toBe(false) })
})
