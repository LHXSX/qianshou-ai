/** Real loopback HTTP origin and a Cordis composition for capability reads; no mocked fetch. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { MemoryCredentials } from '../../../credentials/credentials/tests/memory.ts'
import { ACCOUNT_ACCESS_REF } from '../../qianshou-account/src/store.ts'
import QianshouCapability, { type Config } from '../src/index.ts'

/** One observed request; the body is the raw text the Host sent. */
export interface Observed {
  method: string
  url: string
  authorization: string | undefined
  body: string
}

/** A reply the test server sends for one request. */
export interface Reply {
  status: number
  json?: unknown
  text?: string
  headers?: Record<string, string>
}

/** A started loopback server bound to an ephemeral port. */
export interface TestOrigin {
  origin: string
  requests: Observed[]
  close: () => Promise<void>
}

/**
 * Start a loopback JSON server that answers each request from `replies` in order.
 * @param replies - One reply per expected request; the last reply repeats once exhausted.
 * @returns The `http://127.0.0.1:<port>` origin, the observed requests, and a closer.
 */
export async function origin(replies: Reply[]): Promise<TestOrigin> {
  const requests: Observed[] = []
  let index = 0
  const handler = (request: IncomingMessage, response: ServerResponse): void => {
    const chunks: Buffer[] = []
    request.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    request.on('end', () => {
      requests.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const reply = replies[Math.min(index++, replies.length - 1)] ?? { status: 500 }
      const body = reply.text ?? (reply.json === undefined ? '' : JSON.stringify(reply.json))
      response.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers })
      response.end(body)
    })
  }
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  const port = typeof address === 'object' && address !== null ? address.port : 0
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve) => { server.close(() => { resolve() }) }),
  }
}

/** A booted composition with the capability service and its Context. */
export interface Fixture {
  ctx: Context
  capability: Context['qianshouCapability']
}

/**
 * Mount the capability plugin over in-memory credentials.
 * @param config - Partial plugin config; `coreOrigin` selects the loopback origin.
 * @param token - Account access token to seed, or undefined to stay signed out.
 * @param contexts - Collected for the caller to dispose after each test.
 * @returns The Context and the capability service.
 */
export async function fixture(config: Partial<Config>, token: string | undefined, contexts: Context[]): Promise<Fixture> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(MemoryCredentials, token === undefined ? {} : { [ACCOUNT_ACCESS_REF]: token })
  await ctx.plugin(QianshouCapability, config as Config)
  return { ctx, capability: ctx.qianshouCapability }
}
