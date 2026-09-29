/**
 * 我的能力: saved visibility, the publish wizard's four steps, and the numbers this computer
 * has not measured. Every case here decides what a saved row means and what may reach the hello.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, expect, it, vi } from 'vitest'
import QianshouPluginCatalog, {
  CAPABILITY_WIZARD_STEP_IDS,
  mergesIntoHello,
  type Config,
} from '../src/index.ts'
import type { MarketInstallRecord } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function home(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'qianshou-capabilities-'))
  roots.push(path)
  return path
}

/** One complete plugin config; a test names only what it changes. */
function marketConfig(overrides: Partial<Config> = {}): Config {
  return {
    registryUrl: 'https://registry.npmjs.org/', timeoutMs: 1000, connection: 'shipped',
    apiBaseUrl: '', installHome: '', publisherKeys: {}, ...overrides,
  }
}

function declarationPath(installHome: string): string {
  return join(installHome, 'qianshou', 'market-installed.json')
}

/** Write one declaration file, as this computer would have saved it. */
async function saveFile(installHome: string, installed: readonly Record<string, unknown>[]): Promise<void> {
  await mkdir(join(installHome, 'qianshou'), { recursive: true })
  await writeFile(declarationPath(installHome), `${JSON.stringify({ version: 1, installed }, null, 2)}\n`)
}

async function savedRows(installHome: string): Promise<MarketInstallRecord[]> {
  const body = JSON.parse(await readFile(declarationPath(installHome), 'utf8')) as { installed: MarketInstallRecord[] }
  return body.installed
}

function row(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    id: 'qianshou.article', capabilityId: 'text.transform', version: '1',
    installedAt: '2026-09-23T00:00:00.000Z', visibility: 'draft', inviteAccountIds: [], ...overrides,
  }
}

