/** Collect live Session ids from the optional Host Session store. */

/**
 * Read nonempty Session ids from a live store. A missing store, or a `list` that
 * is missing or throws, contribute no ids, so bootstrap reports no Session
 * rather than inventing one.
 * @param sessions - Optional Host `sessions` service, or any test double.
 * @returns Ids in store order; empty when nothing readable is live.
 */
export function liveSessionIds(sessions: unknown): readonly string[] {
  if (typeof sessions !== 'object' || sessions === null) return []
  const list = (sessions as { list?: unknown }).list
  if (typeof list !== 'function') return []
  let rows: unknown
  try {
    rows = list.call(sessions)
  } catch {
    return []
  }
  if (!Array.isArray(rows)) return []
  const ids: string[] = []
  for (const row of rows) {
    const id = typeof row === 'string' ? row : (typeof row === 'object' && row !== null ? (row as { id?: unknown }).id : undefined)
    if (typeof id === 'string' && id.length > 0) ids.push(id)
  }
  return ids
}
