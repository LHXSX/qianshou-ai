/** The owner's saved intake policy is read from the Host that owns the compute policy. */
export interface IntakeSupplyOrder {
  readonly mode: 'off' | 'idle' | 'allowed'
  readonly maxConcurrency: number
  readonly enabledServiceCount: number | null
  /** Saved owner grants; null means this Host has not reported the exact IDs. */
  readonly enabledServiceIds: readonly string[] | null
}

export interface IntakeOrderSource {
  readonly id: string
  readonly authorProductId?: string
  readonly authorPublication?: {
    readonly publicationId: string
    readonly status: 'review' | 'approved' | 'rejected'
    readonly archiveConfirmed: boolean
    readonly listingStatus: 'not-listed' | 'review' | 'published' | 'rejected' | 'unavailable'
    readonly salePriceYuan: string | null
  }
  readonly kind: 'builtin' | 'plugin' | 'skill'
  readonly source: 'builtin' | 'profile-bundle' | 'profile-entry' | 'user-dsh' | 'user-agents'
  readonly title: string
  readonly description: string
  readonly category: string | null
  readonly loadState: 'active' | 'disabled' | 'failed' | 'unknown'
  readonly capabilityId: string | null
  readonly taskType: string | null
  readonly serviceId: 'node' | null
  /** A candidate may be selected after a fresh Host self-test; selection never grants intake. */
  readonly selectable: boolean
  readonly eligible: boolean
  readonly enabled: boolean
  readonly reason: 'ready' | 'not-selected' | 'not-active' | 'platform-task-unmapped'
    | 'file-input-unsupported' | 'executor-unverified' | 'output-unverified'
    | 'conversation-only' | 'local-trial-ready' | 'publication-pending' | 'publication-approved' | 'publication-rejected'
}

export interface IntakeOrderSources {
  readonly sources: readonly IntakeOrderSource[]
  readonly complete: boolean
}

export interface IntakeOrderSourceSelection {
  readonly selectedSourceId: string
  readonly taskType: string
  readonly capabilityId: string
  readonly requiresGrant: true
}

type RemoteResult = {
  readonly ok: true
  readonly value: unknown
} | {
  readonly ok: false
  readonly error: {
    readonly message: string
    readonly code?: string
  }
}

function validAuthorPublication(item: Record<string, unknown>): boolean {
  if (item.authorPublication === undefined) return true
  if (item.kind !== 'skill' || !['user-dsh', 'user-agents'].includes(String(item.source))) return false
  const value = item.authorPublication
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'archiveConfirmed,listingStatus,publicationId,salePriceYuan,status'
    || typeof row.publicationId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(row.publicationId)
    || !['review', 'approved', 'rejected'].includes(String(row.status))
    || typeof row.archiveConfirmed !== 'boolean'
    || !['not-listed', 'review', 'published', 'rejected', 'unavailable'].includes(String(row.listingStatus))
    || (row.salePriceYuan !== null && (typeof row.salePriceYuan !== 'string'
      || !/^(?:0|[1-9][0-9]{0,9})\.[0-9]{2}$/u.test(row.salePriceYuan)))) return false
  return item.authorProductId === undefined
    || row.status === 'approved' && row.archiveConfirmed && row.listingStatus === 'published'
}

export interface IntakeSupplyRemote {
  myCapabilities(): Promise<RemoteResult>
  /** Newer Hosts expose this small read without waiting for marketplace discovery. */
  myOrderPolicy?(): Promise<RemoteResult>
  orderSources(): Promise<RemoteResult>
  selectOrderSource?(request: { readonly sourceId: string }): Promise<RemoteResult>
  activateAuthorOrderSkill?(request: { readonly source: 'user-dsh' | 'user-agents'; readonly name: string }): Promise<RemoteResult>
  setOwnerSupplyEnabled(request: { readonly enabled: boolean }): Promise<RemoteResult>
  setLocalServiceEnabled(request: { readonly serviceId: 'node'; readonly enabled: boolean }): Promise<RemoteResult>
}

export interface IntakeSupplyTransport {
  read(): Promise<IntakeSupplyOrder | null>
  listSources?(): Promise<IntakeOrderSources>
  selectSource?(sourceId: string): Promise<IntakeOrderSourceSelection>
  activateAuthorSource?(sourceId: string): Promise<IntakeSupplyOrder>
  set(enabled: boolean): Promise<IntakeSupplyOrder>
  setTextService(enabled: boolean): Promise<IntakeSupplyOrder>
}

