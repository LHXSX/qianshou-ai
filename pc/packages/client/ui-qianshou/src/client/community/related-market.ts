/** Read the same reviewed Host catalogs used by the market; linking never acquires a product. */
import type { CommunityRelated } from './transport.ts'

export interface CommunityMarketChoice extends CommunityRelated {
  readonly name: string
  readonly description: string
  readonly version?: string
  readonly salePriceYuan?: string
}
type Answer<T> = { ok: true; value: T } | { ok: false; error: { message: string } }
export interface CommunityMarketRemote {
  orderAdapterCapabilities(): Promise<Answer<{ capabilities: readonly {
    taskType: string
    capabilityId: string
    name: string
    description: string
  }[] }>>
  orderAdapterProducts(): Promise<Answer<{ products: readonly {
    id: string
    name: string
    description: string
    version: string
    salePriceYuan: string
  }[] }>>
}
export type CommunityMarketSearch = (kind: CommunityRelated['kind'], query: string,
  signal?: AbortSignal) => Promise<readonly CommunityMarketChoice[]>
export type CommunityMarketResolve = (related: CommunityRelated,
  signal?: AbortSignal) => Promise<CommunityMarketChoice | null>

async function marketChoices(remote: CommunityMarketRemote, kind: CommunityRelated['kind'],
  signal?: AbortSignal): Promise<CommunityMarketChoice[]> {
  let choices: CommunityMarketChoice[]
  if (kind === 'skill') {
    const answer = await remote.orderAdapterCapabilities()
    if (!answer.ok) throw new Error(answer.error.message)
    choices = answer.value.capabilities.map(item => ({ kind, id: item.taskType,
      name: item.name, description: item.description }))
  } else {
    const answer = await remote.orderAdapterProducts()
    if (!answer.ok) throw new Error(answer.error.message)
    choices = answer.value.products.map(item => ({ kind, id: item.id, name: item.name,
      description: item.description, version: item.version, salePriceYuan: item.salePriceYuan }))
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  return choices
}

export function createCommunityMarketSearch(remote: CommunityMarketRemote): CommunityMarketSearch {
  return async (kind, query, signal) => {
    const needle = query.trim().slice(0, 100).toLocaleLowerCase()
    const choices = await marketChoices(remote, kind, signal)
    return choices.filter(item => !needle || [item.name, item.description]
      .some(value => value.toLocaleLowerCase().includes(needle))).slice(0, 20)
  }
}

/** Resolve persisted links by exact identity across the complete reviewed catalog. */
export function createCommunityMarketResolver(remote: CommunityMarketRemote): CommunityMarketResolve {
  return async (related, signal) => {
    const choices = await marketChoices(remote, related.kind, signal)
    return choices.find(item => item.id === related.id) ?? null
  }
}
