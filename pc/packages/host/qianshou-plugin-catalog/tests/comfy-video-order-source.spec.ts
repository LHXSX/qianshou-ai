import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { COMFY_VIDEO_RUNNER_ABI, comfyVideoPublicContractDigest,
  summarizeComfyVideoApiGraph } from '@deepseek-ai/dsh-compute-core/src/comfy-video-public-contract.ts'
import { buildCanonicalOrderArchive } from '../src/order-source-archive.ts'
import { comfyVideoAuthoringTemplate, readComfyVideoOrderSource } from '../src/comfy-video-order-source.ts'
import { COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM } from '../src/order-source-inventory.ts'
import { prepareRegisteredOrderAdapter } from '../src/registered-order-adapters.ts'
import { installReviewedComfyVideoSource } from '../src/comfy-video-source-install.ts'
import type { VerifiedOrderAdapterSource } from '../src/order-products-http.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

function contract() {
  const graph = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'private prompt' } },
    '2': { class_type: 'LoadImage', inputs: { image: 'private-frame.png' } },
    '3': { class_type: 'VHS_VideoCombine', inputs: { images: ['1', 0], format: 'video/h264-mp4', fps: 24 } },
    '4': { class_type: 'MiniMaxH3ImageToVideo', inputs: { length: 120 } } }
  return { schema: 'qianshou.comfy-video-public-contract.v1', taskType: 'reviewed_video_five_v1',
    capabilityId: 'video.render', graph: { format: 'comfyui-api', ...summarizeComfyVideoApiGraph(graph) },
    inputSlots: [{ name: 'prompt', kind: 'text', nodeId: '1', field: 'text', maxUtf8Bytes: 4096 },
      { name: 'first_frame', kind: 'artifact_ref', nodeId: '2', field: 'image', mimeType: 'image/png',
        maxBytes: 16 * 1024 * 1024 },
      { name: 'frames', kind: 'integer', nodeId: '4', field: 'length', min: 120, max: 120 },
      { name: 'fps', kind: 'integer', nodeId: '3', field: 'fps', min: 24, max: 24 }],
    outputs: [{ nodeId: '3', classType: 'VHS_VideoCombine', kind: 'artifact_ref', mimeType: 'video/mp4' }],
    runner: { abi: COMFY_VIDEO_RUNNER_ABI, sourceSha256: 'a'.repeat(64) },
    dependencyManifestSha256: 'b'.repeat(64), limits: { maxDurationSeconds: 5,
      maxFrames: 120, maxWidth: 1344, maxHeight: 768, maxVramMiB: 16384,
      maxInputBytes: 17 * 1024 * 1024, maxOutputBytes: 64 * 1024 * 1024, timeoutSeconds: 600 } }
}

async function source() {
  const root = await mkdtemp(join(tmpdir(), 'qs-comfy-source-'))
  roots.push(root)
  const files = comfyVideoAuthoringTemplate(contract(), `sha256:${'c'.repeat(64)}`, 'five-second-video').files
  for (const [name, content] of Object.entries(files)) {
    const path = join(root, name)
    await mkdir(join(path, '..'), { recursive: true })
    await writeFile(path, content)
  }
  return { root, skill: join(root, 'SKILL.md') }
}

