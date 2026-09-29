import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { expect, it, vi } from 'vitest'
import QianshouPluginCatalog, { type Config } from '../src/index.ts'
import { identifyRegisteredOrderAdapter } from '../src/registered-order-adapters.ts'
import type { MyOrderSkillPublication } from '../src/types.ts'

async function fixture(options: {
  selected?: 'builtin' | 'vendor'
  runnable?: boolean
  inventory?: boolean
  granted?: boolean
  genericSkill?: boolean
  taskType?: 'word_count' | 'text_sort'
  workerId?: string
} = {}) {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-order-sources-'))
  const genericRoot = join(home, 'generic-skill')
  if (options.genericSkill) await cp(fileURLToPath(new URL('../examples/quickjs-char-count-skill/', import.meta.url)), genericRoot, { recursive: true })
  const ctx = new Context()
  const policy = { mode: 'idle', maxConcurrency: 1, enabledServiceIds: options.granted === false ? [] : ['node'] }
  let selected = options.selected ?? 'builtin'
  const selectOrderExecutor = vi.fn(async (input: { kind: 'builtin' } | { kind: 'plugin'; packageName: string }) => {
    if (policy.enabledServiceIds.includes('node')) {
      throw Object.assign(new Error('grant active'), { code: 'COMPUTE_ORDER_EXECUTOR_SERVICE_ENABLED' })
    }
    if (input.kind === 'plugin' && input.packageName !== '@vendor/wordfreq') {
      throw Object.assign(new Error('unsupported'), { code: 'COMPUTE_ORDER_EXECUTOR_UNAVAILABLE' })
    }
    selected = input.kind === 'builtin' ? 'builtin' : 'vendor'
    return input.kind === 'plugin' && options.taskType === 'text_sort'
      ? { ...input, taskType: 'text_sort' } : input
  })
  const helloRefresh = vi.fn(async () => undefined)
  ctx.provide('computeCore', { ownerSupplyPolicy: async () => policy })
  ctx.provide('qianshou.market.hello', { refresh: helloRefresh })
  ctx.provide('nodeContributor', {
    ...(options.workerId === undefined ? {} : { acknowledgedWorkerId: () => options.workerId }),
    orderExecutor: () => selected === 'vendor'
      ? { kind: 'plugin' as const, packageName: '@vendor/wordfreq',
        ...(options.taskType === 'text_sort' ? { taskType: 'text_sort' } : {}) }
      : { kind: 'builtin' as const },
    orderExecutorVerified: () => options.runnable !== false,
    canSelectOrderBundle: async (name: string) => name === '@vendor/wordfreq',
    ...(options.taskType === 'text_sort' ? { orderBundleContract: async (name: string) =>
      name === '@vendor/wordfreq' ? { taskType: 'text_sort', capabilityId: 'text.transform' } : null } : {}),
    selectOrderExecutor,
    canEnableLocalService: async () => options.runnable !== false,
    setPanelAccepting: () => undefined,
  })
  if (options.inventory !== false) {
    ctx.provide('pluginManager', {
      listBundles: async () => [
        { name: '@vendor/wordfreq', displayName: '本机词频统计', description: '已安装词频包', enabled: true, installed: true, removable: true, optional: false,
          rows: [{ entryId: 'vendor-entry', moduleName: '@vendor/wordfreq' }] },
        { name: 'old-character-counter', description: '字符数统计', enabled: true, installed: true, removable: true, optional: false,
          rows: [{ entryId: 'old-entry', moduleName: 'old-character-counter' }] },
      ],
      listPlugins: async () => [
        { entryId: 'vendor-entry', moduleName: '@vendor/wordfreq', enabled: true, fiberPhase: 'active' },
        { entryId: 'old-entry', moduleName: 'old-character-counter', enabled: true, fiberPhase: 'active' },
        { entryId: 'loose-entry', moduleName: 'other-installed-plugin', enabled: true, fiberPhase: 'active' },
      ],
    })
    ctx.provide('qianshouSkillImport', { listLocal: async () => ({ skills: [
      { name: 'video-helper', displayName: '视频助手', description: '整理视频说明', category: 'video', source: 'user-dsh',
        ...(options.genericSkill ? { path: join(genericRoot, 'SKILL.md') } : {}) },
      { name: 'story-helper', displayName: '故事助手', description: '写故事', source: 'user-agents' },
    ] }) })
  }
  const config: Config = { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
    connection: 'shipped', apiBaseUrl: '', installHome: home, publisherKeys: {} }
  await ctx.plugin(QianshouPluginCatalog, config)
  vi.spyOn(ctx.qianshouPluginCatalog, 'myOrderSkillPublications').mockResolvedValue({ items: [] })
  return { ctx, home, policy, selectOrderExecutor, helloRefresh }
}

