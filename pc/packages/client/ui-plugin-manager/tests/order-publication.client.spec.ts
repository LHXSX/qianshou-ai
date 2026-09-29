import { expect, it, vi } from 'vitest'
import { OrderPublicationController, type OrderPublicationRemote } from '../src/client/order-publication-controller.ts'
import type { LocalPluginCandidateView } from '../src/client/local-plugin-candidates-controller.ts'

const candidate: LocalPluginCandidateView = {
  draftId: 'plugin_draft_12345678-1234-1234-1234-123456789abc', packageName: 'qianshou-local-123',
  packagePath: '/private/candidate-123', toolName: 'qianshou_local_123',
  sourceDigest: 'a'.repeat(64), packageDigest: 'b'.repeat(64), displayName: '文字统计',
  description: '统计词频', operationTitle: '统计文字', preparedAt: 1,
  installableLocally: true, published: false, dispatchable: false,
  orderAdapter: { version: 1, capabilityId: 'text.transform', taskType: 'word_count',
    inputKind: 'inline', outputKind: 'inline_json', contractVersion: 'v1' },
}

function harness(options: { adapter?: boolean; grant?: boolean; changed?: boolean; selected?: boolean } = {}) {
  let installed = options.selected === true
  let enabled = options.selected === true
  let selected = options.selected === true
  let savedReview: { draftId: string; packageDigest: string; name: string; purpose: string;
    category: 'text' | 'data' | 'automation'; configuration: string; salePriceYuan: string | null;
    state: 'local-draft'; savedAt: number } | null = null
  const inspect = vi.fn(async () => ({ ok: true as const, value: { status: 'accepted' as const,
    kind: 'path', bundle: true, name: candidate.packageName } }))
  const installBundle = vi.fn(async () => { installed = true; return { ok: true as const,
    value: { application: 'applied', bundle: candidate.packageName } } })
  const setBundleEnabled = vi.fn(async () => { enabled = true; return { ok: true as const,
    value: { application: 'applied' } } })
  const selectOrderSource = vi.fn(async ({ sourceId }: { sourceId: string }) => {
    selected = true
    return { ok: true as const, value: { selectedSourceId: sourceId, requiresGrant: true } }
  })
  const saveLocalOrderPublicationDraft = vi.fn(async (input: NonNullable<typeof savedReview>) => {
    savedReview = { ...input, state: 'local-draft', savedAt: 123 }
    return { ok: true as const, value: savedReview }
  })
  const submitInstalledOrderSkill = vi.fn(async () => ({ ok: false as const, error: { message: 'unavailable' } }))
  const retryInstalledOrderSkillArchive = vi.fn(async () => ({ ok: false as const,
    error: { message: 'unavailable' } }))
  const remote: OrderPublicationRemote = {
    account: { state: async () => ({ ok: true, value: { account: { id: '167' } } }) },
    catalog: {
      submitInstalledOrderSkill, retryInstalledOrderSkillArchive,
      previewInstalledOrderSkillPrice: async () => ({ ok: false, error: { message: 'unavailable' } }),
      startOrderReviewSamples: async () => ({ ok: false, error: { message: 'unavailable' } }),
      myOrderSkillPublications: async () => ({ ok: true, value: { items: [] } }),
      localCandidates: async () => ({ ok: true, value: { candidates: options.changed ? [] : [candidate] } }),
      checkLocalCandidateInstall: async () => ({ ok: true, value: { packageName: candidate.packageName,
        packageDigest: candidate.packageDigest, matched: installed,
        reason: options.adapter === false ? 'adapter-missing' : installed ? 'matched' : 'not-installed' } }),
      localOrderPublicationDraft: async () => ({ ok: true, value: savedReview }),
      saveLocalOrderPublicationDraft,
      orderSources: async () => ({ ok: true, value: { complete: true,
        order: { enabledServiceIds: options.grant ? ['node'] : [] },
        sources: [
          { id: `bundle:${encodeURIComponent(candidate.packageName)}`, kind: 'plugin', selectable: installed && enabled && !selected,
            eligible: selected, enabled: false, serviceId: selected ? 'node' : null, reason: 'not-selected' },
          { id: 'skill:user-agents:svg-to-video', kind: 'skill', selectable: false,
            eligible: false, enabled: false, serviceId: null, reason: 'file-input-unsupported' },
        ] } }),
      selectOrderSource,
    },
    manager: {
      inspect, installBundle, setBundleEnabled,
      checkBundle: async () => ({ ok: true, value: { state: enabled ? 'active' : 'disabled', selected: enabled } }),
    },
  }
  return { remote, inspect, installBundle, setBundleEnabled, selectOrderSource,
    saveLocalOrderPublicationDraft, submitInstalledOrderSkill }
}