it('saves a new install as a draft that invites nobody', async () => {
  const ctx = new Context()
  const installHome = await home()
  ctx.provide('qianshou.market.hello', { refresh: async () => undefined })
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    const record = await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
    expect(record).toMatchObject({ id: 'qianshou.article', visibility: 'draft', inviteAccountIds: [] })
    expect(await savedRows(installHome)).toEqual([record])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('reads a row without visibility as a draft and a value this build does not know as one too', async () => {
  const ctx = new Context()
  const installHome = await home()
  await saveFile(installHome, [
    { id: 'qianshou.article', capabilityId: 'text.transform', version: '1', installedAt: '2026-09-23T00:00:00.000Z' },
    { id: 'qianshou.image', capabilityId: 'image.generate', version: '1', installedAt: '2026-09-23T00:00:00.000Z', visibility: 'PUBLIC' },
  ])
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    const saved = (await ctx.qianshouPluginCatalog.installed()).records
    expect(saved.map(item => [item.id, item.visibility])).toEqual([
      ['qianshou.article', 'draft'],
      ['qianshou.image', 'draft'],
    ])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('publishes only after the owner confirms, and a later draft takes the capability back out of the hello', async () => {
  const ctx = new Context()
  const installHome = await home()
  let refreshed = 0
  ctx.provide('qianshou.market.hello', { refresh: async () => { refreshed += 1 } })
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
    expect(refreshed).toBe(1)

    await expect(ctx.qianshouPluginCatalog.publishCapability({
      id: 'qianshou.article', visibility: 'public', confirmPublic: false,
    })).rejects.toThrow('publish-unconfirmed')
    expect((await savedRows(installHome))[0]?.visibility).toBe('draft')

    await expect(ctx.qianshouPluginCatalog.publishCapability({
      id: 'qianshou.article', visibility: 'private', confirmPublic: false,
    })).resolves.toMatchObject({ visibility: 'private' })
    expect(mergesIntoHello('private')).toBe(false)

    const published = await ctx.qianshouPluginCatalog.publishCapability({
      id: 'qianshou.article', visibility: 'public', confirmPublic: true,
    })
    expect(published.visibility).toBe('public')
    expect(mergesIntoHello('public')).toBe(true)
    expect((await savedRows(installHome))[0]?.visibility).toBe('public')

    // A draft step over a published row is what withdraws the capability from the next hello.
    const drafted = await ctx.qianshouPluginCatalog.saveCapabilityDraft({ id: 'qianshou.article', inviteAccountIds: [] })
    expect(drafted.visibility).toBe('draft')
    expect(refreshed).toBe(4)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('stores an invite list on this computer, dropping repeats, and leaves the row out of the hello', async () => {
  const ctx = new Context()
  const installHome = await home()
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
    const drafted = await ctx.qianshouPluginCatalog.saveCapabilityDraft({
      id: 'qianshou.article', inviteAccountIds: ['7', '7', '12'],
    })
    expect(drafted).toMatchObject({ visibility: 'draft', inviteAccountIds: ['7', '12'] })
    const invited = await ctx.qianshouPluginCatalog.publishCapability({
      id: 'qianshou.article', visibility: 'invite', confirmPublic: false,
    })
    expect(invited).toMatchObject({ visibility: 'invite', inviteAccountIds: ['7', '12'] })
    expect(mergesIntoHello('invite')).toBe(false)
    expect((await savedRows(installHome))[0]?.inviteAccountIds).toEqual(['7', '12'])
  } finally {
    await ctx.fiber.dispose()
  }
})

it('refuses an invite list that is not account ids, and an id this computer never saved', async () => {
  const ctx = new Context()
  const installHome = await home()
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
    for (const inviteAccountIds of [['abc'], ['+7'], [''], ['0']]) {
      await expect(ctx.qianshouPluginCatalog.saveCapabilityDraft({ id: 'qianshou.article', inviteAccountIds }))
        .rejects.toThrow('invalid-invite')
    }
    expect(await savedRows(installHome)).toEqual([expect.objectContaining({ inviteAccountIds: [] })])
    await expect(ctx.qianshouPluginCatalog.saveCapabilityDraft({ id: 'qianshou.absent', inviteAccountIds: [] }))
      .rejects.toThrow('unknown-listing')
    await expect(ctx.qianshouPluginCatalog.publishCapability({
      id: 'qianshou.absent', visibility: 'public', confirmPublic: true,
    })).rejects.toThrow('unknown-listing')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('refuses a visibility this build does not know', async () => {
  const ctx = new Context()
  const installHome = await home()
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
    await expect(ctx.qianshouPluginCatalog.publishCapability({
      id: 'qianshou.article', visibility: 'unlisted' as 'public', confirmPublic: true,
    })).rejects.toThrow('invalid-visibility')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('reports the wizard steps and the numbers it has not measured as unknown, never as zero', async () => {
  const ctx = new Context()
  const installHome = await home()
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    await ctx.qianshouPluginCatalog.install({ id: 'qianshou.article' })
    const view = await ctx.qianshouPluginCatalog.myCapabilities()
    expect(view.wizardSteps).toEqual([...CAPABILITY_WIZARD_STEP_IDS])
    expect(view.wizardSteps).toEqual(['identity', 'run-preflight', 'order-policy', 'publish'])
    const capability = view.capabilities[0]
    expect(capability?.record.visibility).toBe('draft')
    expect(capability?.title).toBe('文章')
    expect(capability?.advertisable).toBe(true)
    // Unmeasured stays unmeasured: none of the three carries a value, so none can read as 0.
    expect(capability?.metrics).toEqual({
      successRate: { state: 'unknown', reason: 'no-local-sample' },
      p95LatencyMs: { state: 'unknown', reason: 'no-local-sample' },
      vramBytes: { state: 'unknown', reason: 'not-probed' },
    })
    expect(capability?.metrics).not.toHaveProperty('vramBytes.value')
    expect(capability?.freeDiskBytes).toBeGreaterThan(0)
    expect(capability?.totalMemoryBytes).toBeGreaterThan(0)
  } finally {
    await ctx.fiber.dispose()
  }
})

it('marks a capability this computer cannot accept, and refuses to publish it', async () => {
  const ctx = new Context()
  const installHome = await home()
  await saveFile(installHome, [
    row({ id: 'qianshou.image', capabilityId: 'image.generate', visibility: 'public' }),
  ])
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    const view = await ctx.qianshouPluginCatalog.myCapabilities()
    expect(view.capabilities[0]?.advertisable).toBe(false)
    await expect(ctx.qianshouPluginCatalog.publishCapability({
      id: 'qianshou.image', visibility: 'public', confirmPublic: true,
    })).rejects.toThrow('not-advertisable')
    expect((await savedRows(installHome))[0]?.visibility).toBe('public')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('lists a saved row even when the market itself cannot be read', async () => {
  const ctx = new Context()
  const installHome = await home()
  await saveFile(installHome, [row()])
  try {
    // API mode with a dead origin: the saved rows are local and must still be listed.
    await ctx.plugin(QianshouPluginCatalog, marketConfig({
      connection: 'api', apiBaseUrl: 'http://127.0.0.1:1/', timeoutMs: 1000, installHome,
    }))
    const view = await ctx.qianshouPluginCatalog.myCapabilities()
    expect(view.capabilities[0]).toMatchObject({ title: 'qianshou.article', summary: '', advertisable: false })
  } finally {
    await ctx.fiber.dispose()
  }
})

it('reads the saved order policy from the compute service, and reports unknown without one', async () => {
  const ctx = new Context()
  const installHome = await home()
  let read: () => Promise<{ mode: string; maxConcurrency: number }> = async () => ({ mode: 'idle', maxConcurrency: 2 })
  ctx.provide('computeCore', { ownerSupplyPolicy: () => read() })
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    const listings = vi.spyOn(ctx.qianshouPluginCatalog, 'listings').mockRejectedValue(new Error('market offline'))
    expect(await ctx.qianshouPluginCatalog.myOrderPolicy()).toEqual({ mode: 'idle', maxConcurrency: 2 })
    expect(listings).not.toHaveBeenCalled()
    expect((await ctx.qianshouPluginCatalog.myCapabilities()).order).toEqual({ mode: 'idle', maxConcurrency: 2 })
    read = async () => { throw new Error('compute down') }
    expect((await ctx.qianshouPluginCatalog.myCapabilities()).order).toBeNull()
    read = async () => ({ mode: 'PAUSED', maxConcurrency: 2 })
    expect((await ctx.qianshouPluginCatalog.myCapabilities()).order).toBeNull()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('persists only the owner master supply mode and mirrors the node veto without adding per-service grants', async () => {
  const ctx = new Context()
  const installHome = await home()
  const events: string[] = []
  let policy = { mode: 'off', maxConcurrency: 2, minFreeMemoryBytes: 4_000_000_000, minIdleSeconds: 60,
    enabledServiceIds: [] as string[], nodeRates: [] as unknown[] }
  const updateOwnerSupply = vi.fn(async (command: { kind: 'mode'; mode: 'off' | 'idle' }) => {
    policy = { ...policy, mode: command.mode }
    events.push(`save:${policy.mode}`)
    return { ownerPolicy: policy }
  })
  ctx.provide('computeCore', { ownerSupplyPolicy: async () => policy, updateOwnerSupply })
  ctx.provide('nodeContributor', { setPanelAccepting: (on: boolean) => { events.push(`veto:${String(on)}`) } })
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    expect((await ctx.qianshouPluginCatalog.myCapabilities()).order).toEqual({ mode: 'off', maxConcurrency: 2, enabledServiceCount: 0, enabledServiceIds: [] })
    expect(await ctx.qianshouPluginCatalog.setOwnerSupplyEnabled({ enabled: true })).toEqual({ mode: 'idle', maxConcurrency: 2, enabledServiceCount: 0, enabledServiceIds: [] })
    expect(events).toEqual(['save:idle', 'veto:true'])
    expect(updateOwnerSupply).toHaveBeenLastCalledWith({ kind: 'mode', mode: 'idle' }, undefined)
    expect(policy).toMatchObject({ mode: 'idle', enabledServiceIds: [], nodeRates: [], minIdleSeconds: 60 })
    events.length = 0
    expect(await ctx.qianshouPluginCatalog.setOwnerSupplyEnabled({ enabled: false })).toMatchObject({ mode: 'off', enabledServiceCount: 0 })
    expect(events).toEqual(['veto:false', 'save:off'])
    expect(policy.enabledServiceIds).toEqual([])
    await expect(ctx.qianshouPluginCatalog.setOwnerSupplyEnabled({ enabled: 'yes' as unknown as boolean }))
      .rejects.toThrow('invalid-supply-toggle')
  } finally {
    await ctx.fiber.dispose()
  }
})

it('grants only a freshly probed and runnable node order service while keeping the master switch off', async () => {
  const ctx = new Context()
  const installHome = await home()
  const events: string[] = []
  let policy = { mode: 'off', maxConcurrency: 2, minFreeMemoryBytes: 4096, minIdleSeconds: 60,
    enabledServiceIds: ['git'], nodeRates: [{ localServiceId: 'git', amountMinor: 10, unit: 'task', currency: 'CNY' }] }
  ctx.provide('computeCore', {
    ownerSupplyPolicy: async () => policy,
    querySupplySnapshot: async () => {
      events.push('probe')
      return { localServices: [{ id: 'node', kind: 'tool', verification: 'verified' }] }
    },
    updateOwnerSupply: async (command: { kind: 'local-service'; serviceId: string; enabled: boolean }) => {
      policy = { ...policy, enabledServiceIds: command.enabled ? [...policy.enabledServiceIds, command.serviceId]
        : policy.enabledServiceIds.filter(id => id !== command.serviceId),
      nodeRates: command.enabled ? policy.nodeRates : policy.nodeRates.filter(rate => rate.localServiceId !== command.serviceId) }
      events.push(`save:${policy.enabledServiceIds.join(',')}`); return { ownerPolicy: policy }
    },
  })
  ctx.provide('nodeContributor', {
    canEnableLocalService: async (id: string) => { events.push(`runnable:${id}`); return id === 'node' },
    setPanelAccepting: (on: boolean) => { events.push(`veto:${String(on)}`) },
  })
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    expect(await ctx.qianshouPluginCatalog.setLocalServiceEnabled({ serviceId: 'node', enabled: true }))
      .toEqual({ mode: 'off', maxConcurrency: 2, enabledServiceCount: 2, enabledServiceIds: ['git', 'node'] })
    expect(events).toEqual(['probe', 'runnable:node', 'save:git,node', 'veto:true'])
    expect(policy).toMatchObject({ mode: 'off', minFreeMemoryBytes: 4096, minIdleSeconds: 60,
      nodeRates: [{ localServiceId: 'git', amountMinor: 10, unit: 'task', currency: 'CNY' }] })
    policy = { ...policy, nodeRates: [...policy.nodeRates,
      { localServiceId: 'node', amountMinor: 20, unit: 'task', currency: 'CNY' }] }
    events.length = 0
    expect(await ctx.qianshouPluginCatalog.setLocalServiceEnabled({ serviceId: 'node', enabled: false }))
      .toEqual({ mode: 'off', maxConcurrency: 2, enabledServiceCount: 1, enabledServiceIds: ['git'] })
    expect(events).toEqual(['veto:false', 'save:git'])
    expect(policy.mode).toBe('off')
    expect(policy.nodeRates).toEqual([{ localServiceId: 'git', amountMinor: 10, unit: 'task', currency: 'CNY' }])
  } finally { await ctx.fiber.dispose() }
})

it('refuses malformed, unverified, or unrunnable per-service grants without changing the owner policy', async () => {
  const ctx = new Context()
  const installHome = await home()
  const policy = { mode: 'idle', maxConcurrency: 1, minFreeMemoryBytes: 0, minIdleSeconds: 30,
    enabledServiceIds: [] as string[], nodeRates: [] as unknown[] }
  let services: readonly { id: string; kind: string; verification: string }[] = []
  let runnable = true
  const updateOwnerSupply = vi.fn()
  ctx.provide('computeCore', {
    ownerSupplyPolicy: async () => policy,
    querySupplySnapshot: async () => ({ localServices: services }),
    updateOwnerSupply,
  })
  ctx.provide('nodeContributor', { canEnableLocalService: async () => runnable, setPanelAccepting: () => undefined })
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    for (const request of [
      { serviceId: 'git', enabled: true },
      { serviceId: 'node', enabled: 'true' },
      { serviceId: 'node', enabled: true, mode: 'allowed' },
    ]) {
      await expect(ctx.qianshouPluginCatalog.setLocalServiceEnabled(request as never)).rejects.toThrow('invalid-service-toggle')
    }
    await expect(ctx.qianshouPluginCatalog.setLocalServiceEnabled({ serviceId: 'node', enabled: true }))
      .rejects.toThrow('service-unavailable')
    services = [{ id: 'node', kind: 'tool', verification: 'verified' }]
    runnable = false
    await expect(ctx.qianshouPluginCatalog.setLocalServiceEnabled({ serviceId: 'node', enabled: true }))
      .rejects.toThrow('service-unavailable')
    expect(updateOwnerSupply).not.toHaveBeenCalled()
    expect(policy.enabledServiceIds).toEqual([])
  } finally { await ctx.fiber.dispose() }
})

it('vetoes intake before revocation and leaves it paused when persisting fails', async () => {
  const ctx = new Context()
  const installHome = await home()
  const events: string[] = []
  ctx.provide('computeCore', {
    ownerSupplyPolicy: async () => ({ mode: 'idle', maxConcurrency: 1, minFreeMemoryBytes: 0, minIdleSeconds: 0,
      enabledServiceIds: ['node'], nodeRates: [] }),
    updateOwnerSupply: async () => { events.push('save-failed'); throw new Error('disk unavailable') },
  })
  ctx.provide('nodeContributor', { setPanelAccepting: (on: boolean) => { events.push(`veto:${String(on)}`) } })
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    await expect(ctx.qianshouPluginCatalog.setLocalServiceEnabled({ serviceId: 'node', enabled: false }))
      .rejects.toThrow('supply-unavailable')
    expect(events).toEqual(['veto:false', 'save-failed'])
  } finally { await ctx.fiber.dispose() }
})

it('fails closed without the atomic Host switch instead of falling back to a full-policy write', async () => {
  const ctx = new Context()
  const installHome = await home()
  const fullWrite = vi.fn()
  ctx.provide('computeCore', { ownerSupplyPolicy: async () => ({ mode: 'off', maxConcurrency: 1 }), updateSupplyPolicy: fullWrite })
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({ installHome }))
    await expect(ctx.qianshouPluginCatalog.setOwnerSupplyEnabled({ enabled: true })).rejects.toThrow('supply-unavailable')
    await expect(ctx.qianshouPluginCatalog.setLocalServiceEnabled({ serviceId: 'node', enabled: false })).rejects.toThrow('supply-unavailable')
    expect(fullWrite).not.toHaveBeenCalled()
  } finally {
    await ctx.fiber.dispose()
  }
})

it('refuses to publish an API row that impersonates an empty-package built-in declaration', async () => {
  const ctx = new Context()
  const installHome = await home()
  await saveFile(installHome, [row()])
  const server = createServer((request, response) => {
    if (request.url !== '/plugins') { response.writeHead(404).end(); return }
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ listings: [{
      id: 'qianshou.article', title: '文章', summary: 'article', capabilityId: 'text.transform',
      version: '1', packageSpec: '', installable: true,
    }] }))
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('listen failed')
  try {
    await ctx.plugin(QianshouPluginCatalog, marketConfig({
      connection: 'api', apiBaseUrl: `http://127.0.0.1:${address.port}/`, timeoutMs: 5000, installHome,
    }))
    // API rows cannot mint a package-free built-in declaration, even with the same id.
    await expect(ctx.qianshouPluginCatalog.preflight({ id: 'qianshou.article' }))
      .rejects.toThrow('not-advertisable')
    await expect(ctx.qianshouPluginCatalog.publishCapability({
      id: 'qianshou.article', visibility: 'public', confirmPublic: true,
    })).rejects.toThrow('not-advertisable')
    expect((await savedRows(installHome))[0]?.visibility).toBe('draft')
  } finally {
    server.closeAllConnections()
    await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
    await ctx.fiber.dispose()
  }
})
