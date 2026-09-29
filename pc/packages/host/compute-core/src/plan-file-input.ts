/** Completed upload references only. The durable draft contains no file bytes or storage credentials. */
export interface PlanInputFile {
  readonly objectKey: string
  readonly filename: string
  readonly bytes: number
  readonly sha256: string
  readonly contentType: string
  readonly objectVersionId?: string
}
export interface PlanFileInput { readonly kind: 'multi_file'; readonly files: readonly PlanInputFile[] }
export const MAX_PLAN_INPUT_BYTES = 16 * 1024 * 1024
export const MAX_PLAN_INPUT_FILES = 15
const DEVELOPER_KEY = /^v8\/account-[1-9]\d{0,15}\/developer\/[a-f0-9]{32}\/input\/[^/\\\u0000-\u001f]{1,128}$/u
const VIDEO_KEY = /^v8\/account-[1-9]\d{0,15}\/reviewed-video\/input\/[a-f0-9]{32}\/frame\.(?:png|jpg)$/u

/** Admit exact uploaded-file metadata before writing a draft or building a quote. */
export function parsePlanFileInput(value: unknown): PlanFileInput {
  const invalid = (): never => { throw new TypeError('INVALID_COMPUTE_FIELD: fileInput') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid()
  const row = value as Record<string, unknown>
  if (Object.keys(row).sort().join(',') !== 'files,kind' || row.kind !== 'multi_file'
    || !Array.isArray(row.files) || row.files.length < 1 || row.files.length > MAX_PLAN_INPUT_FILES) invalid()
  const seen = new Set<string>()
  let total = 0
  const files = (row.files as unknown[]).map((item): PlanInputFile => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) invalid()
    const file = item as Record<string, unknown>
    if (!['bytes,contentType,filename,objectKey,sha256', 'bytes,contentType,filename,objectKey,objectVersionId,sha256'].includes(Object.keys(file).sort().join(','))
      || typeof file.objectKey !== 'string'
      || !(DEVELOPER_KEY.test(file.objectKey) || VIDEO_KEY.test(file.objectKey)) || seen.has(file.objectKey)
      || typeof file.filename !== 'string' || file.filename.length < 1 || file.filename.length > 128
      || !file.filename.isWellFormed() || /[/\\\u0000-\u001f]/u.test(file.filename)
      || file.objectKey.split('/').at(-1) !== file.filename || file.filename === '.' || file.filename === '..'
      || typeof file.bytes !== 'number' || !Number.isSafeInteger(file.bytes) || file.bytes < 1
      || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(file.sha256)
      || typeof file.contentType !== 'string' || !/^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u.test(file.contentType)
      || file.contentType.length > 128
      || (file.objectVersionId !== undefined && (typeof file.objectVersionId !== 'string'
        || !/^[A-Za-z0-9_.~+-]{1,200}$/u.test(file.objectVersionId) || file.objectVersionId.toLowerCase() === 'null'))) invalid()
    const admitted = file as unknown as PlanInputFile
    seen.add(admitted.objectKey); total += admitted.bytes
    if (total > MAX_PLAN_INPUT_BYTES) invalid()
    return Object.freeze({ objectKey: admitted.objectKey, filename: admitted.filename, bytes: admitted.bytes,
      sha256: admitted.sha256, contentType: admitted.contentType,
      ...(admitted.objectVersionId === undefined ? {} : { objectVersionId: admitted.objectVersionId }) })
  })
  return Object.freeze({ kind: 'multi_file', files: Object.freeze(files) })
}
