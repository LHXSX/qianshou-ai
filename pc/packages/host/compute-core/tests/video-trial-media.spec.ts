/** Media metadata checks reject truncated or mismatched bytes without running models or converters. */
import { deflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { inspectVideoTrialFirstFrame, inspectVideoTrialMp4, inspectFormalMediaImage, inspectFormalMediaMp4 } from '../src/video-trial-media.ts'
import { png as formalPng } from './fixtures/formal-media.ts'

function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8); header.writeUInt32BE(body.length + 8); header.write(type, 4)
  return Buffer.concat([header, body])
}
function words(...values: number[]): Buffer {
  const result = Buffer.alloc(values.length * 4)
  values.forEach((value, i) => result.writeUInt32BE(value, i * 4))
  return result
}
function mp4(options: { wide?: boolean; longTime?: boolean; audio?: boolean } = {}): Buffer {
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), words(512), Buffer.from('isomiso2')]))
  const mdat = box('mdat', Buffer.from([1, 2, 3, 4, 5, 6]))
  const tkhd = Buffer.alloc(options.longTime ? 96 : 84)
  tkhd[0] = options.longTime ? 1 : 0
  tkhd.writeUInt32BE(1344 * 65536, tkhd.length - 8); tkhd.writeUInt32BE(768 * 65536, tkhd.length - 4)
  const mdhd = Buffer.alloc(options.longTime ? 36 : 24)
  mdhd[0] = options.longTime ? 1 : 0
  mdhd.writeUInt32BE(600, options.longTime ? 20 : 12)
  if (options.longTime) mdhd.writeBigUInt64BE(3000n, 24)
  else mdhd.writeUInt32BE(3000, 16)
  const hdlr = Buffer.alloc(24); hdlr.write(options.audio ? 'soun' : 'vide', 8)
  const sample = Buffer.alloc(78)
  sample.writeUInt16BE(1, 6); sample.writeUInt16BE(1344, 24); sample.writeUInt16BE(768, 26)
  const offset = Buffer.alloc(options.wide ? 8 : 4)
  if (options.wide) offset.writeBigUInt64BE(BigInt(ftyp.length + 8))
  else offset.writeUInt32BE(ftyp.length + 8)
  const stbl = box('stbl', Buffer.concat([
    box('stsd', Buffer.concat([words(0, 1), box('avc1', sample)])),
    box('stsz', words(0, 2, 3)), box('stsc', words(0, 1, 1, 3, 1)), box('stts', words(0, 1, 3, 1000)),
    box(options.wide ? 'co64' : 'stco', Buffer.concat([words(0, 1), offset])),
  ]))
  const mdia = box('mdia', Buffer.concat([box('mdhd', mdhd), box('hdlr', hdlr), box('minf', stbl)]))
  return Buffer.concat([ftyp, mdat, box('moov', box('trak', Buffer.concat([box('tkhd', tkhd), mdia])))])
}
// Timing-only metadata captured from H3 job 20260929_083844_43dc0d9d; no generated sample bytes.
const h3Offsets = [
  1024, 1536, 512, 2560, 1024, 0, 512, 2560, 1024, 0, 512, 2560,
  1024, 0, 512, 1536, 512, 2560, 1024, 0, 512, 2560, 1024, 0,
  512, 2560, 1024, 0, 512, 2560, 1024, 0, 512, 2560, 1024, 0,
  512, 2560, 1024, 0, 512, 1536, 512, 2560, 1024, 0, 512, 2560,
  1024, 0, 512, 2560, 1024, 0, 512, 2560, 1024, 0, 512, 2560,
  1024, 0, 512, 2560, 1024, 0, 512, 2560, 1024, 0, 512, 2560,
  1024, 0, 512, 2560, 1024, 0, 512, 2560, 1024, 0, 512, 2560,
  1024, 0, 512, 1536, 512, 2560, 1024, 0, 512, 2560, 1024, 0,
  512, 2560, 1024, 0, 512, 2560, 1024, 0, 512, 2560, 1024, 0,
  512, 2560, 1024, 0, 512, 2560, 1024, 0, 512, 2048, 512, 512,
]
function h3Mp4(options: { signed?: boolean; wideEdit?: boolean; noEdit?: boolean } = {}): Buffer {
  const ftyp = box('ftyp', Buffer.from('69736f6d0000020069736f6d69736f32617663316d703431', 'hex'))
  const mdat = box('mdat', Buffer.alloc(120))
  const mvhd = Buffer.alloc(100); mvhd.writeUInt32BE(1000, 12); mvhd.writeUInt32BE(5000, 16)
  const tkhd = Buffer.alloc(84); tkhd.writeUInt32BE(5000, 20)
  tkhd.writeUInt32BE(1344 * 65536, 76); tkhd.writeUInt32BE(768 * 65536, 80)
  const mdhd = Buffer.alloc(24); mdhd.writeUInt32BE(12288, 12)
  mdhd.writeUInt32BE(options.signed ? 61440 : 61952, 16)
  const edit = Buffer.alloc(options.wideEdit ? 28 : 20); edit[0] = options.wideEdit ? 1 : 0
  edit.writeUInt32BE(1, 4)
  if (options.wideEdit) {
    edit.writeBigUInt64BE(5000n, 8); edit.writeBigInt64BE(options.signed ? 0n : 1024n, 16); edit.writeInt16BE(1, 24)
  } else {
    edit.writeUInt32BE(5000, 8); edit.writeInt32BE(options.signed ? 0 : 1024, 12); edit.writeInt16BE(1, 16)
  }
  const runs: { count: number; offset: number }[] = []
  for (const offset of h3Offsets) {
    const shifted = offset - (options.signed ? 1024 : 0)
    const previous = runs[runs.length - 1]
    if (previous?.offset === shifted) previous.count++
    else runs.push({ count: 1, offset: shifted })
  }
  const composition = Buffer.concat([words(options.signed ? 0x01000000 : 0, runs.length), ...runs.map((run) => {
    const entry = Buffer.alloc(8); entry.writeUInt32BE(run.count)
    if (options.signed) entry.writeInt32BE(run.offset, 4); else entry.writeUInt32BE(run.offset, 4)
    return entry
  })])
  const sample = Buffer.alloc(78)
  sample.writeUInt16BE(1, 6); sample.writeUInt16BE(1344, 24); sample.writeUInt16BE(768, 26)
  const stbl = box('stbl', Buffer.concat([
    box('stsd', Buffer.concat([words(0, 1), box('avc1', sample)])), box('stsz', words(0, 1, 120)),
    box('stsc', words(0, 1, 1, 120, 1)), box('stts', words(0, 1, 120, 512)), box('ctts', composition),
    box('stco', words(0, 1, ftyp.length + 8)),
  ]))
  const handler = Buffer.alloc(24); handler.write('vide', 8)
  const mdia = box('mdia', Buffer.concat([box('mdhd', mdhd), box('hdlr', handler), box('minf', stbl)]))
  const track = box('trak', Buffer.concat([box('tkhd', tkhd),
    ...(options.noEdit ? [] : [box('edts', box('elst', edit))]), mdia]))
  return Buffer.concat([ftyp, mdat, box('moov', Buffer.concat([box('mvhd', mvhd), track]))])
}
function mutate(type: string, offset: number, value: number, bytes = mp4()): Buffer {
  const start = bytes.indexOf(type) + 4
  if (start < 4) throw new Error('fixture box not found')
  bytes.writeUInt32BE(value, start + offset)
  return bytes
}
function jpeg(width = 1344, height = 768): Buffer {
  const segment = (marker: number, body: Buffer) => {
    const header = Buffer.from([255, marker, 0, 0]); header.writeUInt16BE(body.length + 2, 2)
    return Buffer.concat([header, body])
  }
  const dimensions = Buffer.alloc(9); dimensions[0] = 8
  dimensions.writeUInt16BE(height, 1); dimensions.writeUInt16BE(width, 3)
  dimensions[5] = 1; dimensions[6] = 1; dimensions[7] = 0x11
  return Buffer.concat([Buffer.from([255, 216]), segment(0xdb, Buffer.concat([Buffer.from([0]), Buffer.alloc(64, 1)])),
    segment(0xc4, Buffer.from([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])),
    segment(0xc0, dimensions), segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    Buffer.from([12, 255, 0, 34, 255, 217])])
}
function png(): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const contents = Buffer.concat([Buffer.from(type), body])
    let crc = 0xffffffff
    for (const byte of contents) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    return Buffer.concat([words(body.length), contents, words((crc ^ 0xffffffff) >>> 0)])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1); ihdr.writeUInt32BE(1, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from([0, 10, 20, 30]))), chunk('IEND', Buffer.alloc(0))])
}

