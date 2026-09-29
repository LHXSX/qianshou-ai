/** Bounded mono PCM16 WAV encoding for the local transcription service. */

/**
 * Resample browser PCM to the Host's 16 kHz mono PCM16 format.
 * @param samples - Finite captured mono samples.
 * @param inputRate - AudioContext sample rate.
 * @returns A WAV Blob containing a 44-byte header and signed PCM16 samples.
 */
export function encodeWav(samples: Float32Array, inputRate: number): Blob {
  const ratio = inputRate / 16000
  const length = Math.floor(samples.length / ratio)
  const bytes = new ArrayBuffer(44 + length * 2)
  const view = new DataView(bytes)
  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, 'RIFF'); view.setUint32(4, bytes.byteLength - 8, true); write(8, 'WAVE')
  write(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true)
  view.setUint16(22, 1, true); view.setUint32(24, 16000, true); view.setUint32(28, 32000, true)
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, length * 2, true)
  for (let i = 0; i < length; i += 1) {
    const begin = Math.floor(i * ratio)
    const end = Math.min(samples.length, Math.max(begin + 1, Math.floor((i + 1) * ratio)))
    let sum = 0
    for (let index = begin; index < end; index += 1) sum += samples[index] ?? 0
    const sample = Math.max(-1, Math.min(1, sum / (end - begin)))
    view.setInt16(44 + i * 2, sample < 0 ? sample * 32768 : sample * 32767, true)
  }
  return new Blob([bytes], { type: 'audio/wav' })
}
