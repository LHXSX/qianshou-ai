import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import Catalog, { type Config } from '../src/index.ts'
import { installedOrderAdapterSource } from '../src/installed-order-adapter.ts'
import { buildCanonicalOrderArchive } from '../src/order-source-archive.ts'
import { CatalogFailure } from '../src/registry.ts'

const installed = vi.hoisted(() => vi.fn())
vi.mock('../src/installed-order-adapter.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/installed-order-adapter.ts')>(),
  installedOrderAdapter: installed,
}))

const contexts: Context[] = []
const homes: string[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })))
  installed.mockReset()
})

async function fixture(selectArtifactAdapter: (input: unknown) => Promise<unknown>,
  options: { skillImport?: boolean; contributor?: boolean; declaration?: Record<string, unknown>;
    coreOrigin?: string; allowTestOrderAdapterPurchase?: boolean; skillName?: string } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'qianshou-order-skill-'))
  homes.push(home)
  const skillName = options.skillName ?? 'svg-to-video'
  const skillDir = join(home, skillName)
  const skillPath = join(skillDir, 'SKILL.md')
  const adapterRoot = join(skillDir, 'scripts', 'order_adapter')
  await mkdir(adapterRoot, { recursive: true })
  await writeFile(skillPath, '# Test installed skill\n')
  await writeFile(join(adapterRoot, 'local-adapter.json'), JSON.stringify(options.declaration ?? {
    schema: 'qianshou.local-adapter-candidate.v1', taskType: 'bar_chart_svg_v1',
    inputKind: 'inline_json', outputKind: 'local_artifact_manifest', platformDispatchable: true,
  }))
  await mkdir(join(adapterRoot, 'src'), { recursive: true })
  for (const [name, contents] of [
    ['package.json', '{"version":"0.1.0"}'], ['pnpm-lock.yaml', 'lockfileVersion: 9'],
    ['src/adapter.mjs', '// test adapter'], ['src/assemble_gif.py', '# test gif'],
    ['src/encode_frames.swift', '// test mp4'],
  ] as const) await writeFile(join(adapterRoot, name), contents)
  const ctx = new Context()
  contexts.push(ctx)
  const config: Config = { registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000,
    connection: 'shipped', apiBaseUrl: '', installHome: home, publisherKeys: {},
    ...(options.coreOrigin === undefined ? {} : { coreOrigin: options.coreOrigin }),
    ...(options.allowTestOrderAdapterPurchase === undefined ? {} : { allowTestOrderAdapterPurchase: options.allowTestOrderAdapterPurchase }) }
  // Match desktop composition: the catalog mounts before skill import and contributor.
  await ctx.plugin(Catalog, config)
  ctx.provide('profileContext', { dir: home })
  if (options.skillImport !== false) ctx.provide('qianshouSkillImport', { listLocal: async () => ({ skills: [{
    name: skillName, source: 'user-agents', path: skillPath,
  }] }) })
  if (options.contributor !== false) ctx.provide('nodeContributor', { selectArtifactAdapter })
  ctx.provide('accountSession', { ensureAccessToken: async () => 'isolated-test-token' })
  return { catalog: ctx.qianshouPluginCatalog, skillPath, adapterRoot, home }
}

const request = { source: 'user-agents' as const, name: 'svg-to-video',
  displayName: '柱状图动效', purpose: '制作动效', configuration: '', priceYuan: '0.00' }

it.each(['-1', '100000.01', '0.001', '1e2', ''])('rejects invalid buyout price %s before adapter preparation or publication', async salePriceYuan => {
  const select = vi.fn()
  const { catalog } = await fixture(select)
  await expect(catalog.submitInstalledOrderSkill({ ...request, salePriceYuan }))
    .rejects.toMatchObject({ code: 'order-draft-invalid' })
  expect(installed).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
})

it('keeps a missing isolated Pillow runtime separate from a missing adapter', async () => {
  installed.mockRejectedValue(new CatalogFailure('order-runtime-unavailable'))
  const select = vi.fn()
  const { catalog, skillPath } = await fixture(select)
  await expect(catalog.submitInstalledOrderSkill(request))
    .rejects.toMatchObject({ code: 'order-runtime-unavailable' })
  expect(installed).toHaveBeenCalledWith(skillPath, { prepareRuntime: true })
  expect(select).not.toHaveBeenCalled()
})