describe('video trial first frame', () => {
  it('reads bounded JPEG scan metadata and returns dimensions', () => {
    expect(inspectVideoTrialFirstFrame(jpeg(), 'image/jpeg')).toEqual({ width: 1344, height: 768 })
    expect(inspectVideoTrialFirstFrame(jpeg(2048, 2048), 'image/jpeg')).toEqual({ width: 2048, height: 2048 })
  })
  it('reuses PNG CRC and inflate validation', () => {
    expect(inspectVideoTrialFirstFrame(png(), 'image/png')).toEqual({ width: 1, height: 1 })
    const corrupt = png(); corrupt[corrupt.length - 1] = 1
    expect(() => inspectVideoTrialFirstFrame(corrupt, 'image/png')).toThrow('COMPUTE_VIDEO_TRIAL_FRAME_INVALID')
  })
  it.each([
    ['truncated scan', () => jpeg().subarray(0, -2)],
    ['trailing content', () => Buffer.concat([jpeg(), Buffer.from([0])])],
    ['oversized dimensions', () => jpeg(2049, 1)],
    ['zero dimensions', () => jpeg(0, 1)],
    ['oversized file', () => Buffer.alloc(16 * 1024 * 1024 + 1)],
    ['bad segment length', () => { const data = jpeg(); data.writeUInt16BE(65535, 4); return data }],
    ['missing scan', () => Buffer.from([255, 216, 255, 217])],
    ['wrong encoding', png],
  ] as const)('rejects JPEG %s', (_name, make) => {
    expect(() => inspectVideoTrialFirstFrame(make(), 'image/jpeg')).toThrow('COMPUTE_VIDEO_TRIAL_FRAME_INVALID')
  })
  it('rejects a JPEG declared as PNG', () => {
    expect(() => inspectVideoTrialFirstFrame(jpeg(), 'image/png')).toThrow('COMPUTE_VIDEO_TRIAL_FRAME_INVALID')
  })
})
describe('formal media limits', () => {
  it('reads a 4096-pixel official image while the research first frame retains its 2048-pixel limit', () => {
    const bytes = formalPng(4096, 2048)
    expect(inspectFormalMediaImage(bytes, 'image/png')).toEqual({ width: 4096, height: 2048 })
    expect(() => inspectVideoTrialFirstFrame(bytes, 'image/png')).toThrow('COMPUTE_VIDEO_TRIAL_FRAME_INVALID')
    expect(inspectFormalMediaImage(jpeg(4096, 2048), 'image/jpeg')).toEqual({ width: 4096, height: 2048 })
    expect(() => inspectFormalMediaImage(jpeg(4097, 2048), 'image/jpeg')).toThrow('COMPUTE_VIDEO_TRIAL_FRAME_INVALID')
  })
  it('reads the same strictly bounded MP4 sample ranges over 16 MiB only through the official 64 MiB entry', () => {
    const bytes = Buffer.concat([mp4(), box('free', Buffer.alloc(16 * 1024 * 1024))])
    expect(inspectFormalMediaMp4(bytes)).toEqual({ width: 1344, height: 768, durationSeconds: 5, frameCount: 3 })
    expect(() => inspectVideoTrialMp4(bytes)).toThrow('COMPUTE_VIDEO_TRIAL_MP4_INVALID')
    expect(() => inspectFormalMediaMp4(Buffer.alloc(64 * 1024 * 1024 + 1))).toThrow('COMPUTE_VIDEO_TRIAL_MP4_INVALID')
    const invalid = Buffer.from(bytes); invalid.writeUInt32BE(0xffffffff, 0)
    expect(() => inspectFormalMediaMp4(invalid)).toThrow('COMPUTE_VIDEO_TRIAL_MP4_INVALID')
  })
})

