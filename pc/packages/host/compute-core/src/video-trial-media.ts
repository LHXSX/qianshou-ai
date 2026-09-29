/** Bounded media structure checks for the private video trial; no semantic review or transcoding. */
import { inspectImageTrialPng, inspectFormalMediaPng } from './comfy-png.ts'
import { ComputeError } from './errors.ts'

const MAX_BYTES = 16 * 1024 * 1024
const MAX_FIRST_FRAME_SIDE = 2048
const MAX_BOXES = 4096
const MAX_SAMPLES = 100_000

function invalidFrame(): never { throw new ComputeError('COMPUTE_VIDEO_TRIAL_FRAME_INVALID', 422) }
function invalidVideo(): never { throw new ComputeError('COMPUTE_VIDEO_TRIAL_MP4_INVALID', 422) }

/** Inspect a bounded PNG or JPEG first frame without invoking an agent or an image converter.
 * PNG verifies CRCs and inflated rows; JPEG verifies marker, scan, and dimension metadata without decoding pixels.
 * @param bytes - Complete image bytes, capped at 16 MiB and 2048 pixels per side.
 * @param mime - Declared image encoding; a mismatched signature is rejected.
 * @returns Dimensions from the validated image header.
 */
export function inspectVideoTrialFirstFrame(bytes: Buffer, mime: 'image/png' | 'image/jpeg'): { width: number; height: number } {
  return inspectImage(bytes, mime, MAX_BYTES, MAX_FIRST_FRAME_SIDE, false)
}

/** Inspect official PNG/JPEG without widening trial input limits.
 * @param bytes - Complete bytes under the Guangzhou 64 MiB result limit.
 * @param mime - Exact declared PNG or JPEG encoding.
 * @returns Validated dimensions up to 4096 pixels per side.
 */
export function inspectFormalMediaImage(bytes: Buffer, mime: 'image/png' | 'image/jpeg'): { width: number; height: number } {
  return inspectImage(bytes, mime, 64 * 1024 * 1024, 4096, true)
}
function inspectImage(bytes: Buffer, mime: 'image/png' | 'image/jpeg', maxBytes: number, maxSide: number, formal: boolean) {
  if (mime === 'image/png') {
    try { return formal ? inspectFormalMediaPng(bytes) : inspectImageTrialPng(bytes) } catch { return invalidFrame() }
  }
  if (bytes.length < 4 || bytes.length > maxBytes || bytes.readUInt16BE(0) !== 0xffd8) invalidFrame()
  let offset = 2
  let width = 0
  let height = 0
  let scans = 0
  let quantization = false
  let huffman = false
  const components = new Set<number>()
  while (offset < bytes.length) {
    if (bytes[offset++] !== 0xff) invalidFrame()
    while (bytes[offset] === 0xff) offset++
    const marker = bytes[offset++]
    if (marker === 0xd9) {
      if (offset !== bytes.length || scans === 0) invalidFrame()
      return { width, height }
    }
    if (marker === undefined || marker === 0 || marker === 0xd8 || marker >= 0xd0 && marker <= 0xd7
      || offset + 2 > bytes.length) invalidFrame()
    const size = bytes.readUInt16BE(offset)
    if (size < 2 || offset + size > bytes.length) invalidFrame()
    const body = bytes.subarray(offset + 2, offset + size)
    offset += size
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (width !== 0 || body.length < 6 || body[0] !== 8) invalidFrame()
      height = body.readUInt16BE(1); width = body.readUInt16BE(3)
      const count = body.readUInt8(5)
      if (width < 1 || height < 1 || width > maxSide || height > maxSide
        || count !== 1 && count !== 3 || body.length !== 6 + 3 * count) invalidFrame()
      for (let i = 0; i < count; i++) {
        const id = body.readUInt8(6 + 3 * i)
        const sampling = body.readUInt8(7 + 3 * i)
        if (components.has(id) || (sampling >> 4) < 1 || (sampling >> 4) > 4
          || (sampling & 15) < 1 || (sampling & 15) > 4 || body.readUInt8(8 + 3 * i) > 3) invalidFrame()
        components.add(id)
      }
    } else if (marker === 0xdb) {
      validateJpegTables(body, false)
      quantization = true
    } else if (marker === 0xc4) {
      validateJpegTables(body, true)
      huffman = true
    } else if (marker === 0xda) {
      const count = body[0] ?? 0
      if (!quantization || !huffman || width === 0 || count < 1 || count > components.size
        || body.length !== 4 + 2 * count) invalidFrame()
      const scanIds = new Set<number>()
      for (let i = 0; i < count; i++) {
        const id = body.readUInt8(1 + 2 * i)
        if (!components.has(id) || scanIds.has(id)) invalidFrame()
        scanIds.add(id)
      }
      const start = offset
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) { offset++; continue }
        const next = bytes[offset + 1]
        if (next === 0 || next !== undefined && next >= 0xd0 && next <= 0xd7) { offset += 2; continue }
        break
      }
      if (offset === start || offset >= bytes.length) invalidFrame()
      scans++
    } else if (!(marker >= 0xe0 && marker <= 0xef) && marker !== 0xfe && !(marker === 0xdd && body.length === 2)) {
      invalidFrame()
    }
  }
  return invalidFrame()
}

