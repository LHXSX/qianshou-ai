import { generateKeyPairSync, sign, type KeyObject } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { createInlineEdgeBinding } from '@deepseek-ai/dsh-compute-core'
import type { EdgeTaskOffer } from '@deepseek-ai/dsh-compute-core/src/edge-worker/types.ts'
import type { ComputeResidentAttemptExecution } from '@deepseek-ai/dsh-compute-core/resident'
import { createSignedReviewedVideoOfferPort } from '../src/reviewed-video-signed-order.ts'

const receivedAt = '2026-09-17T04:00:00.000Z'
const objectKey = 'v8/account-52/input/first.png'
const getUrl = `https://storage.example.test/${objectKey}?signed=1&versionId=version-1`
const file = { objectKey, objectVersionId: 'version-1', filename: 'first.png',
  bytes: 1024, sha256: 'e'.repeat(64), contentType: 'image/png' }
const firstFrame = { slot: 'first_frame', bucket: 'qianshou-input',
  object_key: objectKey, object_version_id: 'version-1',
  content_type: 'image/png', size_bytes: 1024, sha256: 'e'.repeat(64) }
const params = { prompt: '海面上的云',
  input_manifest: JSON.stringify({ schema: 'qianshou.uploaded-inputs.v1', files: [file] }),
  _reviewed_video_input: { schema: 'qianshou.reviewed-video-worker-input.v1',
    bucket: 'qianshou-input', objectKey, objectVersionId: 'version-1',
    sha256: 'e'.repeat(64), bytes: 1024, contentType: 'image/png', getUrl },
  _developer_api_version: 'v1' }
const bareOffer: EdgeTaskOffer = {
  workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 1,
  taskType: 'owner_video_v1', runtime: 'python3', inputKind: 'multi_file',
  inputRef: getUrl, inputRefs: [getUrl], inlineInput: null, params,
  codeUrl: 'https://server.example.test/legacy.py', codeSha256: 'a'.repeat(64),
  timeoutSeconds: 60, verificationPolicy: 'semantic',
  executionModel: 'runtime_v2', runtimeApi: '2.0', capability: 'video.render',
  capabilityVersion: '>=1.0.0 <2.0.0', leaseTokenSha256: '9'.repeat(64),
}
function assignment(offer: EdgeTaskOffer) {
  return {
    worker_id: offer.workerId, workload_id: offer.workloadId, shard_id: offer.shardId,
    attempt: offer.attempt, task_type: offer.taskType, runtime: offer.runtime,
    input_kind: offer.inputKind, input_ref: offer.inputRef, input_refs: offer.inputRefs,
    inline_input: offer.inlineInput, params: offer.params, code_url: offer.codeUrl,
    code_sha256: offer.codeSha256, timeout_s: offer.timeoutSeconds,
    verification_policy: offer.verificationPolicy, execution_model: offer.executionModel,
    runtime_api: offer.runtimeApi, capability: offer.capability,
    capability_version: offer.capabilityVersion,
    lease_token_sha256: offer.leaseTokenSha256,
  }
}
const order = {
  order_id: '9639503a-0cd6-40d0-a326-e66c4bb56dd1',
  product_id: '8683e6c5-ce57-43cd-8375-16b5a213563a',
  publication_id: 'dc091b4a-426f-471c-be50-e859aed2e14c',
  owner_account_id: 167, customer_account_id: 52, task_type: 'owner_video_v1',
  capability_version: 'reviewed-v1', package_digest: `sha256:${'b'.repeat(64)}`,
  artifact_digest: `sha256:${'c'.repeat(64)}`,
  contract_sha256: `sha256:${'d'.repeat(64)}`,
  approved_contract_digest: `sha256:${'f'.repeat(64)}`,
  max_output_bytes: 100 * 1024 * 1024, lease_expires_at: '2026-09-17T04:00:50.000Z',
  values: { prompt: '海面上的云' }, first_frame: firstFrame, input_get_url: getUrl,
}
function signed(offer: EdgeTaskOffer, privateKey: KeyObject) {
  const payload = Buffer.from(JSON.stringify({ schema: 'qianshou.reviewed-video-order-payload.v1',
    assignment: assignment(offer), order }), 'utf8')
  const signature = sign(null, Buffer.concat([
    Buffer.from('qianshou.reviewed-video-order.v1\0'), payload,
  ]), privateKey)
  return { schema: 'qianshou.reviewed-video-order.v1', key_id: 'shanghai-1',
    payload_b64u: payload.toString('base64url'), signature_b64u: signature.toString('base64url') }
}

