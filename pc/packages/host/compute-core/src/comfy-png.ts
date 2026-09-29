/** Bounded PNG integrity check for one private ComfyUI sample, without image libraries. */
import { inflateSync } from 'node:zlib'
import { ComputeError } from './errors.ts'

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const MAX_BYTES = 16 * 1024 * 1024
const MAX_SIDE = 1024

function invalid(): ComputeError { return new ComputeError('COMPUTE_COMFY_PNG_INVALID', 422) }

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff
  for (const byte of bytes) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Accept only complete, non-interlaced 8-bit RGB/RGBA PNG with valid chunks and inflate size. */
export function inspectPrivateComfyPng(bytes: Buffer): { width: number; height: number } {
  return inspectPng(bytes, MAX_SIDE)
}

/** Validate one research image up to 2048 pixels per side without widening private Comfy sample limits.
 * @param bytes - Complete bounded PNG response.
 * @returns Dimensions of the validated RGB/RGBA image.
 */
export function inspectImageTrialPng(bytes: Buffer): { width: number; height: number } {
  return inspectPng(bytes, 2048)
}

/** Validate an official PNG under Guangzhou's 64 MiB and profile's 4096-pixel limits.
 * @param bytes - Complete result or input PNG; upload callers also enforce their 16 MiB byte limit.
 * @returns Validated RGB/RGBA dimensions without semantic review or conversion.
 */
export function inspectFormalMediaPng(bytes: Buffer): { width: number; height: number } {
  return inspectPng(bytes, 4096, 64 * 1024 * 1024)
}

function inspectPng(bytes: Buffer, maxSide: number, maxBytes = MAX_BYTES): { width: number; height: number } {
  if (bytes.length < 57 || bytes.length > maxBytes || !bytes.subarray(0, 8).equals(SIGNATURE)) throw invalid()
  let offset = 8
  let width = 0
  let height = 0
  let channels = 0
  let imageData: Buffer[] = []
  let seenHeader = false
  let seenImage = false
  let seenEnd = false
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) throw invalid()
    const size = bytes.readUInt32BE(offset)
    const end = offset + 12 + size
    if (size > maxBytes || end > bytes.length) throw invalid()
    const kind = bytes.toString('ascii', offset + 4, offset + 8)
    const body = bytes.subarray(offset + 8, offset + 8 + size)
    if (crc32(bytes.subarray(offset + 4, offset + 8 + size)) !== bytes.readUInt32BE(offset + 8 + size)) throw invalid()
    if (!seenHeader && kind !== 'IHDR') throw invalid()
    if (kind === 'IHDR') {
      if (seenHeader || size !== 13) throw invalid()
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      channels = body[9] === 2 ? 3 : body[9] === 6 ? 4 : 0
      if (width < 1 || width > maxSide || height < 1 || height > maxSide
        || body[8] !== 8 || channels === 0 || body[10] !== 0 || body[11] !== 0 || body[12] !== 0) throw invalid()
      seenHeader = true
    } else if (kind === 'IDAT') {
      if (seenEnd) throw invalid()
      seenImage = true
      imageData.push(body)
    } else if (kind === 'IEND') {
      if (!seenImage || seenEnd || size !== 0 || end !== bytes.length) throw invalid()
      seenEnd = true
    } else if (((bytes[offset + 4] ?? 0) & 0x20) === 0) {
      // A critical chunk other than IHDR/IDAT/IEND needs a decoder we do not provide.
      throw invalid()
    }
    offset = end
  }
  if (!seenHeader || !seenImage || !seenEnd) throw invalid()
  const expected = height * (1 + width * channels)
  let decoded: Buffer
  try { decoded = inflateSync(Buffer.concat(imageData), { maxOutputLength: expected + 1 }) }
  catch { throw invalid() }
  imageData = []
  if (decoded.length !== expected) throw invalid()
  const stride = 1 + width * channels
  for (let row = 0; row < height; row += 1) if ((decoded[row * stride] ?? 255) > 4) throw invalid()
  return { width, height }
}
