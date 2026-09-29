import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QianshouCoreClient } from '../src/core-client.ts'
import type { DeveloperTaskCreateBody, DeveloperTaskEstimate } from '../src/developer-task.ts'
import { ComputeCapabilityId, ComputeWorkloadId } from '../src/protocol.ts'
import { COMFY_VIDEO_RUNNER_ABI, comfyVideoPublicContractDigest } from '../src/comfy-video-public-contract.ts'
import { parseReviewedVideoTaskInput } from '../src/reviewed-video-task-input.ts'
import { ComputeService } from '../src/service.ts'
import { ComputeDraftStore } from '../src/store.ts'
import { SubmissionLedger } from '../src/submission-ledger.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture(estimate: Partial<DeveloperTaskEstimate> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'qianshou-quoted-task-'))
  roots.push(root)
  const store = new ComputeDraftStore({ path: join(root, 'plans.json'), maxDrafts: 8, maxBytes: 65536 })
  const ledger = new SubmissionLedger({ path: join(root, 'ledger.json'), maxRecords: 8, maxBytes: 65536 })
  const quote = vi.fn(async (_body: DeveloperTaskCreateBody): Promise<DeveloperTaskEstimate> => ({
    recommendedBudget: '0.75',
    requestedBudget: '0.50',
    expiresAt: Math.floor(Date.now() / 1000) + 300,
    balanceEnough: true,
    priceBasis: 'server-rule',
    settingsVersion: '1',
    billingMode: 'server_price',
    name: '图像任务',
    quoteToken: 'host-only-ticket',
    ...estimate,
  }))
  const create = vi.fn(async () => ({
    id: ComputeWorkloadId('workload-quoted'), status: 'CREATED', progress: 0, resultAvailable: false,
  }))
  const client = {
    getIdentity: vi.fn(async () => ({ accountId: 41, username: 'owner', role: 'user', status: 'active' })),
    getDeveloperTaskTypes: vi.fn(async () => [{
      taskType: 'video_compress', acceptedInputKinds: ['inline'], defaultInputKind: 'inline',
      capabilityId: ComputeCapabilityId('media.transcode'),
    }]),
    estimateDeveloperTask: quote,
    createDeveloperTask: create,
    close: async () => {},
  } as unknown as QianshouCoreClient
  const service = new ComputeService(client, store, () => true, undefined, undefined, ledger)
  const draft = await store.create({
    capabilityId: ComputeCapabilityId('media.transcode'), goal: '做一张图', budgetMinor: 50,
    currency: 'CNY', maxNodes: 1,
  })
  await store.confirm(draft.id, 'approved')
  return { service, store, ledger, draft, quote, create, client }
}