it('reports a failed local media self-test without inventing a platform submission', async () => {
  installed.mockResolvedValue({ root: '/installed/svg-to-video/scripts/order_adapter', digest: 'a'.repeat(64),
    version: '0.1.0', taskType: 'bar_chart_svg_v1', capabilityId: 'video.render',
    pythonPath: '/isolated/python', swiftPath: '/usr/bin/swift' })
  const select = vi.fn(async () => { throw new Error('COMPUTE_ARTIFACT_ADAPTER_EXECUTION_FAILED') })
  const { catalog } = await fixture(select)
  await expect(catalog.submitInstalledOrderSkill(request))
    .rejects.toMatchObject({ code: 'order-local-verification-failed' })
  expect(select).toHaveBeenCalledTimes(1)
})

it('refuses to sign a v3 runtime digest as a v4 author package', async () => {
  const { catalog, skillPath } = await fixture(async () => {
    const source = await installedOrderAdapterSource(skillPath)
    return { taskType: 'bar_chart_svg_v1', artifactDigest: `sha256:${source.digest}`,
      packageDigest: `sha256:${'b'.repeat(64)}`,
      inventoryAlgorithm: 'qianshou.bar-chart-package.v3',
      localVerified: true, platformReady: false }
  })
  const source = await installedOrderAdapterSource(skillPath)
  installed.mockResolvedValue({ ...source, pythonPath: '/isolated/python', swiftPath: '/usr/bin/swift' })
  const send = vi.fn()
  vi.stubGlobal('fetch', send)
  try {
    await expect(catalog.submitInstalledOrderSkill(request))
      .rejects.toMatchObject({ code: 'order-local-verification-failed' })
    expect(send).not.toHaveBeenCalled()
  } finally { vi.unstubAllGlobals() }
})

it('uses the adapter-specific error only when the adapter files fail validation', async () => {
  installed.mockRejectedValue(new Error('missing manifest'))
  const select = vi.fn()
  const { catalog } = await fixture(select)
  await expect(catalog.submitInstalledOrderSkill(request))
    .rejects.toMatchObject({ code: 'order-adapter-invalid' })
  expect(select).not.toHaveBeenCalled()
})

it('distinguishes a missing skill inventory service from local media self-test', async () => {
  const select = vi.fn()
  const { catalog } = await fixture(select, { skillImport: false })
  await expect(catalog.submitInstalledOrderSkill(request))
    .rejects.toMatchObject({ code: 'order-skill-import-unavailable' })
  expect(installed).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
})

it('prepares the fixed runtime before reporting a missing node contributor service', async () => {
  installed.mockResolvedValue({ root: '/installed/svg-to-video/scripts/order_adapter', digest: 'a'.repeat(64),
    version: '0.1.0', taskType: 'bar_chart_svg_v1', capabilityId: 'video.render',
    pythonPath: '/isolated/python', swiftPath: '/usr/bin/swift' })
  const select = vi.fn()
  const { catalog, skillPath } = await fixture(select, { contributor: false })
  await expect(catalog.submitInstalledOrderSkill(request))
    .rejects.toMatchObject({ code: 'order-node-contributor-unavailable' })
  expect(installed).toHaveBeenCalledWith(skillPath, { prepareRuntime: true })
  expect(select).not.toHaveBeenCalled()
})

it('never prepares or executes an unregistered installed skill declaration', async () => {
  const select = vi.fn()
  const { catalog } = await fixture(select, { declaration: {
    schema: 'qianshou.local-adapter-candidate.v1', taskType: 'unreviewed_file_worker',
    inputKind: 'file', outputKind: 'local_artifact_manifest',
  } })
  await expect(catalog.submitInstalledOrderSkill(request))
    .rejects.toMatchObject({ code: 'order-adapter-invalid' })
  expect(installed).not.toHaveBeenCalled()
  expect(select).not.toHaveBeenCalled()
})

it('selects a registered task contract without requiring a specific skill name', async () => {
  installed.mockResolvedValue({ root: '/private/chart-maker/scripts/order_adapter', digest: 'a'.repeat(64),
    version: '0.1.0', taskType: 'bar_chart_svg_v1', capabilityId: 'video.render',
    pythonPath: '/isolated/python', swiftPath: '/usr/bin/swift' })
  const select = vi.fn(async () => { throw new Error('LOCAL_SELF_TEST_FAILED') })
  const { catalog, skillPath } = await fixture(select, { skillName: 'chart-maker' })
  await expect(catalog.submitInstalledOrderSkill({ ...request, name: 'chart-maker' }))
    .rejects.toMatchObject({ code: 'order-local-verification-failed' })
  expect(installed).toHaveBeenCalledWith(skillPath, { prepareRuntime: true })
  expect(select).toHaveBeenCalledTimes(1)
})

