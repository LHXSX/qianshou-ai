/** Market capability and exact-product selections share one refreshed catalog. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { QianshouMarketSelection } from '@deepseek-ai/dsh-client-ui-qianshou/client'
import type { MarketCapabilitiesController, MarketCapabilityView } from './market-capabilities-controller.ts'
import { canCallMarketCapability } from './market-capabilities-controller.ts'

interface MarketComposer {
  readonly scope: object
  compose(reference: string, goal?: string): boolean
  selectProduct?(item: MarketCapabilityView, product: MarketCapabilityView['products'][number], goal?: string): boolean
}

/** A name must identify one current task even when another entry is unavailable.
 * @param item - The current reviewed task selected by its stable identity.
 * @param catalog - The same complete catalog read by the @ parser.
 * @returns Whether the reference has an inline or multi-file contract and cannot name another task.
 */
export function canComposeMarketCapability(item: MarketCapabilityView, catalog: readonly MarketCapabilityView[]): boolean {
  const overlaps = (left: string, right: string): boolean => left === right
    || (left.startsWith(right) && /^\s/u.test(left.slice(right.length)))
  return canCallMarketCapability(item) && !catalog.some(other => other.taskType !== item.taskType
    && (overlaps(other.name, item.name) || overlaps(item.name, other.name)))
}

/** Bind a displayed card to its execution contract and exact publication versions. */
function selectionIdentity(item: Readonly<MarketCapabilityView>): string {
  return JSON.stringify([item.taskType, item.capabilityId, item.name, item.contractVersion,
    item.executionMode, item.outputKind, item.defaultInputKind, item.executionQuotePath, item.currency,
    item.requiresQuote, item.publisherKind,
    [...item.acceptedInputKinds].sort(), [...item.requiredParams].sort(), [...item.publisherKinds].sort(),
    item.products.map(product => [product.productId, product.publicationId, product.ownerId,
      product.version, product.salePriceYuan, product.availableToPurchase])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
  ])
}

/** Refresh the catalog before adding an @ reference or opening an exact-product call.
 * @param capabilities - The controller shared with the quick @ picker.
 * @param composer - A lookup for the explicitly addressed Session's current input.
 * @returns Selection only; no quote, order, payment or page navigation occurs here.
 */
export function createMarketSelection(capabilities: MarketCapabilitiesController,
  composer: (sessionId: SessionId) => MarketComposer | undefined): QianshouMarketSelection {
  const generations = new Map<SessionId, number>()
  return {
    async listAbilities() {
      const cached = capabilities.store.getSnapshot()
      if (cached.loaded && !cached.error) return cached.capabilities
      await capabilities.ensureLoaded()
      const current = capabilities.store.getSnapshot()
      if (!current.loaded || current.error) throw new Error('market-selection-unavailable')
      return current.capabilities
    },
    async refreshAndSelect(sessionId, taskType, expected, signal, options) {
      if (options?.goal !== undefined && options.goal.length > 8000) return false
      const expectedIdentity = expected === undefined ? undefined : selectionIdentity(expected)
      const generation = (generations.get(sessionId) ?? 0) + 1
      generations.set(sessionId, generation)
      const original = composer(sessionId)
      if (original === undefined || signal?.aborted) return false
      await capabilities.reload()
      if (signal?.aborted || generations.get(sessionId) !== generation) return false
      const catalog = capabilities.store.getSnapshot()
      if (catalog.error || catalog.loading) return false
      const item = catalog.capabilities.find(row => row.taskType === taskType)
      const product = options?.product
      if (item === undefined || !(product === undefined
        ? canComposeMarketCapability(item, catalog.capabilities) : canCallMarketCapability(item))) return false
      if (expectedIdentity !== undefined && expectedIdentity !== selectionIdentity(item)) return false
      const selected = product === undefined ? undefined : item.products.find(row => row.productId === product.productId
        && row.publicationId === product.publicationId && row.version === product.version && row.ownerId === product.ownerId)
      if (product !== undefined && selected === undefined) return false
      const input = composer(sessionId)
      if (signal?.aborted || input === undefined || input.scope !== original.scope) return false
      if (selected !== undefined) return input.selectProduct?.(item, selected, options?.goal) ?? false
      return options?.goal === undefined ? input.compose(`@${item.name}`) : input.compose(`@${item.name}`, options.goal)
    },
  }
}