describe('video trial MP4', () => {
  it.each([{}, { wide: true }, { longTime: true }])('reads video track time and dimensions with %j', (options) => {
    expect(inspectVideoTrialMp4(mp4(options))).toEqual({ width: 1344, height: 768, durationSeconds: 5, frameCount: 3 })
  })
  it.each([{}, { wideEdit: true }, { signed: true }, { signed: true, noEdit: true }])(
    'reads a complete reordered H3 presentation and exact edit mapping with %j', (options) => {
      const bytes = h3Mp4(options)
      expect(bytes.readUInt32BE(bytes.indexOf('ctts') + 8)).toBe(119)
      expect(inspectVideoTrialMp4(bytes)).toEqual({ width: 1344, height: 768, durationSeconds: 5, frameCount: 120 })
    },
  )
  it.each([
    ['missing edit for shifted presentation', () => h3Mp4({ noEdit: true })],
    ['unknown composition version', () => mutate('ctts', 0, 0x02000000, h3Mp4())],
    ['composition flags', () => mutate('ctts', 0, 1, h3Mp4())],
    ['composition count mismatch', () => mutate('ctts', 8, 2, h3Mp4())],
    ['composition gap or overlap', () => mutate('ctts', 12, 1025, h3Mp4())],
    ['arbitrary media duration', () => mutate('mdhd', 16, 61953, h3Mp4())],
    ['sample duration mismatch', () => mutate('stts', 12, 511, h3Mp4())],
    ['edited media start mismatch', () => mutate('elst', 12, 1025, h3Mp4())],
    ['empty edit', () => mutate('elst', 12, 0xffffffff, h3Mp4())],
    ['edited duration mismatch', () => mutate('elst', 8, 5001, h3Mp4())],
    ['non-unit edit rate', () => mutate('elst', 16, 0x00020000, h3Mp4())],
    ['multiple edits', () => mutate('elst', 4, 2, h3Mp4())],
    ['unknown edit version', () => mutate('elst', 0, 0x02000000, h3Mp4())],
    ['track duration mismatch', () => mutate('tkhd', 20, 5001, h3Mp4())],
    ['movie ends before edited track', () => mutate('mvhd', 16, 4999, h3Mp4())],
    ['missing movie time scale', () => mutate('mvhd', 12, 0, h3Mp4())],
    ['sample outside media despite valid edit', () => mutate('stco', 8, 0, h3Mp4())],
    ['sample beyond media despite valid edit', () => mutate('stsz', 4, 2, h3Mp4())],
    ['truncated reordered media', () => h3Mp4().subarray(0, -1)],
  ] as const)('rejects reordered %s', (_name, make) => {
    expect(() => inspectVideoTrialMp4(make())).toThrow('COMPUTE_VIDEO_TRIAL_MP4_INVALID')
  })
  it.each([
    ['truncated moov', () => mp4().subarray(0, -1)],
    ['truncated top box', () => Buffer.concat([mp4(), Buffer.from([1])])],
    ['zero-sized header', () => mutate('tkhd', 76, 0)],
    ['zero time scale', () => mutate('mdhd', 12, 0)],
    ['unknown duration version', () => mutate('mdhd', 0, 0x02000000)],
    ['missing video track', () => mp4({ audio: true })],
    ['sample outside mdat', () => mutate('stco', 8, 0)],
    ['sample beyond mdat', () => mutate('stsz', 4, 3)],
    ['duration/sample disagreement', () => mutate('stts', 12, 999)],
    ['missing first chunk', () => mutate('stsc', 8, 2)],
    ['invalid sample entry', () => mutate('stsd', 8, 0)],
    ['sample size table overflow', () => mutate('stsz', 8, 100_001)],
    ['oversized file', () => Buffer.alloc(16 * 1024 * 1024 + 1)],
    ['nested size overflow', () => { const b = mp4(); b.writeUInt32BE(0xffffffff, b.indexOf('mdia') - 4); return b }],
    ['fragmented media', () => Buffer.concat([mp4(), box('moof', Buffer.alloc(0))])],
    ['unknown file brand', () => { const b = mp4(); b.fill(0, 8, 24); return b }],
  ] as const)('rejects %s', (_name, make) => {
    expect(() => inspectVideoTrialMp4(make())).toThrow('COMPUTE_VIDEO_TRIAL_MP4_INVALID')
  })
  it('checks bounds on wide box lengths before converting to numbers', () => {
    const header = Buffer.concat([words(1), Buffer.from('mdat'), Buffer.alloc(8)])
    header.writeBigUInt64BE(1n << 60n, 8)
    expect(() => inspectVideoTrialMp4(Buffer.concat([mp4(), header]))).toThrow('COMPUTE_VIDEO_TRIAL_MP4_INVALID')
  })
})