describe('Shanghai Ed25519 reviewed-video order', () => {
  it('admits only the exact signed multi-file semantic assignment and remembers its resident attempt', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const port = createSignedReviewedVideoOfferPort({ taskType: 'owner_video_v1',
      publicKeys: { 'shanghai-1': publicKey } })
    const offer = { ...bareOffer, reviewedVideoOrder: signed(bareOffer, privateKey) }
    const binding = createInlineEdgeBinding({ nodeId: 'node-1',
      allowedTaskTypes: ['owner_video_v1'], maxOutputBytes: 4096,
      reviewedVideo: port, sessionKey: Buffer.alloc(32, 7) })
    const mapped = binding.bridge.toNodeOffer(offer, { receivedAt, workerId: 'worker-1' })
    expect('refuse' in mapped).toBe(false)
    if ('refuse' in mapped) return
    expect(mapped.attempt).toBe(2)
    expect(mapped.envelope).toMatchObject({
      capabilityId: 'video.render', capabilityVersion: 'reviewed-v1',
      maxOutputBytes: order.max_output_bytes,
      parameters: { productId: order.product_id, values: order.values,
        edgeIdentity: { workerId: 'worker-1', workloadId: 'workload-1',
          shardId: 'shard-1', attempt: 1 } },
    })
    const execution = { task: mapped.envelope,
      attempt: { attempt: mapped.attempt, leaseExpiresAt: mapped.leaseExpiresAt },
    } as unknown as ComputeResidentAttemptExecution
    await expect(port.readSignedOrder(execution, new AbortController().signal))
      .resolves.toMatchObject({ orderId: order.order_id, productId: order.product_id,
        identity: { workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 1 },
        firstFrame: { objectVersionId: 'version-1', sha256: 'e'.repeat(64) } })
  })

  it('rejects changed URL, buyer parameter, product and invalid signature before local HMAC', () => {
    const { privateKey, publicKey } = generateKeyPairSync('ed25519')
    const port = createSignedReviewedVideoOfferPort({ taskType: 'owner_video_v1',
      publicKeys: { 'shanghai-1': publicKey } })
    const original = { ...bareOffer, reviewedVideoOrder: signed(bareOffer, privateKey) }
    const alteredPayload = JSON.parse(Buffer.from(original.reviewedVideoOrder.payload_b64u,
      'base64url').toString('utf8')) as { order: { product_id: string } }
    alteredPayload.order.product_id = 'different-product'
    const context = { receivedAt, workerId: 'worker-1' }
    expect(port.verifyOffer(original, context)).not.toBeNull()
    for (const changed of [
      { ...original, inputRefs: ['https://storage.example.test/other'] },
      { ...original, params: { ...params, prompt: '篡改提示词' } },
      { ...original, reviewedVideoOrder: { ...original.reviewedVideoOrder,
        payload_b64u: Buffer.from(JSON.stringify(alteredPayload)).toString('base64url') } },
      { ...original, reviewedVideoOrder: { ...original.reviewedVideoOrder as object,
        signature_b64u: Buffer.alloc(64, 1).toString('base64url') } },
      { ...original, leaseTokenSha256: '0'.repeat(64) },
    ]) {
      expect(port.verifyOffer(changed, context)).toBeNull()
    }
    expect(port.verifyOffer({ ...bareOffer, reviewedVideoOrder: undefined }, context)).toBeNull()
  })
})
