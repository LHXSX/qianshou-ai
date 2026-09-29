/** Reuse completed composer receipts and the ordinary direct-storage input uploader. */
import { ComputeError } from './errors.ts'
import { MAX_PLAN_INPUT_BYTES, MAX_PLAN_INPUT_FILES } from './plan-file-input.ts'

interface StoredFile { readonly name: string; readonly bytes: number }
interface ComposerAttachment {
  readonly type: 'file' | 'image'
  readonly receiptId?: string
  readonly data?: string
  readonly mediaType?: string
  readonly name?: string
}

/** Ports carry only files already uploaded for the addressed live Session. */
export interface MarketAttachmentPorts<T, F extends StoredFile = StoredFile> {
  resolve(receiptId: string): F | undefined
  read(file: F, signal: AbortSignal): AsyncIterable<Uint8Array>
  upload(input: { filename: string; contentType: string; bytes: Uint8Array }, signal: AbortSignal): Promise<T>
}

const MIME: Record<string, string> = {
  txt: 'text/plain', md: 'text/markdown', pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv', json: 'application/json', png: 'image/png', jpg: 'image/jpeg',
  jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif',
}

/** Validate the complete selection before sending any bytes to direct storage. */
export async function importMarketAttachments<T, F extends StoredFile = StoredFile>(value: unknown, ports: MarketAttachmentPorts<T, F>,
  signal: AbortSignal): Promise<T[]> {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PLAN_INPUT_FILES) {
    throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 400)
  }
  const prepared: Array<{ filename: string; contentType: string; bytes: Uint8Array }> = []
  let total = 0
  for (const raw of value) {
    signal.throwIfAborted()
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 400)
    const item = raw as ComposerAttachment
    let filename: string, contentType: string, bytes: Uint8Array
    if (item.type === 'file' && typeof item.receiptId === 'string') {
      const file = ports.resolve(item.receiptId)
      if (file === undefined) throw new ComputeError('COMPUTE_INPUT_RECEIPT_INVALID', 409)
      if (!Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes + total > MAX_PLAN_INPUT_BYTES) {
        throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 413)
      }
      filename = file.name
      contentType = MIME[filename.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream'
      const chunks: Uint8Array[] = []
      let size = 0
      for await (const chunk of ports.read(file, signal)) {
        signal.throwIfAborted()
        size += chunk.byteLength
        if (size > file.bytes) throw new ComputeError('COMPUTE_INPUT_SIZE_MISMATCH', 422)
        chunks.push(chunk)
      }
      if (size !== file.bytes) throw new ComputeError('COMPUTE_INPUT_SIZE_MISMATCH', 422)
      bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    } else if (item.type === 'image' && typeof item.data === 'string'
      && typeof item.mediaType === 'string' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(item.mediaType)) {
      if (item.data.length > Math.ceil(MAX_PLAN_INPUT_BYTES / 3) * 4) throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 413)
      bytes = Buffer.from(item.data, 'base64')
      if (bytes.byteLength < 1 || Buffer.from(bytes).toString('base64') !== item.data) throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 400)
      contentType = item.mediaType
      filename = item.name || `image-${prepared.length + 1}.${contentType.slice('image/'.length).replace('jpeg', 'jpg')}`
    } else throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 400)
    if (filename.length < 1 || filename.length > 128 || /[\/\\\u0000-\u001f]/u.test(filename)) {
      throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 400)
    }
    total += bytes.byteLength
    if (total > MAX_PLAN_INPUT_BYTES) throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 413)
    prepared.push({ filename, contentType, bytes })
  }
  const uploaded: T[] = []
  for (const input of prepared) {
    signal.throwIfAborted()
    uploaded.push(await ports.upload(input, signal))
  }
  return uploaded
}
