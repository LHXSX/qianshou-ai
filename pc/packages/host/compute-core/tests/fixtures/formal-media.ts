/** Synthetic structural media for HTTP validation; no generated content or GPU execution. */
import { deflateSync } from 'node:zlib'

function box(type: string, body: Buffer): Buffer {
  const header = Buffer.alloc(8); header.writeUInt32BE(body.length + 8); header.write(type, 4)
  return Buffer.concat([header, body])
}
function words(...values: number[]): Buffer {
  const result = Buffer.alloc(values.length * 4)
  values.forEach((value, i) => result.writeUInt32BE(value, i * 4))
  return result
}
export function mp4(options: { wide?: boolean; longTime?: boolean; audio?: boolean; frames?: 119 | 120 } = {}): Buffer {
  const ftyp = box('ftyp', Buffer.concat([Buffer.from('isom'), words(512), Buffer.from('isomiso2')]))
  const frames = options.frames ?? 120
  const mdat = box('mdat', Buffer.alloc(frames * 2, 1))
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
    box('stsz', words(0, 2, frames)), box('stsc', words(0, 1, 1, frames, 1)),
    box('stts', frames === 119 ? words(0, 2, 118, 25, 1, 50) : words(0, 1, 120, 25)),
    box(options.wide ? 'co64' : 'stco', Buffer.concat([words(0, 1), offset])),
  ]))
  const mdia = box('mdia', Buffer.concat([box('mdhd', mdhd), box('hdlr', hdlr), box('minf', stbl)]))
  return Buffer.concat([ftyp, mdat, box('moov', box('trak', Buffer.concat([box('tkhd', tkhd), mdia])))])
}
export function png(width = 1, height = 1): Buffer {
  const chunk = (type: string, body: Buffer) => {
    const contents = Buffer.concat([Buffer.from(type), body])
    let crc = 0xffffffff
    for (const byte of contents) {
      crc ^= byte
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0)
    }
    return Buffer.concat([words(body.length), contents, words((crc ^ 0xffffffff) >>> 0)])
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.alloc(height * (1 + width * 3)))), chunk('IEND', Buffer.alloc(0))])
}
