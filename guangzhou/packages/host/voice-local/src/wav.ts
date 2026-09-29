/** Strict PCM boundary for microphone uploads accepted by the local recognizer. */
export const MAX_AUDIO_BYTES = 16_000 * 2 * 120 + 4096

/**
 * Accept only bounded mono PCM16 WAV, never arbitrary media or server file paths.
 * @param bytes - Complete uploaded bytes, including the RIFF envelope.
 * @returns Whether format, sample count and declared byte boundaries satisfy the microphone contract.
 */
export function validVoiceWav(bytes: Uint8Array): boolean {
  if (bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES) return false
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return false
  if (buffer.readUInt32LE(4) + 8 !== buffer.length) return false
  let format = false
  let samples = 0
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const size = buffer.readUInt32LE(offset + 4)
    const end = offset + 8 + size
    if (end > buffer.length) return false
    const name = buffer.toString('ascii', offset, offset + 4)
    if (name === 'fmt ') {
      if (size < 16) return false
      format = buffer.readUInt16LE(offset + 8) === 1
        && buffer.readUInt16LE(offset + 10) === 1
        && buffer.readUInt32LE(offset + 12) === 16_000
        && buffer.readUInt32LE(offset + 16) === 32_000
        && buffer.readUInt16LE(offset + 20) === 2
        && buffer.readUInt16LE(offset + 22) === 16
      if (!format) return false
    }
    if (name === 'data') samples += size
    offset = end + size % 2
  }
  return format && samples >= 3200 && samples <= 16_000 * 2 * 120 && samples % 2 === 0
}
