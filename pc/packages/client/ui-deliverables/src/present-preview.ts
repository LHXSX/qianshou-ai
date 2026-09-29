/** Bounded current-file previews authorized by one Session delivery event. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-workspace-files'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { isPresentedData, isPresentedFile, presentedPreviewUrl } from './presented.ts'

const TYPES: Readonly<Record<string, string>> = {
  png: 'image/png', apng: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
}
const HEADERS = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff',
  'content-security-policy': "sandbox; default-src 'none'", 'cross-origin-resource-policy': 'same-origin' }
const MAX_BYTES = 32 * 1024 * 1024

function failureStatus(error: unknown): number {
  const code = remoteErrorOf(error)?.code ?? (error instanceof Error && 'code' in error ? error.code : undefined)
  if (code === 'workspace-file/too-large' || code === 'FS_TOO_LARGE') return 413
  if (code === 'EACCES' || code === 'EPERM' || code === 'FS_PERMISSION_DENIED' || code === 'FS_SANDBOX_DENIED') return 403
  if (['session/not-found', 'workspace-file/not-found', 'workspace-file/not-regular-file',
    'SESSION_QUERY_SESSION_NOT_FOUND', 'SESSION_QUERY_EVENT_NOT_FOUND', 'ENOENT', 'ENOTDIR',
    'FS_NOT_FOUND', 'FS_NOT_REGULAR_FILE', 'FS_NOT_DIRECTORY'].includes(String(code))) return 404
  return 500
}

function coordinate(value: string | null): number | undefined {
  return value !== null && /^(?:0|[1-9]\d*)$/u.test(value) && Number.isSafeInteger(Number(value)) ? Number(value) : undefined
}

function supported(bytes: Uint8Array, mime: string): boolean {
  const ascii = (start: number, end: number): string => String.fromCharCode(...bytes.subarray(start, end))
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(ascii(0, 6))
  if (mime === 'image/png') return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  if (mime === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (mime === 'image/webp') return bytes.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
  if (mime === 'image/bmp') return bytes.length >= 14 && ascii(0, 2) === 'BM'
  if (mime === 'video/webm') return bytes.length >= 4 && [26, 69, 223, 163].every((value, index) => bytes[index] === value)
  if (mime === 'video/ogg') return bytes.length >= 5 && ascii(0, 4) === 'OggS' && bytes[4] === 0
  if (mime === 'image/avif') return bytes.length >= 16 && ascii(4, 8) === 'ftyp'
    && ['avif', 'avis'].includes(ascii(8, 12))
  if (mime === 'video/mp4' || mime === 'video/quicktime') {
    if (bytes.length < 12) return false
    const length = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0)
    return (ascii(4, 8) === 'ftyp' && length >= 12 && length <= bytes.length)
      || (mime === 'video/quicktime' && ['moov', 'mdat', 'wide'].includes(ascii(4, 8))
        && (length === 0 || length >= 8 && length <= bytes.length))
  }
  return false
}

/**
 * Read current safe media from the file declared by one durable delivery.
 * The composed filesystem policy and window caps apply alongside a fixed 32 MiB total cap.
 * Single byte ranges are sliced only after complete source validation; no Agent is activated.
 * @param ctx - authenticated Session query and workspace-file services.
 * @param request - canonical Session/event/index coordinates and cancellation.
 * @returns bounded image/video bytes, or a refusal without exposing filesystem paths.
 */
export async function handlePresentPreview(ctx: Context, request: Request): Promise<Response> {
  const fail = (status: number): Response => new Response('Presented preview unavailable.', { status, headers: HEADERS })
  const url = new URL(request.url)
  const sessionId = url.searchParams.get('sessionId')
  const seq = coordinate(url.searchParams.get('seq')), index = coordinate(url.searchParams.get('index'))
  if (sessionId === null || seq === undefined || index === undefined
    || presentedPreviewUrl(sessionId, seq, index) !== url.pathname + url.search) return fail(400)
  try {
    request.signal.throwIfAborted()
    const { session, target } = await ctx.sessionQuery.readEvent({ sessionId: sessionId as SessionId,
      seq: seq as SessionSeq, before: 0, after: 0 }, request.signal)
    const file = target.type === 'deliverables/presented' && isPresentedData(target.data) ? target.data.files[index] : undefined
    if (!isPresentedFile(file)) return fail(404)
    const extension = /\.([a-z0-9]+)$/iu.exec(file.path)?.[1]?.toLowerCase()
    const mime = extension === undefined ? undefined : TYPES[extension]
    if (mime === undefined) return fail(415)
    const scope = { sessionId: sessionId as SessionId, workspaceRoot: session.cwd ?? ctx.sandboxPolicy.workspaceRoot }
    const initial = await ctx.workspaceFiles.stat(scope, file.path, request.signal)
    if (initial.bytes === undefined || initial.bytes > MAX_BYTES) return fail(413)
    if (initial.bytes === 0) return fail(409)
    const bytes = new Uint8Array(initial.bytes)
    for (let offset = 0; offset < bytes.length;) {
      const length = Math.min(64 * 1024, bytes.length - offset)
      const current = await ctx.workspaceFiles.readBytes(scope, file.path, { offset, length }, request.signal)
      request.signal.throwIfAborted()
      if (current.absolutePath !== initial.absolutePath || current.version !== initial.version
        || current.bytes !== initial.bytes || current.offset !== offset) return fail(409)
      if (current.data.length > Math.ceil(length / 3) * 4) return fail(413)
      const chunk = Buffer.from(current.data, 'base64')
      if (chunk.length !== length || current.eof !== (offset + length === bytes.length)) return fail(409)
      bytes.set(chunk, offset)
      offset += length
    }
    const final = await ctx.workspaceFiles.stat(scope, file.path, request.signal)
    request.signal.throwIfAborted()
    if (final.absolutePath !== initial.absolutePath || final.version !== initial.version
      || final.bytes !== initial.bytes) return fail(409)
    if (!supported(bytes, mime)) return fail(415)
    const headers = { ...HEADERS, 'content-type': mime, 'accept-ranges': 'bytes' }
    const range = request.headers.get('range')
    if (range === null) return new Response(bytes, { headers: { ...headers, 'content-length': String(bytes.length) } })
    const match = /^bytes=(\d*)-(\d*)$/u.exec(range)
    if (match === null || match[1] === '' && match[2] === '') return fail(400)
    const first = Number(match[1]), last = Number(match[2])
    const start = match[1] === '' ? Math.max(0, bytes.length - last) : first
    const end = match[2] === '' || match[1] === '' ? bytes.length - 1 : Math.min(last, bytes.length - 1)
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || start > end
      || start >= bytes.length || match[1] === '' && last === 0) {
      return new Response(null, { status: 416, headers: { ...headers, 'content-range': `bytes */${bytes.length}` } })
    }
    return new Response(bytes.slice(start, end + 1), { status: 206,
      headers: { ...headers, 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': String(end - start + 1) } })
  } catch (error: unknown) {
    request.signal.throwIfAborted()
    return fail(failureStatus(error))
  }
}
