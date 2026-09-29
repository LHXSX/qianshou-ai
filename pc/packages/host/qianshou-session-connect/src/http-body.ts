/** Bounded request parsing and response flushing for the narrow connection routes. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { ConnectFailure } from './validation.ts'

/**
 * Read at most 16 KiB, without destroying an unread socket before an error flushes.
 * @param request - HTTP request owned by the route.
 * @param signal - Complete request deadline and disconnect signal.
 * @returns Parsed untrusted JSON.
 */
export function readJson(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if (request.headers['content-type']?.split(';', 1)[0]?.trim() !== 'application/json') throw new ConnectFailure('invalid-request', 415)
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') throw new ConnectFailure('invalid-request', 415)
  if (Number(request.headers['content-length'] ?? 0) > 16384) throw new ConnectFailure('invalid-request', 413)
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks: Buffer[] = []
    const clean = (): void => {
      request.off('data', data); request.off('end', end); request.off('error', failed)
      signal.removeEventListener('abort', aborted)
    }
    const failed = (): void => { clean(); request.pause(); reject(new ConnectFailure('invalid-request')) }
    const aborted = (): void => { clean(); request.pause(); reject(signal.reason instanceof Error ? signal.reason : new ConnectFailure('closed', 503)) }
    const data = (chunk: Buffer): void => {
      bytes += chunk.byteLength
      if (bytes > 16384) { clean(); request.pause(); reject(new ConnectFailure('invalid-request', 413)); return }
      chunks.push(chunk)
    }
    const end = (): void => {
      clean()
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) }
      catch (_error) { reject(new ConnectFailure('invalid-request')) }
    }
    request.on('data', data); request.once('end', end); request.once('error', failed)
    signal.addEventListener('abort', aborted, { once: true })
    if (signal.aborted) aborted()
  })
}

/**
 * Flush a bounded response, then close unfinished uploads; slow readers have a hard deadline.
 * @param request - Request whose body may remain unread.
 * @param response - Owned response.
 * @param status - HTTP status.
 * @param body - Complete bounded payload.
 * @param type - Fixed content type.
 * @returns Settlement after flush or socket closure.
 */
export function respond(
  request: IncomingMessage, response: ServerResponse, status: number, body: string | Buffer, type: string,
): Promise<void> {
  if (response.destroyed) return Promise.resolve()
  response.statusCode = status
  response.setHeader('Content-Type', type)
  response.setHeader('Content-Length', Buffer.byteLength(body))
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
  if (!request.complete) response.setHeader('Connection', 'close')
  return new Promise((resolve) => {
    const timer = setTimeout(() => { response.destroy(); request.destroy() }, 5000)
    timer.unref()
    const settled = (): void => {
      clearTimeout(timer); response.off('finish', settled); response.off('close', settled)
      if (!request.complete) request.destroy()
      resolve()
    }
    response.once('finish', settled); response.once('close', settled)
    response.end(body)
  })
}