describe('Host developer-task quote gate', () => {
  it('keeps an exact selected product through plan, estimate and create while rereading its listing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-product-call-'))
    roots.push(root)
    const store = new ComputeDraftStore({ path: join(root, 'plans.json'), maxDrafts: 8, maxBytes: 65536 })
    const ledger = new SubmissionLedger({ path: join(root, 'ledger.json'), maxRecords: 8, maxBytes: 65536 })
    const selected = { productId: '11111111-2222-4333-8444-555555555555',
      publicationId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee', ownerId: 167, version: '1.2' }
    const selectedWire = { product_id: selected.productId, publication_id: selected.publicationId,
      owner_id: selected.ownerId, version: selected.version }
    const assertSelectedProduct = vi.fn().mockResolvedValue(undefined)
    const estimate = vi.fn(async (_body: DeveloperTaskCreateBody): Promise<DeveloperTaskEstimate> => ({
      recommendedBudget: '0.50', requestedBudget: '0.00',
      expiresAt: Math.floor(Date.now() / 1000) + 300, balanceEnough: true,
      priceBasis: 'server-rule', settingsVersion: '1', billingMode: 'server_price',
      name: '用户技能', quoteToken: 'exact-product-ticket',
    }))
    const create = vi.fn(async () => ({ id: ComputeWorkloadId('workload-product'), status: 'CREATED',
      progress: 0, resultAvailable: false }))
    const client = { getIdentity: vi.fn(async () => ({ accountId: 41, username: 'owner',
      role: 'user', status: 'active' })), getDeveloperTaskTypes: vi.fn(async () => [{
      taskType: 'seller_product_v1', acceptedInputKinds: ['inline'], defaultInputKind: 'inline',
      requiredParams: [],
    }]), assertSelectedProduct, estimateDeveloperTask: estimate, createDeveloperTask: create, close: async () => {} }
    const service = new ComputeService(client as unknown as QianshouCoreClient,
      store, () => true, undefined, undefined, ledger)
    const input = { capabilityId: 'seller_product_v1', goal: '帮我处理', budgetMinor: 0,
      currency: 'CNY', maxNodes: null, expectedProduct: selected }
    await expect(service.createPlan({ ...input, expectedProduct: { ...selected, ownerId: '167' } }))
      .rejects.toThrow('INVALID_COMPUTE_FIELD: expectedProduct')
    const draft = await service.createPlan(input)
    expect((await store.list())[0]?.request.expectedProduct).toEqual(selected)
    await service.confirmPlan({ id: draft.id, decision: 'approved' })
    assertSelectedProduct.mockRejectedValueOnce(new Error('changed'))
    await expect(service.quotePlan({ id: draft.id })).rejects.toThrow('changed')
    expect(estimate).not.toHaveBeenCalled()
    const quoted = await service.quotePlan({ id: draft.id })
    expect(estimate.mock.calls[0]?.[0]).toMatchObject({ selected_product: selectedWire })
    assertSelectedProduct.mockRejectedValueOnce(new Error('changed'))
    await expect(service.confirmQuotedPlan({ id: draft.id, quoteId: quoted.quoteId,
      amount: quoted.recommendedBudget })).rejects.toThrow('changed')
    expect(create).not.toHaveBeenCalled()
    expect(await ledger.list()).toEqual([])
    const current = await service.quotePlan({ id: draft.id })
    await service.confirmQuotedPlan({ id: draft.id, quoteId: current.quoteId,
      amount: current.recommendedBudget })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ selected_product: selectedWire }), undefined)
    expect(assertSelectedProduct).toHaveBeenCalledTimes(6)
    await service.close()
  })

  it('persists the buyer-confirmed video review and refuses changed catalog versions before quote or paid POST', async () => {
    const root = await mkdtemp(join(tmpdir(), 'qianshou-video-review-'))
    roots.push(root)
    const store = new ComputeDraftStore({ path: join(root, 'plans.json'), maxDrafts: 8, maxBytes: 65536 })
    const ledger = new SubmissionLedger({ path: join(root, 'ledger.json'), maxRecords: 8, maxBytes: 65536 })
    const contract = { schema: 'qianshou.comfy-video-public-contract.v1', taskType: 'owner_video_v1',
      capabilityId: 'video.render', graph: { format: 'comfyui-api', sha256: 'a'.repeat(64), nodeCount: 3 },
      inputSlots: [
        { name: 'prompt', kind: 'text', nodeId: '2', field: 'prompt', maxUtf8Bytes: 4096 },
        { name: 'first_frame', kind: 'artifact_ref', nodeId: '100', field: 'image',
          mimeType: 'image/png', maxBytes: 16 * 1024 * 1024 },
      ],
      outputs: [{ nodeId: '27', classType: 'VHS_VideoCombine', kind: 'artifact_ref', mimeType: 'video/mp4' }],
      runner: { abi: COMFY_VIDEO_RUNNER_ABI, sourceSha256: 'b'.repeat(64) },
      dependencyManifestSha256: 'c'.repeat(64),
      limits: { maxDurationSeconds: 5, maxFrames: 120, maxWidth: 1344, maxHeight: 768,
        maxVramMiB: 16384, maxInputBytes: 17 * 1024 * 1024, maxOutputBytes: 64 * 1024 * 1024,
        timeoutSeconds: 600 },
    }
    const reviewedVideoInput = parseReviewedVideoTaskInput({
      schema: 'qianshou.reviewed-video-task-input.v1', status: 'approved',
      publication_id: '11111111-2222-4333-8444-555555555555',
      approved_contract_digest: comfyVideoPublicContractDigest(contract),
      public_contract: contract, first_frame_slot: 'first_frame', prompt_slot: 'prompt',
      first_frame_source: { kind: 'uploaded_input_manifest', parameter: 'input_manifest', index: 0 },
      prompt_param: 'prompt',
    }, 'owner_video_v1')
    const reviewedPublication = { schema: 'qianshou.reviewed-publication-selection.v1' as const,
      publication_id: reviewedVideoInput.publicationId,
      artifact_digest: `sha256:${'d'.repeat(64)}`,
      contract_sha256: `sha256:${'e'.repeat(64)}` }
    const type = { taskType: 'owner_video_v1', capabilityId: ComputeCapabilityId('video.render'),
      reviewedVideoInput, reviewedPublication,
      acceptedInputKinds: ['multi_file'], defaultInputKind: 'multi_file',
      requiredParams: ['input_manifest', 'prompt'], formSchemaVersion: 'qianshou.task-input-form.v1',
      formReady: true, inputSchema: { oneOf: [] },
      paramsSchema: { type: 'object' as const, additionalProperties: false as const,
        required: ['input_manifest', 'prompt'], properties: {
          input_manifest: { type: 'string' as const }, prompt: { type: 'string' as const },
        } },
    }
    let current = type
    const estimate = vi.fn(async (_body: DeveloperTaskCreateBody): Promise<DeveloperTaskEstimate> => ({
      recommendedBudget: '0.50', requestedBudget: '0.00',
      expiresAt: Math.floor(Date.now() / 1000) + 300, balanceEnough: true,
      priceBasis: 'server-rule', settingsVersion: '1', billingMode: 'server_price',
      name: '视频任务', quoteToken: 'host-only-ticket',
    }))
    const create = vi.fn(async () => ({ id: ComputeWorkloadId('workload-video'), status: 'CREATED',
      progress: 0, resultAvailable: false }))
    const assertSelectedProduct = vi.fn(async () => {})
    let accountId: number | undefined = 41
    const client = { getIdentity: vi.fn(async () => ({ accountId, username: 'owner',
      role: 'user', status: 'active' })), getDeveloperTaskTypes: vi.fn(async () => [current]),
    assertSelectedProduct,
    estimateDeveloperTask: estimate, createDeveloperTask: create, close: async () => {} }
    const service = new ComputeService(client as unknown as QianshouCoreClient,
      store, () => true, undefined, undefined, ledger)
    const input = { capabilityId: ComputeCapabilityId('owner_video_v1'), goal: '海面小猫奔跑',
      params: { prompt: '海面小猫奔跑' }, budgetMinor: 0, currency: 'CNY', maxNodes: null,
      fileInput: { kind: 'multi_file', files: [{
        objectKey: `v8/account-41/reviewed-video/input/${'a'.repeat(32)}/frame.png`, filename: 'frame.png',
        bytes: 9, sha256: 'd'.repeat(64), contentType: 'image/png', objectVersionId: 'version-1',
      }] },
      expectedVideoReview: { publicationId: reviewedVideoInput.publicationId,
        approvedContractDigest: reviewedVideoInput.approvedContractDigest,
        artifactDigest: reviewedPublication.artifact_digest,
        contractSha256: reviewedPublication.contract_sha256 },
    }
    await expect(service.createPlan({ ...input,
      expectedVideoReview: { ...input.expectedVideoReview, approvedContractDigest: 'not-a-digest' },
    })).rejects.toThrow('INVALID_COMPUTE_FIELD: expectedVideoReview')
    await expect(service.createPlan({ ...input, expectedProduct: {
      productId: '33333333-3333-4333-8333-333333333333',
      publicationId: '22222222-2222-4222-8222-222222222222', ownerId: 41, version: '1',
    } })).rejects.toThrow('INVALID_COMPUTE_FIELD: expectedProduct')
    expect(await store.list()).toHaveLength(0)
    await expect(service.createPlan({ ...input, fileInput: { kind: 'multi_file', files: [{
      ...input.fileInput.files[0],
      objectKey: `v8/account-41/developer/${'a'.repeat(32)}/input/frame.png`,
    }] } })).rejects.toMatchObject({ code: 'COMPUTE_VIDEO_MIXED_INPUT_INVALID' })
    await expect(service.createPlan({ ...input, fileInput: { kind: 'multi_file', files: [{
      ...input.fileInput.files[0],
      objectKey: `v8/account-42/reviewed-video/input/${'a'.repeat(32)}/frame.png`,
    }] } })).rejects.toMatchObject({ code: 'COMPUTE_VIDEO_MIXED_INPUT_INVALID' })
    accountId = undefined
    await expect(service.createPlan(input)).rejects.toMatchObject({ code: 'COMPUTE_VIDEO_MIXED_INPUT_INVALID' })
    accountId = 41
    expect(await store.list()).toHaveLength(0)
    expect(estimate).not.toHaveBeenCalled()
    current = { ...type, reviewedVideoInput: { ...reviewedVideoInput,
      approvedContractDigest: `sha256:${'0'.repeat(64)}` } }
    await expect(service.createPlan(input)).rejects.toMatchObject({ code: 'COMPUTE_VIDEO_REVIEW_CHANGED' })
    expect(await store.list()).toHaveLength(0)
    current = type
    const draft = await service.createPlan(input)
    expect((await store.list())[0]?.request.expectedVideoReview).toEqual(input.expectedVideoReview)
    await service.confirmPlan({ id: draft.id, decision: 'approved' })
    accountId = 42
    await expect(service.quotePlan({ id: draft.id }))
      .rejects.toMatchObject({ code: 'COMPUTE_VIDEO_MIXED_INPUT_INVALID' })
    accountId = 41
    expect(estimate).not.toHaveBeenCalled()
    current = { ...type, reviewedVideoInput: { ...reviewedVideoInput,
      approvedContractDigest: `sha256:${'0'.repeat(64)}` } }
    await expect(service.quotePlan({ id: draft.id }))
      .rejects.toMatchObject({ code: 'COMPUTE_VIDEO_REVIEW_CHANGED' })
    expect(estimate).not.toHaveBeenCalled()
    current = type
    const firstQuote = await service.quotePlan({ id: draft.id })
    expect(estimate).toHaveBeenCalledTimes(1)
    expect(estimate.mock.calls[0]?.[0].reviewed_publication).toEqual(reviewedPublication)
    current = { ...type, reviewedVideoInput: { ...reviewedVideoInput,
      publicationId: '22222222-2222-4222-8222-222222222222' } }
    await expect(service.quotePlan({ id: draft.id }))
      .rejects.toMatchObject({ code: 'COMPUTE_VIDEO_REVIEW_CHANGED' })
    await expect(service.confirmQuotedPlan({ id: draft.id, quoteId: firstQuote.quoteId,
      amount: firstQuote.recommendedBudget })).rejects.toMatchObject({ code: 'COMPUTE_QUOTE_CONFIRMATION_INVALID' })
    current = type
    const quote = await service.quotePlan({ id: draft.id })
    accountId = 42
    await expect(service.confirmQuotedPlan({ id: draft.id, quoteId: quote.quoteId,
      amount: quote.recommendedBudget })).rejects.toMatchObject({ code: 'COMPUTE_VIDEO_MIXED_INPUT_INVALID' })
    accountId = 41
    expect(create).not.toHaveBeenCalled()
    expect(await ledger.list()).toEqual([])
    current = { ...type, reviewedVideoInput: { ...reviewedVideoInput,
      publicationId: '22222222-2222-4222-8222-222222222222' } }
    await expect(service.confirmQuotedPlan({ id: draft.id, quoteId: quote.quoteId,
      amount: quote.recommendedBudget })).rejects.toMatchObject({ code: 'COMPUTE_VIDEO_REVIEW_CHANGED' })
    expect(create).not.toHaveBeenCalled()
    expect(await ledger.list()).toEqual([])
    current = type
    const currentQuote = await service.quotePlan({ id: draft.id })
    await service.confirmQuotedPlan({ id: draft.id, quoteId: currentQuote.quoteId,
      amount: currentQuote.recommendedBudget })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      reviewed_publication: reviewedPublication,
    }), undefined)
    const selected = { productId: '33333333-3333-4333-8333-333333333333',
      publicationId: reviewedVideoInput.publicationId, ownerId: 41, version: '1' }
    const selectedWire = { product_id: selected.productId, publication_id: selected.publicationId,
      owner_id: selected.ownerId, version: selected.version }
    const productDraft = await service.createPlan({ ...input, expectedProduct: selected })
    await service.confirmPlan({ id: productDraft.id, decision: 'approved' })
    const productQuote = await service.quotePlan({ id: productDraft.id })
    expect(estimate).toHaveBeenLastCalledWith(expect.objectContaining({
      reviewed_publication: reviewedPublication, selected_product: selectedWire,
    }), undefined)
    await service.confirmQuotedPlan({ id: productDraft.id, quoteId: productQuote.quoteId,
      amount: productQuote.recommendedBudget })
    expect(create).toHaveBeenLastCalledWith(expect.objectContaining({
      reviewed_publication: reviewedPublication, selected_product: selectedWire,
    }), undefined)
    expect(assertSelectedProduct).toHaveBeenCalledTimes(3)
    await service.close()
  })

  it('binds the public quote to the exact local plan and requested capability while exposing its actual landing contract', async () => {
    const { service, draft, create, quote, ledger } = await fixture()
    const types = await service.taskTypes()
    expect(types[0]).toMatchObject({ taskType: 'video_compress', capabilityId: 'media.transcode' })
    const view = await service.quotePlan({ id: draft.id })
    expect(view).toMatchObject({ planId: draft.id, capabilityId: 'media.transcode',
      taskType: 'video_compress', recommendedBudget: '0.75' })
    expect(quote).toHaveBeenCalledWith(expect.objectContaining({ task_type: 'video_compress' }), undefined)
    expect(view).not.toHaveProperty('quoteToken')
    expect(create).not.toHaveBeenCalled()
    expect(await ledger.list()).toEqual([])
    await service.close()
  })

  it('cannot turn local approval or a forged quote into a paid submission', async () => {
    const { service, draft, create } = await fixture()
    await expect(service.publishPlan({ id: draft.id })).rejects.toMatchObject({ code: 'COMPUTE_QUOTE_CONFIRMATION_REQUIRED' })
    await expect(service.confirmQuotedPlan({ id: draft.id, quoteId: 'a'.repeat(32), amount: '0.75' }))
      .rejects.toMatchObject({ code: 'COMPUTE_QUOTE_CONFIRMATION_INVALID' })
    expect(create).not.toHaveBeenCalled()
    await service.close()
  })

  it('refuses an unaffordable or expired quote before creating any ledger intent', async () => {
    const insufficient = await fixture({ balanceEnough: false })
    const view = await insufficient.service.quotePlan({ id: insufficient.draft.id })
    expect(view.balanceEnough).toBe(false)
    await expect(insufficient.service.confirmQuotedPlan({
      id: insufficient.draft.id, quoteId: view.quoteId, amount: view.recommendedBudget,
    })).rejects.toMatchObject({ code: 'COMPUTE_QUOTE_BALANCE_INSUFFICIENT' })
    expect(await insufficient.ledger.list()).toEqual([])
    expect(insufficient.create).not.toHaveBeenCalled()
    await insufficient.service.close()

    const expired = await fixture({ expiresAt: Math.floor(Date.now() / 1000) - 1 })
    await expect(expired.service.quotePlan({ id: expired.draft.id })).rejects.toMatchObject({ code: 'COMPUTE_QUOTE_EXPIRED' })
    expect(await expired.ledger.list()).toEqual([])
    expect(expired.create).not.toHaveBeenCalled()
    await expired.service.close()

    const afterDisplay = await fixture()
    const visible = await afterDisplay.service.quotePlan({ id: afterDisplay.draft.id })
    const clock = vi.spyOn(Date, 'now').mockReturnValue((visible.expiresAt + 1) * 1000)
    try {
      await expect(afterDisplay.service.confirmQuotedPlan({
        id: afterDisplay.draft.id, quoteId: visible.quoteId, amount: visible.recommendedBudget,
      })).rejects.toMatchObject({ code: 'COMPUTE_QUOTE_EXPIRED' })
      expect(await afterDisplay.ledger.list()).toEqual([])
      expect(afterDisplay.create).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
    await afterDisplay.service.close()
  })

  it('a changed server amount requires a fresh visible quote and a new key', async () => {
    const { service, draft, quote, create, ledger } = await fixture()
    const first = await service.quotePlan({ id: draft.id })
    quote.mockImplementationOnce(async () => ({
      recommendedBudget: '0.76', requestedBudget: '0.50',
      expiresAt: Math.floor(Date.now() / 1000) + 300,
      balanceEnough: true, priceBasis: 'new-server-rule', settingsVersion: '2',
      billingMode: 'server_price', name: '图像任务', quoteToken: 'second-private-ticket',
    }))
    const second = await service.quotePlan({ id: draft.id })
    expect(second.quoteId).not.toBe(first.quoteId)
    expect(second.recommendedBudget).toBe('0.76')
    const firstKey = quote.mock.calls[0]?.[0].idempotency_key
    const secondKey = quote.mock.calls[1]?.[0].idempotency_key
    expect(firstKey).not.toBe(secondKey)
    await expect(service.confirmQuotedPlan({ id: draft.id, quoteId: first.quoteId, amount: '0.75' }))
      .rejects.toMatchObject({ code: 'COMPUTE_QUOTE_CONFIRMATION_INVALID' })
    expect(create).not.toHaveBeenCalled()
    await service.confirmQuotedPlan({ id: draft.id, quoteId: second.quoteId, amount: '0.76' })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      idempotency_key: secondKey, budget: '0.76', quote_token: 'second-private-ticket',
    }), undefined)
    expect((await ledger.list())[0]).toMatchObject({ idempotencyKey: secondKey, status: 'CONFIRMED' })
    await service.close()
  })
})
