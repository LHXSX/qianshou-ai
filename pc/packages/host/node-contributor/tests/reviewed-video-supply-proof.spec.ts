import { generateKeyPairSync, sign, verify } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { COMFY_VIDEO_RUNNER_ABI, comfyVideoPublicContractDigest,
  parseComfyVideoPublicContract, summarizeComfyVideoApiGraph,
} from '@deepseek-ai/dsh-compute-core/src/comfy-video-public-contract.ts'
import { createReviewedVideoHostProbe, submitReviewedVideoSupplyUpdate, type ReviewedVideoSampleAttestation,
  type ReviewedVideoSupplySnapshot } from '../src/reviewed-video-supply-proof.ts'

const NOW = Date.parse('2026-09-28T06:00:00.000Z')
const SCHEMA = 'qianshou.reviewed-video-sample-attestation.v1'
const hostKeys = generateKeyPairSync('ed25519')
const attestorKeys = generateKeyPairSync('ed25519')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const item = value as Record<string, unknown>
    return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${canonical(item[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}
function snapshot(): ReviewedVideoSupplySnapshot {
  const graph = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'test' } },
    '2': { class_type: 'LoadImage', inputs: { image: 'first.png' } },
    '3': { class_type: 'VHS_VideoCombine', inputs: { images: ['1', 0], format: 'video/h264-mp4' } } }
  const publicContract = parseComfyVideoPublicContract({
    schema: 'qianshou.comfy-video-public-contract.v1', taskType: 'owner_video_v1',
    capabilityId: 'video.render', graph: { format: 'comfyui-api', ...summarizeComfyVideoApiGraph(graph) },
    inputSlots: [{ name: 'prompt', kind: 'text', nodeId: '1', field: 'text', maxUtf8Bytes: 4096 },
      { name: 'first_frame', kind: 'artifact_ref', nodeId: '2', field: 'image',
        mimeType: 'image/png', maxBytes: 16 * 1024 * 1024 }],
    outputs: [{ nodeId: '3', classType: 'VHS_VideoCombine', kind: 'artifact_ref', mimeType: 'video/mp4' }],
    runner: { abi: COMFY_VIDEO_RUNNER_ABI, sourceSha256: 'a'.repeat(64) },
    dependencyManifestSha256: 'b'.repeat(64),
    limits: { maxDurationSeconds: 5, maxFrames: 120, maxWidth: 1344, maxHeight: 768,
      maxVramMiB: 16384, maxInputBytes: 17 * 1024 * 1024, maxOutputBytes: 64 * 1024 * 1024,
      timeoutSeconds: 600 },
  })
  const publicationId = 'dc091b4a-426f-471c-be50-e859aed2e14c'
  const approvedContractDigest = comfyVideoPublicContractDigest(publicContract)
  const artifactDigest = `sha256:${'e'.repeat(64)}`
  const contractSha256 = `sha256:${'f'.repeat(64)}`
  return {
    workerId: 'worker-1', connectionId: '11111111-1111-4111-8111-111111111111',
    deviceKeyId: 'key-1', ownerAccountId: 167, ownerConsentRevision: 1,
    installation: { ownerAccountId: 167, publicationId, artifactDigest, contractSha256,
      draftId: 'video_draft_11111111-1111-4111-8111-111111111111',
      graphSha256: publicContract.graph.sha256, publicContract, approvedContractDigest,
      packageDigest: 'c'.repeat(64), dependencyManifestSha256: publicContract.dependencyManifestSha256,
      runnerSourceSha256: publicContract.runner.sourceSha256,
      allowedClassTypes: ['CLIPTextEncode', 'LoadImage', 'VHS_VideoCombine'], capabilityVersion: 'v1' },
    publication: { publicationId, ownerAccountId: 167, taskType: 'owner_video_v1',
      artifactDigest, contractSha256, approvedContractDigest, status: 'approved' },
    localTest: { attempt_id: '22222222-2222-4222-8222-222222222222',
      prompt_id: '33333333-3333-4333-8333-333333333333', input_bucket: 'reviewed-evidence',
      input_object_key: `v8/account-167/reviewed-video/input/${'a'.repeat(32)}/frame.png`,
      input_object_version_id: 'input-v1', input_sha256: '1'.repeat(64), input_bytes: 1024,
      output_bucket: 'reviewed-evidence', output_object_key: 'v8/account-167/reviewed-video/sample/test.mp4',
      output_object_version_id: 'output-v1', output_sha256: '2'.repeat(64), output_bytes: 4096,
      completed_at: '2026-09-28T05:59:00.000Z' },
    runtime: { comfy_version: '0.30.0', comfy_process_sha256: '3'.repeat(64),
      ffprobe_sha256: '4'.repeat(64), gpu_model: 'RTX-5080', vram_mb: 24576 },
  }
}
function signedAttestation(probe: Record<string, unknown>, probeSha256: string): ReviewedVideoSampleAttestation {
  const payload = { schema: SCHEMA, purpose: SCHEMA, probe_sha256: `sha256:${probeSha256}`,
    publication_id: probe.publication_id, owner_account_id: probe.owner_account_id,
    worker_id: probe.worker_id, connection_id: probe.connection_id,
    task_type: probe.task_type, device_key_id: probe.device_key_id,
    artifact_digest: probe.artifact_digest, package_digest: probe.package_digest,
    contract_sha256: probe.contract_sha256, approved_contract_digest: probe.approved_contract_digest,
    graph_sha256: probe.graph_sha256, runner_source_sha256: probe.runner_source_sha256,
    dependency_manifest_sha256: probe.dependency_manifest_sha256,
    owner_consent_revision: probe.owner_consent_revision, local_test: probe.local_test,
    result: 'pass', issued_at: '2026-09-28T05:59:30.000Z', expires_at: '2026-09-28T06:04:30.000Z' }
  return { key_id: 'guangzhou-sample-1', payload,
    signature: sign(null, Buffer.from(SCHEMA + '\0' + canonical(payload)), attestorKeys.privateKey).toString('base64url') }
}
function fixture(attested = true) {
  const current = snapshot()
  const readCurrent = vi.fn(async () => current)
  const preview = createReviewedVideoHostProbe(current, NOW / 1000)
  const readSampleAttestation = vi.fn(async (hash: string) => {
    if (!attested) return null
    return signedAttestation(preview.payload, hash)
  })
  const signDevice = vi.fn(async (_id: string, bytes: Uint8Array) =>
    sign(null, bytes, hostKeys.privateKey))
  const sendUpdate = vi.fn(async (update: { request_id: string
    probe_payload_b64u: string
    device_signature_b64u: string }) => {
    const content = Buffer.concat([Buffer.from('qianshou.reviewed-video-host-probe.v1\0'),
      Buffer.from(update.probe_payload_b64u, 'base64url')])
    expect(verify(null, content, hostKeys.publicKey,
      Buffer.from(update.device_signature_b64u, 'base64url'))).toBe(true)
    return { request_id: update.request_id, connection_id: current.connectionId,
      status: 'accepted' as const, publication_id: current.publication.publicationId,
      task_type: current.publication.taskType,
      approved_contract_digest: current.installation.approvedContractDigest }
  })
  return { current, readCurrent, readSampleAttestation, signDevice, sendUpdate }
}
const requestId = '44444444-4444-4444-8444-444444444444'