function validateJpegTables(body: Buffer, huffman: boolean): void {
  if (body.length === 0) invalidFrame()
  let offset = 0
  while (offset < body.length) {
    const tag = body.readUInt8(offset++)
    if ((tag & 15) > 3 || (tag >> 4) > 1) invalidFrame()
    if (huffman) {
      if (offset + 16 > body.length) invalidFrame()
      let count = 0
      let available = 1
      for (let i = 0; i < 16; i++) {
        const size = body.readUInt8(offset + i)
        count += size; available = available * 2 - size
        if (available < 0) invalidFrame()
      }
      if (count === 0 || count > 256 || offset + 16 + count > body.length) invalidFrame()
      offset += 16 + count
    } else {
      const wordBytes = (tag >> 4) + 1
      if (offset + 64 * wordBytes > body.length) invalidFrame()
      for (let i = 0; i < 64; i++) {
        const value = wordBytes === 1 ? body.readUInt8(offset) : body.readUInt16BE(offset)
        if (value === 0) invalidFrame()
        offset += wordBytes
      }
    }
  }
}

type Box = { type: string; start: number; end: number }
type SampleTiming = { frameCount: number; decodeTicks: number; start: number; end: number; lastStart: number; reordered: boolean }
type MovieTiming = { timescale: number; ticks: bigint }

/** Inspect one complete, nonfragmented MP4 with one video track and local sample data.
 * This validates metadata and sample byte ranges, not compressed frame decodability or content quality.
 * @param bytes - Complete MP4 bytes, capped at 16 MiB.
 * @returns Encoded dimensions, sample count and presentation duration after a supported rate-one edit.
 */
export function inspectVideoTrialMp4(bytes: Buffer): { width: number; height: number; durationSeconds: number; frameCount: number } {
  return inspectMp4(bytes, MAX_BYTES)
}

/** Inspect an official nonfragmented MP4 under Guangzhou's 64 MiB result limit.
 * @param bytes - Complete fixed-version result bytes.
 * @returns Validated dimensions, sample count and presentation duration without transcoding or semantic review.
 */
