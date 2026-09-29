/** Request-bound Mac submission bridge. It never forwards browser cookies or review actions. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { PLUGIN_SUBMISSION_MAX_BODY_BYTES } from './plugin-submissions.ts'

export const PLUGIN_SUBMISSIONS_BEARER_PATH = '/qianshou-market/submissions'
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const BEARER = /^Bearer ([\x21-\x7e]{16,4096})$/u

function rejection(code: string): Buffer {
  return Buffer.from(JSON.stringify({ ok: false, code }))
}

async function boundedResponse(response: Response): Promise<Buffer> {
  const announced = Number(response.headers.get('content-length') ?? '0')
  if (!Number.isSafeInteger(announced) || announced < 0 || announced > MAX_RESPONSE_BYTES) {
    throw new Error('PLUGIN_SUBMISSION_RESPONSE_TOO_LARGE')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new Error('PLUGIN_SUBMISSION_RESPONSE_INVALID')
  const chunks: Buffer[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > MAX_RESPONSE_BYTES) throw new Error('PLUGIN_SUBMISSION_RESPONSE_TOO_LARGE')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, length)
  } finally { await reader.cancel().catch(() => undefined) }
}

/** Expose only owner submission and own status on a public Bearer path. The handler must authenticate this Request. */
export function createPluginSubmissionBearerRoute(options: {
  readonly handle: (request: Request) => Promise<Response>
  readonly path?: string
  readonly actions?: readonly string[]
  readonly publicRead?: () => Promise<Response>
}): { readonly kind: 'exact'; readonly path: string;
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> } {
  return {
    kind: 'exact', path: options.path ?? PLUGIN_SUBMISSIONS_BEARER_PATH,
    handler: async (incoming, outgoing) => {
      const headers = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
        'x-content-type-options': 'nosniff' }
      const reject = (status: number, code: string, allow?: string): void => {
        outgoing.writeHead(status, { ...headers, ...(allow === undefined ? {} : { allow }) })
        outgoing.end(rejection(code))
      }
      const path = options.path ?? PLUGIN_SUBMISSIONS_BEARER_PATH
      if (incoming.url !== path) return reject(400, 'BAD_REQUEST')
      if (incoming.method === 'GET' && options.publicRead !== undefined) {
        try {
          const response = await options.publicRead(); const output = await boundedResponse(response)
          outgoing.writeHead(response.status, headers); outgoing.end(output)
        } catch { reject(503, 'PLUGIN_SUBMISSION_UNAVAILABLE') }
        return
      }
      if (incoming.method !== 'POST') return reject(405, 'METHOD_NOT_ALLOWED', options.publicRead === undefined ? 'POST' : 'GET, POST')
      if (incoming.headers.origin !== undefined || incoming.headers.cookie !== undefined
        || incoming.headers['sec-fetch-site'] === 'cross-site') return reject(403, 'CROSS_ORIGIN_FORBIDDEN')
      const authHeaders = incoming.rawHeaders.filter((value, index) =>
        index % 2 === 0 && value.toLowerCase() === 'authorization')
      if (authHeaders.length !== 1 || typeof incoming.headers.authorization !== 'string'
        || BEARER.exec(incoming.headers.authorization) === null) return reject(401, 'LOGIN_REQUIRED')
      if (typeof incoming.headers['content-type'] !== 'string'
        || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(incoming.headers['content-type'])
        || incoming.headers['content-encoding'] !== undefined) return reject(400, 'BAD_REQUEST')
      const announced = Number(incoming.headers['content-length'] ?? '0')
      if (!Number.isSafeInteger(announced) || announced < 0) return reject(400, 'BAD_REQUEST')
      if (announced > PLUGIN_SUBMISSION_MAX_BODY_BYTES) return reject(413, 'PAYLOAD_TOO_LARGE')
      const chunks: Buffer[] = []
      let length = 0
      try {
        for await (const chunk of incoming) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
          length += bytes.length
          if (length > PLUGIN_SUBMISSION_MAX_BODY_BYTES) return reject(413, 'PAYLOAD_TOO_LARGE')
          chunks.push(bytes)
        }
        const body = Buffer.concat(chunks, length)
        let action: unknown
        let decoded: string
        try {
          decoded = new TextDecoder('utf-8', { fatal: true }).decode(body)
          const parsed = JSON.parse(decoded) as unknown
          action = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)['action'] : undefined
        } catch { return reject(400, 'BAD_REQUEST') }
        if (typeof action !== 'string' || !(options.actions ?? ['submit', 'mine']).includes(action)) return reject(403, 'ACTION_FORBIDDEN')
        const request = new Request(`https://qianshou.local${path}`, {
          method: 'POST', headers: { authorization: incoming.headers.authorization,
            'content-type': 'application/json' }, body: decoded,
        })
        const response = await options.handle(request)
        const output = await boundedResponse(response)
        outgoing.writeHead(response.status, headers)
        outgoing.end(output)
      } catch {
        if (outgoing.headersSent) outgoing.destroy()
        else reject(503, 'PLUGIN_SUBMISSION_UNAVAILABLE')
      }
    },
  }
}
