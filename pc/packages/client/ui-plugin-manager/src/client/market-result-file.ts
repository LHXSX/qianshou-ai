/** Resolve an opaque file request without previewing, fetching or authorizing bytes. */
const TASK_FILE_REFERENCE = /^qianshou-file:\/\/task\/([a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12})\/([a-f0-9]{64})$/u

/** Build an exact same-origin attachment route for the current result's workload.
 * A link is only a request: its Host relay must obtain a fresh owner grant and
 * independently verify the file before returning attachment bytes. Raw manifests,
 * storage URLs and other tasks cannot become links. This helper has no side effects.
 * @param reference - Host-projected opaque file reference from a DONE workload.
 * @param expectedWorkloadId - Current card's exact workload identity.
 * @param location - The current renderer's location, never an artifact's origin.
 * @returns A same-origin download request, or null for an unsupported reference or origin.
 */
export function marketResultFile(reference: string, expectedWorkloadId: string,
  location: Pick<Location, 'protocol' | 'origin' | 'hostname'>): { href: string } | null {
  const match = TASK_FILE_REFERENCE.exec(reference)
  if (match === null || match[0] !== reference || match[1] !== expectedWorkloadId) return null
  let base: string
  if (location.protocol === 'dsh-app:' && location.hostname === 'app') base = 'dsh-app://app'
  else if (location.protocol === 'http:' || location.protocol === 'https:') {
    let origin: URL
    try { origin = new URL(location.origin) } catch { return null }
    if (origin.origin !== location.origin || origin.protocol !== location.protocol || origin.hostname !== location.hostname
      || !origin.hostname || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return null
    base = origin.origin
  } else return null
  return { href: `${base}/api/qianshou/result-file?task_id=${match[1]}&asset_id=${match[2]}` }
}
