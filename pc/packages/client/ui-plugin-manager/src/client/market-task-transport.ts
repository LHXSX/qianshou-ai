/** Same-origin PC Host transport for a market task. The Host keeps the Shanghai token. */
import { parseMarketInputRule, type MarketInputRule } from './market-input-form.ts'
import type { SubmitAttachment, ClientSessionContext } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

export interface MarketTaskParamField {
  name: string
  title: string
  type: 'string' | 'integer' | 'number' | 'boolean'
  required: boolean
  minLength?: number
  maxLength?: number
  minimum?: number
  maximum?: number
  choices?: Array<string | number | boolean>
  defaultValue?: string | number | boolean
}

export interface MarketTaskType {
  taskType: string
  capabilityId?: string
  acceptedInputKinds: string[]
  requiredParams: string[]
  canQuoteInline: boolean
  canQuoteFiles?: boolean
  /** Host-verified public contract and explicit first-frame meaning from the reviewed platform row. */
  reviewedVideoInput?: {
    schema: 'qianshou.reviewed-video-task-input.v1'
    publicationId: string
    approvedContractDigest: string
    firstFrameSlot: string
    promptSlot: string
    firstFrameManifestParam: 'input_manifest'
    firstFrameManifestIndex: 0
    promptParam: 'prompt'
    mimeType: 'image/png' | 'image/jpeg'
    maxBytes: number
    maxPromptUtf8Bytes: number
  }
  reviewedPublication?: {
    schema: 'qianshou.reviewed-publication-selection.v1'
    publicationId: string
    artifactDigest: string
    contractSha256: string
  }
  paramFields?: MarketTaskParamField[]
  inlineForm?: {
    title: string
    mediaType: 'text/plain' | 'application/json'
    minLength?: number
    maxLength?: number
    /** Preserve an unsupported signed declaration instead of downgrading it to raw JSON. */
    structuredDeclared?: boolean
    structured?: MarketInputRule
    /** Fixed values from the exact signed legacy examples, never an amended task contract. */
    presentationFixed?: Record<string, string | number | boolean>
    /** One free text field plus reviewed constant fields, from Shanghai's JSON schema. */
    template?: { field: string
      constants: Record<string, string | number | boolean>
      minLength: number
      maxLength: number
      title: string }
  }
}

export interface MarketInputFile {
  readonly objectVersionId?: string
  objectKey: string
  filename: string
  bytes: number
  sha256: string
  contentType: string
}

/** Local expectation captured when the buyer confirms a reviewed video creative. */
export interface MarketVideoReviewExpectation {
  readonly publicationId: string
  readonly approvedContractDigest: string
  readonly artifactDigest: string
  readonly contractSha256: string
}

/** Explicitly selected public listing, separate from a generic task-type call. */
export interface MarketProductSelection {
  readonly productId: string
  readonly publicationId: string
  readonly ownerId: number
  readonly version: string
}

export interface MarketTaskQuote {
  planId: string
  capabilityId?: string
  quoteId: string
  taskType: string
  amountYuan: string
  currency: 'CNY'
  balanceEnough: boolean
  expiresAt: string
}

export interface MarketTaskWorkload {
  id: string
  status: string
  resultAvailable: boolean
  executionStage?: 'waiting' | 'executing' | 'checking'
  /** Exact server-reported progress; zero or null does not establish completion. */
  progress?: number | null
  /** Server creation time, excluding time spent composing or editing a quote. */
  createdAt?: string
}

export interface MarketTaskResult {
  id: string
  status: string
  inlineOutput: string | null
  artifactRef: string | null
}

export interface MarketTaskAcceptance {
  workloadId: string
  status: 'pending_buyer' | 'accepted' | 'rejected'
  workloadStatus: string
  currency: 'CNY'
  heldAmount: string
  inlineOutput: unknown
  contentSha256: string
  outputKind: 'inline_json'
  shardId: string
}

