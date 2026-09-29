import { describe, expect, it } from 'vitest'
import { readPluginZipArchive } from '../src/zip-archive.ts'
import { buildZip, type ZipEntrySpec } from './zip-builder.ts'

const limits = { maxFileCount: 8, maxFileBytes: 4096, maxPackageBytes: 16384 }
const text = (value: string): Buffer => Buffer.from(value, 'utf8')
const read = (bytes: Buffer) => readPluginZipArchive(bytes, { limits })

describe('readPluginZipArchive', () => {
  it('reads stored and deflated entries with canonical relative paths', () => {
    const archive = buildZip([
      { name: 'entry.js', bytes: text('export const capability = 1') },
      { name: 'assets/spec.json', bytes: text('{"kind":"spec"}'), method: 8 },
    ])
    const entries = read(archive)
    expect(entries.map(entry => entry.path)).toEqual(['entry.js', 'assets/spec.json'])
    expect(Buffer.from(entries[0]!.bytes).toString('utf8')).toBe('export const capability = 1')
    expect(Buffer.from(entries[1]!.bytes).toString('utf8')).toBe('{"kind":"spec"}')
  })

  it('skips directory entries but still validates their paths', () => {
    const archive = buildZip([
      { name: 'assets/', bytes: new Uint8Array(), mode: 0o40755 },
      { name: 'assets/spec.json', bytes: text('{}') },
    ])
    expect(read(archive).map(entry => entry.path)).toEqual(['assets/spec.json'])
    expect(() => read(buildZip([{ name: '../outside/', bytes: new Uint8Array(), mode: 0o40755 }]))).toThrowError(expect.objectContaining({ code: 'PLUGIN_PATH_INVALID' }))
  })

  it.each([
    ['traversal file', [{ name: '../escape.js', bytes: text('x') }], 'PLUGIN_PATH_INVALID'],
    ['nested traversal', [{ name: 'assets/../../escape.js', bytes: text('x') }], 'PLUGIN_PATH_INVALID'],
    ['absolute path', [{ name: '/etc/passwd', bytes: text('x') }], 'PLUGIN_PATH_INVALID'],
    ['drive colon', [{ name: 'C:outside.txt', bytes: text('x') }], 'PLUGIN_PATH_INVALID'],
    ['backslash separator', [{ name: 'assets\\spec.json', bytes: text('x') }], 'PLUGIN_PATH_INVALID'],
    ['dot spelling', [{ name: './entry.js', bytes: text('x') }], 'PLUGIN_PATH_INVALID'],
  ])('rejects %s', (_label, entries, code) => {
    expect(() => read(buildZip(entries as ZipEntrySpec[]))).toThrowError(expect.objectContaining({ code }))
  })

  it('rejects a symlink entry before reading its target', () => {
    const archive = buildZip([{ name: 'link.js', bytes: text('/etc/passwd'), mode: 0o120777 }])
    expect(() => read(archive)).toThrowError(expect.objectContaining({ code: 'PLUGIN_ZIP_ENTRY_TYPE_REJECTED' }))
  })

  it('rejects encrypted entries, unsupported methods and zip64 archives', () => {
    expect(() => read(buildZip([{ name: 'entry.js', bytes: text('x'), flags: 0x0801 }])))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_ZIP_ENCRYPTED_UNSUPPORTED' }))
    expect(() => read(buildZip([{ name: 'entry.js', bytes: text('x'), method: 99 }])))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_ZIP_METHOD_UNSUPPORTED' }))
    expect(() => read(buildZip([{ name: 'entry.js', bytes: text('x') }], { totalEntriesOverride: 0xffff, entriesOnDiskOverride: 0xffff })))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_ZIP_ZIP64_UNSUPPORTED' }))
  })

  it('rejects corrupt archives instead of guessing', () => {
    expect(() => read(buildZip([{ name: 'entry.js', bytes: text('payload'), crcOverride: 0 }])))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_ZIP_CRC_MISMATCH' }))
    expect(() => read(buildZip([{ name: 'entry.js', bytes: text('payload'), declaredUncompressedSize: 99 }])))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_ZIP_SIZE_MISMATCH' }))
    expect(() => read(buildZip([{ name: 'entry.js', bytes: text('payload'), localNameOverride: 'other.js' }])))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_ZIP_CORRUPT' }))
    const archive = buildZip([{ name: 'entry.js', bytes: text('payload') }])
    expect(() => read(archive.subarray(0, archive.byteLength - 30))).toThrowError(expect.objectContaining({ code: 'PLUGIN_ZIP_CORRUPT' }))
    expect(() => read(Buffer.alloc(8))).toThrowError(expect.objectContaining({ code: 'PLUGIN_ZIP_CORRUPT' }))
    expect(() => read(buildZip([{ name: 'entry.js', bytes: text('payload') }], { totalEntriesOverride: 5 })))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_ZIP_MULTIDISK_UNSUPPORTED' }))
  })

  it('rejects duplicate names and budget violations', () => {
    expect(() => read(buildZip([
      { name: 'entry.js', bytes: text('one') },
      { name: 'entry.js', bytes: text('two') },
    ]))).toThrowError(expect.objectContaining({ code: 'PLUGIN_PACKAGE_DUPLICATE_FILE' }))
    expect(() => read(buildZip([{ name: 'big.bin', bytes: Buffer.alloc(5000) }])))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_PACKAGE_LIMIT_EXCEEDED' }))
    expect(() => read(buildZip(Array.from({ length: 9 }, (_value, index) => ({ name: `file-${index}.txt`, bytes: text('x') })))))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_PACKAGE_LIMIT_EXCEEDED' }))
    expect(() => readPluginZipArchive(buildZip([{ name: 'a.txt', bytes: text('12345678') }, { name: 'b.txt', bytes: text('12345678') }]), { limits: { maxFileCount: 8, maxFileBytes: 10, maxPackageBytes: 12 } }))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_PACKAGE_LIMIT_EXCEEDED' }))
  })

  it('refuses an invalid limit declaration', () => {
    expect(() => readPluginZipArchive(buildZip([]), { limits: { maxFileCount: 0, maxFileBytes: 10, maxPackageBytes: 10 } }))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_PACKAGE_LIMIT_INVALID' }))
    expect(() => readPluginZipArchive(buildZip([]), { limits: { maxFileCount: 1, maxFileBytes: 50, maxPackageBytes: 10 } }))
      .toThrowError(expect.objectContaining({ code: 'PLUGIN_PACKAGE_LIMIT_INVALID' }))
  })
})