it('lists only intact registered order adapters without preparing, running, or submitting them', async () => {
  const select = vi.fn()
  const { catalog, skillPath, adapterRoot } = await fixture(select, { skillName: 'chart-maker' })
  const source = await installedOrderAdapterSource(skillPath)
  expect(await catalog.localOrderSkillEligibility()).toEqual({ items: [{
    source: 'user-agents', name: 'chart-maker', path: skillPath,
    taskType: 'bar_chart_svg_v1', artifactDigest: `sha256:${source.digest}`,
    platformPriced: false,
  }] })
  expect(select).not.toHaveBeenCalled()
  expect(installed).not.toHaveBeenCalled()
  await rm(join(adapterRoot, 'src/adapter.mjs'))
  expect(await catalog.localOrderSkillEligibility()).toEqual({ items: [] })
})

it('never labels an unregistered skill as ready to publish', async () => {
  const select = vi.fn()
  const { catalog } = await fixture(select, { declaration: {
    schema: 'qianshou.local-adapter-candidate.v1', taskType: 'unreviewed_file_worker',
    inputKind: 'file', outputKind: 'local_artifact_manifest',
  } })
  expect(await catalog.localOrderSkillEligibility()).toEqual({ items: [] })
  expect(select).not.toHaveBeenCalled()
  expect(installed).not.toHaveBeenCalled()
})

it('treats a plain SKILL.md without an adapter declaration as guidance only', async () => {
  const { catalog, adapterRoot } = await fixture(vi.fn())
  await rm(join(adapterRoot, 'local-adapter.json'))
  expect(await catalog.localOrderSkillEligibility()).toEqual({ items: [] })
  expect(installed).not.toHaveBeenCalled()
})

it('restores old platform submission without rewriting it during v2/v3-to-v4 migration', async () => {
  const select = vi.fn()
  const { catalog, skillPath, adapterRoot, home } = await fixture(select, { skillName: 'chart-maker' })
  const choice = join(home, 'qianshou-artifact-adapter.json')
  await writeFile(choice, JSON.stringify({ version: 2, packageDigest: 'b'.repeat(64) }))
  const source = await installedOrderAdapterSource(skillPath)
  const publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
  const send = vi.fn(async (url: URL, request: RequestInit) => {
    expect(url.pathname).toBe('/api/v8/task-adapter-publications/mine')
    expect(request.method).toBe('GET')
    return new Response(JSON.stringify({ items: [{
      id: publicationId, owner_id: 111111, task_type: 'bar_chart_svg_v1',
      artifact_digest: `sha256:${source.digest}`, package_digest: `sha256:${'b'.repeat(64)}`,
      status: 'review', review_reasons: ['等待独立审核'],
    }] }), { status: 200 })
  })
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', send)
  try {
    expect(await catalog.myOrderSkillPublications()).toEqual({ items: [{
      source: 'user-agents', name: 'chart-maker', publicationId, status: 'review',
      taskType: 'bar_chart_svg_v1', artifactDigest: `sha256:${source.digest}`,
      reviewReasons: ['等待独立审核'], archiveStatus: 'pending', packageMigrationRequired: true,
    }] })
    await writeFile(choice, JSON.stringify({ version: 3, packageDigest: 'c'.repeat(64) }))
    expect(await catalog.myOrderSkillPublications()).toEqual({ items: [{
      source: 'user-agents', name: 'chart-maker', publicationId, status: 'review',
      taskType: 'bar_chart_svg_v1', artifactDigest: `sha256:${source.digest}`,
      reviewReasons: ['等待独立审核'], archiveStatus: 'pending', packageMigrationRequired: true,
    }] })
    await writeFile(join(adapterRoot, 'src/adapter.mjs'), '// changed adapter')
    expect((await installedOrderAdapterSource(skillPath)).digest).not.toBe(source.digest)
    expect(await catalog.myOrderSkillPublications()).toEqual({ items: [] })
    expect(await catalog.myOrderSkillPublications({ includeArchived: true })).toEqual({ items: [{
      source: 'platform', name: 'bar_chart_svg_v1', displayName: 'bar_chart_svg_v1',
      publicationId, status: 'review', taskType: 'bar_chart_svg_v1',
      artifactDigest: `sha256:${source.digest}`, reviewReasons: ['等待独立审核'],
    }] })
    expect(await catalog.myOrderSkillPublications()).toEqual({ items: [] })
    expect(send.mock.calls.map(([url]) => url.search)).toEqual([
      '', '', '', '?include_archived=true', '',
    ])
    expect(JSON.parse(await readFile(choice, 'utf8'))).toEqual({
      version: 3, packageDigest: 'c'.repeat(64),
    })
    expect(await readFile(join(adapterRoot, 'src/adapter.mjs'), 'utf8')).toBe('// changed adapter')
    expect(select).not.toHaveBeenCalled()
    expect(installed).not.toHaveBeenCalled()
  } finally {
    vi.unstubAllGlobals()
    expect(globalThis.fetch).toBe(originalFetch)
  }
})

