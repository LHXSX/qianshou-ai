import { createHmac } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { assignmentFingerprint, verifyTaskAssignment } from '../../src/envelope-security.ts'
import { parseNodeTaskLease } from '../../src/node-lease.ts'
import type { EdgeTaskOffer } from '../../src/edge-worker/types.ts'
import {
  createInlineEdgeBinding,
  ISOLATED_INLINE_SESSION_DIGEST,
  ISOLATED_INLINE_SESSION_VERSION,
  type ReviewedVideoOfferProof,
} from '../../src/transport/inline-edge-bridge.ts'

const receivedAt = '2026-09-17T04:00:00.000Z'

function offer(overrides: Partial<EdgeTaskOffer> = {}): EdgeTaskOffer {
  return Object.freeze({
    workerId: 'worker-1',
    workloadId: 'workload-1',
    shardId: 'shard-1',
    attempt: 0,
    taskType: 'word_count',
    runtime: 'node',
    inputKind: 'inline',
    inlineInput: 'count these words',
    inputRef: '',
    inputRefs: [],
    codeUrl: 'https://untrusted.example/script.py',
    codeSha256: '',
    timeoutSeconds: 60,
    verificationPolicy: 'semantic',
    executionModel: '',
    capability: '',
    capabilityVersion: '',
    ...overrides,
  })
}

function reviewedVideoFixture() {
  const objectKey = 'v8/input/first-frame.png'
  const getUrl = `https://storage.example.test/${objectKey}?signed=1&versionId=version-1`
  const task = offer({ taskType: 'owner_video_v1', runtime: 'python3', inputKind: 'multi_file',
    inlineInput: null, inputRef: getUrl, inputRefs: [getUrl], codeUrl: '',
    executionModel: 'runtime_v2', runtimeApi: '2.0',
    capability: 'video.render', capabilityVersion: 'registry-v1', verificationPolicy: 'semantic',
    reviewedVideoOrder: {},
    params: { prompt: '海面上的云', input_manifest: '{}', _reviewed_video_input: {} } })
  const proof: ReviewedVideoOfferProof = {
    identity: { workerId: task.workerId, workloadId: task.workloadId,
      shardId: task.shardId, attempt: task.attempt },
    orderId: '9639503a-0cd6-40d0-a326-e66c4bb56dd1',
    productId: '8683e6c5-ce57-43cd-8375-16b5a213563a',
    publicationId: 'dc091b4a-426f-471c-be50-e859aed2e14c',
    artifactDigest: `sha256:${'a'.repeat(64)}`,
    contractSha256: `sha256:${'c'.repeat(64)}`,
    approvedContractDigest: `sha256:${'d'.repeat(64)}`,
    ownerAccountId: 167, customerAccountId: 52,
    taskType: 'owner_video_v1', capabilityVersion: 'reviewed-v1',
    packageDigest: 'b'.repeat(64), maxOutputBytes: 100 * 1024 * 1024,
    leaseExpiresAt: '2026-09-17T04:00:50.000Z',
    inputGetUrl: getUrl, values: { prompt: '海面上的云' },
    firstFrame: { slot: 'first_frame', bucket: 'qianshou-input', objectKey,
      objectVersionId: 'version-1', contentType: 'image/png', sizeBytes: 1024,
      sha256: 'e'.repeat(64) },
  }
  return { task, proof }
}

