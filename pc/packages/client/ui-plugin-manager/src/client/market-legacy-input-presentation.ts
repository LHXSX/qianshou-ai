/** Ordinary controls for an exact legacy product, from Host-verified signed samples. */
import { parseMarketInputRule, type MarketInputRule } from './market-input-form.ts'
import type { MarketCapabilitiesView } from './market-capabilities-controller.ts'

export interface MarketLegacyInputPresentation {
  rule: MarketInputRule
  fixed: Record<string, string | number | boolean>
}

type RemoteValue<T> = { ok: true; value: T } | { ok: false; error: unknown }
interface PresentationIdentity { productId: string; taskType: string; version: string; artifactDigest: string }
export interface MarketInputPresentationRemote {
  orderAdapterProducts(): Promise<RemoteValue<{ products: Array<{
    id: string; taskType: string; version: string; artifactDigest: string
  }> }>>
  readMarketOrderInputPresentation(request: PresentationIdentity): Promise<RemoteValue<PresentationIdentity & {
    status: 'available' | 'unavailable'; contentSchemaJson: string | null; fixedInputJson: string | null
  }>>
}

export type LoadMarketInputPresentation = (taskType: string, signal: AbortSignal) => Promise<MarketLegacyInputPresentation | null>

/** A presentation is display data only; the original task contract and quote still govern execution. */
export function createMarketInputPresentationLoader(remote: MarketInputPresentationRemote,
  snapshot: () => MarketCapabilitiesView, readOwner: () => Promise<number | null>): LoadMarketInputPresentation {
  return async (taskType, signal) => {
    const initial = snapshot()
    if (!initial.loaded || initial.loading || initial.error || signal.aborted) return null
    const entries = initial.capabilities.filter(item => item.taskType === taskType)
    if (entries.length !== 1 || entries[0]!.products.length !== 1) return null
    const selected = entries[0]!.products[0]!
    const binding = JSON.stringify([taskType, selected.productId, selected.publicationId, selected.version])
    const owner = await readOwner()
    if (owner === null || signal.aborted) return null
    const current = async (): Promise<boolean> => {
      if (signal.aborted || await readOwner() !== owner || signal.aborted) return false
      const view = snapshot()
      const candidates = view.capabilities.filter(item => item.taskType === taskType)
      const product = candidates.length === 1 && candidates[0]!.products.length === 1 ? candidates[0]!.products[0] : undefined
      return view.loaded && !view.loading && !view.error && product !== undefined
        && JSON.stringify([taskType, product.productId, product.publicationId, product.version]) === binding
    }
    try {
      const products = await remote.orderAdapterProducts()
      if (!products.ok || !await current()) return null
      const exact = products.value.products.filter(item => item.id === selected.productId
        && item.taskType === taskType && item.version === selected.version)
      if (exact.length !== 1 || !/^sha256:[a-f0-9]{64}$/u.test(exact[0]!.artifactDigest)) return null
      const request = { productId: selected.productId, taskType, version: selected.version, artifactDigest: exact[0]!.artifactDigest }
      const response = await remote.readMarketOrderInputPresentation(request)
      if (!response.ok || !await current()) return null
      const value = response.value
      if (value.status !== 'available' || Object.keys(request).some(key =>
        value[key as keyof PresentationIdentity] !== request[key as keyof PresentationIdentity])
        || typeof value.contentSchemaJson !== 'string' || value.contentSchemaJson.length > 4096
        || typeof value.fixedInputJson !== 'string' || value.fixedInputJson.length > 16384) return null
      const rule = parseMarketInputRule(JSON.parse(value.contentSchemaJson) as unknown)
      const keys = Object.keys(rule.properties ?? {})
      if (keys.length !== 1 || rule.properties![keys[0]!]!.type !== 'string'
        || !rule.required?.includes(keys[0]!)) return null
      const fixed: unknown = JSON.parse(value.fixedInputJson)
      if (fixed === null || typeof fixed !== 'object' || Array.isArray(fixed)
        || Object.keys(fixed).length > 31 || Object.entries(fixed).some(([key, item]) => keys.includes(key)
          || !/^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/u.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key)
          || typeof item !== 'string' && typeof item !== 'boolean' && !(typeof item === 'number' && Number.isFinite(item))
          || typeof item === 'string' && !item.isWellFormed())) return null
      return { rule, fixed: fixed as Record<string, string | number | boolean> }
    } catch { return null }
  }
}
