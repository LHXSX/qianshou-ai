/** Strict RIFF/WAVE admission for the PCM protocol produced by the voice composer. */

/** Audio protocol ceiling: 120 seconds of mono PCM16 at 16 kHz plus RIFF metadata. */
export const MAX_AUDIO_BYTES = 16000 * 2 * 120 + 4096

/**
 * Accept one complete PCM16 mono 16 kHz WAV with 0.1–120 seconds of frame-aligned data.
 * @param bytes - Complete bounded request body.
 * @returns The admitted PCM data, or undefined when RIFF chunks, padding or audio fields are invalid.
 */
export function voicePcm(bytes: Buffer): Buffer | undefined {
  if (bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF'
    || bytes.toString('ascii', 8, 12) !== 'WAVE' || bytes.readUInt32LE(4) + 8 !== bytes.length) return undefined
  let offset = 12
  let format = false
  let audio: Buffer | undefined
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) return undefined
    const tag = bytes.toString('ascii', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    const end = start + size
    const paddedEnd = end + (size % 2)
    if (paddedEnd > bytes.length) return undefined
    if (tag === 'fmt ') {
      if (format || audio || size < 16 || bytes.readUInt16LE(start) !== 1 || bytes.readUInt16LE(start + 2) !== 1
        || bytes.readUInt32LE(start + 4) !== 16000 || bytes.readUInt32LE(start + 8) !== 32000
        || bytes.readUInt16LE(start + 12) !== 2 || bytes.readUInt16LE(start + 14) !== 16) return undefined
      format = true
    } else if (tag === 'data') {
      if (!format || audio || size < 3200 || size > 3840000 || size % 2 !== 0) return undefined
      audio = bytes.subarray(start, end)
    }
    offset = paddedEnd
  }
  return format && offset === bytes.length ? audio : undefined
}