it('prepares an exact candidate and stops before order authorization or platform publication', async () => {
  const calls = harness()
  const controller = new OrderPublicationController(calls.remote)
  await controller.publishCandidate(candidate)
  expect(controller.store.getSnapshot().items[`candidate:${candidate.draftId}`]).toEqual({ phase: 'ready' })
  expect(calls.inspect).toHaveBeenCalledWith(candidate.packagePath)
  expect(calls.installBundle).toHaveBeenCalledExactlyOnceWith(candidate.packagePath, { enabled: false })
  expect(calls.setBundleEnabled).toHaveBeenCalledExactlyOnceWith(candidate.packageName, true)
  expect(calls.selectOrderSource).toHaveBeenCalledExactlyOnceWith({ sourceId: `bundle:${encodeURIComponent(candidate.packageName)}` })
  expect(calls.submitInstalledOrderSkill).not.toHaveBeenCalled()
  expect(controller.store.getSnapshot().busyKey).toBeNull()
  controller.dispose()
})

it('retries only the saved publication review sample and retains its platform id', async () => {
  const calls = harness()
  const publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
  const start = vi.fn(async () => ({ ok: true as const, value: { publicationId,
    status: 'pending' as const, mediaEvidenceStatus: 'missing' as const } }))
  calls.remote.catalog.startOrderReviewSamples = start
  const controller = new OrderPublicationController(calls.remote)
  controller.store.set({ busyKey: null, review: null,
    sellerProducts: {}, sellerProductsUnavailable: false, sellerProductErrors: {}, items: {
    'skill:user-agents:svg-to-video': { phase: 'submitted', publicationId,
      reviewReasons: [], reviewSampleError: 'order-review-samples-unavailable' },
  } })
  await controller.retryReviewSamples('user-agents', 'svg-to-video')
  expect(start).toHaveBeenCalledExactlyOnceWith({ publicationId })
  expect(calls.submitInstalledOrderSkill).not.toHaveBeenCalled()
  expect(controller.store.getSnapshot().items['skill:user-agents:svg-to-video'])
    .toEqual({ phase: 'submitted', publicationId, reviewReasons: [],
      reviewSampleStatus: 'pending', mediaEvidenceStatus: 'missing' })
  controller.dispose()
})

it('blocks changed candidates, missing adapters and active grants before installation', async () => {
  for (const [options, reason] of [
    [{ changed: true }, 'candidate-changed'], [{ adapter: false }, 'adapter-missing'],
    [{ adapter: false, grant: true }, 'adapter-missing'],
    [{ grant: true }, 'already-authorized'],
  ] as const) {
    const calls = harness(options)
    const controller = new OrderPublicationController(calls.remote)
    await controller.publishCandidate(candidate)
    expect(controller.store.getSnapshot().items[`candidate:${candidate.draftId}`]).toEqual({ phase: 'blocked', reason })
    expect(calls.installBundle).not.toHaveBeenCalled()
    expect(calls.selectOrderSource).not.toHaveBeenCalled()
    controller.dispose()
  }
})

