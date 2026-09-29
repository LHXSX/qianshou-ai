import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { preparePrivateComfyDraftAsset } from '@deepseek-ai/dsh-compute-core/src/comfy-draft-asset.ts'
import { ComputeExecutorRegistry } from '@deepseek-ai/dsh-compute-core/src/executor.ts'
import { approvalPayload, releasePayload } from '../src/release-preview.ts'
import { inspectReviewedArchive } from '../src/reviewed-archive.ts'
import type { ReviewedStageResult } from '../src/reviewed-staging.ts'
import { activatePrivateComfyInstallCandidate, preparePrivateComfyInstallCandidate,
  privateComfyInstallIdentitySha256 } from '../src/private-comfy-install.ts'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })

const publisher = generateKeyPairSync('ed25519')
const reviewer = generateKeyPairSync('ed25519')
const publisherKeys = { studio: publisher.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
const operatorKeys = { reviewer: reviewer.publicKey.export({ format: 'der', type: 'spki' }).toString('base64') }
const graph = {
  '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: 'private.gguf' } },
  '2': { class_type: 'CLIPTextEncode', inputs: { text: 'private prompt', model: ['1', 0] } },
  '3': { class_type: 'SaveImage', inputs: { images: ['2', 0], filename_prefix: 'qianshou' } },
}
const mapping = { prompt: { nodeId: '2', field: 'text' }, outputNodeId: '3' }
const operationId = 'owner.comfy.image'
const sha = (value: Buffer | string) => createHash('sha256').update(value).digest('hex')

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) crc = (crc & 1) ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
  }
  return (crc ^ 0xffffffff) >>> 0
}

function zip(files: Readonly<Record<string, Buffer>>): Buffer {
  const locals: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (const [name, bytes] of Object.entries(files)) {
    const filename = Buffer.from(name)
    const crc = crc32(bytes)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x800, 6); local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(bytes.length, 18); local.writeUInt32LE(bytes.length, 22)
    local.writeUInt16LE(filename.length, 26)
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0); header.writeUInt16LE(0x0314, 4)
    header.writeUInt16LE(20, 6); header.writeUInt16LE(0x800, 8)
    header.writeUInt32LE(crc, 16); header.writeUInt32LE(bytes.length, 20)
    header.writeUInt32LE(bytes.length, 24); header.writeUInt16LE(filename.length, 28)
    header.writeUInt32LE((0o100600 << 16) >>> 0, 38); header.writeUInt32LE(offset, 42)
    const part = Buffer.concat([local, filename, bytes])
    locals.push(part); central.push(Buffer.concat([header, filename])); offset += part.length
  }
  const middle = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length, 8)
  end.writeUInt16LE(central.length, 10); end.writeUInt32LE(middle.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, middle, end])
}

