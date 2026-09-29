import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { CompanionDownloads, type CompanionRelease } from '../src/downloads.ts'
const roots: string[] = []
const owners: CompanionDownloads[] = []
afterEach(async () => {
  for (const owner of owners.splice(0)) owner.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture(bytes = Buffer.from('PK-test-release')) {
  const root = await mkdtemp(join(tmpdir(), 'companion-download-')); roots.push(root)
  const item: CompanionRelease = { id: 'darwin-arm64', version: '0.1.0', filename: 'qianshou-companion-0.1.0-darwin-arm64.zip',
    bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), validation: 'local-mac-verified' }
  await writeFile(join(root, item.filename), bytes)
  await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, releases: [item] }))
  const owner = new CompanionDownloads(root); owners.push(owner)
  return { owner, root, item, bytes }
}
describe('verified companion downloads', () => {
  it('lists only fixed public metadata and streams the exact bytes as an attachment', async () => {
    const { owner, item, bytes, root } = await fixture()
    const catalog = await owner.catalog()
    expect(catalog).toEqual({ releases: [{ ...item, href: '/api/qianshou/companion-downloads/darwin-arm64' }], unavailable: [] })
    expect(JSON.stringify(catalog)).not.toContain(root)
    const response = await owner.download(item.id, new AbortController().signal)
    expect(response.headers.get('content-disposition')).toContain(item.filename)
    expect(response.headers.get('cache-control')).toContain('private')
    expect(response.headers.get('x-archive-sha256')).toBe(item.sha256)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes)
  })
  it('reports a missing manifest or platform without inventing a link', async () => {
    const { owner, root } = await fixture()
    expect((await owner.download('linux-x64', new AbortController().signal)).status).toBe(404)
    await rm(join(root, 'manifest.json'))
    expect(await owner.catalog()).toEqual({ releases: [], unavailable: [] })
  })
  it('invalidates checksum cache when a staged archive changes', async () => {
    const { owner, root, item } = await fixture()
    expect((await owner.catalog()).releases).toHaveLength(1)
    await writeFile(join(root, item.filename), Buffer.alloc(item.bytes, 1))
    expect(await owner.catalog()).toEqual({ releases: [], unavailable: ['darwin-arm64'] })
    await expect(owner.download(item.id, new AbortController().signal)).rejects.toThrow('CHECKSUM')
  })
  it('rejects path traversal and duplicate platforms in the trusted manifest boundary', async () => {
    const { owner, root, item } = await fixture()
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, releases: [{ ...item, filename: '../private.zip' }] }))
    await expect(owner.catalog()).rejects.toThrow('INVALID_RELEASE_MANIFEST')
    await writeFile(join(root, 'manifest.json'), JSON.stringify({ version: 1, releases: [item, item] }))
    await expect(owner.catalog()).rejects.toThrow('INVALID_RELEASE_MANIFEST')
  })
  it.skipIf(process.platform === 'win32')('refuses symlink archives', async () => {
    const { owner, root, item, bytes } = await fixture()
    await rm(join(root, item.filename)); await writeFile(join(root, 'private'), bytes)
    await symlink(join(root, 'private'), join(root, item.filename))
    expect((await owner.catalog()).releases).toHaveLength(0)
  })
  it('does not start a stream after cancellation or disposal', async () => {
    const { owner, item } = await fixture()
    const abort = new AbortController(); abort.abort()
    await expect(owner.download(item.id, abort.signal)).rejects.toThrow('CANCELLED')
    owner.dispose()
    await expect(owner.download(item.id, new AbortController().signal)).rejects.toThrow('CANCELLED')
  })
  it('supports response-body cancellation without buffering the entire file', async () => {
    const { owner, item } = await fixture(Buffer.alloc(4 * 1024 * 1024, 2))
    const response = await owner.download(item.id, new AbortController().signal)
    const reader = response.body?.getReader()
    expect(reader).toBeDefined()
    const first = await reader?.read()
    expect(first?.value?.length).toBeLessThan(item.bytes)
    await reader?.cancel()
  })
})
