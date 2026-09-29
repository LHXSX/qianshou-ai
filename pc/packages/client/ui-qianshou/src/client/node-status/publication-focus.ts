import type { MarketplacePublicationFocus } from '../market-navigation.ts'

/**
 * Parse only the canonical skill source address used by the intake inventory.
 * @param sourceId - Complete source address, without URL or filesystem meaning.
 * @returns Its exact publication focus, or null for any other address.
 */
export function publicationFocus(sourceId: string): MarketplacePublicationFocus | null {
  const matched = /^skill:(user-dsh|user-agents):([a-z0-9][a-z0-9-]{0,63})$/u.exec(sourceId)
  const name = matched?.[2]
  return matched === null || name === undefined ? null
    : { source: matched[1] as MarketplacePublicationFocus['source'], name }
}