describe('inline Edge HMAC bridge', () => {
  it('signs an inline offer that verifyTaskAssignment accepts and never fetches code_url', async () => {
    const fetchImpl = vi.fn()
    vi.stubGlobal('fetch', fetchImpl)
    const sessionKey = Buffer.alloc(32, 9)
    const binding = createInlineEdgeBinding({
      nodeId: 'node-edge-1',
      allowedTaskTypes: ['word_count'],
      maxOutputBytes: 4096,
      sessionKey,
    })
    const mapped = binding.bridge.toNodeOffer(offer(), { receivedAt, workerId: 'worker-1' })
    expect('refuse' in mapped).toBe(false)
    if ('refuse' in mapped) return
    expect(mapped.attempt).toBe(1)
    expect(mapped.envelope.taskId).toBe('workload-1.shard-1')
    expect(mapped.envelope.capabilityId).toBe('text.transform')
    expect(mapped.envelope.capabilityVersion).toBe(ISOLATED_INLINE_SESSION_VERSION)
    expect(mapped.envelope.inputRefs).toEqual([])
    expect(mapped.signature).toMatch(/^[a-f0-9]{64}$/u)
    expect(JSON.stringify(mapped)).not.toContain('untrusted.example')
    expect(fetchImpl).not.toHaveBeenCalled()
    const credential = await verifyTaskAssignment({
      envelope: mapped.envelope,
      attempt: mapped.attempt,
      capabilityPluginDigest: ISOLATED_INLINE_SESSION_DIGEST,
      leaseExpiresAt: mapped.leaseExpiresAt,
      receivedAt: mapped.receivedAt,
    }, mapped.signature, binding.verifySignature)
    expect(credential.verified).toBe(true)
    const fingerprint = assignmentFingerprint({
      envelope: mapped.envelope,
      attempt: mapped.attempt,
      capabilityPluginDigest: ISOLATED_INLINE_SESSION_DIGEST,
      leaseExpiresAt: mapped.leaseExpiresAt,
      receivedAt: mapped.receivedAt,
    })
    expect(mapped.signature).toBe(createHmac('sha256', sessionKey).update(fingerprint).digest('hex'))
    const lease = binding.leaseOf(mapped.envelope.taskId, mapped.attempt, mapped.leaseExpiresAt)
    expect(lease.ownerNodeId).toBe('node-edge-1')
    expect(lease.idempotencyKey).toBe(mapped.envelope.idempotencyKey)
    expect(() => binding.leaseOf(mapped.envelope.taskId, mapped.attempt, '2026-09-17T00:00:00.000Z'))
      .toThrow('COMPUTE_INLINE_LEASE_UNKNOWN')
    vi.unstubAllGlobals()
  })

  /**
   * AT-04/05/06/13/14/15 全都是"节点零痕迹"的那条缺陷的回归测试。
   *
   * 为什么原来的用例抓不到它：上面那条用例把 `capabilityPluginDigest` **手工**传进
   * `verifyTaskAssignment`，而线上路径是 `digestOf(leaseOf(...))`——租约经过
   * `parseNodeTaskLease` 后只剩租约自身字段，digest 被丢掉，校验侧于是用**不含 digest**
   * 的指纹去比一个**含 digest** 的签名，验签必然失败，`runtime.receiveOffer()` 再静默返回。
   * 所以这里必须走**产品真实的读法**：从 `leaseOf()` 的返回值里取 digest。
   */
  it('keeps the plugin digest readable from the lease so the real verification path accepts the signature', async () => {
    const binding = createInlineEdgeBinding({
      nodeId: 'node-edge-1',
      allowedTaskTypes: ['word_count'],
      maxOutputBytes: 4096,
      sessionKey: Buffer.alloc(32, 7),
    })
    const mapped = binding.bridge.toNodeOffer(offer(), { receivedAt, workerId: 'worker-1' })
    expect('refuse' in mapped).toBe(false)
    if ('refuse' in mapped) return
    const level = binding.leaseOf(mapped.envelope.taskId, mapped.attempt, mapped.leaseExpiresAt)
    // 与节点侧 `digestOf()` 同一条判据：只有 64 位小写十六进制才算数。
    const digest = /^[a-f0-9]{64}$/u.test(String((level as { capabilityPluginDigest?: unknown }).capabilityPluginDigest))
      ? (level as { capabilityPluginDigest: string }).capabilityPluginDigest
      : undefined
    expect(digest).toBe(ISOLATED_INLINE_SESSION_DIGEST)
    const credential = await verifyTaskAssignment({
      envelope: mapped.envelope,
      attempt: mapped.attempt,
      capabilityPluginDigest: digest,
      leaseExpiresAt: mapped.leaseExpiresAt,
      receivedAt: mapped.receivedAt,
    }, mapped.signature, binding.verifySignature)
    expect(credential.verified).toBe(true)
    // 租约本身仍是合法租约：多出来的 digest 不影响 parseNodeTaskLease 的判据。
    expect(parseNodeTaskLease(level)).toMatchObject({
      taskId: mapped.envelope.taskId, attempt: mapped.attempt, expiresAt: mapped.leaseExpiresAt,
    })
  })

  it('refuses file-shaped inputs, unknown types and empty inline payloads', () => {
    const binding = createInlineEdgeBinding({
      nodeId: 'node-edge-1',
      allowedTaskTypes: ['word_count'],
      maxOutputBytes: 4096,
      sessionKey: Buffer.alloc(32, 1),
    })
    const context = { receivedAt, workerId: 'worker-1' }
    expect(binding.bridge.toNodeOffer(offer({ taskType: 'shell' }), context)).toEqual({ refuse: 'TASK_TYPE_DENIED' })
    expect(binding.bridge.toNodeOffer(offer({ inputKind: 'file' }), context)).toEqual({ refuse: 'INPUT_KIND_UNSUPPORTED' })
    expect(binding.bridge.toNodeOffer(offer({ inputRef: 'object://x' }), context)).toEqual({ refuse: 'FILE_INPUT_UNSUPPORTED' })
    expect(binding.bridge.toNodeOffer(offer({ inputRefs: ['object://y'] }), context)).toEqual({ refuse: 'FILE_INPUT_UNSUPPORTED' })
    expect(binding.bridge.toNodeOffer(offer({ inlineInput: '   ' }), context)).toEqual({ refuse: 'INLINE_INPUT_MISSING' })
    expect(binding.bridge.toNodeOffer(offer({ inlineInput: null }), context)).toEqual({ refuse: 'INLINE_INPUT_MISSING' })
  })

  it('maps only an exact reviewed order proof to a signed file-input video attempt', async () => {
    const { task, proof } = reviewedVideoFixture()
    const verifyOffer = vi.fn(() => proof)
    const binding = createInlineEdgeBinding({ nodeId: 'node-edge-1',
      allowedTaskTypes: ['owner_video_v1'], maxOutputBytes: 4096,
      reviewedVideo: { taskType: 'owner_video_v1', verifyOffer },
      sessionKey: Buffer.alloc(32, 3) })
    const mapped = binding.bridge.toNodeOffer(task, { receivedAt, workerId: 'worker-1' })
    expect('refuse' in mapped).toBe(false)
    if ('refuse' in mapped) return
    expect(mapped.envelope).toMatchObject({ capabilityId: 'video.render',
      capabilityVersion: 'reviewed-v1', maxOutputBytes: proof.maxOutputBytes,
      inputRefs: [{ name: 'first_frame', bytes: 1024, sha256: 'e'.repeat(64) }],
      parameters: { orderId: proof.orderId, productId: proof.productId,
        publicationId: proof.publicationId, edgeIdentity: proof.identity,
        firstFrame: proof.firstFrame, values: proof.values } })
    expect(mapped.leaseExpiresAt).toBe(proof.leaseExpiresAt)
    const lease = binding.leaseOf(mapped.envelope.taskId, mapped.attempt, mapped.leaseExpiresAt)
    expect(binding.edgeIdentityOf(mapped.envelope.taskId, mapped.attempt, mapped.leaseExpiresAt))
      .toEqual(proof.identity)
    expect(() => binding.edgeIdentityOf(mapped.envelope.taskId, mapped.attempt,
      '2026-09-17T04:01:01.000Z')).toThrow('COMPUTE_INLINE_LEASE_UNKNOWN')
    expect(lease.capabilityPluginDigest).toBe(proof.packageDigest)
    const verification = await verifyTaskAssignment({ envelope: mapped.envelope, attempt: mapped.attempt,
      capabilityPluginDigest: lease.capabilityPluginDigest, leaseExpiresAt: mapped.leaseExpiresAt,
      receivedAt: mapped.receivedAt }, mapped.signature, binding.verifySignature)
    expect(verification.verified).toBe(true)
    expect(verifyOffer).toHaveBeenCalledOnce()
    const returned = { type: 'task.return' as const, taskId: mapped.envelope.taskId,
      attempt: mapped.attempt, outputs: [{ name: 'result.mp4', bytes: 12, sha256: 'f'.repeat(64) }] }
    expect(binding.bridge.toEdgeResult(returned)).toEqual({ refuse: 'RESULT_ATTEMPT_UNAVAILABLE' })
    const artifact = { schema: 'artifact.v1' as const,
      object_key: 'v8/account-52/workload-workload-1/shard-shard-1/result/r/result.mp4',
      object_version_id: 'version-1', filename: 'result.mp4', size_bytes: 12,
      content_type: 'video/mp4', sha256: 'f'.repeat(64), result_id: 'r',
      shard_id: 'shard-1', workload_id: 'workload-1', account_id: 52 }
    expect(() => binding.rememberReviewedArtifact(mapped.envelope.taskId, mapped.attempt + 1, artifact, 3))
      .toThrow('COMPUTE_REVIEWED_VIDEO_RESULT_INVALID')
    binding.rememberReviewedArtifact(mapped.envelope.taskId, mapped.attempt, artifact, 3)
    expect(binding.bridge.toEdgeResult(returned)).toEqual({ artifact, elapsedMs: 3 })
    expect(binding.bridge.toEdgeResult({ ...returned, attempt: mapped.attempt + 1 }))
      .toEqual({ refuse: 'RESULT_ATTEMPT_UNAVAILABLE' })
  })

  it('keeps the old inline contract closed to file offers and refuses stale or mismatched video proof', () => {
    const { task, proof } = reviewedVideoFixture()
    const context = { receivedAt, workerId: 'worker-1' }
    const old = createInlineEdgeBinding({ nodeId: 'node-edge-1',
      allowedTaskTypes: ['owner_video_v1'], maxOutputBytes: 4096 })
    expect(old.bridge.toNodeOffer(task, context)).toEqual({ refuse: 'INPUT_KIND_UNSUPPORTED' })
    let selected: ReviewedVideoOfferProof | null = proof
    const binding = createInlineEdgeBinding({ nodeId: 'node-edge-1',
      allowedTaskTypes: ['owner_video_v1'], maxOutputBytes: 4096,
      reviewedVideo: { taskType: 'owner_video_v1', verifyOffer: () => selected } })
    const check = (change: Partial<ReviewedVideoOfferProof>) => {
      selected = { ...proof, ...change }
      expect(binding.bridge.toNodeOffer(task, context)).toEqual({ refuse: 'REVIEWED_VIDEO_ORDER_INVALID' })
    }
    check({ identity: { ...proof.identity, attempt: 2 } })
    check({ productId: 'wrong-product' })
    check({ leaseExpiresAt: '2026-09-17T04:01:01.000Z' })
    check({ firstFrame: { ...proof.firstFrame, objectVersionId: 'null' } })
    selected = proof
    expect(binding.bridge.toNodeOffer({ ...task, inputRefs: ['v8/input/other.png'] }, context))
      .toEqual({ refuse: 'REVIEWED_VIDEO_OFFER_MISMATCH' })
    expect(binding.bridge.toNodeOffer({ ...task, params: { order_id: 'another' } }, context))
      .toEqual({ refuse: 'REVIEWED_VIDEO_OFFER_MISMATCH' })
    selected = null
    expect(binding.bridge.toNodeOffer(task, context)).toEqual({ refuse: 'REVIEWED_VIDEO_ORDER_UNAVAILABLE' })
  })

  it('returns remembered UTF-8 bytes and refuses when nothing was stored', () => {
    const binding = createInlineEdgeBinding({
      nodeId: 'node-edge-1',
      allowedTaskTypes: ['word_count'],
      maxOutputBytes: 4096,
      sessionKey: Buffer.alloc(32, 2),
    })
    expect(binding.bridge.toEdgeResult({
      type: 'task.return', taskId: 'workload-1.shard-1', attempt: 1,
      outputs: [{ name: 'result.txt', bytes: 4, sha256: 'a'.repeat(64) }],
    })).toEqual({ refuse: 'RESULT_BYTES_UNAVAILABLE' })
    binding.rememberResult('workload-1.shard-1', '真实回传\n', 19)
    expect(binding.bridge.toEdgeResult({
      type: 'task.return', taskId: 'workload-1.shard-1', attempt: 1,
      outputs: [{ name: 'result.txt', bytes: 13, sha256: 'b'.repeat(64) }],
    })).toEqual({ inlineOutputUtf8: '真实回传\n', elapsedMs: 19 })
  })

  it('rejects invalid construction, unknown leases and oversized remembered results', async () => {
    expect(() => createInlineEdgeBinding({
      nodeId: 'bad node', allowedTaskTypes: ['word_count'], maxOutputBytes: 4096, sessionKey: Buffer.alloc(32, 1),
    })).toThrow('COMPUTE_CONTRIBUTOR_NODE_ID_INVALID')
    expect(() => createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: ['word_count'], maxOutputBytes: 0, sessionKey: Buffer.alloc(32, 1),
    })).toThrow('COMPUTE_INLINE_OUTPUT_LIMIT_INVALID')
    expect(() => createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: ['word_count'], maxOutputBytes: 4096, sessionKey: Buffer.alloc(16, 1),
    })).toThrow('COMPUTE_INLINE_SESSION_KEY_INVALID')
    expect(() => createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: ['word_count', 'word_count'], maxOutputBytes: 4096, sessionKey: Buffer.alloc(32, 1),
    })).toThrow('COMPUTE_INLINE_TASK_TYPES_INVALID')
    expect(() => createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: ['bad type'], maxOutputBytes: 4096, sessionKey: Buffer.alloc(32, 1),
    })).toThrow('COMPUTE_INLINE_TASK_TYPES_INVALID')
    expect(() => createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: [1 as never], maxOutputBytes: 4096, sessionKey: Buffer.alloc(32, 1),
    })).toThrow('COMPUTE_INLINE_TASK_TYPES_INVALID')
    expect(() => createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: { length: 1 } as never, maxOutputBytes: 4096, sessionKey: Buffer.alloc(32, 1),
    })).toThrow('COMPUTE_INLINE_TASK_TYPES_INVALID')
    expect(() => createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: Array.from({ length: 65 }, (_, index) => `t${index}`),
      maxOutputBytes: 4096, sessionKey: Buffer.alloc(32, 1),
    })).toThrow('COMPUTE_INLINE_TASK_TYPES_INVALID')
    expect(() => createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: ['word_count'], maxOutputBytes: 1.5, sessionKey: Buffer.alloc(32, 1),
    })).toThrow('COMPUTE_INLINE_OUTPUT_LIMIT_INVALID')
    expect(() => createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: ['word_count'], maxOutputBytes: 4096, sessionKey: 'x' as never,
    })).toThrow('COMPUTE_INLINE_SESSION_KEY_INVALID')
    const generated = createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: ['word_count'], maxOutputBytes: 4096,
    })
    const mappedGenerated = generated.bridge.toNodeOffer(offer(), { receivedAt, workerId: 'worker-1' })
    expect('refuse' in mappedGenerated).toBe(false)
    const binding = createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: ['word_count'], maxOutputBytes: 4, sessionKey: Buffer.alloc(32, 4),
    })
    expect(binding.verifySignature('a'.repeat(64), 'not-hex')).toBe(false)
    expect(await binding.verifySignature('a'.repeat(64), 'b'.repeat(64))).toBe(false)
    expect(() => binding.leaseOf('missing', 1, receivedAt)).toThrow('COMPUTE_INLINE_LEASE_UNKNOWN')
    expect(() => binding.rememberResult('', 'x', 1)).toThrow('COMPUTE_INLINE_RESULT_INVALID')
    expect(() => binding.rememberResult('id', 1 as never, 1)).toThrow('COMPUTE_INLINE_RESULT_INVALID')
    expect(() => binding.rememberResult('id', 'x', -1)).toThrow('COMPUTE_INLINE_RESULT_INVALID')
    expect(() => binding.rememberResult('id', 'x', 1.5)).toThrow('COMPUTE_INLINE_RESULT_INVALID')
    binding.rememberResult('workload-1.shard-1', '12345', 1)
    expect(binding.bridge.toEdgeResult({
      type: 'task.return', taskId: 'workload-1.shard-1', attempt: 1,
      outputs: [{ name: 'result.txt', bytes: 5, sha256: 'c'.repeat(64) }],
    })).toEqual({ refuse: 'RESULT_TOO_LARGE' })
  })

  it('refuses oversized inline input, out-of-range attempts and unusable deadlines', () => {
    const binding = createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: ['word_count'], maxOutputBytes: 4096, sessionKey: Buffer.alloc(32, 6),
    })
    const context = { receivedAt, workerId: 'worker-1' }
    expect(binding.bridge.toNodeOffer(offer({ inlineInput: 'x'.repeat(200_000) }), context)).toEqual({ refuse: 'INLINE_INPUT_TOO_LARGE' })
    expect(binding.bridge.toNodeOffer(offer({ attempt: 1_000_000 }), context)).toEqual({ refuse: 'ATTEMPT_OUT_OF_RANGE' })
    expect(binding.bridge.toNodeOffer(offer({ timeoutSeconds: 0 }), context)).toEqual({ refuse: 'DEADLINE_INVALID' })
    expect(binding.bridge.toNodeOffer(offer({ timeoutSeconds: 1.5 }), context)).toEqual({ refuse: 'DEADLINE_INVALID' })
    expect(binding.bridge.toNodeOffer(offer({ timeoutSeconds: Number.MAX_SAFE_INTEGER }), context)).toEqual({ refuse: 'DEADLINE_INVALID' })
    expect(binding.bridge.toNodeOffer(offer(), { receivedAt: 'not-a-date', workerId: 'worker-1' })).toEqual({ refuse: 'DEADLINE_INVALID' })
    expect(binding.bridge.toNodeOffer(offer(), { receivedAt: '2026-09-17T04:00:00Z', workerId: 'worker-1' })).toEqual({ refuse: 'ENVELOPE_INVALID' })
    const iso = Date.prototype.toISOString
    Date.prototype.toISOString = function toISOString() { return 'not-iso' }
    try {
      expect(binding.bridge.toNodeOffer(offer(), context)).toEqual({ refuse: 'DEADLINE_INVALID' })
    } finally {
      Date.prototype.toISOString = iso
    }
  })

  it('hashes a task id that would exceed the envelope identity limit', () => {
    const binding = createInlineEdgeBinding({
      nodeId: 'node-edge-1', allowedTaskTypes: ['word_count'], maxOutputBytes: 4096, sessionKey: Buffer.alloc(32, 8),
    })
    const mapped = binding.bridge.toNodeOffer(offer({
      workloadId: 'w'.repeat(80),
      shardId: 's'.repeat(80),
    }), { receivedAt, workerId: 'worker-1' })
    expect('refuse' in mapped).toBe(false)
    if ('refuse' in mapped) return
    expect(mapped.envelope.taskId).toMatch(/^[a-f0-9]{64}$/u)
  })
})
