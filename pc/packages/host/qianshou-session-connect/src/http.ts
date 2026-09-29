/** Public static shell plus bearer-only operations, isolated from the owner RPC carrier. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ConnectService } from './service.ts'
import { ConnectFailure, parseRequest, safeFailure } from './validation.ts'
import { readJson, respond } from './http-body.ts'
import { pageCss, pageHtml } from './page.ts'

/** Configured authority and limits captured by one HTTP route owner. */
export interface ConnectHttpOptions { origin: string; viewer: string; maxRequests: number; timeoutMs: number }

/**
 * Validate the one external authority; forwarded headers never grant trust.
 * @param value - Empty for loopback, otherwise an explicit HTTPS origin.
 * @param port - Real listening port.
 * @returns Canonical allowed origin.
 */
export function connectOrigin(value: string, port: number): string {
  if (!value) return `http://127.0.0.1:${port}`
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('Session connection publicOrigin must be an HTTPS origin')
  return url.origin
}

/** Every registered request, including rejected uploads, has a count and lifetime bound. */
export class ConnectHttp {
  private readonly active = new Map<AbortController, Promise<void>>()
  private closed = false
  constructor(private readonly service: ConnectService, private readonly options: ConnectHttpOptions) {}
  /**
   * Handle only the registered connection prefix.
   * @param request - Untrusted HTTP request.
   * @param response - Route-owned response.
   * @returns Response completion.
   */
  handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (this.closed || this.active.size >= this.options.maxRequests) {
      // Close excess sockets immediately rather than create an unbounded rejection queue.
      response.statusCode = this.closed ? 503 : 429
      response.setHeader('Connection', 'close'); response.end(); return Promise.resolve()
    }
    const controller = new AbortController()
    const disconnected = (): void => { controller.abort(new ConnectFailure('closed', 503)) }
    request.once('aborted', disconnected); response.once('close', disconnected)
    const timer = setTimeout(() => { controller.abort(new ConnectFailure('timeout', 504)) }, this.options.timeoutMs)
    timer.unref()
    const task = this.dispatch(request, response, controller.signal).catch(async (error: unknown) => {
      const safe = safeFailure(controller.signal.aborted ? controller.signal.reason : error)
      await respond(request, response, safe.status, JSON.stringify({ error: safe.code }), 'application/json; charset=utf-8')
    }).finally(() => {
      clearTimeout(timer); request.off('aborted', disconnected); response.off('close', disconnected); this.active.delete(controller)
    })
    this.active.set(controller, task); return task
  }
  private async dispatch(request: IncomingMessage, response: ServerResponse, signal: AbortSignal): Promise<void> {
    const authority = new URL(this.options.origin)
    const peer = request.socket.remoteAddress
    if (authority.protocol === 'http:' && peer !== '127.0.0.1' && peer !== '::1' && peer !== '::ffff:127.0.0.1') throw new ConnectFailure('unauthorized', 403)
    if (request.headers.host !== authority.host) throw new ConnectFailure('unauthorized', 403)
    const url = new URL(request.url ?? '/', this.options.origin)
    if (url.origin !== authority.origin || url.search) throw new ConnectFailure('invalid-request')
    const path = url.pathname
    if (request.method === 'GET') {
      if (request.headers.origin && request.headers.origin !== authority.origin) throw new ConnectFailure('unauthorized', 403)
      if (path === '/qianshou-connect' || path === '/qianshou-connect/') return respond(request, response, 200, pageHtml, 'text/html; charset=utf-8')
      if (path === '/qianshou-connect/viewer.js') return respond(request, response, 200, this.options.viewer, 'text/javascript; charset=utf-8')
      if (path === '/qianshou-connect/style.css') return respond(request, response, 200, pageCss, 'text/css; charset=utf-8')
      throw new ConnectFailure('invalid-request', 404)
    }
    if (request.method !== 'POST') throw new ConnectFailure('invalid-request', 405)
    if (request.headers.origin !== authority.origin || request.headers['sec-fetch-site'] === 'cross-site') throw new ConnectFailure('unauthorized', 403)
    const action = path.slice('/qianshou-connect/api/'.length)
    if (!path.startsWith('/qianshou-connect/api/') || (action !== 'read' && action !== 'send' && action !== 'receipt')) throw new ConnectFailure('invalid-request', 404)
    const authorization = request.headers.authorization
    if (!authorization?.startsWith('Bearer ') || authorization.length > 100) throw new ConnectFailure('unauthorized', 401)
    const token = authorization.slice(7)
    // A device names itself in a header rather than the body, so the same bearer
    // presented from a different device is refused before any body is read.
    const device = request.headers['x-qianshou-device']
    if (device !== undefined && (typeof device !== 'string' || device.length === 0 || device.length > 256)) throw new ConnectFailure('invalid-request')
    // Check the bearer before retaining or parsing a body.
    this.service.authorize(token, device)
    const input = parseRequest(action, await readJson(request, signal))
    signal.throwIfAborted()
    /* oxlint-disable typescript/no-non-null-assertion -- The strict parser requires these fields for the selected endpoint. */
    const operation: Promise<unknown> = action === 'read' ? this.service.read(token, input.cursor!, signal, device)
      : action === 'send' ? this.service.send(token, input.requestId!, input.text!, signal, device)
        : this.service.receipt(token, input.requestId!, signal, device)
    /* oxlint-enable typescript/no-non-null-assertion */
    // Session activation has its own owner and may settle late. The service retains its
    // admission slot and cancellation fence while this HTTP owner returns on deadline.
    const value = await responseDeadline(operation, signal)
    signal.throwIfAborted(); this.service.authorize(token, device)
    await respond(request, response, 200, JSON.stringify(value), 'application/json; charset=utf-8')
  }
  /** Stop admission and await every response owner before dependencies close. */
  async dispose(): Promise<void> {
    this.closed = true
    for (const controller of this.active.keys()) controller.abort(new ConnectFailure('closed', 503))
    await Promise.allSettled(this.active.values())
  }
}

function responseDeadline<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const aborted = (): void => { reject(signal.reason instanceof Error ? signal.reason : new ConnectFailure('closed', 503)) }
    signal.addEventListener('abort', aborted, { once: true })
    void operation.then(resolve, reject).finally(() => { signal.removeEventListener('abort', aborted) })
    if (signal.aborted) aborted()
  })
}
