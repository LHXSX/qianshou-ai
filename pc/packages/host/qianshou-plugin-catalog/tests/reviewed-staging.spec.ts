import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdtemp, readFile, readdir, rm, stat, symlink, unlink } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { expect, it, vi } from 'vitest'
import { approvalPayload, releasePayload } from '../src/release-preview.ts'
import { stageReviewedPluginArchive } from '../src/reviewed-staging.ts'

const token = 'test-artifact-access-token-32-characters'
const publisher = generateKeyPairSync('ed25519')
const reviewer = generateKeyPairSync('ed25519')
const publisherKeys = { studio: publisher.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
const operatorKeys = { reviewer: reviewer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }

function zip(name = 'workflow.json', options: { deflate?: boolean; symlink?: boolean; badCrc?: boolean } = {}): Buffer {
  const filename = Buffer.from(name)
  const payload = Buffer.from('hello')
  const stored = options.deflate ? deflateRawSync(payload) : payload
  const crc = options.badCrc ? 0 : 0x3610a686 // CRC-32 of "hello"
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4)
  local.writeUInt16LE(0x800, 6); local.writeUInt16LE(options.deflate ? 8 : 0, 8)
  local.writeUInt32LE(crc, 14); local.writeUInt32LE(stored.length, 18)
  local.writeUInt32LE(payload.length, 22); local.writeUInt16LE(filename.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(0x0314, 4)
  central.writeUInt16LE(20, 6); central.writeUInt16LE(0x800, 8)
  central.writeUInt16LE(options.deflate ? 8 : 0, 10); central.writeUInt32LE(crc, 16)
  central.writeUInt32LE(stored.length, 20); central.writeUInt32LE(payload.length, 24)
  central.writeUInt16LE(filename.length, 28)
  central.writeUInt32LE(((options.symlink ? 0o120777 : 0o100644) << 16) >>> 0, 38)
  const middle = Buffer.concat([central, filename])
  const front = Buffer.concat([local, filename, stored])
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8)
  end.writeUInt16LE(1, 10); end.writeUInt32LE(middle.length, 12)
  end.writeUInt32LE(front.length, 16)
  return Buffer.concat([front, middle, end])
}

function signedRelease(archive: Buffer) {
  const release = {
    pluginId: 'qianshou.workflow', version: '1.0.0', releaseId: 'reviewed-workflow-1',
    title: 'Workflow', summary: 'Privately staged test workflow.',
    packageSha256: createHash('sha256').update(archive).digest('hex'), packageBytes: archive.length,
    platforms: ['darwin', 'win32', 'linux'], architectures: ['arm64', 'x64', 'ia32'],
    operations: [{ capabilityId: 'text.transform', operationId: 'run', executorKind: 'workflow',
      inputSchemaSha256: 'b'.repeat(64), outputSchemaSha256: 'c'.repeat(64), permissions: ['workspace.read'] }],
    publisher: { id: 'studio', signature: '' },
    approval: { reviewId: 'review-1', reviewedAt: 1_780_000_000_000, operatorId: 'reviewer', signature: '' },
    verificationScope: 'opaque-archive-bytes', installable: false,
  }
  release.publisher.signature = sign(null, Buffer.from(releasePayload(release as never)), publisher.privateKey).toString('base64')
  release.approval.signature = sign(null, Buffer.from(approvalPayload(release as never)), reviewer.privateKey).toString('base64')
  return release
}

async function fixture(archive: Buffer, run: (input: {
  base: string; stagingDir: string; release: ReturnType<typeof signedRelease>;
  control: { artifactStatus: number; artifactSha: string | null; archive: Buffer; redirect: boolean;
    interrupt: boolean; metadata: unknown;
    artifactRequests: number } }) => Promise<void>) {
  const stagingDir = await mkdtemp(join(tmpdir(), 'qianshou-stage-'))
  const release = signedRelease(archive)
  const control = { artifactStatus: 200, artifactSha: release.packageSha256 as string | null,
    archive, redirect: false, interrupt: false, metadata: { releases: [release] } as unknown, artifactRequests: 0 }
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== '/qianshou-market/releases') { response.writeHead(404).end(); return }
    if (url.searchParams.size === 0) {
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(control.metadata)); return
    }
    control.artifactRequests += 1
    if (control.redirect) { response.writeHead(302, { location: '/elsewhere' }).end(); return }
    if (request.headers.authorization !== `Bearer ${token}` || control.artifactStatus !== 200) {
      response.writeHead(control.artifactStatus === 200 ? 403 : control.artifactStatus).end(); return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream',
      'content-length': String(control.archive.length),
      'x-qianshou-package-sha256': control.artifactSha ?? '' })
    if (control.interrupt) {
      response.write(control.archive.subarray(0, Math.floor(control.archive.length / 2)))
      setTimeout(() => response.destroy(), 10)
    } else response.end(control.archive)
  })
  await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('server failed')
  try { await run({ base: `http://127.0.0.1:${address.port}/`, stagingDir, release, control }) }
  finally {
    server.closeAllConnections()
    await new Promise<void>(resolve => { server.close(() => resolve()) })
    await rm(stagingDir, { recursive: true, force: true })
  }
}

