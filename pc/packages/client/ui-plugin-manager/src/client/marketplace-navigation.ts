/** Latest-request navigation remains available before the market workspace mounts. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MarketplaceNavigationSnapshot, MarketplacePublicationFocus, QianshouMarketplaceNavigation } from './marketplace-navigation-contract.ts'

function validFocus(value: unknown): boolean {
  if (value === undefined) return true
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const focus = value as Record<string, unknown>
  return Object.keys(focus).sort().join(',') === 'name,source'
    && typeof focus.source === 'string' && ['user-dsh', 'user-agents'].includes(focus.source)
    && typeof focus.name === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(focus.name)
}

/** One scoped owner for panel selection and its outstanding publication request. */
export class MarketplaceNavigation implements QianshouMarketplaceNavigation {
  readonly store = createSnapshotStore<MarketplaceNavigationSnapshot>({ request: null })
  private closed = false
  private revision = 0

  constructor(private readonly openPanel: () => void) {}

  openMySkill(focus: MarketplacePublicationFocus): boolean {
    return this.open(focus, 'mine')
  }

  openPublications(focus?: MarketplacePublicationFocus): boolean {
    return this.open(focus, 'publications')
  }

  private open(focus: MarketplacePublicationFocus | undefined, destination: 'mine' | 'publications'): boolean {
    if (this.closed || !validFocus(focus)) return false
    const id = ++this.revision
    this.store.set({ request: { id, destination, focus: focus === undefined ? null : { source: focus.source, name: focus.name } } })
    // oxlint-disable-next-line typescript/no-unnecessary-condition -- Synchronous store observers can dispose this owner.
    if (this.closed) return false
    try { this.openPanel() }
    catch { this.consume(id); return false }
    return !this.closed
  }

  /** An older workspace acknowledgement cannot discard a newer request. */
  consume(id: number): boolean {
    if (this.closed || this.store.getSnapshot().request?.id !== id) return false
    this.store.set({ request: null })
    return !this.closed
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    this.store.set({ request: null })
  }
}