export function inspectFormalMediaMp4(bytes: Buffer): { width: number; height: number; durationSeconds: number; frameCount: number } {
  return inspectMp4(bytes, 64 * 1024 * 1024)
}
function inspectMp4(bytes: Buffer, maxBytes: number): { width: number; height: number; durationSeconds: number; frameCount: number } {
  if (bytes.length < 32 || bytes.length > maxBytes) invalidVideo()
  let boxCount = 0
  const boxes = (start: number, end: number): Box[] => {
    const result: Box[] = []
    while (start < end) {
      if (++boxCount > MAX_BOXES || end - start < 8) invalidVideo()
      let length = bytes.readUInt32BE(start)
      const type = bytes.toString('ascii', start + 4, start + 8)
      let header = 8
      if (length === 1) {
        if (end - start < 16) invalidVideo()
        const wide = bytes.readBigUInt64BE(start + 8)
        if (wide > BigInt(maxBytes)) invalidVideo()
        length = Number(wide); header = 16
      } else if (length === 0) {
        length = end - start
      }
      if (length < header || length > end - start) invalidVideo()
      result.push({ type, start: start + header, end: start + length })
      start += length
    }
    return result
  }
  const only = (items: Box[], type: string): Box => {
    const matching = items.filter(box => box.type === type)
    if (matching.length !== 1) invalidVideo()
    return matching[0] ?? invalidVideo()
  }
  const body = (box: Box, minimum: number): Buffer => {
    if (box.end - box.start < minimum) invalidVideo()
    return bytes.subarray(box.start, box.end)
  }
  const top = boxes(0, bytes.length)
  if (top.some(box => box.type === 'moof')) invalidVideo()
  const ftyp = body(only(top, 'ftyp'), 8)
  if ((ftyp.length - 8) % 4 !== 0) invalidVideo()
  const brands = [ftyp.toString('ascii', 0, 4)]
  for (let i = 8; i < ftyp.length; i += 4) brands.push(ftyp.toString('ascii', i, i + 4))
  if (!brands.some(brand => ['isom', 'iso2', 'mp41', 'mp42', 'avc1', 'iso5', 'iso6'].includes(brand))) invalidVideo()
  const media = top.filter(box => box.type === 'mdat')
  if (media.length === 0 || media.some(box => box.start === box.end)) invalidVideo()
  const movie = only(top, 'moov')
  const movieBoxes = boxes(movie.start, movie.end)
  const movieHeaders = movieBoxes.filter(box => box.type === 'mvhd')
  if (movieHeaders.length > 1) invalidVideo()
  let movieTiming: MovieTiming | undefined
  if (movieHeaders.length === 1) {
    const header = body(only(movieBoxes, 'mvhd'), 100)
    const version = header[0]
    if (version !== 0 && version !== 1 || header.length !== (version === 1 ? 112 : 100)) invalidVideo()
    const timescale = header.readUInt32BE(version === 1 ? 20 : 12)
    const ticks = version === 1 ? header.readBigUInt64BE(24) : BigInt(header.readUInt32BE(16))
    if (timescale === 0 || ticks === 0n || ticks > BigInt(Number.MAX_SAFE_INTEGER)) invalidVideo()
    movieTiming = { timescale, ticks }
  }
  const tracks = movieBoxes.filter(box => box.type === 'trak')
  let video: { width: number; height: number; durationSeconds: number; frameCount: number } | undefined
  for (const track of tracks) {
    const trackBoxes = boxes(track.start, track.end)
    const mdia = only(trackBoxes, 'mdia')
    const metadata = boxes(mdia.start, mdia.end)
    const handler = body(only(metadata, 'hdlr'), 24)
    if (handler.toString('ascii', 8, 12) !== 'vide') continue
    if (video !== undefined) invalidVideo()
    const tkhd = body(only(trackBoxes, 'tkhd'), 84)
    const version = tkhd[0]
    if (version !== 0 && version !== 1 || tkhd.length !== (version === 1 ? 96 : 84)) invalidVideo()
    const width = tkhd.readUInt32BE(version === 1 ? 88 : 76) / 65536
    const height = tkhd.readUInt32BE(version === 1 ? 92 : 80) / 65536
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 8192 || height > 8192) invalidVideo()
    const mdhd = body(only(metadata, 'mdhd'), 24)
    if (mdhd[0] !== 0 && mdhd[0] !== 1 || mdhd.length !== (mdhd[0] === 1 ? 36 : 24)) invalidVideo()
    const timescale = mdhd.readUInt32BE(mdhd[0] === 1 ? 20 : 12)
    const ticks = mdhd[0] === 1 ? mdhd.readBigUInt64BE(24) : BigInt(mdhd.readUInt32BE(16))
    if (timescale === 0 || ticks === 0n || ticks > BigInt(Number.MAX_SAFE_INTEGER)) invalidVideo()
    const minf = only(metadata, 'minf')
    const stbl = only(boxes(minf.start, minf.end), 'stbl')
    const samples = boxes(stbl.start, stbl.end)
    const timing = validateSamples(bytes, samples, media, width, height, only, body)
    const edits = trackBoxes.filter(box => box.type === 'edts')
    if (edits.length > 1) invalidVideo()
    let durationSeconds = timing.decodeTicks / timescale
    if (edits.length === 1) {
      if (movieTiming === undefined) invalidVideo()
      const editBox = only(trackBoxes, 'edts')
      const editChildren = boxes(editBox.start, editBox.end)
      if (editChildren.length !== 1) invalidVideo()
      const edit = body(only(editChildren, 'elst'), 8)
      const version = edit[0]
      if (version !== 0 && version !== 1 || edit.readUIntBE(1, 3) !== 0 || edit.readUInt32BE(4) !== 1
        || edit.length !== (version === 1 ? 28 : 20)) invalidVideo()
      const segmentTicks = version === 1 ? edit.readBigUInt64BE(8) : BigInt(edit.readUInt32BE(8))
      const mediaStart = version === 1 ? edit.readBigInt64BE(16) : BigInt(edit.readInt32BE(12))
      const rateOffset = version === 1 ? 24 : 16
      if (segmentTicks === 0n || segmentTicks > BigInt(Number.MAX_SAFE_INTEGER)
        || mediaStart < 0n || mediaStart !== BigInt(timing.start)
        || edit.readInt16BE(rateOffset) !== 1 || edit.readInt16BE(rateOffset + 2) !== 0
        || segmentTicks * BigInt(timescale) !== BigInt(timing.end - timing.start) * BigInt(movieTiming.timescale)) invalidVideo()
      const trackTicks = versionOfTrackDuration(tkhd)
      if (trackTicks !== segmentTicks || movieTiming.ticks < trackTicks) invalidVideo()
      // H3's mux declares mdhd at the last composition timestamp. Accept that exact endpoint
      // only when the full reordered timeline and its rate-one edit match; there is no time tolerance.
      const lastTimestamp = timing.reordered && timing.start > 0 && timing.lastStart >= timing.decodeTicks
        && ticks === BigInt(timing.lastStart)
      if (ticks !== BigInt(timing.decodeTicks) && ticks !== BigInt(timing.end) && !lastTimestamp) invalidVideo()
      durationSeconds = Number(segmentTicks) / movieTiming.timescale
    } else {
      if (timing.start !== 0 || ticks !== BigInt(timing.decodeTicks)) invalidVideo()
      if (movieTiming !== undefined) {
        const trackTicks = versionOfTrackDuration(tkhd)
        const scaled = BigInt(timing.decodeTicks) * BigInt(movieTiming.timescale)
        const expected = (scaled + BigInt(timescale) - 1n) / BigInt(timescale)
        if (trackTicks !== expected || movieTiming.ticks < trackTicks) invalidVideo()
      }
    }
    video = { width, height, durationSeconds, frameCount: timing.frameCount }
  }
  if (video === undefined) invalidVideo()
  return video
}