it('retries an existing confirmed archive without creating a second publication', async () => {
  const packageDigest = `sha256:${'b'.repeat(64)}`
  const { catalog, skillPath, adapterRoot } = await fixture(async () => {
    const source = await installedOrderAdapterSource(skillPath)
    return { taskType: 'bar_chart_svg_v1', artifactDigest: `sha256:${source.digest}`,
      packageDigest, inventoryAlgorithm: 'qianshou.bar-chart-package.v4',
      localVerified: true, platformReady: false }
  })
  const source = await installedOrderAdapterSource(skillPath)
  const artifactDigest = `sha256:${source.digest}`
  const archive = await buildCanonicalOrderArchive(adapterRoot, artifactDigest)
  installed.mockResolvedValue({ ...source, pythonPath: '/isolated/python', swiftPath: '/usr/bin/swift' })
  const publicationId = 'b9418e38-b3a5-5722-8005-cc7afbe2a21a'
  const send = vi.fn(async (url: URL, request: RequestInit) => {
    if (url.pathname.endsWith('/mine')) return new Response(JSON.stringify({ items: [{
      id: publicationId, owner_id: 111111, task_type: 'bar_chart_svg_v1',
      artifact_digest: artifactDigest, package_digest: packageDigest,
      status: 'review', review_reasons: ['等待广州验包'], package_upload_status: 'confirmed',
      author_manifest_status: 'recorded',
    }] }))
    if (url.pathname.endsWith('/task-adapter-publisher-keys/challenge')) return Response.json({
      schema: 'qianshou.order-adapter-key-enrollment.v1', owner_id: 111111,
      challenge_id: 'b9418e38-b3a5-5722-8005-cc7afbe2a21b', nonce: 'n'.repeat(43),
      expires_at: Math.floor(Date.now() / 1000) + 240,
    })
    if (url.pathname.endsWith('/task-adapter-publisher-keys')) {
      const body = JSON.parse(String(request.body)) as { key_id: string; public_key: string }
      return Response.json({ schema: 'qianshou.order-adapter-publisher-key.v1', owner_id: 111111,
        key_id: body.key_id, public_key: body.public_key, status: 'active' })
    }
    if (url.pathname.endsWith('/author-manifest')) {
      const body = JSON.parse(String(request.body)) as { author_manifest: { key_id: string } }
      return Response.json({ publication_id: publicationId, owner_id: 111111,
        key_id: body.author_manifest.key_id, status: 'recorded' })
    }
    if (url.pathname.endsWith('/review-samples/start')) {
      expect(request.method).toBe('POST')
      return Response.json({ publication_id: publicationId, status: 'pending',
        media_evidence_status: 'missing',
        samples: { gif: { status: 'pending' }, mp4: { status: 'pending' } } })
    }
    expect(request.method).toBe('GET')
    return new Response(JSON.stringify({ publication_id: publicationId, status: 'confirmed',
      object_key: `v8/account-111111/publication/${publicationId}/adapter/source.zip`,
      archive_digest: archive.archiveDigest, size_bytes: archive.sizeBytes, version_id: 'v-42' }))
  })
  vi.stubGlobal('fetch', send)
  try {
    expect(await catalog.retryInstalledOrderSkillArchive({ source: 'user-agents', name: 'svg-to-video' }))
      .toMatchObject({ publicationId, archiveStatus: 'confirmed', status: 'review',
        reviewSampleStatus: 'pending', mediaEvidenceStatus: 'missing' })
    expect(send).toHaveBeenCalledTimes(6)
  } finally { vi.unstubAllGlobals() }
})

it('keeps paid purchase closed on production and unless explicitly enabled for loopback tests', async () => {
  const select = vi.fn()
  for (const options of [
    { coreOrigin: 'https://qianshousuanli.com', allowTestOrderAdapterPurchase: true },
    { coreOrigin: 'http://127.0.0.1:47123', allowTestOrderAdapterPurchase: false },
  ]) {
    const { catalog } = await fixture(select, options)
    await expect(catalog.purchaseOrderAdapterProduct({ productId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a',
      idempotencyKey: 'isolated-key-123' }))
      .rejects.toMatchObject({ code: 'order-install-not-ready' })
  }
})