async function setup(manifestPatch: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-comfy-install-'))
  roots.push(root)
  const recordDir = join(root, 'activation')
  await mkdir(recordDir, { mode: 0o700 })
  const asset = preparePrivateComfyDraftAsset({ operationId, workflow: graph, mapping })
  const manifest = { format: 'qianshou.comfy-private-package.v1', releaseId: 'comfy-r1',
    pluginId: 'qianshou.comfy', version: '1.0.0', operationId,
    capabilityId: 'comfy.private.sample', executorVersion: '1.0.0',
    inputSchemaSha256: 'b'.repeat(64), outputSchemaSha256: 'c'.repeat(64),
    graphSha256: asset.graphSha256, mapping, ...manifestPatch }
  const archive = zip({ 'manifest.json': Buffer.from(JSON.stringify(manifest)),
    'comfy/workflow-api.json': Buffer.from(JSON.stringify(graph)) })
  const archivePath = join(root, 'reviewed.qspkg')
  await writeFile(archivePath, archive, { mode: 0o600 })
  await chmod(archivePath, 0o600)
  const release = {
    pluginId: 'qianshou.comfy', version: '1.0.0', releaseId: 'comfy-r1',
    title: 'Private Comfy', summary: 'Internal review only.',
    packageSha256: sha(archive), packageBytes: archive.length,
    platforms: [process.platform], architectures: [process.arch],
    operations: [{ capabilityId: 'comfy.private.sample', operationId, executorKind: 'workflow',
      inputSchemaSha256: 'b'.repeat(64), outputSchemaSha256: 'c'.repeat(64),
      permissions: ['model.local', 'gpu'] }],
    publisher: { id: 'studio', signature: '' },
    approval: { reviewId: 'review-1', reviewedAt: 1_780_000_000_000,
      operatorId: 'reviewer', signature: '' },
    verificationScope: 'opaque-archive-bytes', installable: false,
  }
  release.publisher.signature = sign(null, Buffer.from(releasePayload(release as never)), publisher.privateKey).toString('base64')
  release.approval.signature = sign(null, Buffer.from(approvalPayload(release as never)), reviewer.privateKey).toString('base64')
  const stage: ReviewedStageResult = { archivePath, releaseId: release.releaseId,
    pluginId: release.pluginId, version: release.version,
    packageSha256: release.packageSha256, packageBytes: release.packageBytes,
    signedRelease: release as never,
    entries: await inspectReviewedArchive(archivePath, archive.length, new AbortController().signal),
    installable: false }
  const request = { stage, operationId, publisherKeys, operatorKeys, signal: new AbortController().signal }
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const name = String(input).split('/').at(-1)!
    return new Response(JSON.stringify({ [name]: { input: { required: name === 'UnetLoaderGGUF'
      ? { unet_name: [['private.gguf']] } : {} } } }),
    { headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return { request, recordDir, archivePath, fetcher }
}

it('makes an immutable six-field review identity without publishing or exposing graph bytes', async () => {
  const { request, recordDir } = await setup()
  const candidate = await preparePrivateComfyInstallCandidate(request)
  expect(candidate.identity).toEqual({ releaseId: 'comfy-r1', operationId,
    packageSha256: request.stage.packageSha256,
    manifestSha256: request.stage.entries.find(item => item.path === 'manifest.json')?.sha256,
    graphSha256: preparePrivateComfyDraftAsset({ operationId, workflow: graph, mapping }).graphSha256,
    executorVersion: '1.0.0' })
  expect(candidate.identitySha256).toBe(privateComfyInstallIdentitySha256(candidate.identity))
  expect(candidate).toMatchObject({ state: 'private-review-only', installable: false, dispatchable: false })
  expect(JSON.stringify(candidate)).not.toMatch(/private\.gguf|private prompt/u)
  expect(await readdir(recordDir)).toEqual([])
})

it('refuses a mismatched graph or tampered signed declaration before any activation', async () => {
  const wrong = await setup({ graphSha256: '0'.repeat(64) })
  await expect(preparePrivateComfyInstallCandidate(wrong.request)).rejects.toThrow()
  expect(await readdir(wrong.recordDir)).toEqual([])
  const changed = await setup()
  changed.request.stage.signedRelease.title = 'tampered'
  await expect(preparePrivateComfyInstallCandidate(changed.request)).rejects.toThrow()
  expect(await readdir(changed.recordDir)).toEqual([])
})

it('denies missing license and owner approval with zero loader calls, network or record writes', async () => {
  const { request, recordDir, fetcher } = await setup()
  const candidate = await preparePrivateComfyInstallCandidate(request)
  await expect(activatePrivateComfyInstallCandidate({ ...request, candidate, privateRecordDir: recordDir,
    port: 8188, fetcher })).rejects.toThrow()
  const loadBoundExecutor = vi.fn()
  await expect(activatePrivateComfyInstallCandidate({ ...request, candidate,
    privateRecordDir: recordDir, port: 8188, fetcher,
    gates: { verifyLicense: async () => false, approveOwner: async () => true,
      loadBoundExecutor } })).rejects.toThrow()
  await expect(activatePrivateComfyInstallCandidate({ ...request, candidate,
    privateRecordDir: recordDir, port: 8188, fetcher,
    gates: { verifyLicense: async () => true, approveOwner: async () => false,
      loadBoundExecutor } })).rejects.toThrow()
  expect(loadBoundExecutor).not.toHaveBeenCalled()
  expect(fetcher).not.toHaveBeenCalled()
  expect(await readdir(recordDir)).toEqual([])
})

it('fails closed on unavailable model or unbound executor and leaves no activation receipt', async () => {
  const { request, recordDir, fetcher } = await setup()
  const candidate = await preparePrivateComfyInstallCandidate(request)
  const dispose = vi.fn(async () => undefined)
  const loadBoundExecutor = vi.fn(async () => ({ identitySha256: '0'.repeat(64),
    executors: new ComputeExecutorRegistry(), dispose }))
  const gates = { verifyLicense: async () => true, approveOwner: async () => true, loadBoundExecutor }
  const unavailable = vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })) as typeof fetch
  await expect(activatePrivateComfyInstallCandidate({ ...request, candidate,
    privateRecordDir: recordDir, port: 8188, fetcher: unavailable, gates })).rejects.toThrow()
  expect(loadBoundExecutor).not.toHaveBeenCalled()
  await expect(activatePrivateComfyInstallCandidate({ ...request, candidate,
    privateRecordDir: recordDir, port: 8188, fetcher, gates })).rejects.toThrow()
  expect(dispose).toHaveBeenCalledOnce()
  expect(await readdir(recordDir)).toEqual([])
})

it('writes only a private, non-dispatchable receipt after live graph and exact executor preflight', async () => {
  const { request, recordDir, fetcher } = await setup()
  const candidate = await preparePrivateComfyInstallCandidate(request)
  const registry = new ComputeExecutorRegistry()
  registry.register({ capabilityId: 'comfy.private.sample' as never, version: '1.0.0',
    async execute() { return { outputs: [] } } })
  const dispose = vi.fn(async () => undefined)
  const gates = { verifyLicense: async () => true, approveOwner: async () => true,
    loadBoundExecutor: async () => ({ identitySha256: candidate.identitySha256,
      executors: registry, dispose }) }
  const activated = await activatePrivateComfyInstallCandidate({ ...request, candidate,
    privateRecordDir: recordDir, port: 8188, fetcher, gates })
  const receipt = JSON.parse(await readFile(activated.recordPath, 'utf8')) as Record<string, unknown>
  expect(receipt).toMatchObject({ format: 'qianshou.comfy-private-activation.v1',
    identitySha256: candidate.identitySha256, installable: false, dispatchable: false })
  expect(await readdir(recordDir)).toEqual([`${candidate.identitySha256}.json`])
  await expect(activatePrivateComfyInstallCandidate({ ...request, candidate,
    privateRecordDir: recordDir, port: 8188, fetcher, gates })).rejects.toThrow()
  expect(await readdir(recordDir)).toEqual([`${candidate.identitySha256}.json`])
  await activated.dispose()
})