it('explains the file adapter gap despite an unrelated word count grant without installing or switching', async () => {
  const calls = harness({ grant: true })
  const controller = new OrderPublicationController(calls.remote)
  await controller.publishSkill('user-agents', 'svg-to-video')
  expect(controller.store.getSnapshot().items['skill:user-agents:svg-to-video']).toEqual({
    phase: 'blocked', reason: 'file-input-unsupported' })
  expect(calls.installBundle).not.toHaveBeenCalled()
  expect(calls.selectOrderSource).not.toHaveBeenCalled()
  controller.dispose()
})

it('keeps missing adapter, runtime, local self-test and undeployed platform route distinct', async () => {
  const review = { displayName: '柱状图动效', purpose: '制作动效', configuration: '', priceYuan: '0.00' }
  for (const [code, reason] of [
    ['order-adapter-invalid', 'adapter-missing'],
    ['order-runtime-unavailable', 'runtime-unavailable'],
    ['order-skill-import-unavailable', 'skill-import-unavailable'],
    ['order-node-contributor-unavailable', 'node-contributor-unavailable'],
    ['order-local-verification-failed', 'local-verification-failed'],
    ['order-platform-route-unavailable', 'platform-route-unavailable'],
    ['order-platform-contract', 'platform-task-unmapped'],
    ['order-publication-conflict', 'publication-conflict'],
  ] as const) {
    const calls = harness({ grant: true })
    calls.remote.catalog.submitInstalledOrderSkill = async () => ({ ok: false, error: { message: code } })
    const controller = new OrderPublicationController(calls.remote)
    await controller.publishSkill('user-agents', 'svg-to-video', review)
    expect(controller.store.getSnapshot().items['skill:user-agents:svg-to-video'])
      .toEqual({ phase: 'blocked', reason })
    expect(calls.selectOrderSource).not.toHaveBeenCalled()
    controller.dispose()
  }
})

it('restores a platform-reviewed receipt after a controller restart without inventing intake readiness', async () => {
  const calls = harness()
  const publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
  calls.remote.catalog.myOrderSkillPublications = async () => ({ ok: true, value: { items: [{
    source: 'user-agents', name: 'svg-to-video', publicationId, status: 'approved',
    taskType: 'bar_chart_svg_v1', artifactDigest: 'sha256:' + 'a'.repeat(64),
    reviewReasons: [],
  }] } })
  const controller = new OrderPublicationController(calls.remote)
  expect(controller.store.getSnapshot().items).toEqual({})
  await controller.refreshSkillPublications()
  expect(controller.store.getSnapshot().items['skill:user-agents:svg-to-video']).toEqual({
    phase: 'approved', publicationId, reviewReasons: [],
  })
  calls.remote.catalog.myOrderSkillPublications = async () => ({ ok: true, value: { items: [] } })
  await controller.refreshSkillPublications()
  expect(controller.store.getSnapshot().items['skill:user-agents:svg-to-video']).toBeUndefined()
  controller.dispose()
})

