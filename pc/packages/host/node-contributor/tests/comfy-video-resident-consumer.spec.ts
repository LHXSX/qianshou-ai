import { createHash } from 'node:crypto'
import { mkdtemp, open, realpath, rmdir, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { COMFY_VIDEO_RUNNER_ABI, comfyVideoPublicContractDigest,
  parseComfyVideoPublicContract, summarizeComfyVideoApiGraph,
} from '@deepseek-ai/dsh-compute-core/src/comfy-video-public-contract.ts'
import { ComputeCapabilityId, ComputeTaskId } from '@deepseek-ai/dsh-compute-core/protocol'
import { uploadEdgeVideoFile } from '@deepseek-ai/dsh-compute-core/src/edge-worker/artifact-upload-file.ts'
import type { ComputeResidentAttemptExecution, ResidentAttempt } from '@deepseek-ai/dsh-compute-core/resident'
import { createResidentComfyVideoConsumer, stageReviewedComfyVideoValues, uploadVerifiedComfyVideoOutput,
  type ResidentComfyVideoConsumerPorts, type SignedComfyVideoOrder,
  type ResidentComfyVideoFileUploadPort,
  type VersionedComfyVideoObject } from '../src/comfy-video-resident-consumer.ts'
import type { ReviewedComfyVideoInstallation } from '../src/comfy-video-resident-bridge.ts'
import type { ComfyVideoLocalResult } from '../src/comfy-video-runner.ts'
import { createComfyVideoFirstFrameSource } from '../src/comfy-video-first-frame-source.ts'
import { createReviewedComfyVideoResidentRoute } from '../src/reviewed-comfy-video-resident-route.ts'
import { createReviewedVideoFirstFrameReader } from '../src/reviewed-video-first-frame-reader.ts'

const graph = {
  '1': { class_type: 'CLIPTextEncode', inputs: { text: 'private prompt' } },
  '2': { class_type: 'LoadImage', inputs: { image: 'private.png' } },
  '3': { class_type: 'VHS_VideoCombine', inputs: { images: ['1', 0], format: 'video/h264-mp4' } },
}
const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(16)])
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const outputDirectories: string[] = []

afterEach(async () => {
  for (const path of outputDirectories.splice(0)) {
    await unlink(join(path, 'result.mp4')).catch(() => undefined)
    await rmdir(path)
  }
})

async function outputFile(size: number): Promise<{ workspacePath: string; result: ComfyVideoLocalResult }> {
  const workspacePath = await realpath(await mkdtemp(join(tmpdir(), 'comfy-video-consumer-')))
  outputDirectories.push(workspacePath)
  const path = join(workspacePath, 'result.mp4')
  const handle = await open(path, 'wx', 0o600)
  const digest = createHash('sha256')
  const chunk = Buffer.alloc(1024 * 1024, 0x61)
  chunk.writeUInt32BE(24, 0)
  chunk.write('ftypmp42', 4, 'ascii')
  try {
    for (let offset = 0; offset < size;) {
      const bytes = offset === 0 ? chunk : Buffer.alloc(Math.min(chunk.length, size - offset), 0x61)
      const part = bytes.subarray(0, Math.min(bytes.length, size - offset))
      await handle.writeFile(part)
      digest.update(part)
      offset += part.length
    }
    await handle.sync()
  } finally { await handle.close() }
  return { workspacePath, result: { path, filename: 'result.mp4', contentType: 'video/mp4',
    bytes: size, sha256: digest.digest('hex'), promptId: '123e4567-e89b-42d3-a456-426614174000',
    durationSeconds: 5, width: 1344, height: 768, frames: 120 } }
}

