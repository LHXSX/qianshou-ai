/** Exact Node HTTP transport for the dedicated service-authenticated model directory. */
import type { IncomingMessage, ServerResponse } from 'node:http'

const MAX_BODY_BYTES = 64 * 1024

/** Register outside the browser /api carrier without changing its trust or route rules. */
export function createModelReadHttpRoute(
  path: string,
  handle: (request: Request) => Promise<Response>,
): { readonly kind: 'exact'; readonly path: string; readonly handler: (req: IncomingMessage, res: ServerResponse) => Promise<void> } {
  if (path !== '/internal/models/names') {
    throw new Error('Unsupported internal model read route')
  }
  return { kind: 'exact', path, handler: async (req, res) => {
    const reject = (status: number, code: string): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', connection: 'close', ...(status === 405 ? { allow: 'POST' } : {}) })
      res.end(JSON.stringify({ ok: false, code }))
      req.resume()
    }
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) { reject(403, 'service_loopback_required'); return }
    if (req.url !== path) { reject(404, 'not_found'); return }
    if (req.method !== 'POST') { reject(405, 'method_not_allowed'); return }
    if (Number(req.headers['content-length'] ?? 0) > MAX_BODY_BYTES) { reject(413, 'payload_too_large'); return }
    const abort = new AbortController()
    const onClose = (): void => { if (!res.writableEnded) abort.abort() }
    res.on('close', onClose)
    try {
      const chunks: Buffer[] = []
      let size = 0
      // Breaking on an oversized chunk must not destroy the socket before its 413 is sent.
      for await (const chunk of req.iterator({ destroyOnReturn: false })) {
        const bytes = chunk as Buffer
        size += bytes.byteLength
        if (size > MAX_BODY_BYTES) { reject(413, 'payload_too_large'); return }
        chunks.push(bytes)
      }
      const headers = new Headers()
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i], value = req.rawHeaders[i + 1]
        if (name !== undefined && value !== undefined) headers.append(name, value)
      }
      const response = await handle(new Request(`http://service.internal${path}`, {
        method: 'POST', headers, body: Buffer.concat(chunks), signal: abort.signal,
      }))
      res.writeHead(response.status, { ...Object.fromEntries(response.headers), 'cache-control': 'no-store' })
      // The model directory handler return bounded JSON, never a model stream.
      res.end(Buffer.from(await response.arrayBuffer()))
    } catch {
      if (!res.headersSent && !res.destroyed) reject(503, 'internal_transport_unavailable')
      else if (!res.writableEnded) res.destroy()
    } finally {
      res.off('close', onClose)
    }
  } }
}
