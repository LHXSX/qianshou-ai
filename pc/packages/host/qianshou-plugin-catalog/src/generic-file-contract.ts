/** Opt-in file ABI. These limits grant neither filesystem nor network access to QuickJS. */
import { createHash } from 'node:crypto'
import { canonicalOrderJson } from './order-json-canonical.ts'
import { CatalogFailure } from './registry.ts'

export const FILE_ABI = 'qianshou.quickjs-files.v1' as const
export const FILE_BYTES_POLICY = 'independent-file-bytes.v1' as const
export const MAX_QUICKJS_FILE_BYTES = 16 * 1024
const SLOT = /^[a-z][a-z0-9_]{0,31}$/u
const FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u
const MIME = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u
function isArtifactContentType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && MIME.test(value)
}

export interface GenericFileInput {
  readonly name: string
  readonly contentTypes: readonly string[]
  readonly maxBytes: number
}
export interface GenericFileOutput {
  readonly name: string
  readonly filename: string
  readonly contentType: string
  readonly maxBytes: number
  readonly encoding: 'utf8' | 'base64'
}
export interface GenericFileSchema {
  readonly schema: typeof FILE_ABI
  readonly inputs: readonly GenericFileInput[]
  readonly outputs: readonly [GenericFileOutput]
  readonly verificationPolicy: typeof FILE_BYTES_POLICY
}
export interface GenericFileAttachment {
  readonly contentType: string
  readonly sha256: string
  readonly bytes: Uint8Array
}
export interface GenericProducedFile {
  readonly name: string
  readonly filename: string
  readonly contentType: string
  readonly sha256: string
  readonly bytes: Uint8Array
}

function fail(): never { throw new CatalogFailure('order-adapter-invalid') }
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail()
  return value as Record<string, unknown>
}
function keys(value: Record<string, unknown>, expected: string): void {
  if (Object.keys(value).sort().join(',') !== expected) fail()
}
function bounded(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_QUICKJS_FILE_BYTES
}

/** No unknown keywords, paths, URLs, codecs or author-supplied verifier code. */
export function parseGenericFileSchema(value: unknown): GenericFileSchema {
  const raw = row(value)
  keys(raw, 'inputs,outputs,schema,verificationPolicy')
  if (raw.schema !== FILE_ABI || raw.verificationPolicy !== FILE_BYTES_POLICY
    || !Array.isArray(raw.inputs) || raw.inputs.length > 1
    || !Array.isArray(raw.outputs) || raw.outputs.length !== 1
    || Buffer.byteLength(canonicalOrderJson(raw), 'utf8') > 2048) fail()
  for (const item of raw.inputs) {
    const input = row(item)
    keys(input, 'contentTypes,maxBytes,name')
    if (typeof input.name !== 'string' || !SLOT.test(input.name) || !bounded(input.maxBytes)
      || !Array.isArray(input.contentTypes) || input.contentTypes.length < 1 || input.contentTypes.length > 8
      || input.contentTypes.some(type => !isArtifactContentType(type))
      || new Set(input.contentTypes).size !== input.contentTypes.length) fail()
  }
  const output = row(raw.outputs[0])
  keys(output, 'contentType,encoding,filename,maxBytes,name')
  if (typeof output.name !== 'string' || !SLOT.test(output.name)
    || typeof output.filename !== 'string' || !FILENAME.test(output.filename)
    || output.filename.includes('..') || !isArtifactContentType(output.contentType)
    || !bounded(output.maxBytes) || (output.encoding !== 'utf8' && output.encoding !== 'base64')) fail()
  // Return a fresh declaration: asynchronous reads cannot mutate the reviewed limits.
  return Object.freeze({ schema: FILE_ABI, verificationPolicy: FILE_BYTES_POLICY,
    inputs: Object.freeze(raw.inputs.map(item => {
      const input = row(item)
      return Object.freeze({ name: input.name as string, maxBytes: input.maxBytes as number,
        contentTypes: Object.freeze([...(input.contentTypes as string[])]) })
    })), outputs: Object.freeze([Object.freeze({ ...output })]) as unknown as GenericFileSchema['outputs'] })
}

/** Only a declared logical slot is passed to the Host's lease-authorized reader. */
export async function fileGuestInput(schema: GenericFileSchema, input: unknown,
  read: (slot: GenericFileInput) => Promise<GenericFileAttachment>, signal?: AbortSignal): Promise<Buffer> {
  const pinned = parseGenericFileSchema(schema)
  const attachments = []
  for (const slot of pinned.inputs) {
    signal?.throwIfAborted()
    const found = await read(slot)
    signal?.throwIfAborted()
    if (!(found.bytes instanceof Uint8Array) || found.bytes.byteLength < 1
      || found.bytes.byteLength > slot.maxBytes || !slot.contentTypes.includes(found.contentType)
      || !/^[0-9a-f]{64}$/u.test(found.sha256)) fail()
    const bytes = Buffer.from(found.bytes)
    if (createHash('sha256').update(bytes).digest('hex') !== found.sha256) fail()
    attachments.push({ name: slot.name, contentType: found.contentType,
      encoding: 'base64', content: bytes.toString('base64') })
  }
  const encoded = Buffer.from(canonicalOrderJson({ schema: 'qianshou.quickjs-file-input.v1', input, attachments }))
  if (encoded.byteLength > 64 * 1024) fail()
  return encoded
}

/** Guest results contain content only; filename, MIME and limits come from the pinned declaration. */
export function fileGuestOutput(schema: GenericFileSchema, value: unknown): readonly GenericProducedFile[] {
  const pinned = parseGenericFileSchema(schema)
  const raw = row(value)
  keys(raw, 'files,schema')
  if (raw.schema !== 'qianshou.quickjs-file-result.v1' || !Array.isArray(raw.files)
    || raw.files.length !== pinned.outputs.length
    || Buffer.byteLength(canonicalOrderJson(raw), 'utf8') > 64 * 1024) fail()
  const file = row(raw.files[0])
  keys(file, 'content,encoding,name')
  const declared = pinned.outputs[0]
  if (file.name !== declared.name || file.encoding !== declared.encoding
    || typeof file.content !== 'string' || !file.content.isWellFormed()) fail()
  let bytes: Buffer
  if (declared.encoding === 'utf8') bytes = Buffer.from(file.content, 'utf8')
  else {
    // Buffer.from is permissive; require the unique RFC 4648 spelling first.
    if (file.content.length > Math.ceil(declared.maxBytes / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(file.content)) fail()
    bytes = Buffer.from(file.content, 'base64')
    if (bytes.toString('base64') !== file.content) fail()
  }
  if (bytes.byteLength < 1 || bytes.byteLength > declared.maxBytes) fail()
  return [Object.freeze({ name: declared.name, filename: declared.filename,
    contentType: declared.contentType, bytes,
    sha256: createHash('sha256').update(bytes).digest('hex') })]
}
