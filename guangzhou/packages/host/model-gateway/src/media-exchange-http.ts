/** Fixed Guangzhou verifier bridge. Buyers never receive its service credential or COS STS secrets. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Transform } from 'node:stream'
import { createHash } from 'node:crypto'
import { MediaNodeError } from './media-node-store.ts'

export interface MediaExchangeHttp {
  post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>>
  upload(request: IncomingMessage, response: ServerResponse): Promise<void>
  read(request: IncomingMessage, response: ServerResponse): Promise<void>
}

export function createMediaExchangeHttp(origin: string, token: () => Promise<string | undefined>): MediaExchangeHttp {
  const base = new URL(origin)
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/'
    || base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname))) throw new MediaNodeError('MEDIA_EXCHANGE_ORIGIN_INVALID')
  const call = base.protocol === 'https:' ? httpsRequest : httpRequest
  return {
    post: async (path, body) => {
      if (!path.startsWith('/internal/media/') || /[?#]/u.test(path)) throw new MediaNodeError('MEDIA_EXCHANGE_PATH_INVALID')
      const secret = await token()
      if (!secret || secret.length < 32) throw new MediaNodeError('MEDIA_EXCHANGE_NOT_CONFIGURED', 503)
      const raw = Buffer.from(JSON.stringify(body))
      const limit = ['/internal/media/devices/verified', '/internal/media/devices/qualification', '/internal/media/profiles'].includes(path) ? 1024 * 1024 : 128 * 1024
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const request = call(new URL(path, base), { method: 'POST', headers: { authorization: `Bearer ${secret}`,
          'content-type': 'application/json', 'content-length': String(raw.length), accept: 'application/json' } }, incoming => {
          const chunks: Buffer[] = []; let size = 0
          incoming.on('data', (bytes: Buffer) => { size += bytes.length; if (size > limit) incoming.destroy(new Error('limit')); else chunks.push(bytes) })
          incoming.on('error', () => reject(new MediaNodeError('MEDIA_EXCHANGE_UNAVAILABLE', 503)))
          incoming.on('end', () => {
            if (incoming.headers['content-encoding'] !== undefined) return reject(new MediaNodeError('MEDIA_EXCHANGE_UNAVAILABLE', 503))
            try {
              const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))
              if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid')
              if (incoming.statusCode !== 200) {
                // Only reviewed metadata's fixed public enums cross this boundary, never an upstream exception or path.
                const detail = (value as Record<string, unknown>)['detail']
                const code = detail && typeof detail === 'object' && !Array.isArray(detail) ? (detail as Record<string, unknown>)['code'] : undefined
                const allowed = path === '/internal/media/install-manifest' ? ['MEDIA_INSTALL_CATALOG_UNAVAILABLE']
                  : path === '/internal/media/devices/qualification' ? ['MEDIA_PROFILE_QUALIFICATION_UNAVAILABLE'] : []
                return reject(new MediaNodeError(incoming.statusCode === 503 && typeof code === 'string' && allowed.includes(code)
                  ? code : 'MEDIA_EXCHANGE_UNAVAILABLE', incoming.statusCode === 409 ? 409 : 503))
              }
              resolve(value as Record<string, unknown>)
            } catch { reject(new MediaNodeError('MEDIA_EXCHANGE_UNAVAILABLE', 503)) }
          })
        })
        request.setTimeout(30_000, () => request.destroy(new Error('timeout')))
        request.on('error', () => reject(new MediaNodeError('MEDIA_EXCHANGE_UNAVAILABLE', 503)))
        request.end(raw)
      })
    },
    upload: async (incoming, outgoing) => {
      const path = incoming.url
      if (!['/v1/media/assets/upload', '/v1/media/results/upload'].includes(String(path)) || incoming.method !== 'POST') throw new MediaNodeError('BAD_REQUEST')
      if (incoming.headers.origin !== undefined || incoming.headers.cookie !== undefined || incoming.headers['content-encoding'] !== undefined
        || incoming.headers['sec-fetch-site'] === 'cross-site') throw new MediaNodeError('CROSS_ORIGIN_FORBIDDEN', 403)
      const authCount = incoming.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length
      const auth = incoming.headers.authorization
      const size = Number(incoming.headers['content-length'])
      const mime = incoming.headers['content-type']
      const limit = path === '/v1/media/assets/upload' ? 16 * 1024 * 1024 : 64 * 1024 * 1024
      if (authCount !== 1 || typeof auth !== 'string' || !/^Bearer [A-Za-z0-9_-]{128,8192}$/u.test(auth)) throw new MediaNodeError('MEDIA_UPLOAD_TICKET_REQUIRED', 401)
      if (!Number.isSafeInteger(size) || size < 1 || size > limit || !['image/png', 'image/jpeg', 'image/webp', 'video/mp4'].includes(String(mime))) throw new MediaNodeError('MEDIA_UPLOAD_INVALID')
      await new Promise<void>((resolve, reject) => {
        let total = 0
        const count = new Transform({ transform(chunk: Buffer, _encoding, callback) {
          total += chunk.length
          if (total > size || total > limit) callback(new Error('limit')); else callback(null, chunk)
        }, flush(callback) { callback(total === size ? null : new Error('length')) } })
        const request = call(new URL(path!, base), { method: 'POST', headers: { authorization: auth,
          'content-type': String(mime), 'content-length': String(size), accept: 'application/json' } }, response => {
          const chunks: Buffer[] = []; let received = 0
          response.on('data', (bytes: Buffer) => { received += bytes.length; if (received > 128 * 1024) response.destroy(new Error('limit')); else chunks.push(bytes) })
          response.on('error', () => reject(new MediaNodeError('MEDIA_UPLOAD_OUTCOME_UNKNOWN', 503)))
          response.on('end', () => {
            const raw = Buffer.concat(chunks)
            try {
              const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw))
              if (!value || typeof value !== 'object' || Array.isArray(value) || response.headers['content-encoding'] !== undefined) throw new Error('invalid')
              const status = response.statusCode ?? 503
              if (![200, 400, 401, 403, 409, 413, 503].includes(status)) throw new Error('invalid')
              outgoing.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
              outgoing.end(raw); resolve()
            } catch { reject(new MediaNodeError('MEDIA_UPLOAD_OUTCOME_UNKNOWN', 503)) }
          })
        })
        const abort = (): void => { if (!outgoing.writableFinished) request.destroy(new Error('client disconnected')) }
        outgoing.once('close', abort)
        request.once('close', () => outgoing.off('close', abort))
        request.setTimeout(180_000, () => request.destroy(new Error('timeout')))
        request.on('error', () => reject(new MediaNodeError('MEDIA_UPLOAD_OUTCOME_UNKNOWN', 503)))
        count.on('error', () => request.destroy(new Error('invalid stream')))
        incoming.on('error', () => request.destroy(new Error('input disconnected')))
        incoming.pipe(count).pipe(request)
      })
    },
    read: async (incoming, outgoing) => {
      if (incoming.url !== '/v1/media/assets/read' || incoming.method !== 'POST') throw new MediaNodeError('BAD_REQUEST')
      if (incoming.headers.origin !== undefined || incoming.headers.cookie !== undefined || incoming.headers['content-encoding'] !== undefined
        || incoming.headers['sec-fetch-site'] === 'cross-site') throw new MediaNodeError('CROSS_ORIGIN_FORBIDDEN', 403)
      const authCount = incoming.rawHeaders.filter((v, i) => i % 2 === 0 && v.toLowerCase() === 'authorization').length
      const auth = incoming.headers.authorization
      if (authCount !== 1 || typeof auth !== 'string' || !/^Bearer [A-Za-z0-9_-]{128,8192}$/u.test(auth)) throw new MediaNodeError('MEDIA_INPUT_TICKET_REQUIRED', 401)
      if (incoming.headers['transfer-encoding'] !== undefined || incoming.headers['content-length'] !== undefined && incoming.headers['content-length'] !== '0') throw new MediaNodeError('MEDIA_INPUT_READ_INVALID')
      for await (const chunk of incoming) if (chunk.length > 0) throw new MediaNodeError('MEDIA_INPUT_READ_INVALID')
      await new Promise<void>((resolve, reject) => {
        const request = call(new URL('/v1/media/assets/read', base), { method: 'POST', headers: {
          authorization: auth, 'content-length': '0', accept: 'image/png, image/jpeg, image/webp' } }, response => {
          const chunks: Buffer[] = []; let size = 0
          response.on('data', (bytes: Buffer) => { size += bytes.length; if (size > 16 * 1024 * 1024) response.destroy(new Error('limit')); else chunks.push(bytes) })
          response.on('error', () => reject(new MediaNodeError('MEDIA_INPUT_READ_UNAVAILABLE', 503)))
          response.on('end', () => {
            if (response.statusCode !== 200 || response.headers['content-encoding'] !== undefined) return reject(new MediaNodeError('MEDIA_INPUT_READ_UNAVAILABLE', response.statusCode === 401 ? 401 : response.statusCode === 409 ? 409 : 503))
            const mime = response.headers['content-type']; const sha = response.headers['x-content-sha256']; const raw = Buffer.concat(chunks)
            if (!['image/png', 'image/jpeg', 'image/webp'].includes(String(mime)) || Number(response.headers['content-length']) !== size || size < 1
              || typeof sha !== 'string' || !/^[0-9a-f]{64}$/u.test(sha) || createHash('sha256').update(raw).digest('hex') !== sha) return reject(new MediaNodeError('MEDIA_INPUT_READ_UNAVAILABLE', 503))
            outgoing.writeHead(200, { 'content-type': String(mime), 'content-length': String(size), 'x-content-sha256': sha,
              'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); outgoing.end(raw); resolve()
          })
        })
        const abort = (): void => { if (!outgoing.writableFinished) request.destroy(new Error('client disconnected')) }
        outgoing.once('close', abort); request.once('close', () => outgoing.off('close', abort))
        request.setTimeout(60_000, () => request.destroy(new Error('timeout')))
        request.on('error', () => reject(new MediaNodeError('MEDIA_INPUT_READ_UNAVAILABLE', 503))); request.end()
      })
    },
  }
}