function fixture() {
  const publicContract = parseComfyVideoPublicContract({
    schema: 'qianshou.comfy-video-public-contract.v1', taskType: 'owner_video_v1',
    capabilityId: 'video.render', graph: { format: 'comfyui-api', ...summarizeComfyVideoApiGraph(graph) },
    inputSlots: [
      { name: 'prompt', kind: 'text', nodeId: '1', field: 'text', maxUtf8Bytes: 4096 },
      { name: 'first_frame', kind: 'artifact_ref', nodeId: '2', field: 'image',
        mimeType: 'image/png', maxBytes: 1024 },
    ],
    outputs: [{ nodeId: '3', classType: 'VHS_VideoCombine', kind: 'artifact_ref', mimeType: 'video/mp4' }],
    runner: { abi: COMFY_VIDEO_RUNNER_ABI, sourceSha256: 'a'.repeat(64) },
    dependencyManifestSha256: 'b'.repeat(64),
    limits: { maxDurationSeconds: 5, maxFrames: 120, maxWidth: 1344, maxHeight: 768,
      maxVramMiB: 16384, maxInputBytes: 5120, maxOutputBytes: 1024, timeoutSeconds: 30 },
  })
  const reviewed: ReviewedComfyVideoInstallation = {
    ownerAccountId: 167, publicationId: 'dc091b4a-426f-471c-be50-e859aed2e14c',
    artifactDigest: `sha256:${'e'.repeat(64)}`, contractSha256: `sha256:${'f'.repeat(64)}`,
    draftId: 'draft', graphSha256: publicContract.graph.sha256, publicContract,
    approvedContractDigest: comfyVideoPublicContractDigest(publicContract), packageDigest: 'c'.repeat(64),
    dependencyManifestSha256: publicContract.dependencyManifestSha256,
    runnerSourceSha256: publicContract.runner.sourceSha256,
    allowedClassTypes: ['CLIPTextEncode', 'LoadImage', 'VHS_VideoCombine'], capabilityVersion: 'v1',
  }
  const attempt: ResidentAttempt = { taskId: 'video-task-1', attempt: 1, leaseId: 'lease-1',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), idempotencyKey: 'key-1',
    envelopeFingerprint: 'd'.repeat(64), capabilityId: 'video.render', capabilityVersion: 'v1',
    capabilityPluginDigest: reviewed.packageDigest }
  const execution: ComputeResidentAttemptExecution = { task: {
    version: 'qianshou.task.v1', taskId: ComputeTaskId(attempt.taskId),
    capabilityId: ComputeCapabilityId('video.render'), capabilityVersion: 'v1',
    parameters: { taskType: publicContract.taskType,
      orderId: '9639503a-0cd6-40d0-a326-e66c4bb56dd1',
      productId: '8683e6c5-ce57-43cd-8375-16b5a213563a',
      publicationId: reviewed.publicationId, artifactDigest: reviewed.artifactDigest,
      contractSha256: reviewed.contractSha256, approvedContractDigest: reviewed.approvedContractDigest,
      ownerAccountId: reviewed.ownerAccountId, customerAccountId: 52,
      edgeIdentity: { workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 0 },
      values: { prompt: '海面上的云' },
      firstFrame: { slot: 'first_frame', bucket: 'qianshou-input',
        objectKey: `v8/account-52/reviewed-video/input/${'a'.repeat(32)}/frame.png`, objectVersionId: 'version-1',
        contentType: 'image/png', sizeBytes: png.length, sha256: sha(png) } },
    inputRefs: [{ name: 'first_frame', bytes: png.length, sha256: sha(png) }],
    deadlineAt: attempt.leaseExpiresAt, maxOutputBytes: 1024, idempotencyKey: attempt.idempotencyKey,
  }, attempt, signal: new AbortController().signal, reportProgress: async () => {},
  source: { open: async () => { throw Error('not used') } }, dataSource: null }
  const firstFrame = { slot: 'first_frame', bucket: 'qianshou-input',
    objectKey: `v8/account-52/reviewed-video/input/${'a'.repeat(32)}/frame.png`, objectVersionId: 'version-1',
    contentType: 'image/png' as const, sizeBytes: png.length, sha256: sha(png) }
  const order: SignedComfyVideoOrder = { orderId: '9639503a-0cd6-40d0-a326-e66c4bb56dd1',
    productId: '8683e6c5-ce57-43cd-8375-16b5a213563a', publicationId: reviewed.publicationId,
    artifactDigest: reviewed.artifactDigest, contractSha256: reviewed.contractSha256,
    approvedContractDigest: reviewed.approvedContractDigest, customerAccountId: 52,
    ownerAccountId: reviewed.ownerAccountId,
    identity: { workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 0 },
    maxOutputBytes: execution.task.maxOutputBytes, leaseExpiresAt: attempt.leaseExpiresAt,
    inputGetUrl: `https://storage.example.test/${firstFrame.objectKey}?versionId=${firstFrame.objectVersionId}`,
    values: { prompt: '海面上的云' }, firstFrame }
  const object: VersionedComfyVideoObject = { ...firstFrame, bytes: png }
  return { reviewed, execution, order, object }
}