it('submits a market product only for a fresh approved publication and restores the server ledger', async () => {
  const calls = harness()
  const publicationId = '416dfb88-ea17-4a36-98b5-e1c08edd3c55'
  const product = { id: '6651ee49-3c6a-4047-8422-aea5c0c33fbf', publicationId,
    status: 'review' as const, salePriceYuan: '9.90', canApprove: false, reviewReasons: [] }
  const submit = vi.fn(async () => ({ ok: true as const, value: product }))
  calls.remote.catalog.submitSellerOrderProduct = submit
  calls.remote.catalog.mySellerOrderProducts = async () => ({ ok: true, value: { items: [] } })
  calls.remote.catalog.myOrderSkillPublications = async () => ({ ok: true, value: { items: [{
    source: 'user-agents', name: 'qianshou-reverse-acceptance', publicationId,
    status: 'approved', taskType: 'qianshou_reverse_acceptance_v1',
    artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: [], archiveStatus: 'confirmed',
  }] } })
  const controller = new OrderPublicationController(calls.remote)
  expect(await controller.submitSkillProduct('user-agents', 'qianshou-reverse-acceptance', '9.90')).toBe(false)
  expect(submit).not.toHaveBeenCalled()
  await controller.refreshSkillPublications()
  expect(await controller.submitSkillProduct('user-agents', 'qianshou-reverse-acceptance', '9.90')).toBe(true)
  expect(submit).toHaveBeenCalledExactlyOnceWith({ publicationId, salePriceYuan: '9.90' })
  expect(controller.store.getSnapshot().sellerProducts[publicationId]).toEqual(product)
  controller.dispose()

  calls.remote.catalog.mySellerOrderProducts = async () => ({ ok: true, value: { items: [product] } })
  const restored = new OrderPublicationController(calls.remote)
  await restored.refreshSkillPublications()
  expect(restored.store.getSnapshot().sellerProducts[publicationId]).toEqual(product)
  expect(await restored.submitSkillProduct('user-agents', 'qianshou-reverse-acceptance', '9.90')).toBe(false)
  expect(submit).toHaveBeenCalledTimes(1)
  restored.dispose()
})

it('does not treat a mismatched product receipt as market submission', async () => {
  const calls = harness()
  const publicationId = '416dfb88-ea17-4a36-98b5-e1c08edd3c55'
  calls.remote.catalog.submitSellerOrderProduct = async () => ({ ok: true, value: {
    id: '6651ee49-3c6a-4047-8422-aea5c0c33fbf', publicationId,
    status: 'review', salePriceYuan: '1.00', canApprove: false, reviewReasons: [],
  } })
  calls.remote.catalog.mySellerOrderProducts = async () => ({ ok: true, value: { items: [] } })
  calls.remote.catalog.myOrderSkillPublications = async () => ({ ok: true, value: { items: [{
    source: 'user-agents', name: 'qianshou-reverse-acceptance', publicationId, status: 'approved',
    taskType: 'reverse_v1', artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: [], archiveStatus: 'confirmed',
  }] } })
  const controller = new OrderPublicationController(calls.remote)
  await controller.refreshSkillPublications()
  expect(await controller.submitSkillProduct('user-agents', 'qianshou-reverse-acceptance', '9.90')).toBe(false)
  expect(controller.store.getSnapshot().sellerProducts[publicationId]).toBeUndefined()
  expect(controller.store.getSnapshot().sellerProductErrors['skill:user-agents:qianshou-reverse-acceptance'])
    .toBe('invalid-receipt')
  controller.dispose()
})

it('keeps a real submission receipt during a transient read failure and restores every review reason', async () => {
  const calls = harness()
  const publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
  const reasons = Array.from({ length: 12 }, (_, index) => `审核条件 ${index + 1}`)
  calls.remote.account = { state: async () => ({ ok: true, value: { account: { id: '167' } } }) }
  const submitInstalledOrderSkill = vi.fn(async () => ({ ok: true as const, value: {
    publicationId, status: 'review' as const, taskType: 'bar_chart_svg_v1',
    artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: reasons,
    platformReady: false, archiveStatus: 'confirmed' as const,
  } }))
  calls.remote.catalog.submitInstalledOrderSkill = submitInstalledOrderSkill
  const controller = new OrderPublicationController(calls.remote)
  await controller.publishSkill('user-agents', 'svg-to-video', {
    displayName: '柱状图动效', purpose: '制作动效', configuration: '', priceYuan: '2.00',
  })
  const key = 'skill:user-agents:svg-to-video'
  expect(controller.store.getSnapshot().items[key]?.reviewReasons).toEqual(reasons)
  await controller.publishSkill('user-agents', 'svg-to-video', {
    displayName: '柱状图动效', purpose: '制作动效', configuration: '', priceYuan: '2.00',
  })
  expect(controller.store.getSnapshot().items[key]).toMatchObject({ phase: 'submitted', publicationId })
  expect(submitInstalledOrderSkill).toHaveBeenCalledTimes(1)
  calls.remote.catalog.myOrderSkillPublications = async () => {
    throw new Error('network-unavailable')
  }
  await controller.refreshSkillPublications()
  expect(controller.store.getSnapshot().items[key]).toMatchObject({
    phase: 'submitted', publicationId, reviewSyncStale: true, reviewReasons: reasons,
  })
  calls.remote.catalog.myOrderSkillPublications = async () => ({ ok: true, value: { items: [{
    source: 'user-agents', name: 'svg-to-video', publicationId, status: 'rejected',
    taskType: 'bar_chart_svg_v1', artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: reasons,
  }] } })
  await controller.refreshSkillPublications()
  expect(controller.store.getSnapshot().items[key]).toEqual({
    phase: 'rejected', publicationId, reviewReasons: reasons,
  })
  controller.dispose()
})

