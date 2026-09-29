/** Actual HTTP socket regression coverage for unread-body responses and carrier cancellation. */
import { createServer, request, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bridge } from '../src/http-bridge.ts'
import type { ConnectionFetchHandler } from '../src/rpc.ts'

const servers: Server[] = []
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>((resolve, reject) => {
    server.closeAllConnections()
    server.close((error) => { if (error) reject(error); else resolve() })
  })))
})

async function serve(handler: ConnectionFetchHandler, limit = 1024) {
  const completed: IncomingMessage[] = []
  const failures: unknown[] = []
  const transferred: number[] = []
  let settle!: () => void
  const completion = new Promise<void>((resolve) => { settle = resolve })
  const server = createServer((req, res) => {
    const index = transferred.push(0) - 1
    req.on('data', (chunk: Buffer) => { transferred[index] = (transferred[index] ?? 0) + chunk.byteLength })
    void bridge(req, res, handler, limit).then(() => { completed.push(req); settle() }, (error: unknown) => {
      failures.push(error); res.destroy(); settle()
    })
  })
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/test`, completed, failures, transferred, completion }
}

function slowPost(url: string, headers: Record<string, string>, bytes = Buffer.from([1])) {
  const result = new Promise<{ status: number | undefined; text: string; close: string | undefined }>((resolve, reject) => {
    const client = request(url, { method: 'POST', headers }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (data: Buffer) => { chunks.push(data) })
      response.on('error', reject)
      response.on('end', () => {
        resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString(), close: response.headers.connection })
        client.destroy()
      })
    })
    client.on('error', reject)
    // Deliberately leave the body unfinished. Rejection must never wait for the sender.
    client.write(bytes)
  })
  return result
}

describe('HTTP bridge on real sockets', () => {
  it.each([409, 429, 415])('flushes a %i JSON rejection before closing an unfinished upload', async (status) => {
    const b = await serve({ requestBodyMode: () => 'streaming', fetch: async () => Response.json({ error: 'REFUSED' }, { status }) })
    const response = await slowPost(b.url, { 'content-length': '1000000000', 'content-type': 'audio/wav' })
    expect(response).toEqual({ status, text: '{"error":"REFUSED"}', close: 'close' })
    await vi.waitFor(() => { expect(b.completed).toHaveLength(1) })
    expect(b.completed[0]?.destroyed).toBe(true)
    expect(b.failures).toEqual([])
  })

  it.each(['declared', 'chunked'] as const)('flushes 413 for a %s oversized body without draining it', async (kind) => {
    const entered = vi.fn(async () => new Response('must not run'))
    const b = await serve({ requestBodyMode: () => 'buffered', fetch: entered }, 16)
    const headers = kind === 'declared' ? { 'content-length': '1000000000' } : { 'transfer-encoding': 'chunked' }
    expect(await slowPost(b.url, headers, Buffer.alloc(32))).toEqual({ status: 413, text: '', close: 'close' })
    expect(entered).not.toHaveBeenCalled()
    await vi.waitFor(() => { expect(b.completed).toHaveLength(1) })
    expect(b.completed[0]?.destroyed).toBe(true)
    expect(b.failures).toEqual([])
  })

  it('bounds byte prefetch while a streaming handler has not consumed the upload', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const b = await serve({ requestBodyMode: () => 'streaming', fetch: async () => {
      await gate
      return new Response(null, { status: 409 })
    } })
    const client = request(b.url, { method: 'POST', headers: { 'content-length': String(8 * 1024 * 1024) } })
    client.on('error', () => { /* The server refuses this deliberately unread upload. */ })
    client.on('response', (response) => { response.resume() })
    client.end(Buffer.alloc(8 * 1024 * 1024))
    try {
      await vi.waitFor(() => { expect(b.transferred[0]).toBeGreaterThan(0) })
      await new Promise<void>(resolve => setTimeout(resolve, 100))
      expect(b.transferred[0]).toBeLessThanOrEqual(256 * 1024)
    } finally {
      release()
      client.destroy()
    }
    await vi.waitFor(() => { expect(b.completed).toHaveLength(1) })
    expect(b.failures).toEqual([])
  })

  it('bounds an unread-upload response when its peer also stops reading', async () => {
    let cancelled = false
    let aborted = false
    const b = await serve({ requestBodyMode: () => 'streaming', fetch: async (input) => {
      input.signal.addEventListener('abort', () => { aborted = true }, { once: true })
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
        cancel() { cancelled = true },
      }), { status: 429 })
    } })
    const client = request(b.url, { method: 'POST', headers: { 'content-length': '1000000000' } }, (response) => {
      response.pause()
    })
    client.on('error', () => { /* The server deliberately closes this stalled peer. */ })
    client.write(Buffer.from([1]))
    try {
      await vi.waitFor(() => { expect(b.completed).toHaveLength(1) }, { timeout: 7_000 })
      expect(b.completed[0]?.destroyed).toBe(true)
      expect(aborted).toBe(true)
      expect(cancelled).toBe(true)
      expect(b.failures).toEqual([])
    } finally {
      client.destroy()
    }
  }, 10_000)

  it('completes a normal consumed-body response without falsely aborting its handler', async () => {
    let signal: AbortSignal | undefined
    const b = await serve({ requestBodyMode: () => 'streaming', fetch: async (input) => {
      signal = input.signal
      return Response.json({ body: await input.text() })
    } })
    const response = await fetch(b.url, { method: 'POST', body: 'complete input' })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ body: 'complete input' })
    expect(signal?.aborted).toBe(false)
    await vi.waitFor(() => { expect(b.completed).toHaveLength(1) })
    expect(b.failures).toEqual([])
  })

  it('settles a pending handler when the browser disconnects before it returns a response', async () => {
    let start!: () => void
    const started = new Promise<void>((resolve) => { start = resolve })
    let aborted = false
    let bodyCancelled = false
    const b = await serve({ requestBodyMode: () => 'streaming', fetch: async (input) => {
      await input.arrayBuffer()
      const disconnected = new Promise<void>((resolve) => {
        if (input.signal.aborted) resolve()
        else input.signal.addEventListener('abort', () => { resolve() }, { once: true })
      })
      start()
      await disconnected
      aborted = true
      return new Response(new ReadableStream({ cancel() { bodyCancelled = true } }))
    } })
    const client = request(b.url, { method: 'POST' })
    client.on('error', () => { /* This client intentionally tears down its own socket. */ })
    client.end('complete input')
    try {
      await started
      const closed = new Promise<void>(resolve => client.once('close', resolve))
      client.destroy()
      await closed
      await b.completion
      expect(b.completed).toHaveLength(1)
      expect(aborted).toBe(true)
      expect(bodyCancelled).toBe(true)
      expect(b.failures).toEqual([])
    } finally {
      client.destroy()
    }
  })

  it('cancels an idle response reader and settles after the consumed request disconnects', async () => {
    let start!: () => void
    const started = new Promise<void>((resolve) => { start = resolve })
    let notifyCancelled!: () => void
    const cancelling = new Promise<void>((resolve) => { notifyCancelled = resolve })
    let finishCancel!: () => void
    const cancelComplete = new Promise<void>((resolve) => { finishCancel = resolve })
    let aborted = false
    let cancelled = false
    let body: ReadableStream<Uint8Array> | undefined
    const b = await serve({ requestBodyMode: () => 'streaming', fetch: async (input) => {
      await input.arrayBuffer()
      input.signal.addEventListener('abort', () => { aborted = true }, { once: true })
      body = new ReadableStream<Uint8Array>({
        pull() { start() },
        cancel() { cancelled = true; notifyCancelled(); return cancelComplete },
      })
      return new Response(body)
    } })
    const client = request(b.url, { method: 'POST' })
    client.on('error', () => { /* This peer closes while the response producer has no output. */ })
    client.end('complete input')
    try {
      await started
      client.destroy()
      await cancelling
      expect(b.completed).toEqual([])
      finishCancel()
      await b.completion
      expect(b.completed).toHaveLength(1)
      expect(aborted).toBe(true)
      expect(cancelled).toBe(true)
      expect(body?.locked).toBe(false)
      expect(b.failures).toEqual([])
    } finally {
      finishCancel()
      client.destroy()
    }
  })

  it('releases response backpressure and cancels its producer on client disconnect', async () => {
    let aborted = false
    let cancelled = false
    const b = await serve({ requestBodyMode: () => 'streaming', fetch: async (input) => {
      await input.arrayBuffer()
      input.signal.addEventListener('abort', () => { aborted = true }, { once: true })
      return new Response(new ReadableStream({
        pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024)) },
        cancel() { cancelled = true },
      }))
    } })
    const client = request(b.url, { method: 'POST' }, (response) => {
      response.pause()
      client.destroy()
    })
    client.on('error', () => { /* The paused client intentionally closes its socket. */ })
    client.end('complete input')
    await vi.waitFor(() => { expect(b.completed).toHaveLength(1) })
    expect(aborted).toBe(true)
    expect(cancelled).toBe(true)
    expect(b.failures).toEqual([])
  })
})