it('starts independent installation receipt reads together and fails closed when one fails', async () => {
  const { ctx, home } = await fixture({ workerId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
  const inline = Promise.withResolvers<Awaited<ReturnType<typeof ctx.qianshouPluginCatalog.verifiedPurchasedOrderRuntimes>>>()
  const file = Promise.withResolvers<Awaited<ReturnType<typeof ctx.qianshouPluginCatalog.verifiedPurchasedFileOrderRuntimes>>>()
  const readInline = vi.spyOn(ctx.qianshouPluginCatalog, 'verifiedPurchasedOrderRuntimes').mockReturnValue(inline.promise)
  const readFile = vi.spyOn(ctx.qianshouPluginCatalog, 'verifiedPurchasedFileOrderRuntimes').mockReturnValue(file.promise)
  try {
    const inventory = ctx.qianshouPluginCatalog.orderSources()
    await vi.waitFor(() => {
      expect(readInline).toHaveBeenCalledTimes(1)
      expect(readFile).toHaveBeenCalledTimes(1)
    })
    file.resolve([])
    inline.reject(new Error('buyer ledger unavailable'))
    expect((await inventory).complete).toBe(false)
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('loads conversation plugins from local inventory even while cloud publication reads are unavailable', async () => {
  const { ctx, home } = await fixture()
  const publications = vi.spyOn(ctx.qianshouPluginCatalog, 'myOrderSkillPublications')
    .mockImplementation(() => Promise.withResolvers<{ items: MyOrderSkillPublication[] }>().promise)
  try {
    expect(await ctx.qianshouPluginCatalog.conversationPlugins()).toEqual([
      { id: 'bundle:%40vendor%2Fwordfreq', title: '本机词频统计', description: '已安装词频包' },
      { id: 'bundle:old-character-counter', title: 'old-character-counter', description: '字符数统计' },
    ])
    expect(publications).not.toHaveBeenCalled()
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('does not advertise a local plugin without a complete active loader receipt', async () => {
  const { ctx, home } = await fixture({ inventory: false })
  try {
    await expect(ctx.qianshouPluginCatalog.conversationPlugins()).rejects.toThrow()
    ctx.provide('pluginManager', {
      listBundles: async () => [
        { name: 'disabled', installed: true, removable: true, enabled: false, rows: [{ entryId: 'a', moduleName: 'disabled' }] },
        { name: 'incomplete', installed: true, removable: true, enabled: true, rows: [{ entryId: 'missing', moduleName: 'incomplete' }] },
        { name: 'shipped', installed: false, removable: false, enabled: true, rows: [{ entryId: 's', moduleName: 'shipped' }] },
      ],
      listPlugins: async () => [
        { entryId: 'a', moduleName: 'disabled', enabled: true, fiberPhase: 'active' },
        { entryId: 's', moduleName: 'shipped', enabled: true, fiberPhase: 'active' },
      ],
    })
    expect(await ctx.qianshouPluginCatalog.conversationPlugins()).toEqual([])
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('lists both installation sources without converting an old counter or a SKILL.md into order authority', async () => {
  const { ctx, home } = await fixture({ selected: 'vendor' })
  try {
    const inventory = await ctx.qianshouPluginCatalog.orderSources()
    expect(inventory.complete).toBe(true)
    expect(inventory.sources.map(item => item.id)).toEqual([
      'builtin:word_count', 'bundle:%40vendor%2Fwordfreq', 'bundle:old-character-counter',
      'skill:user-dsh:video-helper', 'skill:user-agents:story-helper',
    ])
    expect(inventory.sources.find(item => item.id === 'bundle:%40vendor%2Fwordfreq')).toMatchObject({
      title: '本机词频统计',
      kind: 'plugin', source: 'profile-bundle', loadState: 'active', capabilityId: 'text.transform',
      taskType: 'word_count', serviceId: 'node', eligible: true, enabled: true, reason: 'ready',
    })
    expect(inventory.sources.find(item => item.id === 'bundle:old-character-counter')).toMatchObject({
      capabilityId: null, taskType: null, serviceId: null, selectable: false, eligible: false, enabled: false,
      reason: 'platform-task-unmapped',
    })
    expect(inventory.sources.find(item => item.id === 'skill:user-dsh:video-helper')).toMatchObject({
      category: 'video', serviceId: null, eligible: false, reason: 'conversation-only',
    })
    expect(inventory.sources.find(item => item.id === 'builtin:word_count')).toMatchObject({
      serviceId: null, eligible: false, reason: 'not-selected',
    })
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('selects an installed adapter only after the owner revokes node, without granting it again', async () => {
  const { ctx, home, policy, selectOrderExecutor, helloRefresh } = await fixture({ granted: false })
  try {
    const before = await ctx.qianshouPluginCatalog.orderSources()
    expect(before.sources.find(item => item.id === 'bundle:%40vendor%2Fwordfreq')).toMatchObject({
      category: 'text', capabilityId: 'text.transform', taskType: 'word_count',
      serviceId: null, selectable: true, eligible: false, reason: 'not-selected',
    })
    expect(await ctx.qianshouPluginCatalog.selectOrderSource({ sourceId: 'bundle:%40vendor%2Fwordfreq' }))
      .toEqual({ selectedSourceId: 'bundle:%40vendor%2Fwordfreq',
        taskType: 'word_count', capabilityId: 'text.transform', requiresGrant: true })
    expect(selectOrderExecutor).toHaveBeenCalledExactlyOnceWith({ kind: 'plugin', packageName: '@vendor/wordfreq' })
    expect(helloRefresh).toHaveBeenCalledTimes(1)
    expect(policy.enabledServiceIds).toEqual([])
    expect((await ctx.qianshouPluginCatalog.orderSources()).sources.find(item => item.serviceId === 'node'))
      .toMatchObject({ id: 'bundle:%40vendor%2Fwordfreq', enabled: false, eligible: true })
    expect(await ctx.qianshouPluginCatalog.selectOrderSource({ sourceId: 'builtin:word_count' }))
      .toMatchObject({ selectedSourceId: 'builtin:word_count', requiresGrant: true })
    expect(helloRefresh).toHaveBeenCalledTimes(2)
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('shows the actual declared task type and returns it after selecting another inline adapter', async () => {
  const { ctx, home } = await fixture({ granted: false, taskType: 'text_sort' })
  try {
    const before = await ctx.qianshouPluginCatalog.orderSources()
    expect(before.sources.find(item => item.id === 'bundle:%40vendor%2Fwordfreq')).toMatchObject({
      taskType: 'text_sort', capabilityId: 'text.transform', selectable: true,
    })
    expect(await ctx.qianshouPluginCatalog.selectOrderSource({ sourceId: 'bundle:%40vendor%2Fwordfreq' }))
      .toEqual({ selectedSourceId: 'bundle:%40vendor%2Fwordfreq', taskType: 'text_sort',
        capabilityId: 'text.transform', requiresGrant: true })
    const after = await ctx.qianshouPluginCatalog.orderSources()
    expect(after.sources.find(item => item.id === 'bundle:%40vendor%2Fwordfreq')).toMatchObject({
      taskType: 'text_sort', serviceId: 'node', enabled: false,
    })
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('rejects unknown, skill and old-adapter IDs before any executor write', async () => {
  const { ctx, home, selectOrderExecutor } = await fixture({ granted: false })
  try {
    for (const sourceId of ['skill:user-dsh:video-helper', 'bundle:old-character-counter',
      'bundle:missing', 'bundle:%2Foutside']) {
      await expect(ctx.qianshouPluginCatalog.selectOrderSource({ sourceId }))
        .rejects.toThrow(/QIANSHOU_CATALOG_(invalid-order-source|order-source-unavailable)/)
    }
    expect(selectOrderExecutor).not.toHaveBeenCalled()
    expect((await ctx.qianshouPluginCatalog.orderSources()).sources.find(item => item.serviceId === 'node'))
      .toMatchObject({ id: 'builtin:word_count' })
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('requires revocation before changing the selected runner and preserves the current choice on failure', async () => {
  const { ctx, home, selectOrderExecutor } = await fixture()
  try {
    await expect(ctx.qianshouPluginCatalog.selectOrderSource({ sourceId: 'bundle:%40vendor%2Fwordfreq' }))
      .rejects.toThrow('QIANSHOU_CATALOG_order-service-enabled')
    expect(selectOrderExecutor).toHaveBeenCalledExactlyOnceWith({ kind: 'plugin', packageName: '@vendor/wordfreq' })
    const rows = (await ctx.qianshouPluginCatalog.orderSources()).sources
    expect(rows.find(item => item.serviceId === 'node')).toMatchObject({ id: 'builtin:word_count', enabled: true })
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('keeps a saved owner grant revocable when the selected executor fails its live self-test', async () => {
  const { ctx, home } = await fixture({ selected: 'vendor', runnable: false })
  try {
    const item = (await ctx.qianshouPluginCatalog.orderSources()).sources.find(row => row.id === 'bundle:%40vendor%2Fwordfreq')
    expect(item).toMatchObject({ serviceId: 'node', eligible: false, enabled: true, reason: 'executor-unverified' })
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('reports incomplete coverage when install inventories are unavailable, without inventing installed items', async () => {
  const { ctx, home } = await fixture({ inventory: false })
  try {
    const inventory = await ctx.qianshouPluginCatalog.orderSources()
    expect(inventory.complete).toBe(false)
    expect(inventory.sources).toHaveLength(1)
    expect(inventory.sources[0]).toMatchObject({ id: 'builtin:word_count', eligible: true })
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})


it('recognizes a local executable from its actual files without granting order authority from a category label', async () => {
  const { ctx, home } = await fixture({ genericSkill: true })
  try {
    const item = (await ctx.qianshouPluginCatalog.orderSources()).sources.find(row => row.id === 'skill:user-dsh:video-helper')
    expect(item).toMatchObject({ category: 'video', reason: 'local-trial-ready',
      title: '文字统计', description: '统计文字里的字符数量，支持中文、英文和表情符号。',
      taskType: 'qianshou_quickjs_char_count_v1', selectable: false, eligible: false, enabled: false })
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

async function authorFixture() {
  const f = await fixture({ genericSkill: true, granted: false })
  const account = { id: '7' }
  f.ctx.provide('qianshouAccount', { state: async () => ({ phase: 'authenticated', account }) })
  f.ctx.provide('accountSession', { ensureAccessToken: async () => 'mock-token-not-sent' })
  const identity = await identifyRegisteredOrderAdapter(join(f.home, 'generic-skill', 'SKILL.md'))
  if (identity === null) throw new Error('fixture missing adapter')
  const publication: MyOrderSkillPublication = {
    source: 'user-dsh', name: 'video-helper', publicationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    status: 'approved', taskType: identity.taskType, artifactDigest: identity.artifactDigest,
    priceYuan: '0.50', salePriceYuan: null, archiveStatus: 'confirmed', reviewReasons: [],
  }
  vi.spyOn(f.ctx.qianshouPluginCatalog, 'myOrderSkillPublications').mockResolvedValue({ items: [publication] })
  vi.spyOn(f.ctx.qianshouPluginCatalog, 'mySellerOrderProducts').mockResolvedValue({ items: [] })
  return { ...f, publication, identity, account }
}

it('keeps an approved unlisted source separate from task pricing and device eligibility', async () => {
  const { ctx, home, publication } = await authorFixture()
  try {
    const item = (await ctx.qianshouPluginCatalog.orderSources()).sources.find(row => row.id === 'skill:user-dsh:video-helper')
    expect(item).toMatchObject({ reason: 'publication-approved', eligible: false, enabled: false,
      authorPublication: { publicationId: publication.publicationId, status: 'approved', archiveConfirmed: true,
        listingStatus: 'not-listed', salePriceYuan: null } })
    expect(item).not.toHaveProperty('authorProductId')
    expect(publication.priceYuan).toBe('0.50')
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it.each(['review', 'published', 'rejected'] as const)('joins the exact separate seller listing in %s without borrowing another publication', async (status) => {
  const { ctx, home, publication } = await authorFixture()
  try {
    vi.spyOn(ctx.qianshouPluginCatalog, 'mySellerOrderProducts').mockResolvedValue({ items: [
      { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', publicationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
        status: 'published', salePriceYuan: '99.00', canApprove: false, reviewReasons: [] },
      { id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', publicationId: publication.publicationId,
        status, salePriceYuan: '0.00', canApprove: false, reviewReasons: [] },
    ] })
    const item = (await ctx.qianshouPluginCatalog.orderSources()).sources.find(row => row.id === 'skill:user-dsh:video-helper')
    expect(item?.authorPublication).toMatchObject({ status: 'approved', listingStatus: status, salePriceYuan: '0.00' })
    expect(item?.authorProductId).toBe(status === 'published' ? 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' : undefined)
    expect(item).toMatchObject({ eligible: false, enabled: false })
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('does not turn unavailable listing or publication reads into confirmed absence or pending review', async () => {
  const { ctx, home } = await authorFixture()
  try {
    vi.spyOn(ctx.qianshouPluginCatalog, 'mySellerOrderProducts').mockRejectedValue(new Error('offline'))
    let result = await ctx.qianshouPluginCatalog.orderSources()
    expect(result.complete).toBe(false)
    expect(result.sources.find(row => row.id === 'skill:user-dsh:video-helper')).toMatchObject({
      reason: 'publication-approved', authorPublication: { status: 'approved', listingStatus: 'unavailable' }, eligible: false })
    vi.spyOn(ctx.qianshouPluginCatalog, 'myOrderSkillPublications').mockRejectedValue(new Error('offline'))
    result = await ctx.qianshouPluginCatalog.orderSources()
    expect(result.complete).toBe(false)
    expect(result.sources.find(row => row.id === 'skill:user-dsh:video-helper')).not.toHaveProperty('authorPublication')
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('does not reuse an approval for different local source bytes', async () => {
  const { ctx, home, publication } = await authorFixture()
  try {
    vi.spyOn(ctx.qianshouPluginCatalog, 'myOrderSkillPublications').mockResolvedValue({ items: [{ ...publication,
      artifactDigest: `sha256:${'e'.repeat(64)}` }] })
    const item = (await ctx.qianshouPluginCatalog.orderSources()).sources.find(row => row.id === 'skill:user-dsh:video-helper')
    expect(item).toMatchObject({ reason: 'local-trial-ready', eligible: false, enabled: false })
    expect(item).not.toHaveProperty('authorPublication')
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('does not expose an earlier account approval or product after the account changes during a read', async () => {
  const { ctx, home, publication, account } = await authorFixture()
  try {
    vi.spyOn(ctx.qianshouPluginCatalog, 'mySellerOrderProducts').mockImplementationOnce(async () => {
      account.id = '8'
      return { items: [{ id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', publicationId: publication.publicationId,
        status: 'published', salePriceYuan: '1.00', canApprove: false, reviewReasons: [] }] }
    })
    const result = await ctx.qianshouPluginCatalog.orderSources()
    expect(result.complete).toBe(false)
    const item = result.sources.find(row => row.id === 'skill:user-dsh:video-helper')
    expect(item).toMatchObject({ reason: 'local-trial-ready', eligible: false, enabled: false, serviceId: null })
    expect(item).not.toHaveProperty('authorPublication')
    expect(item).not.toHaveProperty('authorProductId')
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})

it('includes current device file runtimes and discards an observation after worker identity changes', async () => {
  const { ctx, home, publication, identity, policy } = await authorFixture()
  let workerId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
  const node = ctx.get('nodeContributor') as unknown as { acknowledgedWorkerId?: () => string }
  node.acknowledgedWorkerId = () => workerId
  const productId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
  vi.spyOn(ctx.qianshouPluginCatalog, 'mySellerOrderProducts').mockResolvedValue({ items: [{ id: productId,
    publicationId: publication.publicationId, status: 'published', salePriceYuan: '1.00', canApprove: false, reviewReasons: [] }] })
  vi.spyOn(ctx.qianshouPluginCatalog, 'verifiedPurchasedOrderRuntimes').mockResolvedValue([])
  const files = vi.spyOn(ctx.qianshouPluginCatalog, 'verifiedPurchasedFileOrderRuntimes').mockResolvedValue([{
    productId, entitlementId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', taskType: identity.taskType,
    capabilityId: 'text.char_counter', outputKind: 'artifact_ref', artifactDigest: identity.artifactDigest,
    packageDigest: identity.artifactDigest, runtimeDigest: `sha256:${'e'.repeat(64)}`, contractVersion: 'v1',
    contractSha256: `sha256:${'f'.repeat(64)}`, fileSchemaSha256: 'a'.repeat(64),
    fileSchema: { schema: 'qianshou.quickjs-files.v1', inputs: [], verificationPolicy: 'independent-file-bytes.v1',
      outputs: [{ name: 'result', filename: 'result.txt', contentType: 'text/plain', maxBytes: 1024, encoding: 'utf8' }] },
  }])
  policy.enabledServiceIds.push('node')
  try {
    const item = (await ctx.qianshouPluginCatalog.orderSources()).sources.find(row => row.id === 'skill:user-dsh:video-helper')
    expect(item).toMatchObject({ reason: 'ready', eligible: true, enabled: true, authorProductId: productId })
    files.mockImplementationOnce(async () => { workerId = 'ffffffff-ffff-4fff-8fff-ffffffffffff'; return [] })
    const changed = await ctx.qianshouPluginCatalog.orderSources()
    expect(changed.complete).toBe(false)
    expect(changed.sources.find(row => row.id === 'skill:user-dsh:video-helper')).toMatchObject({ eligible: false, enabled: false,
      reason: 'publication-approved', authorPublication: { status: 'approved', listingStatus: 'published' } })
  } finally { await ctx.fiber.dispose(); await rm(home, { recursive: true, force: true }) }
})