function parseSources(value: unknown): IntakeOrderSources {
  if (typeof value !== 'object' || value === null) throw new Error('INVALID_ORDER_SOURCES')
  const envelope = value as Record<string, unknown>
  if (!Array.isArray(envelope.sources) || typeof envelope.complete !== 'boolean') throw new Error('INVALID_ORDER_SOURCES')
  const sources: IntakeOrderSource[] = []
  const ids = new Set<string>()
  let nodeGrant: boolean | undefined
  let defaultNodeCount = 0
  for (const raw of envelope.sources) {
    if (typeof raw !== 'object' || raw === null) throw new Error('INVALID_ORDER_SOURCES')
    const item = raw as Record<string, unknown>
    if (typeof item.id !== 'string' || item.id.length === 0 || ids.has(item.id)
      || !['builtin', 'plugin', 'skill'].includes(String(item.kind))
      || !['builtin', 'profile-bundle', 'profile-entry', 'user-dsh', 'user-agents'].includes(String(item.source))
      || typeof item.title !== 'string' || typeof item.description !== 'string'
      || (item.category !== null && typeof item.category !== 'string')
      || !['active', 'disabled', 'failed', 'unknown'].includes(String(item.loadState))
      || (item.capabilityId !== null && typeof item.capabilityId !== 'string')
      || (item.taskType !== null && typeof item.taskType !== 'string')
      || (item.serviceId !== null && item.serviceId !== 'node')
      || (item.authorProductId !== undefined && (item.kind !== 'skill'
        || !['user-dsh', 'user-agents'].includes(String(item.source))
        || typeof item.authorProductId !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u.test(item.authorProductId)))
      || typeof item.selectable !== 'boolean'
      || !validAuthorPublication(item)
      || typeof item.eligible !== 'boolean' || typeof item.enabled !== 'boolean'
      || !['ready', 'not-selected', 'not-active', 'platform-task-unmapped', 'file-input-unsupported',
        'executor-unverified', 'output-unverified', 'conversation-only', 'local-trial-ready',
        'publication-pending', 'publication-approved', 'publication-rejected'].includes(String(item.reason))
      || (item.eligible && item.serviceId !== 'node') || (item.enabled && item.serviceId !== 'node')) {
      throw new Error('INVALID_ORDER_SOURCES')
    }
    if (item.serviceId === 'node') {
      if (nodeGrant !== undefined && nodeGrant !== item.enabled) throw new Error('INVALID_ORDER_SOURCES')
      if (item.kind === 'skill' && (item.authorProductId === undefined || !item.eligible
        || item.reason !== 'ready' || item.loadState !== 'active')) throw new Error('INVALID_ORDER_SOURCES')
      if (item.kind !== 'skill' && ++defaultNodeCount > 1) throw new Error('INVALID_ORDER_SOURCES')
      nodeGrant = item.enabled as boolean
    }
    ids.add(item.id)
    sources.push(item as unknown as IntakeOrderSource)
  }
  return { sources, complete: envelope.complete }
}

function parseSelection(value: unknown): IntakeOrderSourceSelection {
  if (typeof value !== 'object' || value === null) throw new Error('INVALID_ORDER_SOURCE_SELECTION')
  const result = value as Record<string, unknown>
  if (typeof result.selectedSourceId !== 'string' || result.selectedSourceId.length === 0
    || typeof result.taskType !== 'string' || result.taskType.length === 0
    || typeof result.capabilityId !== 'string' || result.capabilityId.length === 0
    || result.requiresGrant !== true) throw new Error('INVALID_ORDER_SOURCE_SELECTION')
  return result as unknown as IntakeOrderSourceSelection
}

