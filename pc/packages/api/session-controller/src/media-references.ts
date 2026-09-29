/** Authenticated file display. Large audio/video is read in bounded windows. */

import { extname, isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-attachment'
import { FsError, type FileSystem, type FsTarget } from '@deepseek-ai/dsh-fs'
import mime from 'mime-types'

const BASE_HEADERS = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  // HTML and SVG files may be opened directly on the authenticated API origin.
  'Content-Security-Policy': "sandbox; default-src 'none'",
}

const MEDIA_CHUNK_BYTES = 1024 * 1024
const STREAMABLE_MEDIA = /^(?:audio|video)\//u
const SIGNATURE_VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.webm'])
const SIGNATURE_VIDEO_TYPES = new Set(['video/mp4', 'video/x-m4v', 'video/quicktime', 'video/webm'])

/** An extension alone is not enough to turn arbitrary files into unbounded media responses. */
async function hasVideoSignature(fs: FileSystem, target: FsTarget, mediaType: string, size: number, signal: AbortSignal): Promise<boolean> {
  const length = mediaType === 'video/webm' ? 4 : 12
  if (size < length) return false
  const bytes = await fs.readByteRange(target, { offset: 0, length }, signal)
  if (bytes.byteLength !== length) return false
  if (mediaType === 'video/webm') {
    return bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3
  }
  const atom = String.fromCharCode(...bytes.subarray(4, 8))
  const atomSize = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0)
  if (atom === 'ftyp') return atomSize >= 12 && atomSize <= size
  return mediaType === 'video/quicktime'
    && (atom === 'moov' || atom === 'mdat' || atom === 'wide')
    && (atomSize === 0 || (atomSize >= 8 && atomSize <= size))
}

/** One RFC 7233 byte range. Multi-range requests are deliberately unsupported. */
function mediaRange(value: string, size: number, maxBytes: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/u.exec(value)
  if (match === null || (match[1] === '' && match[2] === '') || maxBytes < 1) return null
  const first = match[1] ?? ''
  const last = match[2] ?? ''
  if ((first !== '' && !Number.isSafeInteger(Number(first)))
    || (last !== '' && !Number.isSafeInteger(Number(last)))) return null
  const start = first === '' ? Math.max(0, size - Number(last)) : Number(first)
  const wantedEnd = first === '' ? size - 1 : last === '' ? size - 1 : Number(last)
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(wantedEnd)
    || start < 0 || start >= size || wantedEnd < start) return null
  return { start, end: Math.min(wantedEnd, size - 1, start + Math.min(MEDIA_CHUNK_BYTES, maxBytes) - 1) }
}

/** Stream a large file without materializing it in the Host or renderer. */
function streamMedia(fs: FileSystem, target: FsTarget, size: number, signal: AbortSignal, maxBytes: number): ReadableStream<Uint8Array<ArrayBuffer>> {
  const cancelled = new AbortController()
  const scoped = AbortSignal.any([signal, cancelled.signal])
  let offset = 0
  return new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      if (offset >= size) { controller.close(); return }
      try {
        const bytes = await fs.readByteRange(target, { offset, length: Math.min(MEDIA_CHUNK_BYTES, maxBytes, size - offset) }, scoped)
        if (bytes.length === 0) { controller.close(); return }
        offset += bytes.length
        controller.enqueue(bytes.slice())
      } catch (error) { controller.error(error) }
    },
    cancel() { cancelled.abort() },
  })
}

