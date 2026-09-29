/** One owner grant, read from the Host's measured supply and saved policy. */
export interface NodeCapabilityGrant {
  readonly enabled: boolean
  readonly verified: boolean
  readonly hasLocalRate: boolean
}

export interface NodeCapabilityTransport {
  read(): Promise<NodeCapabilityGrant>
  setNodeEnabled(enabled: boolean): Promise<NodeCapabilityGrant>
}

export interface NodeCapabilityTransportOptions {
  readonly baseUri?: string
  readonly fetchImpl?: typeof fetch
}

type OwnerPolicy = {
  readonly mode: 'off' | 'idle' | 'allowed'
  readonly maxConcurrency: number
  readonly minFreeMemoryBytes: number
  readonly minIdleSeconds: number
  readonly enabledServiceIds: readonly string[]
  readonly nodeRates: readonly { readonly localServiceId: string; readonly amountMinor: number; readonly unit: string; readonly currency: string }[]
}

type SupplyRead = { readonly policy: OwnerPolicy; readonly grant: NodeCapabilityGrant }

/** The renderer sees no Shanghai token. It only changes one saved local service grant. */
export function createNodeCapabilityTransport(options: NodeCapabilityTransportOptions = {}): NodeCapabilityTransport {
  const request = options.fetchImpl ?? fetch
  const baseUri = options.baseUri ?? (typeof document === 'undefined' ? 'http://127.0.0.1/' : document.baseURI)
  const url = new URL('/api/qianshou/compute/supply', baseUri)
  const policyUrl = new URL('/api/qianshou/compute/supply/policy', baseUri)
  const read = async (): Promise<SupplyRead> => {
    const response = await request(url.toString(), {
      method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
    })
    if (!response.ok) throw new Error('NODE_SUPPLY_UNAVAILABLE')
    return parseNodeSupply(await response.json())
  }
  return {
    async read() { return (await read()).grant },
    async setNodeEnabled(enabled) {
      const current = await read()
      if (enabled && !current.grant.verified) throw new Error('NODE_SERVICE_NOT_VERIFIED')
      if (current.grant.enabled === enabled) return current.grant
      const next: OwnerPolicy = {
        ...current.policy,
        enabledServiceIds: enabled
          ? [...current.policy.enabledServiceIds, 'node']
          : current.policy.enabledServiceIds.filter(id => id !== 'node'),
        // The Host requires every local rate to belong to an enabled service.
        nodeRates: enabled ? current.policy.nodeRates
          : current.policy.nodeRates.filter(rate => rate.localServiceId !== 'node'),
      }
      const response = await request(policyUrl.toString(), {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(next),
      })
      if (!response.ok) throw new Error('NODE_SUPPLY_WRITE_UNCONFIRMED')
      // A write response alone does not prove which policy is currently saved.
      const observed = (await read()).grant
      if (observed.enabled !== enabled) throw new Error('NODE_SUPPLY_WRITE_UNCONFIRMED')
      return observed
    },
  }
}

/** Reject unknown policy shapes before sending a full-policy update back to Host. */
export function parseNodeSupply(value: unknown): SupplyRead {
  const body = record(value)
  if (body.version !== 'qianshou.local-supply.v1' || !Array.isArray(body.localServices) || body.localServices.length > 256) throw new Error('NODE_SUPPLY_INVALID')
  const policy = record(body.ownerPolicy)
  const keys = Object.keys(policy).sort().join(',')
  if (keys !== 'enabledServiceIds,maxConcurrency,minFreeMemoryBytes,minIdleSeconds,mode,nodeRates'
    || !['off', 'idle', 'allowed'].includes(String(policy.mode))
    || !whole(policy.maxConcurrency, 1) || !whole(policy.minFreeMemoryBytes, 0) || !whole(policy.minIdleSeconds, 0)
    || !Array.isArray(policy.enabledServiceIds) || policy.enabledServiceIds.length > 128
    || !policy.enabledServiceIds.every(serviceId)
    || new Set(policy.enabledServiceIds).size !== policy.enabledServiceIds.length
    || !Array.isArray(policy.nodeRates) || policy.nodeRates.length > 128) throw new Error('NODE_SUPPLY_INVALID')
  const enabledServiceIds = policy.enabledServiceIds as string[]
  const rates = policy.nodeRates.map(value => {
    const rate = record(value)
    if (Object.keys(rate).sort().join(',') !== 'amountMinor,currency,localServiceId,unit'
      || !serviceId(rate.localServiceId) || !enabledServiceIds.includes(rate.localServiceId)
      || !whole(rate.amountMinor, 0) || typeof rate.unit !== 'string' || !rate.unit.trim() || rate.unit.length > 64
      || typeof rate.currency !== 'string' || !/^[A-Z]{3}$/u.test(rate.currency)) throw new Error('NODE_SUPPLY_INVALID')
    return rate as OwnerPolicy['nodeRates'][number]
  })
  if (new Set(rates.map(rate => rate.localServiceId)).size !== rates.length) throw new Error('NODE_SUPPLY_INVALID')
  const services = body.localServices.map(record)
  const nodeServices = services.filter(service => service.id === 'node')
  if (nodeServices.length > 1) throw new Error('NODE_SUPPLY_INVALID')
  const node = nodeServices[0]
  const parsed: OwnerPolicy = {
    mode: policy.mode as OwnerPolicy['mode'], maxConcurrency: policy.maxConcurrency as number,
    minFreeMemoryBytes: policy.minFreeMemoryBytes as number, minIdleSeconds: policy.minIdleSeconds as number,
    enabledServiceIds, nodeRates: rates,
  }
  return {
    policy: parsed,
    grant: {
      enabled: parsed.enabledServiceIds.includes('node'),
      verified: node?.kind === 'tool' && node.verification === 'verified',
      hasLocalRate: rates.some(rate => rate.localServiceId === 'node'),
    },
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('NODE_SUPPLY_INVALID')
  return value as Record<string, unknown>
}
function whole(value: unknown, min: number): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min
}
function serviceId(value: unknown): value is string { return typeof value === 'string' && /^[\w.:-]{1,256}$/u.test(value) }
