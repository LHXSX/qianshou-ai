/** Authenticated core reads and the observed developer-task create POST. */
import type { BrandedNumber } from '@deepseek-ai/dsh-brand'
import { createHash } from 'node:crypto'
import { MAX_PLAN_INPUT_BYTES, parsePlanFileInput, type PlanInputFile } from './plan-file-input.ts'
import { ComputeError } from './errors.ts'
import {
  DEVELOPER_TASK_CREATE_PATH,
  DEVELOPER_TASK_ESTIMATE_PATH,
  capabilityIdIfRegistered,
  developerTaskResultPath,
  type DeveloperTaskCreateBody,
  type DeveloperTaskEstimate,
  type DeveloperTaskType,
} from './developer-task.ts'
import { ComputeCapabilityId, ComputeWorkloadId, type ComputeCapability, type ComputePlanRequest,
  type ComputeWorkloadResult, type ComputeWorkloadSummary } from './protocol.ts'
import { isVideoArtifactResult, ownedVideoResultKind,
  parseOwnedWorkloadResult, parseWorkloadResult } from './workload-result.ts'
import { parseTaskFormMetadata } from './task-form.ts'
import { parseReviewedVideoTaskInput } from './reviewed-video-task-input.ts'
import { parseReviewedPublicationSelection } from './reviewed-publication-selection.ts'
import type { FormalMediaSpec } from './formal-media-protocol.ts'

/** Core account identity admitted from the authenticated me response. */
export type CoreAccountId = BrandedNumber<'qianshou-core-account-id'>

/** Host-side account display fields, without tokens, email, or financial records. */
export interface CoreAccountIdentity {
  accountId: CoreAccountId
  username: string
  role: string
  status: string
}

/** One owner-visible ledger row, exactly as the scheduler reports it. */
export interface CoreLedgerEntry {
  readonly id: string
  readonly type: string
  /** Decimal string in the ledger's own units, copied verbatim; never re-rounded here. */
  readonly amount: string
  /** Workload this row belongs to, or null for account-level rows. */
  readonly workloadId: string | null
  readonly note: string
  readonly createdAt: string
}

/** Sanitized, owner-scoped Shanghai execution facts for one worker. */
export interface CoreNodeDashboard {
  readonly schema: 'qianshou.node-dashboard.v1'
  readonly worker_id: string
  readonly history_scope: 'current_shard_assignment'
  readonly counts: {
    readonly executions: number
    readonly orders: number
    readonly succeeded: number
    readonly failed: number
    readonly cancelled: number
    readonly pending_resolution: number
    readonly avg_success_elapsed_ms: number | null
  }
  readonly earnings: { readonly currency: 'CNY'; readonly settled_node_compute: string }
  readonly plugin_calls: null
  readonly plugin_calls_note: string
  readonly total: number
  readonly limit: number
  readonly offset: number
  readonly items: readonly {
    readonly shard_id: string
    readonly workload_id: string
    readonly task_type: string
    readonly status: string
    readonly attempts: number
    readonly dispatched_at: string | null
    readonly started_at: string | null
    readonly completed_at: string | null
    readonly elapsed_ms: number | null
    readonly settled_node_compute_cny: string
  }[]
}

/** One name in Shanghai's live semantic registry, without node or order claims. */
export interface CoreRegistryCapability {
  readonly capability: string
  readonly implementations: readonly string[]
  readonly legacyTaskTypes: readonly string[]
}

/** Successful read of Shanghai's versioned semantic registry. */
export interface CoreCapabilityRegistry {
  readonly registryVersion: string
  readonly capabilities: readonly CoreRegistryCapability[]
}

/** Owner ledger tail. Bounded so one read cannot pull an unbounded account history. */
const LEDGER_PATH = '/api/v8/economy/ledger?limit=50'
const LEDGER_MAX_ROWS = 200
const MONEY = /^-?\d+(?:\.\d+)?$/u
/** 05/06 册原文：取不到就说这句话，不显示 0。 */
export const ACCOUNT_FIELD_MISSING = '上游没返回这一项'

function moneyOrNull(value: unknown): string | null {
  if (typeof value !== 'string' || value.length < 1 || value.length > 32 || !MONEY.test(value)) return null
  return value
}

/** Authenticated /me plus a balance string only when the core already emitted one. */
export interface CoreAccountView {
  readonly identity: CoreAccountIdentity
  /** Copied from /me when it is already a decimal string; never coerced from a number. */
  readonly balance: string | null
}

/** Owner-visible account facts. Missing money stays null; this object never invents a zero. */
export interface ComputeAccountSnapshot {
  readonly identity: CoreAccountIdentity | null
  readonly balance: string | null
  readonly balanceNote: string | null
  readonly rewards: string | null
  readonly rewardsNote: string | null
  readonly withdrawn: { readonly total: null; readonly rows: readonly CoreLedgerEntry[] }
  readonly withdrawnNote: string
  readonly ledger: readonly CoreLedgerEntry[] | null
  readonly ledgerNote: string | null
  readonly usageNote: string
}

/** Server-issued, short-lived quote for one exact workload spec. Token stays on the Host. */
export interface CoreExecutionQuote {
  readonly taskType: string
  readonly amountYuan: string
  readonly amountMinor: number
  readonly balanceEnough: boolean
  readonly priceBasis: string
  readonly quoteToken: string
  readonly expiresAt: string
}

/** A buyer's server-held result. Structural validity alone does not settle funds. */
export interface CoreBuyerAcceptance {
  readonly workloadId: string
  readonly status: 'pending_buyer' | 'accepted' | 'rejected'
  readonly workloadStatus: string
  readonly currency: 'CNY'
  readonly heldAmount: string
  readonly inlineOutput: unknown
  readonly contentSha256: string
  readonly outputKind: 'inline_json'
  readonly shardId: string
}

function parseBuyerAcceptance(value: unknown, workloadId: string): CoreBuyerAcceptance {
  const row = object(value)
  if (row.workload_id !== workloadId || !['pending_buyer', 'accepted', 'rejected'].includes(String(row.status))
    || row.currency !== 'CNY' || row.output_kind !== 'inline_json'
    || typeof row.held_amount !== 'string' || !/^(?:0|[1-9]\d{0,9})(?:\.\d{1,4})?$/u.test(row.held_amount)
    || typeof row.content_sha256 !== 'string' || !/^[0-9a-f]{64}$/u.test(row.content_sha256)
    || typeof row.shard_id !== 'string' || row.shard_id.length > 128) return invalidResponse()
  const encoded = JSON.stringify(row.inline_output)
  if (encoded === undefined || Buffer.byteLength(encoded) > 64 * 1024) return invalidResponse()
  return { workloadId, status: row.status as CoreBuyerAcceptance['status'],
    workloadStatus: text(row.workload_status, 64), currency: 'CNY',
    heldAmount: row.held_amount, inlineOutput: row.inline_output,
    contentSha256: row.content_sha256, outputKind: 'inline_json', shardId: row.shard_id }
}

/** Deployment-selected origin and complete-response bounds. */
export interface CoreClientConfig {
  baseUrl: string
  timeoutMs: number
  maxResponseBytes: number
  /** Exact deployment-trusted COS hostname. Missing keeps file uploads closed. */
  inputStorageHostname?: string
}

/**
 * Host credential lookup; return a raw access token or authorized API key, never refresh.
 * A Promise is allowed so a logged-in account session can hydrate or refresh before the request.
 */
export type CoreTokenProvider = () => string | undefined | Promise<string | undefined>

function isTokenPromise(value: string | undefined | Promise<string | undefined>): value is Promise<string | undefined> {
  return typeof value === 'object' && value !== null && typeof value.then === 'function'
}

/** Reject when the caller aborts while a credential Promise is still pending. */
async function tokenOrAbort(provided: Promise<string | undefined>, signal?: AbortSignal): Promise<string | undefined> {
  if (signal === undefined) return await provided
  if (signal.aborted) throw new ComputeError('CORE_REQUEST_ABORTED', 499)
  return await new Promise<string | undefined>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort)
      reject(new ComputeError('CORE_REQUEST_ABORTED', 499))
    }
    signal.addEventListener('abort', onAbort)
    provided.then(
      (value) => { signal.removeEventListener('abort', onAbort); resolve(value) },
      (error) => { signal.removeEventListener('abort', onAbort); reject(error) },
    )
  })
}