describe('reviewed Comfy supply review update', () => {
  it('bounds retained video samples by the approved recipe instead of one machine-sized limit', () => {
    const current = snapshot()
    const publicContract = parseComfyVideoPublicContract({ ...current.installation.publicContract,
      limits: { ...current.installation.publicContract.limits,
        maxOutputBytes: 128 * 1024 * 1024 } })
    const approvedContractDigest = comfyVideoPublicContractDigest(publicContract)
    const expanded = { ...current,
      installation: { ...current.installation, publicContract, approvedContractDigest },
      publication: { ...current.publication, approvedContractDigest },
      localTest: { ...current.localTest, output_bytes: 80 * 1024 * 1024 } }
    expect(createReviewedVideoHostProbe(expanded, NOW / 1000).sha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(() => createReviewedVideoHostProbe({ ...expanded,
      localTest: { ...expanded.localTest, output_bytes: 129 * 1024 * 1024 } }, NOW / 1000))
      .toThrow('COMPUTE_REVIEWED_VIDEO_SUPPLY_PROOF_INVALID')
  })
  it('keeps review submission closed without an independently attested sample', async () => {
    const ctx = fixture(false)
    await expect(submitReviewedVideoSupplyUpdate({ requestId,
      attestorPublicKeys: { 'guangzhou-sample-1': attestorKeys.publicKey },
      ports: ctx, signal: new AbortController().signal, now: () => NOW }))
      .rejects.toThrow('COMPUTE_REVIEWED_VIDEO_SUPPLY_PROOF_INVALID')
    expect(ctx.signDevice).not.toHaveBeenCalled()
    expect(ctx.sendUpdate).not.toHaveBeenCalled()
  })

  it('sends only a current device-signed probe with a matching Guangzhou sample and exact ACK', async () => {
    const ctx = fixture()
    const ack = await submitReviewedVideoSupplyUpdate({ requestId,
      attestorPublicKeys: { 'guangzhou-sample-1': attestorKeys.publicKey },
      ports: ctx, signal: new AbortController().signal, now: () => NOW })
    expect(ack.status).toBe('accepted')
    expect(ctx.readCurrent).toHaveBeenCalledTimes(3)
    expect(ctx.signDevice).toHaveBeenCalledTimes(1)
    expect(ctx.sendUpdate).toHaveBeenCalledTimes(1)
    const sent = ctx.sendUpdate.mock.calls[0]?.[0]
    expect(sent).toMatchObject({ request_id: requestId })
    if (sent === undefined) throw new Error('review update was not sent')
    expect(JSON.parse(Buffer.from(sent.probe_payload_b64u, 'base64url').toString('utf8')))
      .toMatchObject({ capability_id: 'video.render', input_kind: 'multi_file',
        output_kind: 'artifact_ref', owner_consent_revision: 1 })
  })

  it('refuses a changed local runtime before sending, even after both signatures exist', async () => {
    const ctx = fixture()
    let reads = 0
    ctx.readCurrent.mockImplementation(async () => {
      reads += 1
      return reads === 1 ? ctx.current : { ...ctx.current,
        runtime: { ...ctx.current.runtime, comfy_process_sha256: '9'.repeat(64) } }
    })
    await expect(submitReviewedVideoSupplyUpdate({ requestId,
      attestorPublicKeys: { 'guangzhou-sample-1': attestorKeys.publicKey },
      ports: ctx, signal: new AbortController().signal, now: () => NOW }))
      .rejects.toThrow('COMPUTE_REVIEWED_VIDEO_SUPPLY_PROOF_INVALID')
    expect(ctx.sendUpdate).not.toHaveBeenCalled()
  })

  it('refuses stale or substituted independent samples before device signing', async () => {
    const ctx = fixture()
    const preview = createReviewedVideoHostProbe(ctx.current, NOW / 1000)
    ctx.readSampleAttestation.mockImplementation(async () => {
      const value = signedAttestation(preview.payload, preview.sha256)
      return { ...value, payload: { ...value.payload, result: 'failed' } }
    })
    await expect(submitReviewedVideoSupplyUpdate({ requestId,
      attestorPublicKeys: { 'guangzhou-sample-1': attestorKeys.publicKey },
      ports: ctx, signal: new AbortController().signal, now: () => NOW }))
      .rejects.toThrow('COMPUTE_REVIEWED_VIDEO_SUPPLY_PROOF_INVALID')
    expect(ctx.signDevice).not.toHaveBeenCalled()
    expect(ctx.sendUpdate).not.toHaveBeenCalled()
  })

  it('does not advertise supply on an ACK for a different connection or digest', async () => {
    const ctx = fixture()
    ctx.sendUpdate.mockImplementation(async update => ({ request_id: update.request_id,
      connection_id: '99999999-9999-4999-8999-999999999999', status: 'accepted' as const,
      publication_id: ctx.current.publication.publicationId,
      task_type: ctx.current.publication.taskType,
      approved_contract_digest: ctx.current.installation.approvedContractDigest }))
    await expect(submitReviewedVideoSupplyUpdate({ requestId,
      attestorPublicKeys: { 'guangzhou-sample-1': attestorKeys.publicKey },
      ports: ctx, signal: new AbortController().signal, now: () => NOW }))
      .rejects.toThrow('COMPUTE_REVIEWED_VIDEO_SUPPLY_PROOF_INVALID')
  })
})