export interface MarketTaskTransport {
  taskTypes(signal: AbortSignal): Promise<MarketTaskType[]>
  createPlan(taskType: string, goal: string, signal: AbortSignal,
    params?: Record<string, string | number | boolean>, files?: readonly MarketInputFile[],
    expectedVideoReview?: MarketVideoReviewExpectation,
    expectedProduct?: MarketProductSelection): Promise<string>
  /** Upload selected bytes through the local Host; no task or fee is created. */
  uploadInputFile?: (file: File, signal: AbortSignal,
    purpose?: 'reviewed-video-first-frame') => Promise<MarketInputFile>
  /** Promote existing Session-scoped composer receipts using the same Host uploader. */
  importComposerFiles?: (session: ClientSessionContext, attachments: readonly SubmitAttachment[],
    signal: AbortSignal) => Promise<MarketInputFile[]>
  quotePlan(planId: string, signal: AbortSignal, expectedCapabilityId?: string): Promise<MarketTaskQuote>
  confirmAndPublish(planId: string, quoteId: string, signal: AbortSignal): Promise<string>
  findWorkload(planId: string, signal: AbortSignal): Promise<string | null>
  readWorkload(workloadId: string, signal: AbortSignal): Promise<MarketTaskWorkload>
  readResult(workloadId: string, signal: AbortSignal): Promise<MarketTaskResult>
  readAcceptance(workloadId: string, signal: AbortSignal): Promise<MarketTaskAcceptance | null>
  decideAcceptance(workloadId: string, decision: 'accept' | 'reject',
    idempotencyKey: string, signal: AbortSignal): Promise<MarketTaskAcceptance>
}

function serializedOutput(value: unknown): string | undefined {
  return JSON.stringify(value)
}

function acceptance(raw: unknown, workloadId: string): MarketTaskAcceptance {
  const row = record(raw)
  const workloadStatus = valueString(row.workloadStatus, 64)
  if (row.workloadId !== workloadId || !['pending_buyer', 'accepted', 'rejected'].includes(String(row.status))
    || row.currency !== 'CNY' || row.outputKind !== 'inline_json'
    || (row.status === 'pending_buyer' && workloadStatus !== 'QUARANTINED')
    || typeof row.heldAmount !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,4})?$/u.test(row.heldAmount)
    || typeof row.contentSha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(row.contentSha256)
    || typeof row.shardId !== 'string' || row.shardId.length > 128) {
    throw new Error('MARKET_TASK_INVALID_RESPONSE')
  }
  const output = serializedOutput(row.inlineOutput)
  if (output === undefined || output.length > 64 * 1024) throw new Error('MARKET_TASK_INVALID_RESPONSE')
  return { workloadId, status: row.status as MarketTaskAcceptance['status'],
    workloadStatus, currency: 'CNY', heldAmount: row.heldAmount,
    inlineOutput: row.inlineOutput, contentSha256: row.contentSha256,
    outputKind: 'inline_json', shardId: row.shardId }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('MARKET_TASK_INVALID_RESPONSE')
  return value as Record<string, unknown>
}

/** Saved upload metadata remains a reference; the Host rechecks account authority at quote time. */
export function marketInputFile(value: unknown): MarketInputFile {
  const row = record(value)
  if (typeof row.filename !== 'string' || row.filename.length < 1 || row.filename.length > 128
    || /[\/\\\u0000-\u001f]/u.test(row.filename)
    || !Number.isSafeInteger(row.bytes) || (row.bytes as number) < 1 || (row.bytes as number) > 16 * 1024 * 1024
    || typeof row.objectKey !== 'string' || !/^v8\/account-[1-9]\d*\/(?:developer\/[a-f0-9]{32}\/input\/[^/\\]+|reviewed-video\/input\/[a-f0-9]{32}\/frame\.(?:png|jpg))$/u.test(row.objectKey)
    || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256)
    || typeof row.contentType !== 'string' || row.contentType.length < 1 || row.contentType.length > 200) {
    throw new Error('MARKET_TASK_INVALID_RESPONSE')
  }
  return { filename: row.filename, bytes: row.bytes as number, objectKey: row.objectKey, sha256: row.sha256,
    contentType: row.contentType,
    ...(row.objectVersionId === undefined ? {} : { objectVersionId: valueString(row.objectVersionId, 200) }) }
}