it('retries a pending archive against the same publication id without resubmitting metadata', async () => {
  const calls = harness()
  const publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
  calls.remote.catalog.submitInstalledOrderSkill = vi.fn(async () => ({ ok: true as const, value: {
    publicationId, status: 'review' as const, taskType: 'bar_chart_svg_v1',
    artifactDigest: `sha256:${'a'.repeat(64)}`, reviewReasons: ['等待广州验包'],
    platformReady: false, archiveStatus: 'pending' as const,
    archiveError: 'order-archive-upload-failed',
  } }))
  const retry = vi.fn(async () => ({ ok: true as const, value: {
    publicationId, status: 'review' as const, taskType: 'bar_chart_svg_v1',
    artifactDigest: `sha256:${'a'.repeat(64)}`, reviewReasons: ['等待广州验包'],
    platformReady: false, archiveStatus: 'confirmed' as const,
  } }))
  calls.remote.catalog.retryInstalledOrderSkillArchive = retry
  const controller = new OrderPublicationController(calls.remote)
  const review = { displayName: '柱状图动效', purpose: '制作动效', configuration: '', priceYuan: '2.00' }
  await controller.publishSkill('user-agents', 'svg-to-video', review)
  expect(controller.store.getSnapshot().items['skill:user-agents:svg-to-video']).toMatchObject({
    phase: 'archive-pending', publicationId, archiveError: 'order-archive-upload-failed',
  })
  await controller.retrySkillArchive('user-agents', 'svg-to-video')
  expect(retry).toHaveBeenCalledExactlyOnceWith({ source: 'user-agents', name: 'svg-to-video' })
  expect(calls.remote.catalog.submitInstalledOrderSkill).toHaveBeenCalledTimes(1)
  expect(controller.store.getSnapshot().items['skill:user-agents:svg-to-video']).toMatchObject({
    phase: 'submitted', publicationId,
  })
  expect(controller.store.getSnapshot().items['skill:user-agents:svg-to-video']?.archiveError).toBeUndefined()
  controller.dispose()
})

it('retains the locked free sale during archive recovery and accepts the actual approved listing receipt', async () => {
  const calls = harness()
  const publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
  const marketProductId = '104a209d-553a-4ed4-88e9-8a3ae6f52bd4'
  calls.remote.catalog.retryInstalledOrderSkillArchive = async () => ({ ok: true, value: {
    publicationId, status: 'approved', taskType: 'bar_chart_svg_v1',
    artifactDigest: `sha256:${'a'.repeat(64)}`, reviewReasons: [],
    platformReady: false, archiveStatus: 'confirmed', marketProductId, marketProductStatus: 'published',
  } })
  const controller = new OrderPublicationController(calls.remote)
  controller.store.set({ busyKey: null, review: null, sellerProducts: {}, sellerProductsUnavailable: false,
    sellerProductErrors: {}, items: { 'skill:user-agents:svg-to-video': {
      phase: 'archive-pending', publicationId, priceYuan: '2.00', salePriceYuan: '0.00',
      archiveError: 'order-archive-upload-failed',
    } } })
  await controller.retrySkillArchive('user-agents', 'svg-to-video')
  expect(controller.store.getSnapshot().items['skill:user-agents:svg-to-video']).toEqual({
    phase: 'approved', archiveStatus: 'confirmed', publicationId, priceYuan: '2.00', salePriceYuan: '0.00',
    marketProductId, marketProductStatus: 'published', reviewReasons: [],
  })
  expect(calls.submitInstalledOrderSkill).not.toHaveBeenCalled()
  controller.dispose()
})

