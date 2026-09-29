import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { inspectOrderProductSourceArchive } from '../src/order-product-source-archive.ts'
import { stageVerifiedOrderAdapterSource } from '../src/order-product-source-stage.ts'
import type { VerifiedOrderAdapterSource } from '../src/order-products-http.ts'

const names = ['package.json', 'pnpm-lock.yaml', 'local-adapter.json',
  'src/adapter.mjs', 'src/assemble_gif.py', 'src/encode_frames.swift']
const sha = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? value >>> 1 ^ 0xedb88320 : value >>> 1
  return value >>> 0
})
function crc(bytes: Buffer): number {
  let value = 0xffffffff
  for (const byte of bytes) value = value >>> 8 ^ crcTable[(value ^ byte) & 255]!
  return (value ^ 0xffffffff) >>> 0
}

function archiveFixture(paths = names, inventoryAlgorithm:
  'qianshou.bar-chart-package.v4' | 'qianshou.source-package.v1' = 'qianshou.bar-chart-package.v4') {
  const contents = paths.map(name => Buffer.from(`reviewed:${name}\n`))
  const locals: Buffer[] = []
  const central: Buffer[] = []
  const aggregate = createHash('sha256')
  let offset = 0
  for (let index = 0; index < paths.length; index += 1) {
    const name = paths[index]!
    const data = contents[index]!
    const filename = Buffer.from(name)
    const checksum = crc(data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(33, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(filename.length, 26)
    locals.push(local, filename, data)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(0x0314, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt16LE(33, 14)
    entry.writeUInt32LE(checksum, 16)
    entry.writeUInt32LE(data.length, 20)
    entry.writeUInt32LE(data.length, 24)
    entry.writeUInt16LE(filename.length, 28)
    entry.writeUInt32LE((0o100644 << 16) >>> 0, 38)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, filename)
    offset += local.length + filename.length + data.length
    aggregate.update(name).update('\0').update(String(data.length)).update('\0').update(data)
  }
  const centralBytes = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(paths.length, 8)
  end.writeUInt16LE(paths.length, 10)
  end.writeUInt32LE(centralBytes.length, 12)
  end.writeUInt32LE(offset, 16)
  const bytes = Buffer.concat([...locals, centralBytes, end])
  const source = {
    taskType: 'bar_chart_svg_v1', capabilityId: 'video.render',
    check: { productId: 'product', entitlementId: 'entitlement', publicationId: 'publication',
      archiveDigest: `sha256:${sha(bytes)}`, archiveSizeBytes: bytes.length,
      archiveVersionId: 'version-1', archiveFormat: 'zip-source-v1',
      signatureVerified: true, packageReceiptVerified: true, deviceInstalled: false,
      nextStep: 'archive-download-and-device-verification-required' },
    artifactDigest: `sha256:${aggregate.digest('hex')}`,
    inventoryAlgorithm,
    archiveBucket: 'test-evidence-1463872884',
    reviewedSellerRuntimeDigest: `sha256:${'b'.repeat(64)}`,
    downloadUrl: 'https://archive.example/a.zip?versionId=version-1',
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    files: paths.map((path, index) => ({ path, sizeBytes: contents[index]!.length,
      sha256: sha(contents[index]!) })),
  } as VerifiedOrderAdapterSource
  return { bytes, source }
}

it('extracts only the six exact reviewed files and recomputes the signed source digest', () => {
  const { bytes, source } = archiveFixture()
  const found = inspectOrderProductSourceArchive(bytes, source)
  expect([...found.files.keys()]).toEqual(names)
  expect(found.artifactDigest).toBe(source.artifactDigest)
})

it('accepts the real Python zipfile layout used by the package author tool on Mac', () => {
  if (process.platform !== 'darwin') return
  const script = `import io, stat, sys, zipfile
names = ['package.json', 'pnpm-lock.yaml', 'local-adapter.json',
 'src/adapter.mjs', 'src/assemble_gif.py', 'src/encode_frames.swift']
output = io.BytesIO()
with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_STORED, allowZip64=False) as archive:
 for name in names:
  info = zipfile.ZipInfo(name, date_time=(1980, 1, 1, 0, 0, 0))
  info.create_system = 3
  info.external_attr = (stat.S_IFREG | 0o644) << 16
  info.compress_type = zipfile.ZIP_STORED
  archive.writestr(info, ('reviewed:' + name + '\\n').encode())
sys.stdout.buffer.write(output.getvalue())`
  const built = spawnSync('/usr/bin/python3', ['-c', script], { maxBuffer: 16 * 1024 * 1024 })
  expect(built.status).toBe(0)
  const bytes = built.stdout
  const source = archiveFixture().source
  source.check = { ...source.check, archiveDigest: `sha256:${sha(bytes)}`,
    archiveSizeBytes: bytes.length }
  expect(inspectOrderProductSourceArchive(bytes, source).artifactDigest).toBe(source.artifactDigest)
})

it('rejects a different object version, a changed byte and an ambiguous extra ZIP member', () => {
  const { bytes, source } = archiveFixture()
  expect(() => inspectOrderProductSourceArchive(bytes, {
    ...source, check: { ...source.check, archiveDigest: `sha256:${'a'.repeat(64)}` },
  })).toThrow('order-install-manifest-invalid')
  const changed = Buffer.from(bytes)
  const changedAt = changed.indexOf(Buffer.from('reviewed:'))
  expect(changedAt).toBeGreaterThanOrEqual(0)
  changed[changedAt] = changed[changedAt]! ^ 1
  expect(() => inspectOrderProductSourceArchive(changed, source)).toThrow('order-install-manifest-invalid')
  const extra = Buffer.concat([bytes, Buffer.from('extra')])
  expect(() => inspectOrderProductSourceArchive(extra, {
    ...source, check: { ...source.check, archiveDigest: `sha256:${sha(extra)}`,
      archiveSizeBytes: extra.length },
  })).toThrow('order-install-manifest-invalid')
})

it('pins the archive host, quarantines exact bytes, and stays unavailable to chat and orders', async () => {
  const { bytes, source } = archiveFixture()
  const home = await mkdtemp(join(tmpdir(), 'order-buyer-stage-'))
  const send = vi.fn(async (_input: Parameters<typeof fetch>[0], _init?: Parameters<typeof fetch>[1]) => new Response(bytes, { status: 200,
    headers: { 'content-length': String(bytes.length) } }))
  try {
    await expect(stageVerifiedOrderAdapterSource(source, { home,
      trustedArchiveHostname: '', fetch: send as typeof fetch }))
      .rejects.toThrow('order-install-not-ready')
    await expect(stageVerifiedOrderAdapterSource({ ...source,
      downloadUrl: source.downloadUrl + '&versionId=wrong' }, { home,
      trustedArchiveHostname: 'archive.example', fetch: send as typeof fetch }))
      .rejects.toThrow('order-install-not-ready')
    expect(await readdir(home)).toEqual([])
    const staged = await stageVerifiedOrderAdapterSource(source, { home,
      trustedArchiveHostname: 'archive.example', fetch: send as typeof fetch })
    expect(staged).toMatchObject({ sourceVerified: true, deviceInstalled: false,
      chatAvailable: false, orderAvailable: false,
      nextStep: 'independent-device-install-attestation-required' })
    expect(JSON.stringify(staged)).not.toContain('archive.example')
    const target = join(home, 'qianshou', 'order-adapter-quarantine', 'product', 'entitlement',
      sha(Buffer.from('version-1')))
    expect(await readFile(join(target, 'src', 'adapter.mjs'), 'utf8'))
      .toBe('reviewed:src/adapter.mjs\n')
    expect(await readdir(target)).toHaveLength(5)
    await stageVerifiedOrderAdapterSource(source, { home,
      trustedArchiveHostname: 'archive.example', fetch: send as typeof fetch })
    expect(send).toHaveBeenCalledTimes(1)
    expect(send.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', credentials: 'omit' })
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('derives only the exact COS host of the independently signed archive bucket', async () => {
  const { bytes, source } = archiveFixture()
  const home = await mkdtemp(join(tmpdir(), 'order-buyer-cos-'))
  const send = vi.fn(async () => new Response(bytes, { status: 200 }))
  try {
    const cosSource = { ...source,
      downloadUrl: `https://${source.archiveBucket}.cos.ap-shanghai.myqcloud.com/a.zip?versionId=version-1` }
    await expect(stageVerifiedOrderAdapterSource(cosSource, { home,
      trustedArchiveHostname: '', fetch: send as typeof fetch })).resolves.toMatchObject({ sourceVerified: true })
    expect(send).toHaveBeenCalledTimes(1)
    const changedHost = { ...cosSource,
      downloadUrl: 'https://attacker.cos.ap-shanghai.myqcloud.com/a.zip?versionId=version-1' }
    await expect(stageVerifiedOrderAdapterSource(changedHost, { home,
      trustedArchiveHostname: '', fetch: send as typeof fetch })).rejects.toThrow('order-install-not-ready')
    expect(send).toHaveBeenCalledTimes(1)
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('leaves no installable source when the downloaded object fails its signed digest', async () => {
  const { bytes, source } = archiveFixture()
  const home = await mkdtemp(join(tmpdir(), 'order-buyer-reject-'))
  const corrupt = Buffer.from(bytes)
  corrupt[50] = corrupt[50]! ^ 1
  try {
    await expect(stageVerifiedOrderAdapterSource(source, { home,
      trustedArchiveHostname: 'archive.example',
      fetch: async () => new Response(corrupt, { status: 200 }) }))
      .rejects.toThrow('order-install-manifest-invalid')
    const base = join(home, 'qianshou', 'order-adapter-quarantine', 'product', 'entitlement')
    expect(await readdir(base)).toEqual([])
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('verifies and quarantines a sorted non-video source package with nested files', async () => {
  const paths = ['local-adapter.json', 'package.json', 'pnpm-lock.yaml',
    'src/adapter.mjs', 'src/lib/validator.mjs', 'tests/cases.json']
  const { bytes, source } = archiveFixture(paths, 'qianshou.source-package.v1')
  expect([...inspectOrderProductSourceArchive(bytes, source).files.keys()]).toEqual(paths)
  const home = await mkdtemp(join(tmpdir(), 'order-generic-stage-'))
  const send = vi.fn(async () => new Response(bytes, { status: 200 }))
  try {
    const result = await stageVerifiedOrderAdapterSource(source, { home,
      trustedArchiveHostname: 'archive.example', fetch: send as typeof fetch })
    expect(result).toMatchObject({ sourceVerified: true, deviceInstalled: false,
      chatAvailable: false, orderAvailable: false })
    const target = join(home, 'qianshou', 'order-adapter-quarantine', 'product', 'entitlement',
      sha(Buffer.from('version-1')))
    expect(await readFile(join(target, 'src/lib/validator.mjs'), 'utf8'))
      .toBe('reviewed:src/lib/validator.mjs\n')
    expect(await readdir(join(target, 'src'))).toEqual(['adapter.mjs', 'lib'])
    await stageVerifiedOrderAdapterSource(source, { home,
      trustedArchiveHostname: 'archive.example', fetch: send as typeof fetch })
    expect(send).toHaveBeenCalledTimes(1)
    await writeFile(join(target, 'src/lib/unreviewed.mjs'), 'unreviewed')
    await expect(stageVerifiedOrderAdapterSource(source, { home,
      trustedArchiveHostname: 'archive.example', fetch: send as typeof fetch }))
      .rejects.toThrow('order-install-not-ready')
  } finally { await rm(home, { recursive: true, force: true }) }
})

it('rejects path traversal, absent entry points, duplicate or unsorted source members', () => {
  const paths = ['local-adapter.json', 'package.json', 'pnpm-lock.yaml', 'src/adapter.mjs']
  const { bytes, source } = archiveFixture(paths, 'qianshou.source-package.v1')
  const variants = [
    ['../escape', ...paths.slice(1)],
    ['local-adapter.json', 'package.json', 'pnpm-lock.yaml', 'src/else.mjs'],
    ['package.json', 'local-adapter.json', 'pnpm-lock.yaml', 'src/adapter.mjs'],
    ['local-adapter.json', 'local-adapter.json', 'pnpm-lock.yaml', 'src/adapter.mjs'],
  ]
  for (const variant of variants) {
    expect(() => inspectOrderProductSourceArchive(bytes, { ...source,
      files: source.files.map((row, index) => ({ ...row, path: variant[index]! })) }))
      .toThrow('order-install-manifest-invalid')
  }
  const centralStart = bytes.readUInt32LE(bytes.length - 22 + 16)
  const symlink = Buffer.from(bytes)
  symlink.writeUInt32LE((0o120777 << 16) >>> 0, centralStart + 38)
  expect(() => inspectOrderProductSourceArchive(symlink, {
    ...source, check: { ...source.check, archiveDigest: `sha256:${sha(symlink)}` },
  })).toThrow('order-install-manifest-invalid')
})