function valueOf(result: RemoteResult): unknown {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

function parseOrder(value: unknown): IntakeSupplyOrder | null {
  if (value === null) return null
  if (typeof value !== 'object' || value === null) throw new Error('INVALID_SUPPLY_POLICY')
  const order = value as Record<string, unknown>
  if (order.mode !== 'off' && order.mode !== 'idle' && order.mode !== 'allowed') throw new Error('INVALID_SUPPLY_POLICY')
  if (typeof order.maxConcurrency !== 'number' || !Number.isInteger(order.maxConcurrency) || order.maxConcurrency < 0) {
    throw new Error('INVALID_SUPPLY_POLICY')
  }
  const count = order.enabledServiceCount
  if (count !== undefined && (typeof count !== 'number' || !Number.isInteger(count) || count < 0)) {
    throw new Error('INVALID_SUPPLY_POLICY')
  }
  const ids = order.enabledServiceIds
  if (ids !== undefined && (!Array.isArray(ids) || !ids.every(id => typeof id === 'string'))) {
    throw new Error('INVALID_SUPPLY_POLICY')
  }
  if (ids !== undefined && count !== undefined && count !== ids.length) throw new Error('INVALID_SUPPLY_POLICY')
  return { mode: order.mode, maxConcurrency: order.maxConcurrency,
    enabledServiceCount: count === undefined ? null : count as number,
    enabledServiceIds: ids === undefined ? null : ids as string[] }
}

export function createIntakeSupplyTransport(remote: IntakeSupplyRemote): IntakeSupplyTransport {
  const selectOrderSource = remote.selectOrderSource
  const activateAuthorOrderSkill = remote.activateAuthorOrderSkill
  return {
    async read() {
      if (remote.myOrderPolicy !== undefined) {
        const result = await remote.myOrderPolicy()
        // A generated Remote proxy may expose the method before an older Host implements it.
        // Only this exact missing-method receipt permits the legacy read; auth and transport
        // failures remain unavailable rather than being confused with a saved owner setting.
        if (result.ok || result.error.code !== 'gateway/invocation-unavailable') {
          return parseOrder(valueOf(result))
        }
      }
      const result = valueOf(await remote.myCapabilities())
      if (typeof result !== 'object' || result === null || !('order' in result)) throw new Error('INVALID_SUPPLY_POLICY')
      return parseOrder(result.order)
    },
    async listSources() { return parseSources(valueOf(await remote.orderSources())) },
    ...(selectOrderSource === undefined ? {} : {
      async selectSource(sourceId: string) {
        return parseSelection(valueOf(await selectOrderSource.call(remote, { sourceId })))
      },
    }),
    ...(activateAuthorOrderSkill === undefined ? {} : {
      async activateAuthorSource(sourceId: string) {
        const matched = /^skill:(user-dsh|user-agents):(.+)$/u.exec(sourceId)
        if (!matched) throw new Error('INVALID_AUTHOR_ORDER_SOURCE')
        let name: string
        const encodedName = matched[2]
        if (encodedName === undefined) throw new Error('INVALID_AUTHOR_ORDER_SOURCE')
        try { name = decodeURIComponent(encodedName) } catch { throw new Error('INVALID_AUTHOR_ORDER_SOURCE') }
        const source = matched[1] as 'user-dsh' | 'user-agents'
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/u.test(name)
          || sourceId !== `skill:${source}:${encodeURIComponent(name)}`) throw new Error('INVALID_AUTHOR_ORDER_SOURCE')
        const raw = valueOf(await activateAuthorOrderSkill.call(remote, { source, name }))
        if (!raw || typeof raw !== 'object') throw new Error('INVALID_AUTHOR_ORDER_ACTIVATION')
        const result = raw as Record<string, unknown>
        const order = parseOrder(result.order)
        const uuid = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/u
        if (result.source !== source || result.name !== name || result.deviceInstalled !== true
          || result.dispatchEligible !== true || typeof result.productId !== 'string'
          || typeof result.deviceId !== 'string' || typeof result.runtimeDigest !== 'string'
          || !uuid.test(result.productId) || !uuid.test(result.deviceId)
          || typeof result.publicationId !== 'string' || !uuid.test(result.publicationId)
          || !/^sha256:[a-f0-9]{64}$/u.test(result.runtimeDigest) || !order || order.mode === 'off'
          || !order.enabledServiceIds?.includes('node')) throw new Error('INVALID_AUTHOR_ORDER_ACTIVATION')
        return order
      },
    }),
    async set(enabled) {
      const order = parseOrder(valueOf(await remote.setOwnerSupplyEnabled({ enabled })))
      if (order === null) throw new Error('INVALID_SUPPLY_POLICY')
      return order
    },
    async setTextService(enabled) {
      const order = parseOrder(valueOf(await remote.setLocalServiceEnabled({ serviceId: 'node', enabled })))
      if (order === null || order.enabledServiceIds === null) throw new Error('INVALID_SUPPLY_POLICY')
      return order
    },
  }
}