async function serveFile(request: Request, fs: FileSystem, maxBytes: number): Promise<Response> {
  const fail = (status: number, text: string): Response =>
    new Response(request.method === 'HEAD' ? null : text, { status, headers: BASE_HEADERS })
  const path = new URL(request.url).searchParams.get('path')
  if (path === null || path.length === 0) return fail(400, 'missing path')
  if (path.includes('\0') || !isAbsolute(path)) return fail(400, 'absolute path required')
  try {
    const target = await fs.resolve(path, { signal: request.signal })
    const mediaType = mime.lookup(target.displayPath) || 'application/octet-stream'
    const headers: Record<string, string> = {
      ...BASE_HEADERS,
      'Content-Type': mediaType,
    }
    const info = await fs.stat(target, request.signal)
    if (info === undefined) return fail(404, 'not found')
    if (info.type !== 'file') return fail(403, 'not a regular file')
    const size = info.size
    if (size !== undefined && (!Number.isSafeInteger(size) || size < 0)) return fail(500, 'invalid file size')
    const signedVideo = SIGNATURE_VIDEO_EXTENSIONS.has(extname(target.displayPath).toLowerCase())
      && SIGNATURE_VIDEO_TYPES.has(mediaType)
    const isStreamable = STREAMABLE_MEDIA.test(mediaType)
      && size !== undefined && maxBytes > 0
      && (!signedVideo || await hasVideoSignature(fs, target, mediaType, size, request.signal))
    if (isStreamable && size !== undefined && Number.isSafeInteger(size) && size >= 0) {
      headers['Accept-Ranges'] = 'bytes'
      // This route emits no validators, so an If-Range condition cannot match.
      const rangeHeader = request.method === 'GET' && !request.headers.has('if-range')
        ? request.headers.get('range') : null
      if (rangeHeader !== null) {
        const range = mediaRange(rangeHeader, size, maxBytes)
        if (range === null) return new Response(request.method === 'HEAD' ? null : 'range not satisfiable', {
          status: 416, headers: { ...headers, 'Content-Range': `bytes */${size}` },
        })
        const bytes = await fs.readByteRange(target,
          { offset: range.start, length: range.end - range.start + 1 }, request.signal)
        if (bytes.byteLength !== range.end - range.start + 1) return fail(409, 'file changed during read')
        const actualEnd = range.start + bytes.byteLength - 1
        headers['Content-Range'] = `bytes ${range.start}-${actualEnd}/${size}`
        headers['Content-Length'] = String(actualEnd - range.start + 1)
        return new Response(bytes.slice(), { status: 206, headers })
      }
      if (request.method === 'HEAD') {
        headers['Content-Length'] = String(size)
        return new Response(null, { headers })
      }
      if (size > maxBytes) return new Response(streamMedia(fs, target, size, request.signal, maxBytes), { headers })
    }
    if (request.method === 'HEAD') {
      if (size !== undefined) {
        if (size > maxBytes) return fail(413, 'file exceeds byte limit')
        headers['Content-Length'] = String(size)
      }
      return new Response(null, { headers })
    }
    const bytes = await fs.readBytes(target, request.signal, maxBytes)
    headers['Content-Length'] = String(bytes.byteLength)
    return new Response(bytes.slice(), { headers })
  } catch (error: unknown) {
    if (!(error instanceof FsError)) throw error
    const statuses: Partial<Record<FsError['code'], number>> = {
      FS_NOT_FOUND: 404,
      FS_NOT_REGULAR_FILE: 403,
      FS_PERMISSION_DENIED: 403,
      FS_SANDBOX_DENIED: 403,
      FS_TOO_LARGE: 413,
      FS_ABORTED: 499,
    }
    return fail(statuses[error.code] ?? 500, error.code)
  }
}

/**
 * File-display contribution. The connection service supplies authentication;
 * `ctx.fs` supplies the execution world's paths, reads, and access policy.
 */
export const SessionMediaReferences = {
  inject: ['connection', 'fs', 'attachments'],
  apply(ctx: Context): void {
    const maxBytes = ctx.attachments.imageLimits.maxImageBytes
    ctx.effect(() => ctx.connection.fetch.register({
      path: '/api/file',
      methods: ['GET', 'HEAD'],
      requestBody: 'buffered',
      fetch: request => serveFile(request, ctx.fs, maxBytes),
    }), 'session-controller: /api/file')
  },
}
