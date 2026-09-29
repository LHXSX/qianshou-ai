/**
 * node:http ↔ WHATWG fetch bridge for the /api transport (host side of the
 * web carrier; the fetch-shaped handler itself is transport-agnostic).
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import type { ConnectionFetchHandler } from './rpc.ts'

/** Default carrier cap for all HTTP RPC bodies: sized for the default
 * aggregate image limit (200 MiB) after base64 expansion plus envelope
 * headroom (~267.7 MiB required), rounded up for slack. The bridge buffers
 * each body in memory, so this cap is also the per-request resident bound. */
export const DEFAULT_MAX_REQUEST_BODY_BYTES = 300 * 1024 * 1024

/** Finish response writes before closing a connection whose request body is still unread. */
async function endResponse(req: IncomingMessage, res: ServerResponse, closeUnread: boolean): Promise<void> {
  if (!closeUnread) { res.end(); return }
  await new Promise<void>((resolve) => {
    const settled = (): void => {
      res.off('finish', settled)
      res.off('close', settled)
      req.destroy()
      resolve()
    }
    if (res.destroyed || res.writableFinished) { settled(); return }
    res.once('finish', settled)
    res.once('close', settled)
    res.end()
  })
}

/** Stream a response with a bounded close deadline only when abandoning an unread upload. */
async function writeResponse(req: IncomingMessage, res: ServerResponse, response: Response, requestUnread: boolean): Promise<void> {
  const deadline = requestUnread ? setTimeout(() => {
    res.destroy()
    req.destroy()
  }, 5_000) : undefined
  deadline?.unref()
  try {
    const responseHeaders = Object.fromEntries(response.headers.entries())
    res.writeHead(response.status, requestUnread ? { ...responseHeaders, connection: 'close' } : responseHeaders)
    if (response.body === null) {
      await endResponse(req, res, requestUnread)
      return
    }
    const reader = response.body.getReader()
    let bodyFinished = false
    let cancellation: Promise<void> | undefined
    const cancelReader = (): void => {
      cancellation ??= reader.cancel()
      void cancellation.catch((_failure: unknown) => { /* The bridge awaits cancellation during cleanup below. */ })
    }
    res.once('close', cancelReader)
    try {
      while (!res.destroyed) {
        const { value: chunk, done } = await reader.read()
        if (done) { bodyFinished = true; break }
        if (res.destroyed) break
        // Wait for drain or close under backpressure; close also cancels an idle producer read.
        if (!res.write(chunk)) {
          await new Promise<void>((resolve) => {
            if (res.destroyed) { resolve(); return }
            const done = (): void => {
              res.off('drain', done)
              res.off('close', done)
              resolve()
            }
            res.once('drain', done)
            res.once('close', done)
          })
        }
      }
      await endResponse(req, res, requestUnread)
    } finally {
      res.off('close', cancelReader)
      if (!bodyFinished) cancelReader()
      try { await cancellation } finally { reader.releaseLock() }
    }
  } finally {
    clearTimeout(deadline)
  }
}

/**
 * Bridge one node:http request to the fetch-shaped handler (client close
 * aborts; response bodies stream out chunk by chunk).
 * @param req - incoming node:http request.
 * @param res - node:http response the bridge writes and owns to completion.
 * @param apiHandler - fetch-shaped API carrier the request is dispatched to.
 * @param maxRequestBodyBytes - maximum bytes buffered for a buffered route.
 */
export async function bridge(
  req: IncomingMessage,
  res: ServerResponse,
  apiHandler: ConnectionFetchHandler,
  maxRequestBodyBytes = DEFAULT_MAX_REQUEST_BODY_BYTES,
): Promise<void> {
  const abort = new AbortController()
  // Client-disconnect detection MUST hang off the response, not the request:
  // since Node 16, IncomingMessage 'close' fires as soon as the request body is
  // fully consumed (immediately for a bodyless GET), which would abort a
  // streaming response right after open. ServerResponse 'close' fires on connection teardown;
  // writableEnded distinguishes a normal end() from the client going away.
  res.on('close', () => {
    if (!res.writableEnded) abort.abort()
  })
  /* v8 ignore next 2 -- node:http always sets url/method on server requests. */
  const url = new URL(req.url ?? '/', 'http://dsh.internal')
  const method = req.method ?? 'GET'
  const headers = Object.fromEntries(
    Object.entries(req.headers).filter(([, value]) => typeof value === 'string') as [string, string][],
  )
  const bodyMode = apiHandler.requestBodyMode({ method, url })
  let request: Request
  if (bodyMode === 'buffered') {
    const declaredLength = req.headers['content-length']
    if (declaredLength !== undefined && Number(declaredLength) > maxRequestBodyBytes) {
      await writeResponse(req, res, new Response(null, { status: 413 }), true)
      return
    }
    const chunks: Buffer[] = []
    let received = 0
    for await (const chunk of req) {
      const buffer = chunk as Buffer
      received += buffer.byteLength
      if (received > maxRequestBodyBytes) {
        await writeResponse(req, res, new Response(null, { status: 413 }), true)
        return
      }
      chunks.push(buffer)
    }
    request = new Request(url, {
      method,
      headers,
      ...chunks.length > 0 ? { body: Buffer.concat(chunks) } : {},
      signal: abort.signal,
    })
  } else {
    request = new Request(url, {
      method,
      headers,
      body: Readable.toWeb(req, { strategy: {
        highWaterMark: req.readableHighWaterMark,
        size: (chunk: Buffer) => chunk.byteLength,
      } }) as ReadableStream<Uint8Array>,
      signal: abort.signal,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' })
  }
  const response = await apiHandler.fetch(request)
  if (res.destroyed) {
    await response.body?.cancel()
    req.destroy()
    return
  }
  await writeResponse(req, res, response, bodyMode === 'streaming' && !req.readableEnded)
}