function versionOfTrackDuration(tkhd: Buffer): bigint {
  return tkhd[0] === 1 ? tkhd.readBigUInt64BE(28) : BigInt(tkhd.readUInt32BE(20))
}

function validateSamples(bytes: Buffer, samples: Box[], media: Box[], width: number, height: number,
  only: (items: Box[], type: string) => Box, body: (box: Box, minimum: number) => Buffer): SampleTiming {
  const sizes = body(only(samples, 'stsz'), 12)
  const fixed = sizes.readUInt32BE(4)
  const count = sizes.readUInt32BE(8)
  if (count === 0 || count > MAX_SAMPLES || sizes.length !== 12 + (fixed === 0 ? count * 4 : 0)) invalidVideo()
  const stts = body(only(samples, 'stts'), 8)
  const entries = stts.readUInt32BE(4)
  if (stts.readUInt32BE(0) !== 0 || entries === 0 || entries > MAX_SAMPLES || stts.length !== 8 + entries * 8) invalidVideo()
  let timedCount = 0
  let timedTicks = 0
  const durations: number[] = []
  for (let i = 0; i < entries; i++) {
    const n = stts.readUInt32BE(8 + i * 8); const duration = stts.readUInt32BE(12 + i * 8)
    if (n === 0 || duration === 0 || n > count - timedCount) invalidVideo()
    timedCount += n; timedTicks += n * duration
    for (let j = 0; j < n; j++) durations.push(duration)
  }
  if (timedCount !== count || !Number.isSafeInteger(timedTicks)) invalidVideo()
  const composition = samples.filter(box => box.type === 'ctts')
  if (composition.length > 1) invalidVideo()
  const compositionOffsets: number[] = []
  if (composition.length === 1) {
    const table = body(only(samples, 'ctts'), 8)
    const version = table[0]
    const entries = table.readUInt32BE(4)
    if (version !== 0 && version !== 1 || table.readUIntBE(1, 3) !== 0
      || entries === 0 || entries > count || table.length !== 8 + entries * 8) invalidVideo()
    for (let i = 0; i < entries; i++) {
      const n = table.readUInt32BE(8 + i * 8)
      const offset = version === 1 ? table.readInt32BE(12 + i * 8) : table.readUInt32BE(12 + i * 8)
      if (n === 0 || n > count - compositionOffsets.length) invalidVideo()
      for (let j = 0; j < n; j++) compositionOffsets.push(offset)
    }
    if (compositionOffsets.length !== count) invalidVideo()
  }
  const presentation: { start: number; end: number }[] = []
  let decoded = 0
  let reordered = false
  for (let i = 0; i < count; i++) {
    const duration = durations[i] ?? invalidVideo()
    const start = decoded + (compositionOffsets[i] ?? 0)
    const end = start + duration
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) invalidVideo()
    if (i > 0 && start < (presentation[i - 1] ?? invalidVideo()).start) reordered = true
    presentation.push({ start, end }); decoded += duration
  }
  presentation.sort((a, b) => a.start - b.start)
  for (let i = 1; i < count; i++) {
    if ((presentation[i] ?? invalidVideo()).start !== (presentation[i - 1] ?? invalidVideo()).end) invalidVideo()
  }
  const firstPresentation = presentation[0] ?? invalidVideo()
  const lastPresentation = presentation[count - 1] ?? invalidVideo()
  const offsetBoxes = samples.filter(box => box.type === 'stco' || box.type === 'co64')
  if (offsetBoxes.length !== 1) invalidVideo()
  const offsetBox = offsetBoxes[0] ?? invalidVideo()
  const wide = offsetBox.type === 'co64'
  const offsets = body(offsetBox, 8)
  const chunks = offsets.readUInt32BE(4)
  if (chunks === 0 || chunks > count || offsets.length !== 8 + chunks * (wide ? 8 : 4)) invalidVideo()
  const stsc = body(only(samples, 'stsc'), 8)
  const mappings = stsc.readUInt32BE(4)
  if (mappings === 0 || mappings > chunks || stsc.length !== 8 + mappings * 12) invalidVideo()
  const descriptions = body(only(samples, 'stsd'), 8)
  const descriptionCount = descriptions.readUInt32BE(4)
  if (descriptionCount < 1 || descriptionCount > MAX_BOXES) invalidVideo()
  let descriptionOffset = 8
  for (let i = 0; i < descriptionCount; i++) {
    if (descriptionOffset + 8 > descriptions.length) invalidVideo()
    const length = descriptions.readUInt32BE(descriptionOffset)
    if (length < 86 || descriptionOffset + length > descriptions.length
      || descriptions.readUInt16BE(descriptionOffset + 32) !== width
      || descriptions.readUInt16BE(descriptionOffset + 34) !== height) invalidVideo()
    descriptionOffset += length
  }
  if (descriptionOffset !== descriptions.length) invalidVideo()
  const map: Array<{ first: number; count: number }> = []
  for (let i = 0; i < mappings; i++) {
    const first = stsc.readUInt32BE(8 + i * 12)
    const perChunk = stsc.readUInt32BE(12 + i * 12)
    const description = stsc.readUInt32BE(16 + i * 12)
    if (first < 1 || first > chunks || i === 0 && first !== 1 || i > 0 && first <= (map[i - 1]?.first ?? 0)
      || perChunk < 1 || perChunk > count || description < 1 || description > descriptionCount) invalidVideo()
    map.push({ first, count: perChunk })
  }
  let sampleIndex = 0
  let mapping = 0
  for (let chunk = 1; chunk <= chunks; chunk++) {
    if (mapping + 1 < map.length && chunk >= (map[mapping + 1]?.first ?? Infinity)) mapping++
    const start = wide ? Number(offsets.readBigUInt64BE(8 + (chunk - 1) * 8)) : offsets.readUInt32BE(8 + (chunk - 1) * 4)
    let length = 0
    const perChunk = (map[mapping] ?? invalidVideo()).count
    for (let i = 0; i < perChunk; i++) {
      if (sampleIndex >= count) invalidVideo()
      const size = fixed || sizes.readUInt32BE(12 + sampleIndex * 4)
      if (size === 0) invalidVideo()
      length += size; sampleIndex++
    }
    if (!Number.isSafeInteger(start) || start + length > bytes.length
      || !media.some(box => start >= box.start && start + length <= box.end)) invalidVideo()
  }
  if (sampleIndex !== count) invalidVideo()
  return { frameCount: count, decodeTicks: timedTicks, start: firstPresentation.start, end: lastPresentation.end,
    lastStart: lastPresentation.start, reordered }
}