function request(base: string, stagingDir: string) {
  return { apiBaseUrl: base, stagingDir, releaseId: 'reviewed-workflow-1',
    publisherKeys, operatorKeys, artifactAccessToken: token, timeoutMs: 5000 }
}

it('privately stages one matching archive, verifies deflated entry content, and never installs it', async () => {
  const archive = zip('flows/recipe.json', { deflate: true })
  await fixture(archive, async ({ base, stagingDir }) => {
    const result = await stageReviewedPluginArchive(request(base, stagingDir))
    expect(result.installable).toBe(false)
    expect(result.entries).toEqual([{ path: 'flows/recipe.json', bytes: 5,
      compressedBytes: deflateRawSync(Buffer.from('hello')).length,
      sha256: createHash('sha256').update('hello').digest('hex') }])
    expect(await readFile(result.archivePath)).toEqual(archive)
    expect((await stat(result.archivePath)).mode & 0o777).toBe(0o600)
    expect(await readdir(stagingDir)).toEqual([result.archivePath.split('/').at(-1)])
  })
})

it('refuses untrusted metadata before requesting any archive', async () => {
  await fixture(zip(), async ({ base, stagingDir, release, control }) => {
    control.metadata = { releases: [{ ...release, title: 'tampered' }] }
    await expect(stageReviewedPluginArchive(request(base, stagingDir))).rejects.toThrow()
    expect(control.artifactRequests).toBe(0)
    expect(await readdir(stagingDir)).toEqual([])
  })
})

it('rejects artifact authorization, redirects, digest headers and body changes without leaving a file', async () => {
  for (const kind of ['forbidden', 'redirect', 'header', 'body'] as const) {
    await fixture(zip(), async ({ base, stagingDir, control }) => {
      if (kind === 'forbidden') control.artifactStatus = 403
      if (kind === 'redirect') control.redirect = true
      if (kind === 'header') control.artifactSha = '0'.repeat(64)
      if (kind === 'body') control.archive = zip('another.json')
      await expect(stageReviewedPluginArchive(request(base, stagingDir))).rejects.toThrow()
      expect(await readdir(stagingDir)).toEqual([])
    })
  }
})

it('rejects path traversal, links and corrupt entry content after signed-byte verification', async () => {
  for (const archive of [zip('../escape'), zip('workflow.json', { symlink: true }),
    zip('workflow.json', { badCrc: true }), Buffer.from('not a zip')]) {
    await fixture(archive, async ({ base, stagingDir }) => {
      await expect(stageReviewedPluginArchive(request(base, stagingDir))).rejects.toThrow()
      expect(await readdir(stagingDir)).toEqual([])
    })
  }
})

it('removes partial files after network interruption and refuses public or linked staging directories', async () => {
  await fixture(zip(), async ({ base, stagingDir, control }) => {
    control.interrupt = true
    await expect(stageReviewedPluginArchive(request(base, stagingDir))).rejects.toThrow()
    expect(await readdir(stagingDir)).toEqual([])
    control.interrupt = false
    await chmod(stagingDir, 0o755)
    await expect(stageReviewedPluginArchive(request(base, stagingDir))).rejects.toThrow()
    expect(await readdir(stagingDir)).toEqual([])
    await chmod(stagingDir, 0o700)
    const link = `${stagingDir}-link`
    await symlink(stagingDir, link)
    try { await expect(stageReviewedPluginArchive(request(base, link))).rejects.toThrow() }
    finally { await unlink(link) }
    expect(await readdir(stagingDir)).toEqual([])
  })
})

it('bounds an oversized response chunk before writing it to the private file', async () => {
  const archive = zip()
  await fixture(archive, async ({ base, stagingDir, release }) => {
    const ordinaryFetch = globalThis.fetch
    const mocked = vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      if (!new URL(String(input)).searchParams.has('artifact')) return ordinaryFetch(input, init)
      return new Response(Buffer.concat([archive, Buffer.from('extra bytes')]), {
        status: 200, headers: { 'content-type': 'application/octet-stream',
          'content-length': String(release.packageBytes),
          'x-qianshou-package-sha256': release.packageSha256 },
      })
    })
    try {
      await expect(stageReviewedPluginArchive(request(base, stagingDir))).rejects.toThrow()
      expect(await readdir(stagingDir)).toEqual([])
    } finally { mocked.mockRestore() }
  })
})
