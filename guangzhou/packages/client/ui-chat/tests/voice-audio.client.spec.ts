import { describe, expect, it } from 'vitest'
import { encodeWav, SpeechSegmenter } from '../src/client/chat/voice/audio.ts'
import { spokenText } from '../src/client/chat/voice/speech.ts'
import { PlaybackSpeechGate } from '../src/client/chat/voice/barge-in.ts'

describe('local voice audio', () => {
  it('does not submit silence or a short noise spike', () => {
    const vad = new SpeechSegmenter()
    for (let i = 0; i < 30; i++) expect(vad.push(new Float32Array(1600), 16000)).toBeNull()
    expect(vad.push(new Float32Array(1600).fill(0.1), 16000)).toBeNull()
    for (let i = 0; i < 20; i++) expect(vad.push(new Float32Array(1600), 16000)).toBeNull()
    expect(vad.speaking).toBe(false)
  })
  it('segments sustained speech only after a natural pause and resets between turns', () => {
    const vad = new SpeechSegmenter()
    for (let i = 0; i < 8; i++) expect(vad.push(new Float32Array(1600).fill(0.15), 16000)).toBeNull()
    expect(vad.speaking).toBe(true)
    let segment: Float32Array | null = null
    for (let i = 0; i < 12; i++) segment ??= vad.push(new Float32Array(1600), 16000)
    expect(segment?.length).toBeGreaterThan(16000)
    expect(vad.speaking).toBe(false)
    vad.push(new Float32Array(1600).fill(0.15), 16000)
    vad.reset()
    expect(vad.speaking).toBe(false)
  })
  it('encodes exact mono PCM16 16k WAV from a 48k audio context', async () => {
    const blob = encodeWav(new Float32Array(48000).fill(0.5), 48000)
    const bytes = await blob.arrayBuffer()
    const view = new DataView(bytes)
    expect(blob.type).toBe('audio/wav')
    expect(bytes.byteLength).toBe(32044)
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe('RIFF')
    expect(view.getUint32(24, true)).toBe(16000)
    expect(view.getUint16(22, true)).toBe(1)
    expect(view.getUint16(34, true)).toBe(16)
    expect(view.getInt16(44, true)).toBe(16383)
  })
  it('speaks answer prose without reading code fences or Markdown syntax', () => {
    expect(spokenText('# 完成\n**已修复** [文件](src/a.ts)\n```ts\nconst x = 1\n```')).toBe('完成\n已修复 文件')
  })
})

describe('playback-time speech onset', () => {
  const tone = (amplitude: number) => Float32Array.from({ length: 1600 }, (_, index) => amplitude * Math.sin(2 * Math.PI * 220 * index / 16000))

  it('rejects silence, residual low-level playback, short clicks and high-frequency hiss', () => {
    const gate = new PlaybackSpeechGate()
    for (let i = 0; i < 20; i++) expect(gate.push(tone(0.01), 16000)).toBeNull()
    expect(gate.push(tone(0.5), 16000)).toBeNull()
    for (let i = 0; i < 20; i++) expect(gate.push(new Float32Array(1600), 16000)).toBeNull()
    const hiss = Float32Array.from({ length: 1600 }, (_, index) => index % 2 === 0 ? 0.2 : -0.2)
    for (let i = 0; i < 20; i++) expect(gate.push(hiss, 16000)).toBeNull()
  })

  it('requires sustained activity and returns the buffered onset instead of clipping it', () => {
    const gate = new PlaybackSpeechGate()
    const onset = tone(0.08)
    gate.push(new Float32Array(1600), 16000)
    expect(gate.push(onset, 16000)).toBeNull()
    expect(gate.push(tone(0.16), 16000)).toBeNull()
    const buffered = gate.push(tone(0.16), 16000)
    expect(buffered).toHaveLength(4)
    expect(buffered?.[1]).toEqual(onset)
    gate.reset()
    expect(gate.push(tone(0.16), 16000)).toBeNull()
  })
})