function valueString(value: unknown, max = 256): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > max) throw new Error('MARKET_TASK_INVALID_RESPONSE')
  return value
}

function paramsFields(schema: unknown): MarketTaskParamField[] {
  if (schema === undefined || schema === null) return []
  const root = record(schema)
  if (root.type !== 'object' || root.additionalProperties !== false) throw new Error('MARKET_TASK_INVALID_RESPONSE')
  const properties = record(root.properties)
  const required = root.required
  if (!Array.isArray(required) || required.length > 32 || Object.keys(properties).length > 32
    || required.some(name => typeof name !== 'string' || !(name in properties))) {
    throw new Error('MARKET_TASK_INVALID_RESPONSE')
  }
  return Object.entries(properties).map(([name, value]) => {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name)) throw new Error('MARKET_TASK_INVALID_RESPONSE')
    const field = record(value)
    if (field.type !== 'string' && field.type !== 'integer' && field.type !== 'number'
      && field.type !== 'boolean') throw new Error('MARKET_TASK_INVALID_RESPONSE')
    const bound = (key: string): number | undefined => {
      const value = field[key]
      if (value === undefined) return undefined
      const ceiling = key === 'minLength' || key === 'maxLength' ? 1_000_000 : Number.MAX_SAFE_INTEGER
      if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > ceiling) {
        throw new Error('MARKET_TASK_INVALID_RESPONSE')
      }
      return value
    }
    const choices = field.enum
    if (choices !== undefined && (!Array.isArray(choices) || choices.length < 1 || choices.length > 30
      || choices.some(choice => typeof choice !== field.type && !(field.type === 'integer' && typeof choice === 'number')))) {
      throw new Error('MARKET_TASK_INVALID_RESPONSE')
    }
    const minLength = bound('minLength')
    const maxLength = bound('maxLength')
    const minimum = bound('minimum')
    const maximum = bound('maximum')
    if ((minLength !== undefined && (!Number.isSafeInteger(minLength) || minLength < 0))
      || (maxLength !== undefined && (!Number.isSafeInteger(maxLength) || maxLength < 0))
      || (minLength !== undefined && maxLength !== undefined && minLength > maxLength)
      || (minimum !== undefined && maximum !== undefined && minimum > maximum)
      || (field.default !== undefined && typeof field.default !== field.type
        && !(field.type === 'integer' && typeof field.default === 'number'))
      || (field.type === 'integer' && field.default !== undefined && !Number.isSafeInteger(field.default))) {
      throw new Error('MARKET_TASK_INVALID_RESPONSE')
    }
    return { name, title: typeof field.title === 'string' && field.title.length <= 80 ? field.title : name,
      type: field.type, required: required.includes(name),
      ...(minLength === undefined ? {} : { minLength }),
      ...(maxLength === undefined ? {} : { maxLength }),
      ...(minimum === undefined ? {} : { minimum }),
      ...(maximum === undefined ? {} : { maximum }),
      ...(choices === undefined ? {} : { choices: choices as Array<string | number | boolean> }),
      ...(field.default === undefined ? {} : { defaultValue: field.default as string | number | boolean }) }
  })
}