function completeResponse(request: { identity: { workerId: string
  workloadId: string
  shardId: string
  attempt: number }
bucket: string
objectKey: string
objectVersionId: string
sha256: string
sizeBytes: number }) {
  return { ok: true, completed: true, bucket: request.bucket, object_key: request.objectKey,
    object_version_id: request.objectVersionId, sha256: request.sha256,
    size_bytes: request.sizeBytes, content_type: 'video/mp4',
    signed_video_upload_completion_receipt: { key_id: 'upload-key', signature: 'a'.repeat(86),
      payload: { schema: 'qianshou.reviewed-video-object-upload.v1',
        purpose: 'shanghai.video.upload.v1', role: 'output', account_id: 52,
        workload_id: request.identity.workloadId, shard_id: request.identity.shardId,
        worker_id: request.identity.workerId, attempt: request.identity.attempt,
        object: { bucket: request.bucket, key: request.objectKey,
          version_id: request.objectVersionId, sha256: request.sha256,
          size_bytes: request.sizeBytes, mime_type: 'video/mp4' } } } }
}

function reviewedHeaders(request: { sha256: string; sizeBytes: number; contentMd5: string }) {
  return { 'content-type': 'video/mp4', 'content-md5': request.contentMd5,
    'x-amz-checksum-sha256': Buffer.from(request.sha256, 'hex').toString('base64'),
    'x-amz-meta-sha256': request.sha256,
    'x-amz-object-lock-mode': 'COMPLIANCE',
    'x-amz-object-lock-retain-until-date': new Date(Date.now() + 73 * 60 * 60 * 1000).toISOString() }
}

