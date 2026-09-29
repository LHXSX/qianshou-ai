/** Header translation for the loopback development proxy; production origin checks stay intact. */
interface IncomingHeaders {
  readonly host?: string | readonly string[]
  readonly origin?: string | readonly string[]
  readonly 'sec-fetch-site'?: string | readonly string[]
}
interface OutgoingRequest {
  removeHeader(name: string): void
  setHeader(name: string, value: string): void
}

/**
 * Translate an exactly same-origin loopback browser request to the configured upstream origin.
 * Missing, opaque, malformed, external and cross-site origins remain untouched for upstream rejection.
 * @param outgoing - Proxy request after Vite has replaced Host with the target authority.
 * @param incoming - Original browser headers before proxying.
 * @param targetOrigin - Deployment-validated upstream origin.
 */
export function forwardPreviewHeaders(outgoing: OutgoingRequest, incoming: IncomingHeaders, targetOrigin: string): void {
  outgoing.removeHeader('cookie')
  if (typeof incoming.host !== 'string' || typeof incoming.origin !== 'string') return
  if (incoming['sec-fetch-site'] !== undefined && incoming['sec-fetch-site'] !== 'same-origin') return
  let origin: URL
  try { origin = new URL(incoming.origin) }
  catch { return }
  if (!['http:', 'https:'].includes(origin.protocol)
    || !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
    || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash
    || incoming.origin !== origin.origin || origin.host !== incoming.host) return
  outgoing.setHeader('origin', targetOrigin)
}