function reviewedVideoInput(value: unknown): NonNullable<MarketTaskType['reviewedVideoInput']> {
  const row = record(value)
  if (Object.keys(row).sort().join(',') !== [
    'approvedContractDigest', 'firstFrameManifestIndex', 'firstFrameManifestParam',
    'firstFrameSlot', 'maxBytes', 'maxPromptUtf8Bytes', 'mimeType', 'promptParam',
    'promptSlot', 'publicationId', 'schema',
  ].sort().join(',') || row.schema !== 'qianshou.reviewed-video-task-input.v1'
    || typeof row.publicationId !== 'string'
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(row.publicationId)
    || typeof row.approvedContractDigest !== 'string'
    || !/^sha256:[a-f0-9]{64}$/u.test(row.approvedContractDigest)
    || row.firstFrameSlot !== 'first_frame' || row.promptSlot !== 'prompt'
    || row.firstFrameManifestParam !== 'input_manifest' || row.firstFrameManifestIndex !== 0
    || row.promptParam !== 'prompt'
    || row.mimeType !== 'image/png' && row.mimeType !== 'image/jpeg'
    || !Number.isSafeInteger(row.maxBytes) || (row.maxBytes as number) < 1
    || (row.maxBytes as number) > 256 * 1024 * 1024
    || !Number.isSafeInteger(row.maxPromptUtf8Bytes)
    || (row.maxPromptUtf8Bytes as number) < 1 || (row.maxPromptUtf8Bytes as number) > 8192) {
    throw new Error('MARKET_TASK_INVALID_RESPONSE')
  }
  return row as unknown as NonNullable<MarketTaskType['reviewedVideoInput']>
}

function reviewedPublication(value: unknown): NonNullable<MarketTaskType['reviewedPublication']> {
  const row = record(value)
  if (Object.keys(row).sort().join(',') !== 'artifactDigest,contractSha256,publicationId,schema'
    || row.schema !== 'qianshou.reviewed-publication-selection.v1'
    || typeof row.publicationId !== 'string'
    || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(row.publicationId)
    || typeof row.artifactDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(row.artifactDigest)
    || typeof row.contractSha256 !== 'string' || !/^sha256:[a-f0-9]{64}$/u.test(row.contractSha256)) {
    throw new Error('MARKET_TASK_INVALID_RESPONSE')
  }
  return row as unknown as NonNullable<MarketTaskType['reviewedPublication']>
}

function inlineForm(schema: unknown): MarketTaskType['inlineForm'] {
  if (schema === undefined || schema === null) return undefined
  const root = record(schema)
  const variants = root.oneOf
  if (!Array.isArray(variants) || variants.length > 8) return undefined
  const inline = variants.map(value => record(value)).find((value) => {
    const properties = record(value.properties)
    return record(properties.input_kind).const === 'inline'
  })
  if (!inline) return undefined
  const field = record(record(inline.properties).inline_input)
  if (field.type !== 'string') return undefined
  const mediaType = field.contentMediaType === 'application/json' ? 'application/json' : 'text/plain'
  const title = typeof field.title === 'string' && field.title.length <= 80 ? field.title : '描述要完成的事'
  const form: NonNullable<MarketTaskType['inlineForm']> = { title, mediaType }
  if (typeof field.minLength === 'number' && Number.isSafeInteger(field.minLength)
    && field.minLength >= 0 && field.minLength <= 16384) form.minLength = field.minLength
  if (typeof field.maxLength === 'number' && Number.isSafeInteger(field.maxLength)
    && field.maxLength > 0 && field.maxLength <= 16384) form.maxLength = field.maxLength
  if (mediaType !== 'application/json' || field.contentSchema === undefined) return form
  form.structuredDeclared = true
  try { form.structured = parseMarketInputRule(field.contentSchema) } catch { return form }
  const content = record(field.contentSchema)
  if (content.type !== 'object' || content.additionalProperties !== false) return form
  const properties = record(content.properties)
  const required = content.required
  const keys = Object.keys(properties)
  if (!Array.isArray(required) || keys.length < 1 || keys.length > 8
    || required.length !== keys.length || keys.some(key => !required.includes(key))
    || keys.some(key => !/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key))) return form
  const constants: Record<string, string | number | boolean> = {}
  let variable: { field: string; minLength: number; maxLength: number; title: string } | null = null
  for (const key of keys) {
    const rule = record(properties[key])
    if (rule.const !== undefined) {
      if (typeof rule.const !== 'string' && typeof rule.const !== 'number'
        && typeof rule.const !== 'boolean') return form
      if (typeof rule.const === 'number' && !Number.isFinite(rule.const)) return form
      constants[key] = rule.const
    } else {
      if (variable !== null || rule.type !== 'string') return form
      const min = rule.minLength === undefined ? 1 : rule.minLength
      const max = rule.maxLength === undefined ? 8000 : rule.maxLength
      if (typeof min !== 'number' || typeof max !== 'number'
        || !Number.isSafeInteger(min) || !Number.isSafeInteger(max)
        || min < 1 || max < min || max > 8000) return form
      variable = { field: key, minLength: min, maxLength: max,
        title: typeof rule.title === 'string' && rule.title.length <= 80 ? rule.title : title }
    }
  }
  if (variable !== null) form.template = { ...variable, constants }
  return form
}