describe('opt-in resident Comfy video consumer', () => {
  it('keeps the composed reviewed-video route closed until explicitly enabled', async () => {
    const { execution } = fixture()
    const verifyOffer = vi.fn()
    const route = createReviewedComfyVideoResidentRoute({ nodeId: 'node-1',
      offer: { taskType: 'owner_video_v1', verifyOffer, readSignedOrder: vi.fn() },
      ports: {} as ResidentComfyVideoConsumerPorts })
    expect(route.inputSource).toBeUndefined()
    expect(route.binding.bridge.toNodeOffer({ workerId: 'worker-1', workloadId: 'workload-1',
      shardId: 'shard-1', attempt: 0, taskType: 'owner_video_v1', runtime: 'comfyui',
      inputKind: 'single_file', inlineInput: null, inputRef: '', inputRefs: [],
      codeUrl: '', codeSha256: '', timeoutSeconds: 60, verificationPolicy: 'artifact',
      executionModel: 'comfyui', capability: 'video.render', capabilityVersion: 'v1',
    }, { receivedAt: new Date().toISOString(), workerId: 'worker-1' }))
      .toEqual({ refuse: 'TASK_TYPE_DENIED' })
    expect(verifyOffer).not.toHaveBeenCalled()
    await expect(route.resultConsumer.consume({ execution,
      workspace: { path: '/unused', outputs: [], close: async () => {} }, signal: execution.signal }))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_CONSUMER_DISABLED')
  })

  it('refuses to enable a reviewed video route without an authenticated Edge session', () => {
    expect(() => createReviewedComfyVideoResidentRoute({ enabled: true, nodeId: 'node-1',
      offer: { taskType: 'owner_video_v1', verifyOffer: vi.fn(), readSignedOrder: vi.fn() },
      ports: {} as ResidentComfyVideoConsumerPorts }))
      .toThrow('COMPUTE_COMFY_VIDEO_EDGE_SESSION_UNAVAILABLE')
  })

  it('reads Shanghai frozen first-frame bytes only from the configured evidence bucket and signed version', async () => {
    const { execution, order } = fixture()
    const url = `https://qianshou-input.storage.example/${order.firstFrame.objectKey}?versionId=version-1&sig=opaque`
    const frozen = { ...order, inputGetUrl: url }
    const fetchImage = vi.fn(async () => new Response(png, { headers: {
      'content-length': String(png.length), 'x-cos-version-id': 'version-1',
    } }))
    const config = { controlOrigin: new URL('https://shanghai.example'),
      evidenceEndpoint: new URL('https://storage.example'), evidenceBucket: 'qianshou-input',
      readSignedOrder: vi.fn(async () => frozen), fetch: fetchImage }
    const read = createReviewedVideoFirstFrameReader(config)
    expect((await read(execution, order.firstFrame, execution.signal)).bytes).toEqual(png)
    await expect(read(execution, { ...order.firstFrame, objectVersionId: 'other' }, execution.signal))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_FIRST_FRAME_MISMATCH')
    const wrongBucket = createReviewedVideoFirstFrameReader({ ...config, evidenceBucket: 'other' })
    await expect(wrongBucket(execution, order.firstFrame, execution.signal))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_FIRST_FRAME_MISMATCH')
    const substituted = createReviewedVideoFirstFrameReader({ ...config,
      readSignedOrder: async () => ({ ...frozen, inputGetUrl:
        `https://storage.example/${order.firstFrame.objectKey}?versionId=version-1` }) })
    await expect(substituted(execution, order.firstFrame, execution.signal))
      .rejects.toMatchObject({ code: 'EDGE_ATTACHMENT_READ_DENIED' })
    expect(fetchImage).toHaveBeenCalledTimes(1)
  })

  it('refuses the default-disabled consumer before reading a signed order or opening a GPU runner', async () => {
    const { execution } = fixture()
    const consumer = createResidentComfyVideoConsumer({ ports: {} as ResidentComfyVideoConsumerPorts })
    await expect(consumer.consume({ execution, workspace: { path: '/unused', outputs: [], close: async () => {} },
      signal: execution.signal })).rejects.toThrow('COMPUTE_COMFY_VIDEO_CONSUMER_DISABLED')
  })

  it('refuses a missing file upload lease port before reading an order or running GPU', async () => {
    const { execution } = fixture()
    const readSignedOrder = vi.fn()
    const consumer = createResidentComfyVideoConsumer({ enabled: true,
      ports: { readSignedOrder } as unknown as ResidentComfyVideoConsumerPorts })
    await expect(consumer.consume({ execution, workspace: { path: '/unused', outputs: [], close: async () => {} },
      signal: execution.signal })).rejects.toThrow('COMPUTE_COMFY_VIDEO_FILE_UPLOAD_UNAVAILABLE')
    expect(readSignedOrder).not.toHaveBeenCalled()
  })

  it('requires an installed, reviewed graph before consulting any remote order port on either OS', async () => {
    const { execution } = fixture()
    const readSignedOrder = vi.fn()
    const ports = { fileUpload: { edgeIdentityOf: vi.fn(), uploadAuthenticatedResult: vi.fn(), remember: vi.fn() },
      bridge: { readCurrentInstallation: async () => null }, readSignedOrder } as unknown as ResidentComfyVideoConsumerPorts
    const consumer = createResidentComfyVideoConsumer({ enabled: true, ports })
    await expect(consumer.consume({ execution, workspace: { path: '/unused', outputs: [], close: async () => {} },
      signal: execution.signal })).rejects.toThrow('COMPUTE_COMFY_VIDEO_INSTALLATION_UNAVAILABLE')
    expect(readSignedOrder).not.toHaveBeenCalled()
  })

  it('copies an exact versioned first frame into only the reviewed slot', async () => {
    const { reviewed, execution, order, object } = fixture()
    const read = vi.fn(async () => object)
    const values = await stageReviewedComfyVideoValues(execution, reviewed, order, read, execution.signal)
    expect(values).toMatchObject({ prompt: '海面上的云', first_frame: { mimeType: 'image/png',
      sha256: sha(png), bytes: png } })
    expect(read).toHaveBeenCalledWith(execution, order.firstFrame, execution.signal)
    expect(values.first_frame).not.toBe(object)
  })

  it('rejects a substituted version or bytes before GPU and never retries another object', async () => {
    const { reviewed, execution, order, object } = fixture()
    for (const changed of [{ ...object, objectVersionId: 'version-2' },
      { ...object, bytes: Buffer.concat([png.subarray(0, 8), Buffer.alloc(16, 1)]) }]) {
      const read = vi.fn(async () => changed)
      await expect(stageReviewedComfyVideoValues(execution, reviewed, order, read, execution.signal))
        .rejects.toThrow('COMPUTE_COMFY_VIDEO_INPUT_VERSION_MISMATCH')
      expect(read).toHaveBeenCalledTimes(1)
    }
  })

  it('rejects a drifted frozen input reference before any object read', async () => {
    const { reviewed, execution, order, object } = fixture()
    const read = vi.fn(async () => object)
    const wrong = { ...execution, task: { ...execution.task, inputRefs: [{ name: 'first_frame',
      bytes: png.length, sha256: '0'.repeat(64) }] } }
    await expect(stageReviewedComfyVideoValues(wrong, reviewed, order, read, execution.signal))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_ORDER_INVALID')
    expect(read).not.toHaveBeenCalled()
  })

  it('rejects a different signed Edge attempt, product, lease or output ceiling before reading media', async () => {
    const { reviewed, execution, order, object } = fixture()
    for (const changed of [
      { ...order, identity: { ...order.identity, attempt: 1 } },
      { ...order, productId: '8683e6c5-ce57-43cd-8375-16b5a213563b' },
      { ...order, leaseExpiresAt: new Date(Date.now() + 90_000).toISOString() },
      { ...order, maxOutputBytes: order.maxOutputBytes + 1 },
    ]) {
      const read = vi.fn(async () => object)
      await expect(stageReviewedComfyVideoValues(execution, reviewed, changed, read, execution.signal))
        .rejects.toThrow('COMPUTE_COMFY_VIDEO_ORDER_INVALID')
      expect(read).not.toHaveBeenCalled()
    }
  })

  it('stages only the independently signed first-frame version through the resident input source', async () => {
    const { reviewed, execution, order, object } = fixture()
    const readSignedOrder = vi.fn(async () => order)
    const readVersionedFirstFrame = vi.fn(async () => object)
    const publication = { status: 'approved', publicationId: reviewed.publicationId,
      ownerAccountId: reviewed.ownerAccountId, taskType: reviewed.publicContract.taskType,
      artifactDigest: reviewed.artifactDigest, contractSha256: reviewed.contractSha256,
      approvedContractDigest: reviewed.approvedContractDigest }
    const source = createComfyVideoFirstFrameSource({ bridge: { readCurrentInstallation: async () => reviewed,
      readCurrentPublication: async () => publication,
      assertOrderPublication: vi.fn(async () => undefined),
      assertOrderOwnership: vi.fn(async () => undefined) },
    readSignedOrder, readVersionedFirstFrame } as unknown as ResidentComfyVideoConsumerPorts)
    const input = execution.task.inputRefs[0]!
    const stream = await source.open(execution, execution.task, input, execution.signal)
    const output = await new Response(stream).arrayBuffer()
    expect(Buffer.from(output)).toEqual(png)
    expect(readSignedOrder).toHaveBeenCalledWith(execution, execution.signal)
    expect(readVersionedFirstFrame).toHaveBeenCalledWith(execution, order.firstFrame, execution.signal)
    await expect(source.open(execution, execution.task, { ...input, sha256: '0'.repeat(64) }, execution.signal))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_INPUT_BINDING_INVALID')
    expect(readSignedOrder).toHaveBeenCalledTimes(1)
    readSignedOrder.mockResolvedValueOnce({ ...order, firstFrame: { ...order.firstFrame,
      objectVersionId: 'version-2' } })
    await expect(source.open(execution, execution.task, input, execution.signal))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_ORDER_INVALID')
    expect(readVersionedFirstFrame).toHaveBeenCalledTimes(1)
  })

  it('does not read an order or first-frame bytes after publication withdrawal', async () => {
    const { reviewed, execution } = fixture()
    const readSignedOrder = vi.fn()
    const readVersionedFirstFrame = vi.fn()
    const source = createComfyVideoFirstFrameSource({
      bridge: { readCurrentInstallation: async () => reviewed,
        readCurrentPublication: async () => ({ status: 'withdrawn', publicationId: reviewed.publicationId }),
        assertOrderPublication: vi.fn(), assertOrderOwnership: vi.fn() },
      readSignedOrder, readVersionedFirstFrame,
    } as unknown as ResidentComfyVideoConsumerPorts)
    await expect(source.open(execution, execution.task, execution.task.inputRefs[0]!, execution.signal))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_PUBLICATION_UNAVAILABLE')
    expect(readSignedOrder).not.toHaveBeenCalled()
    expect(readVersionedFirstFrame).not.toHaveBeenCalled()
  })

  it('refuses an MP4 below the first-round 1 MiB candidate minimum before requesting upload', async () => {
    const { execution: originalExecution, order } = fixture()
    const { workspacePath, result } = await outputFile(1024 * 1024 - 1)
    const execution = { ...originalExecution, task: { ...originalExecution.task,
      maxOutputBytes: 64 * 1024 * 1024 } }
    const uploadAuthenticatedResult = vi.fn()
    await expect(uploadVerifiedComfyVideoOutput(
      { path: workspacePath, outputs: [], close: async () => {} }, result, order, execution,
      { edgeIdentityOf: vi.fn(), uploadAuthenticatedResult, remember: vi.fn() }, execution.signal))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_OUTPUT_CHANGED')
    expect(uploadAuthenticatedResult).not.toHaveBeenCalled()
  })

  it('streams a 17 MiB synthetic ftyp file through one lease-bound PUT with no buffered output port', async () => {
    const { execution: originalExecution, order } = fixture()
    const { workspacePath, result } = await outputFile(17 * 1024 * 1024 + 23)
    const execution = { ...originalExecution, task: { ...originalExecution.task,
      maxOutputBytes: result.bytes } }
    const identity = { workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 0 }
    let streamedBytes = 0
    let maximumChunk = 0
    const issueUpload = vi.fn(async (request: { resultId: string; sha256: string; sizeBytes: number; contentMd5: string }) => ({
      schemaVersion: 'artifact-file.v1', identity,
      leaseTokenSha256: createHash('sha256').update('private-lease').digest('hex'),
      resultId: request.resultId, sha256: request.sha256, sizeBytes: request.sizeBytes,
      contentType: 'video/mp4', method: 'PUT',
      bucket: 'video-evidence',
      objectKey: `v8/account-52/workload-${identity.workloadId}/shard-${identity.shardId}/result/${request.resultId}/result.mp4`,
      uploadUrl: 'https://media.example.test/upload?signature=opaque',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      headers: reviewedHeaders(request),
      signedHeaderNames: Object.keys(reviewedHeaders(request)),
    }))
    const put = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      expect(init?.body).toBeInstanceOf(ReadableStream)
      const reader = (init?.body as ReadableStream<Uint8Array>).getReader()
      const received = createHash('sha256')
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        streamedBytes += part.value.byteLength
        maximumChunk = Math.max(maximumChunk, part.value.byteLength)
        received.update(part.value)
      }
      expect(received.digest('hex')).toBe(result.sha256)
      return new Response(null, { status: 200, headers: { 'x-amz-version-id': 'version-1' } })
    }) as typeof fetch
    const completeUpload = vi.fn(async (request: Parameters<typeof completeResponse>[0]) => completeResponse(request))
    const bindAuthenticatedLease = vi.fn(async (_execution: ComputeResidentAttemptExecution,
      _signal: AbortSignal) => ({ identity, leaseToken: 'private-lease',
      controlOrigin: new URL('https://shanghai.example.test'),
      storageOrigin: new URL('https://media.example.test'),
      assertLeaseActive: vi.fn(async () => undefined), issueUpload,
      completeUpload,
      fetch: put }))
    const uploadAuthenticatedResult = vi.fn(async (...[actualExecution, input, signal]:
    Parameters<ResidentComfyVideoFileUploadPort['uploadAuthenticatedResult']>) => uploadEdgeVideoFile({
      ...(await bindAuthenticatedLease(actualExecution, signal)), ...input, signal }))
    const artifact = await uploadVerifiedComfyVideoOutput(
      { path: workspacePath, outputs: [], close: async () => {} }, result, order, execution,
      { edgeIdentityOf: () => identity, uploadAuthenticatedResult, remember: vi.fn() }, execution.signal)
    expect(bindAuthenticatedLease).toHaveBeenCalledWith(execution, execution.signal)
    expect(issueUpload).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledTimes(1)
    expect(completeUpload).toHaveBeenCalledTimes(1)
    expect(streamedBytes).toBe(result.bytes)
    expect(maximumChunk).toBeLessThanOrEqual(1024 * 1024)
    expect(artifact).toMatchObject({ account_id: 52, object_version_id: 'version-1',
      size_bytes: result.bytes, sha256: result.sha256 })
  })

  it('does not retry an uncertain streamed PUT or permit a different Edge attempt', async () => {
    const { execution: originalExecution, order } = fixture()
    const { workspacePath, result } = await outputFile(1024 * 1024 + 23)
    const execution = { ...originalExecution, task: { ...originalExecution.task,
      maxOutputBytes: result.bytes } }
    const identity = { workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 0 }
    const issueUpload = vi.fn(async (request: { resultId: string; sha256: string; sizeBytes: number; contentMd5: string }) => ({
      schemaVersion: 'artifact-file.v1', identity,
      leaseTokenSha256: createHash('sha256').update('private-lease').digest('hex'),
      resultId: request.resultId, sha256: request.sha256, sizeBytes: request.sizeBytes,
      contentType: 'video/mp4', method: 'PUT',
      bucket: 'video-evidence',
      objectKey: `v8/account-52/workload-${identity.workloadId}/shard-${identity.shardId}/result/${request.resultId}/result.mp4`,
      uploadUrl: 'https://media.example.test/upload?signature=opaque',
      expiresAt: Math.floor(Date.now() / 1000) + 600,
      headers: reviewedHeaders(request),
      signedHeaderNames: Object.keys(reviewedHeaders(request)),
    }))
    const put = vi.fn(async (_url: URL | RequestInfo, init?: RequestInit) => {
      await (init?.body as ReadableStream<Uint8Array>).getReader().read()
      throw new Error('possibly committed')
    }) as typeof fetch
    const bindAuthenticatedLease = vi.fn(async (_execution: ComputeResidentAttemptExecution,
      _signal: AbortSignal) => ({ identity, leaseToken: 'private-lease',
      controlOrigin: new URL('https://shanghai.example.test'),
      storageOrigin: new URL('https://media.example.test'),
      assertLeaseActive: vi.fn(async () => undefined), issueUpload,
      completeUpload: vi.fn(async (request: Parameters<typeof completeResponse>[0]) => completeResponse(request)),
      fetch: put }))
    const uploadAuthenticatedResult = vi.fn(async (...[actualExecution, input, signal]:
    Parameters<ResidentComfyVideoFileUploadPort['uploadAuthenticatedResult']>) => uploadEdgeVideoFile({
      ...(await bindAuthenticatedLease(actualExecution, signal)), ...input, signal }))
    const workspace = { path: workspacePath, outputs: [], close: async () => {} }
    await expect(uploadVerifiedComfyVideoOutput(workspace, result, order, execution,
      { edgeIdentityOf: () => identity, uploadAuthenticatedResult, remember: vi.fn() }, execution.signal))
      .rejects.toMatchObject({ code: 'EDGE_VIDEO_UPLOAD_OUTCOME_UNKNOWN' })
    expect(issueUpload).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledTimes(1)
    const wrongIdentity = { ...identity, attempt: 1 }
    await expect(uploadVerifiedComfyVideoOutput(workspace, result, order, execution,
      { edgeIdentityOf: () => wrongIdentity, uploadAuthenticatedResult, remember: vi.fn() }, execution.signal))
      .rejects.toThrow('COMPUTE_COMFY_VIDEO_UPLOAD_MISMATCH')
    expect(issueUpload).toHaveBeenCalledTimes(1)
    expect(put).toHaveBeenCalledTimes(1)
  })
})