function invalidResponse(): never {
  throw new ComputeError('CORE_INVALID_RESPONSE', 502)
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalidResponse()
  return value as Record<string, unknown>
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    return invalidResponse()
  }
  return value
}

/** Parse bounded yuan strings as exact fen for response comparisons. */
function cnyFen(value: string): bigint | null {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/u.test(value)) return null
  const [whole = '', fraction = ''] = value.split('.')
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))
}

function workloadIdOrThrow(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(id) || id === '.' || id === '..') {
    throw new ComputeError('CORE_INVALID_WORKLOAD_ID')
  }
  return id
}

function capabilityIdOrThrow(id: string): string {
  if (!/^[A-Za-z0-9._-]{1,128}$/u.test(id) || id === '.' || id === '..' || id.includes('..')) {
    throw new ComputeError('CORE_INVALID_CAPABILITY_ID')
  }
  return id
}

function dashboardWorkerId(id: string): string {
  if (!/^[A-Za-z0-9._-]{6,128}$/u.test(id) || id.includes('..')) {
    throw new ComputeError('CORE_INVALID_WORKER_ID', 400)
  }
  return id
}

function nonNegativeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalidResponse()
  return value
}

function nullableInstant(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 64 || !/^\d{4}-\d{2}-\d{2}T/u.test(value)) return invalidResponse()
  return value
}

function nullableCount(value: unknown): number | null {
  return value === null ? null : nonNegativeInteger(value)
}

function parseNodeDashboard(value: unknown, workerId: string): CoreNodeDashboard {
  const body = object(value)
  if (body.schema !== 'qianshou.node-dashboard.v1' || body.worker_id !== workerId
    || body.history_scope !== 'current_shard_assignment' || body.plugin_calls !== null
    || !Array.isArray(body.items) || body.items.length > 100) return invalidResponse()
  const counts = object(body.counts)
  const earnings = object(body.earnings)
  const money = moneyOrNull(earnings.settled_node_compute)
  if (earnings.currency !== 'CNY' || money === null) return invalidResponse()
  const total = nonNegativeInteger(body.total)
  const limit = nonNegativeInteger(body.limit)
  const offset = nonNegativeInteger(body.offset)
  if (limit < 1 || limit > 100 || offset > 100_000 || body.items.length > limit) return invalidResponse()
  const items = body.items.map((value) => {
    const item = object(value)
    const income = moneyOrNull(item.settled_node_compute_cny)
    if (income === null) return invalidResponse()
    return {
      shard_id: text(item.shard_id, 128),
      workload_id: text(item.workload_id, 128),
      task_type: typeof item.task_type === 'string' && item.task_type.length <= 128 ? item.task_type : invalidResponse(),
      status: text(item.status, 32),
      attempts: nonNegativeInteger(item.attempts),
      dispatched_at: nullableInstant(item.dispatched_at),
      started_at: nullableInstant(item.started_at),
      completed_at: nullableInstant(item.completed_at),
      elapsed_ms: nullableCount(item.elapsed_ms),
      settled_node_compute_cny: income,
    }
  })
  return {
    schema: 'qianshou.node-dashboard.v1', worker_id: workerId, history_scope: 'current_shard_assignment',
    counts: {
      executions: nonNegativeInteger(counts.executions),
      orders: nonNegativeInteger(counts.orders),
      succeeded: nonNegativeInteger(counts.succeeded),
      failed: nonNegativeInteger(counts.failed),
      cancelled: nonNegativeInteger(counts.cancelled),
      pending_resolution: nonNegativeInteger(counts.pending_resolution),
      avg_success_elapsed_ms: nullableCount(counts.avg_success_elapsed_ms),
    },
    earnings: { currency: 'CNY', settled_node_compute: money },
    plugin_calls: null,
    plugin_calls_note: text(body.plugin_calls_note, 256),
    total, limit, offset, items,
  }
}

function countsByImpl(value: unknown): Record<string, number> {
  const row = object(value)
  const out: Record<string, number> = {}
  for (const [key, count] of Object.entries(row)) {
    text(key, 64)
    if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0) return invalidResponse()
    out[key] = count
  }
  return out
}

/** One worker the scheduler is willing to name for a capability; never a dispatch ranking. */
export interface CapabilityPoolProvide {
  readonly workerId: string
  readonly impl: string
  readonly availableNow: boolean
  readonly status: string
}

/** Registry reverse-lookup: catalog membership, declared ads, and currently available ads are independent. */
export interface CapabilityPoolSnapshot {
  readonly lookup: 'found' | 'not_in_registry' | 'unreachable'
  readonly capability: string
  readonly registryVersion: string | null
  readonly declared: { readonly count: number; readonly byImpl: Record<string, number> } | null
  readonly availableNow: { readonly count: number; readonly byImpl: Record<string, number>; readonly onlineTtlSeconds: number } | null
  readonly provides: readonly CapabilityPoolProvide[]
  readonly note: string
}

const POOL_NOT_IN_REGISTRY = '目录里没有这个能力名；不是池子里没人。'
const POOL_FOUND = '这是登记与在线声明，不是派单承诺。'
const POOL_PROVIDES_MAX = 50

function originFor(value: string): URL {
  let url: URL
  try { url = new URL(value) } catch { throw new ComputeError('CORE_INVALID_ORIGIN') }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/'
  ) throw new ComputeError('CORE_INVALID_ORIGIN')
  return url
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  const declared = response.headers.get('content-length')
  if (declared !== null && Number(declared) > maxBytes) throw new ComputeError('CORE_RESPONSE_TOO_LARGE', 502)
  if (!response.body) return invalidResponse()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const chunks: string[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes) throw new ComputeError('CORE_RESPONSE_TOO_LARGE', 502)
      chunks.push(decoder.decode(chunk.value, { stream: true }))
    }
    chunks.push(decoder.decode())
  } finally {
    reader.releaseLock()
  }
  try { return JSON.parse(chunks.join('')) as unknown } catch { return invalidResponse() }
}

async function readResearchPng(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'image/png'
    || declared === null || !/^[1-9][0-9]*$/u.test(declared) || Number(declared) > maxBytes
    || response.body === null) throw new ComputeError('CORE_RESPONSE_INVALID', 502)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > maxBytes || bytes > Number(declared)) throw new ComputeError('CORE_RESPONSE_TOO_LARGE', 502)
      chunks.push(chunk.value)
    }
    if (bytes !== Number(declared)) throw new ComputeError('CORE_RESPONSE_INVALID', 502)
    return Buffer.concat(chunks, bytes)
  } finally {
    await reader.cancel().catch(() => undefined)
    reader.releaseLock()
  }
}

/** Admit only known tariff failures from the estimate boundary; never relay upstream text. */
async function estimateTariffFailure(response: Response, maxBytes: number): Promise<string | null> {
  try {
    const raw = object(await readJson(response, Math.min(maxBytes, 4096)))
    const message = typeof raw.message === 'string' ? raw.message : raw.detail
    if (message === '当前任务尚未配置服务端价目，暂不能报价'
      || message === '已审核任务缺少人民币价目，不能报价'
      || message === '官方能力缺少人民币价目，不能报价') return 'COMPUTE_TASK_PRICING_UNAVAILABLE'
    if (message === '当前任务没有有效的正数服务端价格，暂不能报价'
      || message === '官方能力人民币价目必须为正数'
      || message === '人民币任务价目重复') return 'COMPUTE_TASK_PRICING_INVALID'
  } catch { /* Unknown or malformed error bodies retain the safe HTTP classification. */ }
  return null
}

/** Core identity, advertised capabilities, sanitized task progress, and developer-task create. */
export class QianshouCoreClient {
  private readonly origin: URL
  private readonly timeoutMs: number
  private readonly maxResponseBytes: number
  private readonly active = new Map<AbortController, Promise<unknown>>()
  private closed = false
  private readonly inputStorageHostname: string | undefined
  private readonly inputUploads = new Set<AbortController>()