describe('reviewed five-second Comfy source', () => {
  it('exports exact public metadata and a byte-bound archive without private workflow contents', async () => {
    const fixture = await source()
    const loaded = await readComfyVideoOrderSource(fixture.skill)
    expect(loaded.taskDefinition.inputKinds).toEqual(['multi_file'])
    expect(loaded.taskDefinition.inputSchema).toEqual({})
    expect(Object.keys(loaded.taskDefinition)).toHaveLength(11)
    expect(loaded.taskDefinition.paramsSchema).toMatchObject({ properties: {
      frames: { minimum: 120, maximum: 120 }, fps: { minimum: 24, maximum: 24 } },
      required: ['fps', 'frames', 'input_manifest', 'prompt'] })
    expect(loaded.declaration.approvedContractDigest)
      .toBe(comfyVideoPublicContractDigest(loaded.taskDefinition.publicContract))
    const exported = await buildCanonicalOrderArchive(loaded.root, `sha256:${loaded.digest}`,
      COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM)
    expect(exported.inventoryAlgorithm).toBe(COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM)
    expect(exported.files.map(file => file.path)).toEqual([
      'local-adapter.json', 'package.json', 'pnpm-lock.yaml', 'task-definition.json'])
    expect(exported.bytes.toString('utf8')).not.toContain('private prompt')
    expect(exported.bytes.toString('utf8')).not.toContain('private-frame.png')
    const prepared = await prepareRegisteredOrderAdapter(fixture.skill)
    expect(prepared.taskDefinitionSha256).toBe(`sha256:${createHash('sha256')
      .update(await readFile(join(loaded.root, 'task-definition.json'))).digest('hex')}`)
    await expect(prepared.verifyLocal(undefined)).rejects.toMatchObject({ code: 'order-node-contributor-unavailable' })
    await expect(prepared.verifyLocal({ selectReviewedComfyVideoAuthorBinding: async () => ({
      taskType: loaded.declaration.taskType, artifactDigest: `sha256:${loaded.digest}`,
      packageDigest: loaded.declaration.packageDigest,
      inventoryAlgorithm: COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM, localVerified: true,
      platformReady: true,
    }) })).rejects.toMatchObject({ code: 'order-local-verification-failed' })
  })

  it('rejects changed metadata, an executable member and a symlinked declaration', async () => {
    const fixture = await source()
    const path = join(fixture.root, 'scripts', 'order_adapter', 'task-definition.json')
    const definition = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    await writeFile(path, JSON.stringify({ ...definition, inputKinds: ['inline'] }))
    await expect(readComfyVideoOrderSource(fixture.skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
    await writeFile(path, comfyVideoAuthoringTemplate(contract(), `sha256:${'c'.repeat(64)}`,
      'five-second-video').files['scripts/order_adapter/task-definition.json']!)
    await writeFile(join(fixture.root, 'scripts', 'order_adapter', 'run.py'), 'print(1)')
    await expect(readComfyVideoOrderSource(fixture.skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
    await rm(join(fixture.root, 'scripts', 'order_adapter', 'run.py'))
    const declaration = join(fixture.root, 'scripts', 'order_adapter', 'local-adapter.json')
    const contents = await readFile(declaration)
    await rm(declaration)
    const alternate = join(fixture.root, 'declaration.json')
    await writeFile(alternate, contents)
    await symlink(alternate, declaration)
    await expect(readComfyVideoOrderSource(fixture.skill)).rejects.toMatchObject({ code: 'order-adapter-invalid' })
  })

  it('refuses six seconds, a second image, and mismatched private-package proof', async () => {
    expect(() => comfyVideoAuthoringTemplate({ ...contract(), limits: { ...contract().limits,
      maxDurationSeconds: 6 } }, `sha256:${'c'.repeat(64)}`, 'five-second-video')).toThrow('order-adapter-invalid')
    expect(() => comfyVideoAuthoringTemplate({ ...contract(), inputSlots: [...contract().inputSlots,
      { name: 'extra', kind: 'artifact_ref', nodeId: '4', field: 'image', mimeType: 'image/png',
        maxBytes: 1024 }] }, `sha256:${'c'.repeat(64)}`, 'five-second-video')).toThrow('order-adapter-invalid')
    const fixture = await source()
    const prepared = await prepareRegisteredOrderAdapter(fixture.skill)
    await expect(prepared.verifyLocal({ selectReviewedComfyVideoAuthorBinding: async () => ({
      taskType: prepared.taskType, artifactDigest: `sha256:${prepared.digest}`,
      packageDigest: `sha256:${'d'.repeat(64)}`,
      inventoryAlgorithm: COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM,
      localVerified: true, platformReady: false,
    }) })).rejects.toMatchObject({ code: 'order-local-verification-failed' })
  })

  it('installs signed public metadata only and rejects a changed local copy', async () => {
    const fixture = await source()
    const loaded = await readComfyVideoOrderSource(fixture.skill)
    const archive = await buildCanonicalOrderArchive(loaded.root, `sha256:${loaded.digest}`,
      COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM)
    const home = await mkdtemp(join(tmpdir(), 'qs-comfy-install-'))
    roots.push(home)
    const productId = '11111111-1111-4111-8111-111111111111'
    const entitlementId = '22222222-2222-4222-8222-222222222222'
    const publicationId = '33333333-3333-4333-8333-333333333333'
    const signedSource: VerifiedOrderAdapterSource = {
      check: { productId, entitlementId, publicationId, archiveDigest: archive.archiveDigest,
        archiveSizeBytes: archive.sizeBytes, archiveVersionId: 'sealed-v1', archiveFormat: 'zip-source-v1',
        signatureVerified: true, packageReceiptVerified: true, deviceInstalled: false,
        nextStep: 'archive-download-and-device-verification-required' },
      taskType: loaded.declaration.taskType, capabilityId: 'video.render',
      acceptedInputKinds: ['multi_file'], outputKind: 'artifact_ref', contractVersion: 'v1',
      inventoryAlgorithm: COMFY_VIDEO_BINDING_INVENTORY_ALGORITHM,
      archiveBucket: 'reviewed-bucket', artifactDigest: archive.artifactDigest,
      reviewedSellerRuntimeDigest: loaded.declaration.packageDigest,
      downloadUrl: 'https://archive.example.test/video.zip?versionId=sealed-v1',
      expiresAt: Date.now() / 1000 + 120, files: archive.files.map(file => ({ path: file.path,
        sizeBytes: file.size_bytes, sha256: file.sha256 })),
    }
    const fetchArchive = async (): Promise<Response> => new Response(Uint8Array.from(archive.bytes),
      { status: 200, headers: { 'content-length': String(archive.sizeBytes) } })
    const input = { home, trustedArchiveHostname: 'archive.example.test', fetch: fetchArchive as typeof fetch }
    const installed = await installReviewedComfyVideoSource(signedSource, input)
    expect(installed).toMatchObject({ sourceVerified: true, metadataInstalled: true,
      deviceInstalled: false, orderAvailable: false })
    await expect(installReviewedComfyVideoSource(signedSource, input)).resolves.toEqual(installed)
    const version = createHash('sha256').update('sealed-v1').digest('hex')
    const task = join(home, 'qianshou', 'reviewed-video-source', productId,
      entitlementId, version, 'scripts', 'order_adapter', 'task-definition.json')
    await writeFile(task, '{}')
    await expect(installReviewedComfyVideoSource(signedSource, input))
      .rejects.toMatchObject({ code: 'order-adapter-invalid' })
  })
})