/** Fetch only local Host routes; never send a platform credential from the renderer. */
export function createMarketTaskTransport(fetchImpl: typeof fetch = fetch,
  baseUri = typeof document === 'undefined' ? 'http://127.0.0.1/' : document.baseURI): MarketTaskTransport {
  const quotes = new Map<string, MarketTaskQuote>()
  const planCapabilities = new Map<string, string>()
  // Retain every submission outcome so a missing response cannot cause a second paid POST.
  const submissions = new Map<string, Promise<string>>()
  const request = async (path: string, body: unknown, signal: AbortSignal,
    maxResponseBytes = 64 * 1024): Promise<unknown> => {
    const url = new URL(`/api/qianshou/compute/${path}`, baseUri)
    const response = await fetchImpl(url.toString(), {
      method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
      redirect: 'error', signal, headers: { accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    if (!response.ok) {
      const error = await response.json().catch(() => null) as unknown
      const detail = error !== null && typeof error === 'object' && !Array.isArray(error)
        ? (error as Record<string, unknown>).error : undefined
      const code = detail !== null && typeof detail === 'object' && !Array.isArray(detail)
        ? (detail as Record<string, unknown>).code : undefined
      throw new Error(typeof code === 'string' && /^[A-Z][A-Z0-9_]{2,100}$/u.test(code)
        ? code : 'MARKET_TASK_UNAVAILABLE')
    }
    const raw = await response.text()
    if (new TextEncoder().encode(raw).byteLength > maxResponseBytes) throw new Error('MARKET_TASK_INVALID_RESPONSE')
    try { return JSON.parse(raw) as unknown } catch { throw new Error('MARKET_TASK_INVALID_RESPONSE') }
  }
  return {
    async taskTypes(signal) {
      // A catalog contains many bounded contracts; the single-result limit is too small for it.
      const rows = await request('task-types', undefined, signal, 1024 * 1024)
      if (!Array.isArray(rows) || rows.length > 500) throw new Error('MARKET_TASK_INVALID_RESPONSE')
      return rows.map((raw) => {
        const row = record(raw)
        if (!Array.isArray(row.acceptedInputKinds) || !Array.isArray(row.requiredParams)
          || typeof row.canQuoteInline !== 'boolean') {
          throw new Error('MARKET_TASK_INVALID_RESPONSE')
        }
        const rawFields = paramsFields(row.paramsSchema)
        const canQuoteFiles = row.canQuoteFiles === true && row.formReady === true
          && row.acceptedInputKinds.includes('multi_file')
        const fields = rawFields.filter(field => !(canQuoteFiles && field.name === 'input_manifest'))
        const requiredParams = row.requiredParams.map(name => valueString(name, 64))
        const parsedInlineForm = inlineForm(row.inputSchema)
        const videoInput = row.reviewedVideoInput === undefined ? undefined
          : reviewedVideoInput(row.reviewedVideoInput)
        const publication = row.reviewedPublication === undefined ? undefined
          : reviewedPublication(row.reviewedPublication)
        if (videoInput !== undefined && row.capabilityId !== 'video.render') {
          throw new Error('MARKET_TASK_INVALID_RESPONSE')
        }
        if (videoInput !== undefined && publication !== undefined
          && videoInput.publicationId !== publication.publicationId) {
          throw new Error('MARKET_TASK_INVALID_RESPONSE')
        }
        return { taskType: valueString(row.taskType, 100),
          ...(row.capabilityId === undefined ? {} : { capabilityId: valueString(row.capabilityId, 100) }),
          acceptedInputKinds: row.acceptedInputKinds.map(kind => valueString(kind, 30)),
          requiredParams,
          canQuoteInline: row.canQuoteInline && row.formReady !== false
            && requiredParams.every(name => fields.some(field => field.name === name && field.required)),
          canQuoteFiles: canQuoteFiles && requiredParams.every(name => name === 'input_manifest'
            || fields.some(field => field.name === name && field.required)),
          paramFields: fields, ...(parsedInlineForm === undefined ? {} : { inlineForm: parsedInlineForm }),
          ...(videoInput === undefined ? {} : { reviewedVideoInput: videoInput }),
          ...(publication === undefined ? {} : { reviewedPublication: publication }) }
      })
    },
    async uploadInputFile(file, signal, purpose) {
      if (file.size < 1 || file.size > 16 * 1024 * 1024) throw new Error('COMPUTE_INPUT_UPLOAD_INVALID')
      const response = await fetchImpl(new URL('/api/qianshou/compute/files/upload', baseUri), {
        method: 'POST', credentials: 'same-origin', redirect: 'error', signal,
        headers: { 'content-type': file.type || 'application/octet-stream',
          'x-qianshou-filename': encodeURIComponent(file.name),
          ...(purpose === undefined ? {} : { 'x-qianshou-upload-purpose': purpose }) }, body: file,
      })
      if (!response.ok) throw new Error('COMPUTE_INPUT_UPLOAD_FAILED')
      const raw = await response.text()
      if (raw.length > 4096) throw new Error('MARKET_TASK_INVALID_RESPONSE')
      const row = marketInputFile(JSON.parse(raw) as unknown)
      const expectedFilename = purpose === 'reviewed-video-first-frame'
        ? (file.type === 'image/png' ? 'frame.png' : file.type === 'image/jpeg' ? 'frame.jpg' : '')
        : file.name
      const expectedKey = purpose === 'reviewed-video-first-frame'
        ? /^v8\/account-[1-9]\d*\/reviewed-video\/input\/[a-f0-9]{32}\/frame\.(?:png|jpg)$/u
        : /^v8\/account-[1-9]\d*\/developer\/[a-f0-9]{32}\/input\/[^/\\]+$/u
      if (row.filename !== expectedFilename || row.bytes !== file.size || typeof row.objectKey !== 'string'
        || !expectedKey.test(row.objectKey) || row.objectKey.split('/').at(-1) !== row.filename
        || typeof row.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(row.sha256)
        || row.contentType !== (file.type || 'application/octet-stream')) throw new Error('MARKET_TASK_INVALID_RESPONSE')
      return { filename: row.filename, bytes: file.size, objectKey: row.objectKey, sha256: row.sha256,
        contentType: file.type || 'application/octet-stream',
        ...(row.objectVersionId === undefined ? {} : { objectVersionId: valueString(row.objectVersionId, 200) }) }
    },
    async importComposerFiles(session, attachments, signal) {
      const rows = await request('files/from-composer', { sessionId: session.sessionId, attachments }, signal)
      if (!Array.isArray(rows) || rows.length !== attachments.length || rows.length < 1 || rows.length > 15) {
        throw new Error('MARKET_TASK_INVALID_RESPONSE')
      }
      const files = rows.map(marketInputFile)
      if (files.reduce((sum, file) => sum + file.bytes, 0) > 16 * 1024 * 1024
        || new Set(files.map(file => file.objectKey)).size !== files.length) throw new Error('MARKET_TASK_INVALID_RESPONSE')
      return files
    },
    async createPlan(taskType, goal, signal, params, files, expectedVideoReview, expectedProduct) {
      const row = record(await request('plans', { capabilityId: taskType, goal,
        budgetMinor: 0, currency: 'CNY', maxNodes: null, ...(params ? { params } : {}),
        ...(files === undefined ? {} : { fileInput: { kind: 'multi_file', files } }),
        ...(expectedVideoReview === undefined ? {} : { expectedVideoReview }),
        ...(expectedProduct === undefined ? {} : { expectedProduct }) }, signal))
      const id = valueString(row.id, 128)
      // The quote click approves only the local draft; this route cannot submit or charge.
      const approved = record(await request('plans/confirm', { id, decision: 'approved' }, signal))
      if (approved.id !== id || approved.authorization !== 'approved' || approved.workloadId !== null) {
        throw new Error('MARKET_TASK_INVALID_RESPONSE')
      }
      planCapabilities.set(id, taskType)
      return id
    },
    async quotePlan(planId, signal, expectedCapabilityId) {
      if (submissions.has(planId)) throw new Error('COMPUTE_SUBMISSION_UNKNOWN')
      quotes.delete(planId)
      const expected = planCapabilities.get(planId) ?? expectedCapabilityId
      if (expected === undefined || (expectedCapabilityId !== undefined && expected !== expectedCapabilityId)) {
        throw new Error('MARKET_TASK_INVALID_RESPONSE')
      }
      const row = record(await request('plans/quote', { id: planId }, signal))
      if (row.planId !== planId || row.capabilityId !== expected) throw new Error('MARKET_TASK_INVALID_RESPONSE')
      const amount = valueString(row.recommendedBudget, 32)
      if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(amount) || row.currency !== 'CNY'
        || typeof row.balanceEnough !== 'boolean') throw new Error('MARKET_TASK_INVALID_RESPONSE')
      if (typeof row.expiresAt !== 'number' || !Number.isSafeInteger(row.expiresAt) || row.expiresAt <= 0
        || row.expiresAt > 8_640_000_000_000) throw new Error('MARKET_TASK_INVALID_RESPONSE')
      const expiresAt = new Date(row.expiresAt * 1000).toISOString()
      if (Date.parse(expiresAt) <= Date.now()) throw new Error('COMPUTE_QUOTE_EXPIRED')
      const quoteId = valueString(row.quoteId, 32)
      if (!/^[a-f0-9]{32}$/u.test(quoteId)) throw new Error('MARKET_TASK_INVALID_RESPONSE')
      const [whole, fraction = ''] = amount.split('.')
      const view: MarketTaskQuote = { planId, capabilityId: expected, quoteId,
        taskType: valueString(row.taskType, 100), amountYuan: `${whole}.${fraction.padEnd(2, '0')}`, currency: 'CNY',
        balanceEnough: row.balanceEnough, expiresAt }
      quotes.set(planId, { ...view })
      return view
    },
    async confirmAndPublish(planId, quoteId, signal) {
      const prior = submissions.get(planId)
      if (prior !== undefined) return prior
      const quote = quotes.get(planId)
      if (quote === undefined || quote.quoteId !== quoteId) throw new Error('COMPUTE_QUOTE_CONFIRMATION_INVALID')
      if (Date.parse(quote.expiresAt) <= Date.now()) throw new Error('COMPUTE_QUOTE_EXPIRED')
      if (!quote.balanceEnough) throw new Error('COMPUTE_QUOTE_BALANCE_INSUFFICIENT')
      quotes.delete(planId)
      const submission = (async (): Promise<string> => {
        let raw: unknown
        try {
          raw = await request('plans/confirm-quoted', { id: planId, quoteId, amount: quote.amountYuan }, signal)
        } catch (error) {
          if (error instanceof Error && /^(?:COMPUTE|CORE|INVALID_COMPUTE)_[A-Z0-9_]{1,90}$/u.test(error.message)) throw error
          throw new Error('COMPUTE_SUBMISSION_UNKNOWN')
        }
        try {
          const row = record(raw)
          if (row.id !== planId) throw new Error('COMPUTE_SUBMISSION_UNKNOWN')
          return valueString(row.workloadId, 128)
        } catch { throw new Error('COMPUTE_SUBMISSION_UNKNOWN') }
      })()
      submissions.set(planId, submission)
      try { return await submission }
      catch (error) {
        // Host emits these only before its paid POST and before recording a
        // submission intent. A changed reviewed video needs a fresh plan.
        if (error instanceof Error && ['COMPUTE_VIDEO_REVIEW_CHANGED',
          'COMPUTE_VIDEO_MIXED_INPUT_INVALID', 'COMPUTE_VIDEO_REVIEW_UNEXPECTED'].includes(error.message)
          && submissions.get(planId) === submission) submissions.delete(planId)
        throw error
      }
    },
    async findWorkload(planId, signal) {
      const rows = await request('plans', undefined, signal)
      if (!Array.isArray(rows) || rows.length > 1000) throw new Error('MARKET_TASK_INVALID_RESPONSE')
      const row = rows.map(record).find(item => item.id === planId)
      if (!row || row.workloadId === null) return null
      return valueString(row.workloadId, 128)
    },
    async readWorkload(workloadId, signal) {
      const row = record(await request(`workload?id=${encodeURIComponent(workloadId)}`, undefined, signal))
      if (row.id !== workloadId || typeof row.resultAvailable !== 'boolean') {
        throw new Error('MARKET_TASK_INVALID_RESPONSE')
      }
      if (row.executionStage !== undefined && (typeof row.executionStage !== 'string'
        || !['waiting', 'executing', 'checking'].includes(row.executionStage))) {
        throw new Error('MARKET_TASK_INVALID_RESPONSE')
      }
      if (row.progress !== undefined && row.progress !== null && (typeof row.progress !== 'number'
        || !Number.isFinite(row.progress) || row.progress < 0 || row.progress > 1)) {
        throw new Error('MARKET_TASK_INVALID_RESPONSE')
      }
      if (row.createdAt !== undefined && (typeof row.createdAt !== 'string' || row.createdAt.length > 64
        || !/(?:Z|[+-]\d{2}:\d{2})$/u.test(row.createdAt) || !Number.isFinite(Date.parse(row.createdAt)))) {
        throw new Error('MARKET_TASK_INVALID_RESPONSE')
      }
      return { id: workloadId, status: valueString(row.status, 64), resultAvailable: row.resultAvailable,
        ...(row.progress === undefined ? {} : { progress: row.progress }),
        ...(row.createdAt === undefined ? {} : { createdAt: row.createdAt }),
        ...(row.executionStage === undefined ? {} : { executionStage: row.executionStage as NonNullable<MarketTaskWorkload['executionStage']> }) }
    },
    async readResult(workloadId, signal) {
      const row = record(await request(`workload/result?id=${encodeURIComponent(workloadId)}`, undefined, signal))
      if (row.id !== workloadId || (row.inlineOutput !== null && typeof row.inlineOutput !== 'string')
        || (row.artifactRef !== null && typeof row.artifactRef !== 'string')
        || (row.inlineOutput !== null && row.artifactRef !== null)) {
        throw new Error('MARKET_TASK_INVALID_RESPONSE')
      }
      return { id: workloadId, status: valueString(row.status, 64),
        inlineOutput: row.inlineOutput, artifactRef: row.artifactRef }
    },
    async readAcceptance(workloadId, signal) {
      const raw = await request(`workload/acceptance?id=${encodeURIComponent(workloadId)}`, undefined, signal)
      return raw === null ? null : acceptance(raw, workloadId)
    },
    async decideAcceptance(workloadId, decision, idempotencyKey, signal) {
      return acceptance(await request('workload/acceptance', {
        id: workloadId, decision, idempotencyKey,
      }, signal), workloadId)
    },
  }
}