  /** Create a client without making requests or reading credential files.
   * @param config - HTTPS origin, timeout, and response byte ceiling; loopback HTTP supports fixtures.
   * @param tokenProvider - Host-owned raw access-token/API-key lookup.
   * @param fetchImpl - Fetch implementation; defaults to the host implementation.
   */
  constructor(
    config: CoreClientConfig,
    private readonly tokenProvider: CoreTokenProvider,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {
    this.origin = originFor(config.baseUrl)
    if (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs < 1 || config.timeoutMs > 2_147_483_647) {
      throw new ComputeError('CORE_INVALID_TIMEOUT')
    }
    if (!Number.isSafeInteger(config.maxResponseBytes) || config.maxResponseBytes < 1) {
      throw new ComputeError('CORE_INVALID_RESPONSE_LIMIT')
    }
    this.timeoutMs = config.timeoutMs
    this.maxResponseBytes = config.maxResponseBytes
    this.inputStorageHostname = config.inputStorageHostname
  }

  /** Configured origin without credentials, path, or a live request.
   * @returns Scheme, host and port only.
   */
  originHref(): string {
    return this.origin.origin
  }

  /** Upload on the PC directly to trusted storage; Shanghai receives metadata only.
   * @param input - Bounded file bytes held by the local authenticated Host.
   * @param signal - Cancellation; neither failure nor upload creates a paid task.
   * @returns Only the completed account-owned upload reference, never a signed URL.
   */
  async uploadInputFile(input: { filename: string; contentType: string; bytes: Uint8Array },
    signal?: AbortSignal, purpose?: 'reviewed-video-first-frame'): Promise<PlanInputFile> {
    if (purpose === 'reviewed-video-first-frame') return this.uploadReviewedVideoFirstFrame(input, signal)
    if (purpose !== undefined) throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 400)
    if (!this.inputStorageHostname || !/^[a-z0-9][a-z0-9.-]{0,252}$/u.test(this.inputStorageHostname)
      || this.inputStorageHostname === this.origin.hostname) throw new ComputeError('COMPUTE_INPUT_UPLOAD_UNAVAILABLE', 409)
    if (this.closed) throw new ComputeError('CORE_CLIENT_CLOSED', 503)
    if (input.bytes.length < 1 || input.bytes.length > MAX_PLAN_INPUT_BYTES
      || !/^[^/\\\u0000-\u001f]{1,128}$/u.test(input.filename) || !input.filename.isWellFormed()
      || input.filename === '.' || input.filename === '..') throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 400)
    const controller = new AbortController()
    this.inputUploads.add(controller)
    const lifetime = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs),
      ...(signal === undefined ? [] : [signal])])
    try {
      const account = await this.getIdentity(lifetime)
      const bytes = Buffer.from(input.bytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const signed = object(await this.request('/api/v8/developer/files/upload-url', lifetime,
        { filename: input.filename, content_type: input.contentType, size_bytes: bytes.length, sha256 }))
      const file = parsePlanFileInput({ kind: 'multi_file', files: [{ objectKey: signed.object_key,
        filename: input.filename, bytes: bytes.length, sha256, contentType: input.contentType }] }).files[0]
      if (!file) invalidResponse()
      if (!file.objectKey.startsWith(`v8/account-${account.accountId}/`)
        || signed.method !== 'PUT' || typeof signed.upload_url !== 'string') invalidResponse()
      let url: URL
      try { url = new URL(signed.upload_url) } catch { return invalidResponse() }
      if (url.protocol !== 'https:' || url.hostname !== this.inputStorageHostname || url.port
        || url.username || url.password || url.hash || decodeURIComponent(url.pathname) !== '/' + file.objectKey) invalidResponse()
      const headers = new Headers()
      for (const [name, value] of Object.entries(object(signed.headers))) {
        if (typeof value !== 'string' || value.length > 2048 || /^(?:authorization|cookie|host|connection|transfer-encoding)$/iu.test(name)) invalidResponse()
        headers.set(name, value)
      }
      headers.set('content-type', input.contentType)
      if ((await this.getIdentity(lifetime)).accountId !== account.accountId) throw new ComputeError('COMPUTE_QUOTE_ACCOUNT_CHANGED', 409)
      const uploaded = await this.fetchImpl(url, { method: 'PUT', body: bytes, headers,
        credentials: 'omit', redirect: 'error', signal: lifetime })
      if (!uploaded.ok) throw new ComputeError('COMPUTE_INPUT_UPLOAD_FAILED', 502)
      await uploaded.body?.cancel()
      if ((await this.getIdentity(lifetime)).accountId !== account.accountId) throw new ComputeError('COMPUTE_QUOTE_ACCOUNT_CHANGED', 409)
      const completed = object(await this.request('/api/v8/developer/files/complete', lifetime,
        { object_key: file.objectKey, size_bytes: file.bytes, sha256, content_type: file.contentType }))
      if (completed.completed !== true || completed.object_key !== file.objectKey
        || completed.size_bytes !== file.bytes || completed.sha256 !== file.sha256) invalidResponse()
      lifetime.throwIfAborted()
      const result = parsePlanFileInput({ kind: 'multi_file', files: [{ ...file,
        ...(completed.object_version_id === null || completed.object_version_id === undefined
          ? {} : { objectVersionId: completed.object_version_id }) }] }).files[0]
      if (result === undefined) invalidResponse()
      return result
    } finally { this.inputUploads.delete(controller) }
  }

  /** Video frames use the independently versioned evidence bucket, never the ordinary input bucket. */
  private async uploadReviewedVideoFirstFrame(
    input: { filename: string; contentType: string; bytes: Uint8Array },
    signal?: AbortSignal,
  ): Promise<PlanInputFile> {
    if (this.closed) throw new ComputeError('CORE_CLIENT_CLOSED', 503)
    const extension = input.contentType === 'image/png' ? 'png'
      : input.contentType === 'image/jpeg' ? 'jpg' : null
    if (extension === null || input.bytes.length < 1 || input.bytes.length > MAX_PLAN_INPUT_BYTES
      || !/^[^/\\\u0000-\u001f]{1,128}$/u.test(input.filename) || !input.filename.isWellFormed()
      || (extension === 'png' ? !/\.png$/iu.test(input.filename) : !/\.jpe?g$/iu.test(input.filename))) {
      throw new ComputeError('COMPUTE_INPUT_UPLOAD_INVALID', 400)
    }
    const controller = new AbortController()
    this.inputUploads.add(controller)
    const lifetime = AbortSignal.any([controller.signal, AbortSignal.timeout(this.timeoutMs),
      ...(signal === undefined ? [] : [signal])])
    try {
      const account = await this.getIdentity(lifetime)
      const bytes = Buffer.from(input.bytes)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const contentMd5 = createHash('md5').update(bytes).digest('base64')
      const signed = object(await this.request('/api/v8/developer/video-input/upload-url', lifetime,
        { filename: input.filename, content_type: input.contentType, size_bytes: bytes.length,
          sha256, content_md5: contentMd5 }))
      const key = `v8/account-${account.accountId}/reviewed-video/input/`
      const filename = `frame.${extension}`
      if (typeof signed.object_key !== 'string'
        || !new RegExp(`^${key}[a-f0-9]{32}/${filename.replace('.', '\\.')}$`, 'u').test(signed.object_key)
        || signed.filename !== filename || typeof signed.bucket !== 'string'
        || !/^[a-z0-9][a-z0-9-]{2,127}$/u.test(signed.bucket)
        || signed.method !== 'PUT' || typeof signed.upload_url !== 'string'
        || typeof signed.upload_hostname !== 'string'
        || !/^[a-z0-9.-]{1,253}$/u.test(signed.upload_hostname)
        || typeof signed.upload_intent !== 'object' || signed.upload_intent === null) invalidResponse()
      const file = parsePlanFileInput({ kind: 'multi_file', files: [{ objectKey: signed.object_key,
        filename, bytes: bytes.length, sha256, contentType: input.contentType }] }).files[0]
      if (!file) invalidResponse()
      let url: URL
      try { url = new URL(signed.upload_url) } catch { return invalidResponse() }
      const baseHost = /^cos\.[a-z0-9-]+\.myqcloud\.com$/u
      const providerHost = signed.upload_hostname.startsWith(`${signed.bucket}.`)
        ? signed.upload_hostname.slice(signed.bucket.length + 1) : signed.upload_hostname
      let path: string
      try { path = decodeURIComponent(url.pathname) } catch { return invalidResponse() }
      const validVirtual = signed.upload_hostname === `${signed.bucket}.${providerHost}`
        && path === `/${file.objectKey}`
      const validPath = signed.upload_hostname === providerHost
        && path === `/${signed.bucket}/${file.objectKey}`
      if (url.protocol !== 'https:' || url.hostname !== signed.upload_hostname || url.port
        || url.username || url.password || url.hash || !url.search || !baseHost.test(providerHost)
        || (!validVirtual && !validPath)) invalidResponse()
      const headers = new Headers()
      const signedHeaders = object(signed.headers)
      const allowedHeaders = new Set(['content-type', 'content-md5', 'x-amz-checksum-sha256',
        'x-amz-object-lock-mode', 'x-amz-object-lock-retain-until-date', 'x-amz-meta-sha256'])
      for (const [name, value] of Object.entries(signedHeaders)) {
        if (!allowedHeaders.has(name.toLowerCase())
          || typeof value !== 'string' || value.length > 2048) invalidResponse()
        headers.set(name, value)
      }
      if (headers.get('content-type') !== input.contentType
        || headers.get('content-md5') !== contentMd5
        || headers.get('x-amz-checksum-sha256') !== createHash('sha256').update(bytes).digest('base64')
        || headers.get('x-amz-meta-sha256') !== sha256
        || headers.get('x-amz-object-lock-mode') !== 'COMPLIANCE'
        || !headers.has('x-amz-object-lock-retain-until-date')) invalidResponse()
      if ((await this.getIdentity(lifetime)).accountId !== account.accountId) throw new ComputeError('COMPUTE_QUOTE_ACCOUNT_CHANGED', 409)
      const uploaded = await this.fetchImpl(url, { method: 'PUT', body: bytes, headers,
        credentials: 'omit', redirect: 'error', signal: lifetime })
      if (!uploaded.ok) throw new ComputeError('COMPUTE_INPUT_UPLOAD_FAILED', 502)
      const cosVersion = uploaded.headers.get('x-cos-version-id')
      const s3Version = uploaded.headers.get('x-amz-version-id')
      await uploaded.body?.cancel()
      const version = cosVersion ?? s3Version
      if (version === null || (cosVersion && s3Version && cosVersion !== s3Version)
        || !/^[A-Za-z0-9_.~+-]{1,200}$/u.test(version) || version.toLowerCase() === 'null') invalidResponse()
      if ((await this.getIdentity(lifetime)).accountId !== account.accountId) throw new ComputeError('COMPUTE_QUOTE_ACCOUNT_CHANGED', 409)
      const completed = object(await this.request('/api/v8/developer/video-input/complete', lifetime,
        { upload_intent: signed.upload_intent, object_version_id: version }))
      if (completed.completed !== true || completed.bucket !== signed.bucket
        || completed.object_key !== file.objectKey || completed.object_version_id !== version
        || completed.filename !== filename || completed.size_bytes !== file.bytes
        || completed.sha256 !== sha256 || completed.content_type !== input.contentType) invalidResponse()
      lifetime.throwIfAborted()
      const result = parsePlanFileInput({ kind: 'multi_file', files: [{ ...file,
        objectVersionId: version }] }).files[0]
      if (!result) invalidResponse()
      return result
    } finally { this.inputUploads.delete(controller) }
  }

  private async request(path: string, callerSignal?: AbortSignal, body?: unknown, method?: 'GET' | 'POST' | 'DELETE',
    gateway?: { origin: URL; bearer?: string; contentType?: string; pngLimit?: number }): Promise<unknown> {
    if (this.closed) throw new ComputeError('CORE_CLIENT_CLOSED', 503)
    if (callerSignal?.aborted) throw new ComputeError('CORE_REQUEST_ABORTED', 499)
    let token: string | undefined
    try {
      const provided = gateway?.bearer ?? this.tokenProvider()
      token = isTokenPromise(provided) ? await tokenOrAbort(provided, callerSignal) : provided
    } catch (error) {
      if (error instanceof ComputeError) throw error
      throw new ComputeError('CORE_CREDENTIALS_UNAVAILABLE', 503)
    }
    if (this.closed) throw new ComputeError('CORE_CLIENT_CLOSED', 503)
    if (callerSignal?.aborted) throw new ComputeError('CORE_REQUEST_ABORTED', 499)
    if (!token) throw new ComputeError('CORE_CREDENTIALS_MISSING', 503)
    if (/\s/u.test(token)) throw new ComputeError('CORE_CREDENTIALS_INVALID', 503)

    const controller = new AbortController()
    const abort = () =>{  controller.abort(new ComputeError('CORE_REQUEST_ABORTED', 499)) }
    callerSignal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(
      () =>{  controller.abort(new ComputeError('CORE_REQUEST_TIMEOUT', 504)) },
      this.timeoutMs,
    )
    // The verb used to be implied by "has a body"; DELETE carries no body, so the
    // caller states it explicitly and GET/POST keep their previous meaning.
    const verb = method ?? (body !== undefined ? 'POST' : 'GET')
    const headers: Record<string, string> = { Authorization: 'Bearer ' + token,
      Accept: gateway?.pngLimit === undefined ? 'application/json' : 'image/png' }
    if (verb === 'POST') headers['Content-Type'] = gateway?.contentType ?? 'application/json'
    if (gateway?.contentType !== undefined && Buffer.isBuffer(body)) headers['Content-Length'] = String(body.length)
    const operation = Promise.resolve().then(async () => {
      try {
        controller.signal.throwIfAborted()
        const response = await this.fetchImpl(new URL(path, gateway?.origin ?? this.origin), {
          method: verb,
          headers,
          ...(verb === 'POST' ? { body: gateway?.contentType !== undefined && Buffer.isBuffer(body)
            ? new Uint8Array(body) : JSON.stringify(body) } : {}),
          redirect: 'error',
          signal: controller.signal,
        })
        if (!response.ok) {
          if (path === DEVELOPER_TASK_ESTIMATE_PATH && response.status === 400) {
            const code = await estimateTariffFailure(response, this.maxResponseBytes)
            if (code !== null) throw new ComputeError(code, 400)
          }
          const localStatus = [401, 403, 404, 409, 422, 429].includes(response.status) ? response.status : 502
          throw new ComputeError(`CORE_HTTP_${response.status}`, localStatus)
        }
        if (gateway?.pngLimit !== undefined) return await readResearchPng(response, gateway.pngLimit)
        return await readJson(response, this.maxResponseBytes)
      } catch (error) {
        if (error instanceof ComputeError) throw error
        if (controller.signal.aborted && controller.signal.reason instanceof ComputeError) {
          throw controller.signal.reason
        }
        throw new ComputeError('CORE_UNAVAILABLE', 502)
      } finally {
        clearTimeout(timer)
        callerSignal?.removeEventListener('abort', abort)
        controller.abort()
        this.active.delete(controller)
      }
    })
    this.active.set(controller, operation)
    return operation
  }

  /** Read the official media directory through the existing authenticated control carrier.
   * @param signal - Caller cancellation.
   * @returns Wire metadata for the formal media parser; no media bytes.
   */
  mediaProfiles(signal?: AbortSignal): Promise<unknown> {
    return this.request('/api/v8/economy/media-profiles', signal)
  }

  /** Request an exact official media quote without creating a workload.
   * @param spec - Host-admitted ten-field media input and task type.
   * @param signal - Caller cancellation.
   * @returns Quote fields including a Host-private confirmation token.
   */
  estimateMediaTask(spec: FormalMediaSpec, signal?: AbortSignal): Promise<unknown> {
    return this.request('/api/v8/economy/estimate', signal, { spec })
  }

  /** Submit only a freshly confirmed formal quote with a stable owner request identifier.
   * @param body - Exact quoted specification, amount and private quote token.
   * @param signal - Caller cancellation; an interrupted response remains unknown.
   * @returns Shanghai's created or idempotently recovered workload fields.
   */
  submitMediaTask(body: { name: string; spec: FormalMediaSpec; budget: string; quote_token: string; request_id: string },
    signal?: AbortSignal): Promise<unknown> {
    return this.request('/api/v8/workloads', signal, body)
  }

  /** Query an owner's formal task or stable request identifier; this method never submits.
   * @param locator - Task identity or request UUID supplied by the Host route.
   * @param signal - Caller cancellation.
   * @returns Authoritative state, settlement and a private Guangzhou viewer receipt.
   */
  readMediaTask(locator: { taskId: string } | { requestId: string }, signal?: AbortSignal): Promise<unknown> {
    return this.request('taskId' in locator ? `/api/v8/media/tasks/${encodeURIComponent(workloadIdOrThrow(locator.taskId))}`
      : `/api/v8/media/tasks?request_id=${encodeURIComponent(locator.requestId)}`, signal)
  }

  /** Submit one explicitly requested, free, same-owner fixed image trial to Shanghai.
   * @param request - Stable request UUID and original prompt; no machine selection or media bytes.
   * @param ownerId - Persisted owner of the original request, verified with the exact credential used to submit.
   * @param signal - Cancellation; an interrupted response permits only the original GET.
   * @returns Shanghai's bounded research task metadata.
   */
  submitResearchImageTask(request: { requestId: string; mode: 'image'; input: { prompt: string } },
    ownerId: CoreAccountId, signal?: AbortSignal): Promise<unknown> {
    return this.researchBearer(ownerId, signal).then(bearer =>
      this.request('/api/v8/media/research/tasks', signal, request, 'POST', { origin: this.origin, bearer }))
  }

  /** Read the original owner request without spending another submission right.
   * @param requestId - Original canonical request UUID retained before submission.
   * @param ownerId - Persisted owner of the original request.
   * @param signal - Caller cancellation.
   * @returns Authoritative research task metadata; never media bytes.
   */
  readResearchImageTask(requestId: string, ownerId: CoreAccountId, signal?: AbortSignal): Promise<unknown> {
    return this.researchBearer(ownerId, signal).then(bearer =>
      this.request(`/api/v8/media/research/tasks?request_id=${encodeURIComponent(requestId)}`, signal,
        undefined, 'GET', { origin: this.origin, bearer }))
  }

  /** Read the original PNG directly from the deployment-trusted Guangzhou origin.
   * @param origin - Exact operator-configured HTTPS origin.
   * @param locator - Immutable original task and attempt UUIDs, validated by the Host ledger.
   * @param ownerId - Persisted owner whose captured credential authorizes this delivery.
   * @param signal - Caller cancellation; this GET cannot start generation.
   * @returns Bounded PNG bytes; credentials stay in the Host.
   */
  async readResearchImageResult(origin: URL, locator: { taskId: string; attemptId: string },
    ownerId: CoreAccountId, signal?: AbortSignal): Promise<Buffer> {
    const bearer = await this.researchBearer(ownerId, signal)
    const result = await this.request(`/v1/media/research/result?taskId=${encodeURIComponent(locator.taskId)}&attemptId=${encodeURIComponent(locator.attemptId)}`,
      signal, undefined, 'GET', { origin, bearer, pngLimit: 16 * 1024 * 1024 })
    if (!Buffer.isBuffer(result)) return invalidResponse()
    return result
  }

  private async researchBearer(ownerId: CoreAccountId, signal?: AbortSignal): Promise<string> {
    // Verify and use the same captured credential; a later token lookup must never change the POST's owner.
    const lookup = async (): Promise<string | undefined> => {
      try {
        const provided = this.tokenProvider()
        return isTokenPromise(provided) ? await tokenOrAbort(provided, signal) : provided
      } catch (error) {
        if (error instanceof ComputeError) throw error
        throw new ComputeError('CORE_CREDENTIALS_UNAVAILABLE', 503)
      }
    }
    const bearer = await lookup()
    if (!bearer || /\s/u.test(bearer)) throw new ComputeError('CORE_CREDENTIALS_MISSING', 503)
    const body = object(await this.request('/api/v8/auth/me', signal, undefined, 'GET', { origin: this.origin, bearer }))
    if (body.ok !== true || object(body.account).id !== ownerId) throw new ComputeError('IMAGE_TRIAL_ACCOUNT_CHANGED', 403)
    if (await lookup() !== bearer) {
      throw new ComputeError('IMAGE_TRIAL_ACCOUNT_CHANGED', 403)
    }
    return bearer
  }

  /** Verify the retained owner and discard an identity reply that outlived its credential.
   * @param ownerId - Persisted owner of the original research request.
   * @param signal - Caller cancellation.
   * @returns No credential or identity data; success authorizes returning this owner's retained result.
   */
  async assertResearchOwner(ownerId: CoreAccountId, signal?: AbortSignal): Promise<void> {
    await this.researchBearer(ownerId, signal)
  }

  /** Send actor-scoped assets directly to the deployment-trusted Guangzhou origin.
   * @param origin - Origin admitted by the formal media Config validator.
   * @param action - Closed public operation; no COS or service credentials are exposed.
   * @param body - Ticket/status metadata or validated image bytes.
   * @param signal - Caller cancellation; interrupted uploads remain unknown.
   * @param upload - Host-private upload grant and exact image MIME, required for upload.
   * @returns Bounded Guangzhou registration metadata.
   */
  mediaAssetRequest(origin: URL, action: 'ticket' | 'status' | 'upload', body: unknown, signal: AbortSignal,
    upload?: { token: string; contentType: 'image/png' | 'image/jpeg' }): Promise<unknown> {
    if ((action === 'upload') !== (upload !== undefined)) throw new ComputeError('COMPUTE_MEDIA_ASSET_INVALID', 400)
    return this.request(`/v1/media/assets/${action}`, signal, body, 'POST', { origin,
      ...(upload === undefined ? {} : { bearer: upload.token, contentType: upload.contentType }) })
  }

  /** Read only account display fields from the authenticated account.
   * @param signal - Optional caller cancellation.
   * @returns Account identity without credentials or unrelated profile fields.
   */
  async getIdentity(signal?: AbortSignal): Promise<CoreAccountIdentity> {
    return (await this.getAccountView(signal)).identity
  }

  /** Read /me identity and copy a decimal-string balance only. Numbers are treated as missing.
   * @param signal - Optional caller cancellation.
   * @returns Display identity plus `balance` or null; never a coerced or summed figure.
   */
  async getAccountView(signal?: AbortSignal): Promise<CoreAccountView> {
    const body = object(await this.request('/api/v8/auth/me', signal))
    if (body.ok !== true) return invalidResponse()
    const account = object(body.account)
    if (typeof account.id !== 'number' || !Number.isSafeInteger(account.id) || account.id < 1) return invalidResponse()
    return {
      identity: {
        accountId: account.id as CoreAccountId,
        username: text(account.username, 255),
        role: text(account.role, 64),
        status: text(account.status, 64),
      },
      balance: moneyOrNull(account.balance),
    }
  }

  /** Read advertised developer tasks. Available means requestable in the catalogue, not online nodes.
   * @param signal - Optional caller cancellation.
   * @returns Semantic capability rows with no fabricated node count, version, or price.
   *   Known aliases collapse to one semantic row; newly reviewed task types
   *   remain visible verbatim without a desktop registry release.
   */
  async getCapabilities(signal?: AbortSignal): Promise<ComputeCapability[]> {
    const body = object(await this.request('/api/v8/developer/task-types', signal))
    if (body.ok !== true || !Array.isArray(body.items)) return invalidResponse()
    const seen = new Set<string>()
    const items: ComputeCapability[] = []
    for (const value of body.items) {
      const item = object(value)
      const taskType = text(item.task_type, 128)
      if (typeof item.description !== 'string' || item.description.length > 8_000) return invalidResponse()
      const id = capabilityIdIfRegistered(taskType) ?? ComputeCapabilityId(taskType)
      if (seen.has(id)) continue
      seen.add(id)
      items.push({
        id: ComputeCapabilityId(id),
        name: id,
        description: item.description,
        delivery: 'remote',
        available: true,
      })
    }
    return items
  }

  /** Read a task's progress while discarding task inputs and result contents.
   * @param id - Core-issued workload identity; never interpreted as a path.
   * @param signal - Optional caller cancellation.
   * @returns Progress and result visibility for exactly the requested workload.
   */
  async getWorkload(id: string, signal?: AbortSignal): Promise<ComputeWorkloadSummary> {
    const workloadId = workloadIdOrThrow(id)
    const item = object(await this.request('/api/v8/workloads/' + encodeURIComponent(workloadId), signal))
    if (item.id !== workloadId) return invalidResponse()
    const status = text(item.status, 64)
    const progress = item.progress
    if (progress !== null && (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1)) return invalidResponse()
    if (item.result !== null) object(item.result)
    let createdAt: string | undefined
    if (item.created_at !== undefined) {
      const raw = text(item.created_at, 64)
      // The central API also emits naive UTC datetimes. Qualify them before the
      // browser can interpret them in the user's local timezone.
      const instant = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/u.test(raw) ? raw : `${raw}Z`)
      if (!Number.isFinite(instant) || instant <= 0) return invalidResponse()
      createdAt = new Date(instant).toISOString()
    }
    const executionStage = status === 'RUNNING' ? await this.executionStage(workloadId, signal) : undefined
    return {
      id: ComputeWorkloadId(workloadId),
      status,
      progress,
      resultAvailable: status === 'DONE' && item.result !== null,
      ...(createdAt === undefined ? {} : { createdAt }),
      ...(executionStage === undefined ? {} : { executionStage }),
    }
  }

  private async executionStage(workloadId: string, signal?: AbortSignal): Promise<ComputeWorkloadSummary['executionStage']> {
    let observed: unknown
    try {
      observed = await this.request('/api/v8/workloads/' + encodeURIComponent(workloadId) + '/shards', signal)
    } catch (error) {
      // Shard detail is supplementary. A missing receipt cannot establish that
      // execution started, and cannot erase the valid parent task observation.
      if (signal?.aborted) throw error
      return undefined
    }
    if (observed === null || typeof observed !== 'object' || Array.isArray(observed)) return undefined
    const detail = observed as Record<string, unknown>
    if (detail.workload_id !== workloadId || detail.workload_status !== 'RUNNING'
      || !Array.isArray(detail.shards) || detail.shards.length > 10_000) return undefined
    const shards: Array<{ status: string; started: boolean }> = []
    for (const value of detail.shards) {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
      const row = value as Record<string, unknown>
      if (typeof row.status !== 'string' || row.status.length > 64) return undefined
      // started_at is also written by optimistic dispatch. Only a persisted
      // progress receipt comes from the current worker/attempt acknowledgement.
      shards.push({ status: row.status, started: typeof row.progress_at === 'string'
        && Number.isFinite(Date.parse(row.progress_at)) })
    }
    if (shards.some(row => row.status === 'RUNNING' && row.started)) return 'executing'
    if (shards.length > 0 && shards.every(row => ['DONE', 'SUCCEEDED', 'COMPLETED'].includes(row.status))) return 'checking'
    if (shards.length === 0 || shards.every(row => ['PENDING', 'DISPATCHED', 'LEASED'].includes(row.status))) return 'waiting'
    return undefined
  }

  /** Read one owner's node ledger and content-free execution rows from Shanghai. */
  async getNodeDashboard(workerId: string, offset = 0, signal?: AbortSignal): Promise<CoreNodeDashboard> {
    const id = dashboardWorkerId(workerId)
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
      throw new ComputeError('CORE_INVALID_DASHBOARD_OFFSET', 400)
    }
    const path = `/api/v8/workers/${encodeURIComponent(id)}/dashboard?limit=20&offset=${String(offset)}`
    return parseNodeDashboard(await this.request(path, signal), id)
  }

  /** Read owner-visible output. Ordinary media orders use the owner workload detail
   * after the developer-task result route returns a definite 404. Never GETs `/download`.
   * @param id - Core-issued workload identity; never interpreted as a path.
   * @param signal - Optional caller cancellation.
   * @returns Inline text or an artifact reference, never both, and never settlement.
   */
  async getWorkloadResult(id: string, signal?: AbortSignal): Promise<ComputeWorkloadResult> {
    const workloadId = workloadIdOrThrow(id)
    let developerBody: unknown
    try {
      developerBody = await this.request(developerTaskResultPath(workloadId), signal)
    } catch (error) {
      if (!(error instanceof ComputeError && error.code === 'CORE_HTTP_404')) throw error
      const ownerBody = await this.request(`/api/v8/workloads/${encodeURIComponent(workloadId)}`, signal)
      const result = parseOwnedWorkloadResult(workloadId, ownerBody, this.maxResponseBytes)
      return this.admitVideoResult(workloadId, result, ownerBody, signal)
    }
    const result = parseWorkloadResult(workloadId, developerBody, this.maxResponseBytes)
    return this.admitVideoResult(workloadId, result, undefined, signal)
  }

  private async admitVideoResult(id: string, result: ComputeWorkloadResult,
    ownerBody: unknown | undefined, signal?: AbortSignal): Promise<ComputeWorkloadResult> {
    if (!isVideoArtifactResult(result)) return result
    let detail: unknown
    let accountId: number
    try {
      detail = ownerBody ?? await this.request(`/api/v8/workloads/${encodeURIComponent(id)}`, signal)
      accountId = (await this.getIdentity(signal)).accountId
    } catch {
      signal?.throwIfAborted()
      throw new ComputeError('CORE_VIDEO_RESULT_UNVERIFIED', 502)
    }
    const kind = ownedVideoResultKind(id, detail, accountId, result.status)
    if (kind === 'ordinary') return result
    // A reviewed order's deliverable is one exact, completed MP4 media reference.
    // Do not return a non-MP4 URL or a raw manifest for the model to re-link.
    if (result.status !== 'DONE'
      || !/^qianshou-media:\/\/task\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}\/[a-f0-9]{64}\.mp4$/u.test(result.artifactRef ?? '')) {
      throw new ComputeError('CORE_REVIEWED_VIDEO_RESULT_INVALID', 502)
    }
    const ownerResult = parseOwnedWorkloadResult(id, detail, this.maxResponseBytes)
    if (ownerResult.status !== result.status || ownerResult.artifactRef !== result.artifactRef) {
      throw new ComputeError('CORE_REVIEWED_VIDEO_RESULT_INVALID', 502)
    }
    return result
  }

  /** Only a task owner may see or decide a structurally validated result. */
  async getBuyerAcceptance(id: string, signal?: AbortSignal): Promise<CoreBuyerAcceptance | null> {
    const workloadId = workloadIdOrThrow(id)
    try {
      return parseBuyerAcceptance(await this.request(
        `/api/v8/workloads/${encodeURIComponent(workloadId)}/acceptance`, signal), workloadId)
    } catch (error) {
      if (error instanceof ComputeError && error.code === 'CORE_HTTP_404') return null
      throw error
    }
  }

  async decideBuyerAcceptance(id: string, decision: 'accept' | 'reject',
    idempotencyKey: string, signal?: AbortSignal): Promise<CoreBuyerAcceptance> {
    const workloadId = workloadIdOrThrow(id)
    if (!/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(idempotencyKey)) {
      throw new ComputeError('COMPUTE_ACCEPTANCE_REQUEST_INVALID', 400)
    }
    const receipt = parseBuyerAcceptance(await this.request(
      `/api/v8/workloads/${encodeURIComponent(workloadId)}/acceptance`, signal,
      { decision, idempotency_key: idempotencyKey }), workloadId)
    if (receipt.status !== (decision === 'accept' ? 'accepted' : 'rejected')) {
      throw new ComputeError('CORE_ACCEPTANCE_UNCONFIRMED', 502)
    }
    return receipt
  }

  /** Ask the scheduler to cancel one owner workload.
   *
   * The scheduler owns the decision, so this method does not pre-judge it: a live workload answers
   * `status: CANCELLED`, and an already-terminal one answers 400 — which the transport surfaces as
   * `CORE_HTTP_400`. Policy on top of that (idempotent repeat, explicit refusal for a finished task)
   * belongs to the caller, not to the wire.
   * @param id - Core-issued workload identity; never interpreted as a path.
   * @param signal - Optional caller cancellation.
   * @returns The workload identity and the status the scheduler now reports.
   */
  async cancelWorkload(id: string, signal?: AbortSignal): Promise<{ id: ComputeWorkloadId; status: string }> {
    const workloadId = workloadIdOrThrow(id)
    const item = object(await this.request('/api/v8/workloads/' + encodeURIComponent(workloadId), signal, undefined, 'DELETE'))
    if (item.id !== workloadId) return invalidResponse()
    return { id: ComputeWorkloadId(workloadId), status: text(item.status, 64) }
  }

  /** Read the owner's ledger tail, newest first.
   *
   * Why cancellation reads it: the refund for a cancelled workload is written to the ledger in the
   * same second that the account balance projection still shows the old figure (AT-03), so the
   * ledger is the only honest evidence a caller can be handed about what was really refunded.
   * @param signal - Optional caller cancellation.
   * @returns Bounded ledger rows with no computed balance, total, or price.
   */
  async getLedger(signal?: AbortSignal): Promise<readonly CoreLedgerEntry[]> {
    const body = object(await this.request(LEDGER_PATH, signal))
    if (body.ok !== true || !Array.isArray(body.items)) return invalidResponse()
    return body.items.slice(0, LEDGER_MAX_ROWS).map((value) => {
      const item = object(value)
      return Object.freeze({
        id: text(item.id, 128),
        type: text(item.type, 64),
        amount: text(item.amount, 32),
        workloadId: typeof item.workload_id === 'string' && item.workload_id.length > 0 ? item.workload_id : null,
        note: typeof item.note === 'string' ? item.note.slice(0, 512) : '',
        createdAt: typeof item.created_at === 'string' ? item.created_at : '',
      })
    })
  }

  /** Read who currently declares one contract capability. A missing name is not an empty pool.
   * @param capability - Contract capability id or recorded platform `task_type`; never a path.
   * @param signal - Optional caller cancellation.
   * @returns Catalog membership, declared counts, and available-now counts as separate facts.
   */
  async getCapabilityWorkers(capability: string, signal?: AbortSignal): Promise<CapabilityPoolSnapshot> {
    const raw = capabilityIdOrThrow(capability)
    // Keep known legacy task-type aliases, but let Shanghai decide whether a new
    // plugin capability belongs to its current registry. The bundled map cannot
    // know capabilities approved after this PC build was released.
    const id = capabilityIdIfRegistered(raw) ?? raw
    const path = '/api/v8/capabilities/' + encodeURIComponent(id) + '/workers'
    let body: Record<string, unknown>
    try {
      body = object(await this.request(path, signal))
    } catch (error) {
      if (error instanceof ComputeError && error.code === 'CORE_HTTP_404') {
        return {
          lookup: 'not_in_registry',
          capability: id,
          registryVersion: null,
          declared: null,
          availableNow: null,
          provides: [],
          note: POOL_NOT_IN_REGISTRY,
        }
      }
      throw error
    }
    if (body.found !== true || body.capability !== id) return invalidResponse()
    const declared = object(body.declared)
    const available = object(body.available_now)
    if (typeof declared.count !== 'number' || !Number.isSafeInteger(declared.count) || declared.count < 0) {
      return invalidResponse()
    }
    if (typeof available.count !== 'number' || !Number.isSafeInteger(available.count) || available.count < 0) {
      return invalidResponse()
    }
    if (typeof available.online_ttl_seconds !== 'number' || !Number.isSafeInteger(available.online_ttl_seconds) || available.online_ttl_seconds < 0) {
      return invalidResponse()
    }
    if (!Array.isArray(body.provides)) return invalidResponse()
    const provides = body.provides.slice(0, POOL_PROVIDES_MAX).map((value) => {
      const item = object(value)
      return {
        workerId: text(item.worker_id, 128),
        impl: text(item.impl, 64),
        availableNow: item.available_now === true,
        status: text(item.status, 64),
      }
    })
    return {
      lookup: 'found',
      capability: id,
      registryVersion: typeof body.registry_version === 'string' ? text(body.registry_version, 64) : null,
      declared: { count: declared.count, byImpl: countsByImpl(declared.by_impl) },
      availableNow: {
        count: available.count,
        byImpl: countsByImpl(available.by_impl),
        onlineTtlSeconds: available.online_ttl_seconds,
      },
      provides,
      note: POOL_FOUND,
    }
  }

  /** Read all current semantic capability names without the PC's bundled alias map.
   * Registry membership is separate from requestable task types, node health, quotes and dispatch.
   * @param signal - Optional caller cancellation.
   * @returns Bounded registry entries and its server version, with no credentials or node identities.
   */
  async getCapabilityRegistry(signal?: AbortSignal): Promise<CoreCapabilityRegistry> {
    const body = object(await this.request('/api/v8/capabilities', signal))
    const registryVersion = text(body.registry_version, 128)
    if (!Array.isArray(body.capabilities) || body.capabilities.length > 5_000) return invalidResponse()
    const seen = new Set<string>()
    const capabilities = body.capabilities.map((value): CoreRegistryCapability => {
      const item = object(value)
      const capability = text(item.capability, 128)
      if (!/^[A-Za-z0-9._-]{1,128}$/u.test(capability) || capability === '.' || capability === '..'
        || capability.includes('..') || seen.has(capability)) return invalidResponse()
      seen.add(capability)
      if (!Array.isArray(item.implementations) || item.implementations.length > 128
        || !Array.isArray(item.legacy_task_types) || item.legacy_task_types.length > 128) return invalidResponse()
      const implementations = item.implementations.map(value => text(value, 256))
      const legacyTaskTypes = item.legacy_task_types.map((value) => {
        const name = text(value, 128)
        if (!/^[A-Za-z0-9._-]{1,128}$/u.test(name) || name.includes('..')) return invalidResponse()
        return name
      })
      return { capability, implementations, legacyTaskTypes }
    })
    return { registryVersion, capabilities }
  }

  /** Whether the contract registry currently lists this capability. Unknown when the list cannot be read.
   * @param capability - Contract capability id; never a path.
   * @param signal - Optional caller cancellation.
   * @returns True or false from a successful list, or null when the scheduler did not answer.
   */
  async registryContains(capability: string, signal?: AbortSignal): Promise<boolean | null> {
    const raw = capabilityIdOrThrow(capability)
    const id = capabilityIdIfRegistered(raw) ?? raw
    try {
      const body = object(await this.request('/api/v8/capabilities', signal))
      // Shanghai's list route returns registry_version + capabilities, not the
      // developer-task catalogue's ok + items shape. A malformed or unreachable
      // list cannot prove absence.
      text(body.registry_version, 128)
      if (!Array.isArray(body.capabilities) || body.capabilities.length > 5_000) return null
      let found = false
      for (const value of body.capabilities) {
        if (text(object(value).capability, 128) === id) found = true
      }
      return found
    } catch (error) {
      if (error instanceof ComputeError && error.code === 'CORE_INVALID_CAPABILITY_ID') throw error
      return null
    }
  }

  /** Read developer-task input kinds used to build a legal create body.
   * @param signal - Optional caller cancellation.
   * @returns Catalogue rows with accepted input kinds; available display fields stay on {@link getCapabilities}.
   */
  async getDeveloperTaskTypes(signal?: AbortSignal): Promise<DeveloperTaskType[]> {
    const body = object(await this.request('/api/v8/developer/task-types', signal))
    if (body.ok !== true || !Array.isArray(body.items) || body.items.length > 5_000) return invalidResponse()
    const seen = new Set<string>()
    return body.items.map((value) => {
      const item = object(value)
      const taskType = text(item.task_type, 128)
      if (seen.has(taskType)) return invalidResponse()
      seen.add(taskType)
      if (!Array.isArray(item.accepted_input_kinds) || item.accepted_input_kinds.length > 32
        || typeof item.default_input_kind !== 'string') return invalidResponse()
      const acceptedInputKinds = item.accepted_input_kinds.map(kind => text(kind, 30))
      const defaultInputKind = text(item.default_input_kind, 30)
      if (acceptedInputKinds.length < 1) return invalidResponse()
      const registeredCapabilityId = capabilityIdIfRegistered(taskType)
      const declaredCapabilityId = item.capability_id === undefined ? undefined
        : text(item.capability_id, 100)
      if (declaredCapabilityId !== undefined
        && (!/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/u.test(declaredCapabilityId)
          || registeredCapabilityId !== undefined && declaredCapabilityId !== registeredCapabilityId)) {
        return invalidResponse()
      }
      const capabilityId = declaredCapabilityId === undefined ? registeredCapabilityId
        : ComputeCapabilityId(declaredCapabilityId)
      let reviewedVideoInput
      if (item.reviewed_video_input !== undefined) {
        if (capabilityId !== 'video.render') return invalidResponse()
        try { reviewedVideoInput = parseReviewedVideoTaskInput(item.reviewed_video_input, taskType) }
        catch { return invalidResponse() }
      }
      let reviewedPublication
      if (item.reviewed_publication !== undefined) {
        try { reviewedPublication = parseReviewedPublicationSelection(item.reviewed_publication) }
        catch { return invalidResponse() }
      }
      if (reviewedVideoInput !== undefined && reviewedPublication !== undefined
        && reviewedVideoInput.publicationId !== reviewedPublication.publication_id) return invalidResponse()
      const runtimes = Array.isArray(item.runtimes) ? item.runtimes.map(runtime => text(runtime, 64)) : []
      const description = typeof item.description === 'string' && item.description.length <= 8_000 ? item.description : ''
      const category = typeof item.category === 'string' && item.category.length <= 64 ? item.category : ''
      const requiredParams = Array.isArray(item.required_params)
        ? item.required_params.map(param => text(param, 128)) : null
      return { taskType, acceptedInputKinds, defaultInputKind, runtimes, description, category,
        requiredParams, ...parseTaskFormMetadata(item),
        ...(capabilityId === undefined ? {} : { capabilityId }),
        ...(reviewedVideoInput === undefined ? {} : { reviewedVideoInput }),
        ...(reviewedPublication === undefined ? {} : { reviewedPublication }) }
    })
  }

  /** Recheck the public listing before plan, quote and submission; only Shanghai can lock it. */
  async assertSelectedProduct(selection: NonNullable<ComputePlanRequest['expectedProduct']>,
    taskType: string, signal?: AbortSignal): Promise<void> {
    let product: Record<string, unknown>
    try {
      product = object(await this.request(
        `/api/v8/order-adapter-products/${encodeURIComponent(selection.productId)}`, signal))
    } catch (error) {
      if (error instanceof ComputeError && error.code === 'CORE_HTTP_404') {
        throw new ComputeError('COMPUTE_PRODUCT_SELECTION_CHANGED', 409)
      }
      throw error
    }
    if (product.id !== selection.productId || product.status !== 'published'
      || product.publication_id !== selection.publicationId
      || product.owner_id !== selection.ownerId || product.version !== selection.version
      || product.task_type !== taskType) throw new ComputeError('COMPUTE_PRODUCT_SELECTION_CHANGED', 409)
  }

  /** Request Shanghai's read-only quote for the exact final developer-task fields.
   * The raw ticket is returned only to Host callers and never logged or exposed by local routes.
   * @param body - Full task body with a fixed idempotency key, before a ticket exists.
   * @param signal - Caller cancellation.
   */
  async estimateDeveloperTask(body: DeveloperTaskCreateBody, signal?: AbortSignal): Promise<DeveloperTaskEstimate> {
    if (body.quote_token != null) throw new ComputeError('COMPUTE_QUOTE_REQUEST_INVALID')
    const item = object(await this.request(DEVELOPER_TASK_ESTIMATE_PATH, signal, body))
    // Shanghai's live estimate responds with price facts and an opaque signed quote;
    // it does not echo final_spec or idempotency_key. The quote signature binds the
    // canonical spec and account, then create rechecks both and the current price.
    if (item.ok !== true || item.currency !== 'CNY'
      || item.task_type !== body.task_type || item.input_kind !== body.input_kind
      || typeof item.balance_enough !== 'boolean'
      || (item.billing_mode !== 'server_price' && item.billing_mode !== 'client_budget')
      || typeof item.quote_expires_at !== 'number' || !Number.isSafeInteger(item.quote_expires_at)
      || item.quote_expires_at <= 0) return invalidResponse()
    if (body.selected_product !== undefined) {
      const selected = item.selected_product
      if (selected === null || typeof selected !== 'object' || Array.isArray(selected)
        || Object.keys(selected).sort().join(',') !== 'owner_id,product_id,publication_id,version'
        || Object.entries(body.selected_product).some(([key, value]) =>
          (selected as Record<string, unknown>)[key] !== value)) {
        throw new ComputeError('COMPUTE_PRODUCT_SELECTION_UNSUPPORTED', 409)
      }
    }
    const amount = text(item.recommended_budget, 32)
    const requested = text(item.requested_budget, 32)
    const recommendedFen = cnyFen(amount)
    const requestedFen = cnyFen(requested)
    if (recommendedFen === null || recommendedFen <= 0n || requestedFen === null
      || requestedFen !== cnyFen(body.budget)) return invalidResponse()
    if (item.estimated_total !== amount) return invalidResponse()
    const settings = item.settings_version
    if ((typeof settings !== 'string' && typeof settings !== 'number')
      || String(settings).length > 128) return invalidResponse()
    return {
      recommendedBudget: amount,
      requestedBudget: requested,
      expiresAt: item.quote_expires_at,
      balanceEnough: item.balance_enough,
      priceBasis: text(item.price_basis, 255),
      settingsVersion: String(settings),
      billingMode: item.billing_mode,
      name: body.name || body.task_type,
      quoteToken: text(item.quote_token, 4096),
    }
  }

  /** Create a developer task through the idempotent observed route. Never POSTs `/api/v8/workloads`.
   * @param body - Canonical `DeveloperTaskCreateIn` JSON, including `idempotency_key`.
   * @param signal - Optional caller cancellation.
   * @returns The core-issued workload identity and native status from `_task_status_payload`.
   */
  async createDeveloperTask(body: DeveloperTaskCreateBody, signal?: AbortSignal): Promise<ComputeWorkloadSummary> {
    const item = object(await this.request(DEVELOPER_TASK_CREATE_PATH, signal, body))
    if (item.ok !== true) return invalidResponse()
    if (body.selected_product !== undefined) {
      const selected = item.selected_product
      if (selected === null || typeof selected !== 'object' || Array.isArray(selected)
        || Object.keys(selected).sort().join(',') !== 'owner_id,product_id,publication_id,version'
        || Object.entries(body.selected_product).some(([key, value]) =>
          (selected as Record<string, unknown>)[key] !== value)) return invalidResponse()
    }
    const id = text(item.id, 128)
    if (item.task_id !== id || item.workload_id !== id || !/^[A-Za-z0-9._-]{1,128}$/u.test(id) || id === '.' || id === '..') {
      return invalidResponse()
    }
    const status = text(item.status, 64)
    const progress = item.progress
    if (typeof progress !== 'number' || !Number.isFinite(progress) || progress < 0 || progress > 1) return invalidResponse()
    return {
      id: ComputeWorkloadId(id),
      status,
      progress,
      resultAvailable: status === 'DONE',
    }
  }

  /** Abort owned requests and wait for transport cleanup; a closed client cannot be reused.
   * @returns Once every request active at close has settled.
   */
  async close(): Promise<void> {
    this.closed = true
    for (const controller of this.inputUploads) controller.abort(new ComputeError('CORE_CLIENT_CLOSED', 503))
    const operations = [...this.active.values()]
    for (const controller of this.active.keys()) controller.abort(new ComputeError('CORE_CLIENT_CLOSED', 503))
    await Promise.allSettled(operations)
  }
}
