/** Reproducible, data-only official seed artifact. No signing key enters this repository. */
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed', 'csv-profile')
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const inputSchema = await readFile(join(root, 'input.schema.json'))
const outputSchema = await readFile(join(root, 'output.schema.json'))
const manifest = Buffer.from(JSON.stringify({
  format: 'qianshou.seed-csv-profile.v1',
  releaseId: 'qianshou.csv-profile-1.0.0',
  pluginId: 'qianshou.csv-profile',
  version: '1.0.0',
  operationId: 'csv.profile',
  capabilityId: 'text.transform',
  executorId: 'qianshou.csv-profile.adapter.v1',
  inputSchemaSha256: digest(inputSchema),
  outputSchemaSha256: digest(outputSchema),
}) + '\n', 'utf8')
const entries = [
  ['manifest.json', manifest],
  ['schemas/input.json', inputSchema],
  ['schemas/output.json', outputSchema],
  ['samples/basic-input.json', await readFile(join(root, 'basic-input.json'))],
  ['samples/basic-output.json', await readFile(join(root, 'basic-output.json'))],
]
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = (value & 1) ? 0xedb88320 ^ (value >>> 1) : value >>> 1
  return value >>> 0
})
function crc32(bytes) {
  let value = 0xffffffff
  for (const byte of bytes) value = (crcTable[(value ^ byte) & 0xff] ^ (value >>> 8)) >>> 0
  return (value ^ 0xffffffff) >>> 0
}
const locals = []
const centrals = []
let offset = 0
for (const [path, contents] of entries) {
  const name = Buffer.from(path, 'ascii')
  const crc = crc32(contents)
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(crc, 14)
  local.writeUInt32LE(contents.length, 18)
  local.writeUInt32LE(contents.length, 22)
  local.writeUInt16LE(name.length, 26)
  locals.push(local, name, contents)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE((3 << 8) | 20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(contents.length, 20)
  central.writeUInt32LE(contents.length, 24)
  central.writeUInt16LE(name.length, 28)
  central.writeUInt32LE((0o100600 << 16) >>> 0, 38)
  central.writeUInt32LE(offset, 42)
  centrals.push(central, name)
  offset += local.length + name.length + contents.length
}
const centralBytes = centrals.reduce((sum, bytes) => sum + bytes.length, 0)
const end = Buffer.alloc(22)
end.writeUInt32LE(0x06054b50, 0)
end.writeUInt16LE(entries.length, 8)
end.writeUInt16LE(entries.length, 10)
end.writeUInt32LE(centralBytes, 12)
end.writeUInt32LE(offset, 16)
const artifact = Buffer.concat([...locals, ...centrals, end])
await writeFile(join(root, 'manifest.json'), manifest)
await writeFile(join(root, 'qianshou.csv-profile-1.0.0.qspkg'), artifact)
process.stdout.write(JSON.stringify({ packageBytes: artifact.length, packageSha256: digest(artifact),
  entries: Object.fromEntries(entries.map(([path, bytes]) => [path, digest(bytes)])) }) + '\n')