it('retains a failed archive retry through same-publication polls and clears it after confirmation', async () => {
  const calls = harness()
  const publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
  const key = 'skill:user-agents:svg-to-video'
  let archiveStatus: 'pending' | 'confirmed' = 'pending'
  calls.remote.catalog.myOrderSkillPublications = async () => ({ ok: true, value: { items: [{
    source: 'user-agents', name: 'svg-to-video', publicationId, status: 'review', archiveStatus,
    taskType: 'bar_chart_svg_v1', artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: [],
  }] } })
  const retry = vi.fn(async () => ({ ok: true as const, value: {
    publicationId, status: 'review' as const, taskType: 'bar_chart_svg_v1',
    artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: [], platformReady: false,
    archiveStatus, ...(archiveStatus === 'pending' ? { archiveError: 'order-author-key-unavailable' } : {}),
  } }))
  calls.remote.catalog.retryInstalledOrderSkillArchive = retry
  const controller = new OrderPublicationController(calls.remote)
  await controller.refreshSkillPublications()
  await controller.retrySkillArchive('user-agents', 'svg-to-video')
  await controller.refreshSkillPublications()
  await controller.refreshSkillPublications()
  expect(controller.store.getSnapshot().items[key]).toMatchObject({
    phase: 'archive-pending', publicationId, archiveError: 'order-author-key-unavailable',
  })
  expect(retry).toHaveBeenCalledOnce()
  archiveStatus = 'confirmed'
  await controller.retrySkillArchive('user-agents', 'svg-to-video')
  expect(controller.store.getSnapshot().items[key]?.archiveError).toBeUndefined()
  await controller.refreshSkillPublications()
  expect(controller.store.getSnapshot().items[key]).toMatchObject({ phase: 'submitted', archiveStatus: 'confirmed' })
  expect(controller.store.getSnapshot().items[key]?.archiveError).toBeUndefined()
  expect(calls.submitInstalledOrderSkill).not.toHaveBeenCalled()
  controller.dispose()
})

it.each(['new-publication', 'new-owner', 'confirmed'] as const)(
  'clears the local archive failure when a poll returns %s', async (change) => {
    const calls = harness()
    let accountId = '167'
    let publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
    let archiveStatus: 'pending' | 'confirmed' = 'pending'
    const key = 'skill:user-agents:svg-to-video'
    calls.remote.account = { state: async () => ({ ok: true, value: { account: { id: accountId } } }) }
    calls.remote.catalog.myOrderSkillPublications = async () => ({ ok: true, value: { items: [{
      source: 'user-agents', name: 'svg-to-video', publicationId, status: 'review', archiveStatus,
      taskType: 'bar_chart_svg_v1', artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: [],
    }] } })
    calls.remote.catalog.retryInstalledOrderSkillArchive = async () => ({ ok: true, value: {
      publicationId, status: 'review', archiveStatus: 'pending', archiveError: 'order-archive-upload-failed',
      taskType: 'bar_chart_svg_v1', artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: [], platformReady: false,
    } })
    const controller = new OrderPublicationController(calls.remote)
    await controller.refreshSkillPublications()
    await controller.retrySkillArchive('user-agents', 'svg-to-video')
    expect(controller.store.getSnapshot().items[key]?.archiveError).toBe('order-archive-upload-failed')
    if (change === 'new-publication') publicationId = 'a9418e38-b3a5-5722-8005-cc7afbe2a21a'
    if (change === 'new-owner') accountId = '6'
    if (change === 'confirmed') archiveStatus = 'confirmed'
    await controller.refreshSkillPublications()
    expect(controller.store.getSnapshot().items[key]?.archiveError).toBeUndefined()
    controller.dispose()
  },
)

it.each(['new-publication', 'new-owner'] as const)(
  'discards a late archive failure after %s changes', async (change) => {
    const calls = harness()
    let accountId = '167'
    let publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
    const key = 'skill:user-agents:svg-to-video'
    let started!: () => void
    const requestStarted = new Promise<void>((resolve) => { started = resolve })
    let reject!: (error: Error) => void
    calls.remote.account = { state: async () => ({ ok: true, value: { account: { id: accountId } } }) }
    calls.remote.catalog.myOrderSkillPublications = async () => ({ ok: true, value: { items: [{
      source: 'user-agents', name: 'svg-to-video', publicationId, status: 'review', archiveStatus: 'pending',
      taskType: 'bar_chart_svg_v1', artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: [],
    }] } })
    calls.remote.catalog.retryInstalledOrderSkillArchive = () => {
      started()
      return new Promise<never>((_resolve, rejectRequest) => { reject = rejectRequest })
    }
    const controller = new OrderPublicationController(calls.remote)
    await controller.refreshSkillPublications()
    const pending = controller.retrySkillArchive('user-agents', 'svg-to-video')
    await requestStarted
    if (change === 'new-publication') publicationId = 'a9418e38-b3a5-5722-8005-cc7afbe2a21a'
    else accountId = '6'
    await controller.refreshSkillPublications()
    reject(new Error('private failed upload URL'))
    await pending
    expect(controller.store.getSnapshot().items[key]?.archiveError).toBeUndefined()
    expect(controller.store.getSnapshot().items[key]?.publicationId).toBe(publicationId)
    expect(controller.store.getSnapshot().busyKey).toBeNull()
    controller.dispose()
  },
)

it('discards a successful archive reply when the owner changes before the next poll', async () => {
  const calls = harness()
  const publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
  const key = 'skill:user-agents:svg-to-video'
  let accountId = '167'
  let started!: () => void
  const requestStarted = new Promise<void>((resolve) => { started = resolve })
  let finish!: (reply: Awaited<ReturnType<OrderPublicationRemote['catalog']['retryInstalledOrderSkillArchive']>>) => void
  calls.remote.account = { state: async () => ({ ok: true, value: { account: { id: accountId } } }) }
  calls.remote.catalog.myOrderSkillPublications = async () => ({ ok: true, value: { items: [{
    source: 'user-agents', name: 'svg-to-video', publicationId, status: 'review', archiveStatus: 'pending',
    taskType: 'bar_chart_svg_v1', artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: [],
  }] } })
  calls.remote.catalog.retryInstalledOrderSkillArchive = () => {
    started()
    return new Promise((resolve) => { finish = resolve })
  }
  const controller = new OrderPublicationController(calls.remote)
  await controller.refreshSkillPublications()
  const pending = controller.retrySkillArchive('user-agents', 'svg-to-video')
  await requestStarted
  accountId = '6'
  finish({ ok: true, value: { publicationId, status: 'review', archiveStatus: 'confirmed',
    taskType: 'bar_chart_svg_v1', artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: [], platformReady: false } })
  await pending
  expect(controller.store.getSnapshot().items[key]).toBeUndefined()
  expect(controller.store.getSnapshot().busyKey).toBeNull()
  expect(calls.submitInstalledOrderSkill).not.toHaveBeenCalled()
  controller.dispose()
})

it('drops account-scoped receipts on account change or an authentication refusal', async () => {
  const calls = harness()
  const publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
  let accountId = '167'
  calls.remote.account = { state: async () => ({ ok: true, value: { account: { id: accountId } } }) }
  calls.remote.catalog.myOrderSkillPublications = async () => ({ ok: true, value: { items: [{
    source: 'user-agents', name: 'svg-to-video', publicationId, status: 'approved',
    taskType: 'bar_chart_svg_v1', artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: [],
  }] } })
  const controller = new OrderPublicationController(calls.remote)
  const key = 'skill:user-agents:svg-to-video'
  await controller.refreshSkillPublications()
  expect(controller.store.getSnapshot().items[key]?.phase).toBe('approved')
  expect(controller.store.getSnapshot().reviewSyncedAt).toEqual(expect.any(Number))
  accountId = '6'
  calls.remote.catalog.myOrderSkillPublications = async () => {
    throw new Error('network-unavailable')
  }
  await controller.refreshSkillPublications()
  expect(controller.store.getSnapshot().items[key]).toBeUndefined()
  expect(controller.store.getSnapshot().reviewSyncedAt).toBeUndefined()
  calls.remote.catalog.myOrderSkillPublications = async () => ({ ok: true, value: { items: [{
    source: 'user-agents', name: 'svg-to-video', publicationId, status: 'approved',
    taskType: 'bar_chart_svg_v1', artifactDigest: 'sha256:' + 'a'.repeat(64), reviewReasons: [],
  }] } })
  await controller.refreshSkillPublications()
  expect(controller.store.getSnapshot().items[key]?.phase).toBe('approved')
  calls.remote.catalog.myOrderSkillPublications = async () => ({ ok: false,
    error: { message: 'order-auth-required' } })
  await controller.refreshSkillPublications()
  expect(controller.store.getSnapshot().items[key]).toBeUndefined()
  controller.dispose()
})

it('rechecks the already selected candidate without changing an active grant', async () => {
  const calls = harness({ selected: true, grant: true })
  const controller = new OrderPublicationController(calls.remote)
  await controller.publishCandidate(candidate)
  expect(controller.store.getSnapshot().items[`candidate:${candidate.draftId}`]).toEqual({ phase: 'ready' })
  expect(calls.installBundle).not.toHaveBeenCalled()
  expect(calls.setBundleEnabled).not.toHaveBeenCalled()
  expect(calls.selectOrderSource).not.toHaveBeenCalled()
  controller.dispose()
})

it('opens the review immediately, saves CNY author metadata locally and never submits to central server', async () => {
  const calls = harness()
  const controller = new OrderPublicationController(calls.remote)
  controller.openReview(candidate)
  expect(controller.store.getSnapshot().review).toMatchObject({ status: 'loading', name: '文字统计' })
  await vi.waitFor(() => expect(controller.store.getSnapshot().review?.status).toBe('ready'))
  await vi.waitFor(() => expect(controller.store.getSnapshot().items[`candidate:${candidate.draftId}`]?.phase).toBe('ready'))
  controller.editReview({ name: '中文词频助手', purpose: '统计文本词频', category: 'data',
    configuration: '不需要密钥', saleMode: 'paid', salePriceYuan: '2.50' })
  await controller.saveReview()
  expect(calls.saveLocalOrderPublicationDraft).toHaveBeenCalledExactlyOnceWith({
    draftId: candidate.draftId, packageDigest: candidate.packageDigest, name: '中文词频助手',
    purpose: '统计文本词频', category: 'data', configuration: '不需要密钥', salePriceYuan: '2.50' })
  expect(controller.store.getSnapshot().review).toMatchObject({ status: 'saved', salePriceYuan: '2.50' })
  expect(calls.submitInstalledOrderSkill).not.toHaveBeenCalled()
  controller.editReview({ salePriceYuan: '0' })
  await controller.saveReview()
  expect(controller.store.getSnapshot().review).toMatchObject({ status: 'error', error: 'invalid-fields' })
  expect(calls.saveLocalOrderPublicationDraft).toHaveBeenCalledTimes(1)
  controller.closeReview()
  expect(controller.store.getSnapshot().review).toBeNull()
  controller.dispose()
})
