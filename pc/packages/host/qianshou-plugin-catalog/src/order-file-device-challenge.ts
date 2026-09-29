/** Independent file-device proof executed by the installed pinned QuickJS runtime. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { isAbsolute } from 'node:path'
import { FILE_ABI, FILE_BYTES_POLICY, parseGenericFileSchema,
  type GenericFileAttachment, type GenericFileSchema } from './generic-file-contract.ts'
import { runGenericOrderFileChallenge } from './generic-file-runtime.ts'
import { installVerifiedOrderAdapterSource, loadInstalledVerifiedOrderAdapterSource } from './order-buyer-install.ts'
import { canonicalOrderJson } from './order-json-canonical.ts'
import type { VerifiedOrderAdapterSource } from './order-products-http.ts'
import { CatalogFailure } from './registry.ts'

const PURPOSE = 'qianshou:file-device-attestor'
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const SHA = /^sha256:[0-9a-f]{64}$/u
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PINNED = ['product_id', 'entitlement_id', 'buyer_id', 'publication_id', 'device_id',
  'archive_digest', 'archive_version_id', 'artifact_digest', 'reviewed_seller_runtime_digest']
const PLAN_FIELDS = [...PINNED, 'schema', 'challenge_nonce', 'input_kind',
  'challenge_input_sha256', 'input_ref', 'issued_at', 'expires_at', 'file_binding']
const RECEIPT_FIELDS = [...PINNED, 'schema', 'result', 'runtime_digest', 'challenge_nonce',
  'challenge_input_sha256', 'challenge_result_sha256', 'issued_at', 'expires_at', 'file_binding']
const BINDING_FIELDS = ['schema', 'purpose', 'verification_policy', 'contract_sha256',
  'file_schema_sha256', 'file_schema', 'attachment_manifest_sha256',
  'output_manifest_sha256', 'file_bytes_verified']

/** Authenticated worker WS acknowledgement; attachment and output contents stay off Shanghai. */
export interface FileDeviceChallengeObservation {
  readonly challengeNonce: string
  readonly inputDigest: string
  readonly outputDigest: string
  readonly runtimeDigest: string
  readonly artifactDigest: string
}

/** Dedicated file-purpose signed envelope, verified before returning to the install consumer. */
export interface FileDeviceChallengeReceipt {
  readonly key_id: string
  readonly payload: Readonly<Record<string, unknown>>
  readonly signature: string
}

/** File-device trust comes from local enrolled roots, never key fields in a downloaded plan. */
export interface FileDeviceChallengeTrust {
  readonly source: VerifiedOrderAdapterSource
  readonly fileAttestorKeyId: string
  readonly fileAttestorPublicKey: string
  readonly ordinaryAttestorPublicKeys: readonly string[]
  readonly nodeId: string
  readonly accountId: number
  /** Digest of the current independently reviewed publication, from the authenticated source consumer. */
  readonly contractSha256: string
  readonly fileSchema: GenericFileSchema
}

/** Installed runtime and authenticated transport ports used for one independent challenge. */
export interface InstalledFileDeviceChallengeInput extends FileDeviceChallengeTrust {
  readonly home: string
  readonly trustedArchiveHostname: string
  readonly attestorOrigin: string
  readonly attestorHostname: string
  readonly signedPlan: unknown
  readonly observeNodeChallenge: (observation: FileDeviceChallengeObservation) => Promise<void>
  readonly fetch?: typeof fetch
}

function invalid(): never { throw new CatalogFailure('order-activation-invalid') }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function exact(row: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(row).sort().join(',') !== [...fields].sort().join(',')) invalid()
}
function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(canonicalOrderJson(value)).digest('hex')}`
}
function rawBase64url(value: unknown, length: number): Buffer {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) invalid()
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== length || bytes.toString('base64url') !== value.replace(/=+$/u, '')) invalid()
  return bytes
}
function cloneJson(value: unknown): Record<string, unknown> {
  const encoded = canonicalOrderJson(value)
  if (Buffer.byteLength(encoded, 'utf8') > 8192) invalid()
  return record(JSON.parse(encoded) as unknown)
}
function signedPayload(value: unknown, input: FileDeviceChallengeTrust,
  fields: readonly string[]): FileDeviceChallengeReceipt {
  const envelope = cloneJson(value)
  exact(envelope, ['key_id', 'payload', 'signature'])
  if (envelope.key_id !== input.fileAttestorKeyId) invalid()
  const payload = record(envelope.payload)
  exact(payload, fields)
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519_PREFIX,
    rawBase64url(input.fileAttestorPublicKey, 32)]), format: 'der', type: 'spki' })
  if (!verify(null, Buffer.from(canonicalOrderJson(payload), 'utf8'), key,
    rawBase64url(envelope.signature, 64))) invalid()
  return Object.freeze({ key_id: envelope.key_id as string,
    payload: Object.freeze(payload), signature: envelope.signature as string })
}
function binding(plan: Readonly<Record<string, unknown>>, input: FileDeviceChallengeTrust,
  schema: GenericFileSchema): Record<string, unknown> {
  const found = record(plan.file_binding)
  exact(found, BINDING_FIELDS)
  if (found.schema !== FILE_ABI || found.purpose !== PURPOSE
    || found.verification_policy !== FILE_BYTES_POLICY
    || found.contract_sha256 !== input.contractSha256
    || found.file_schema_sha256 !== digest(schema).slice(7)
    || canonicalOrderJson(parseGenericFileSchema(found.file_schema)) !== canonicalOrderJson(schema)
    || found.file_bytes_verified !== true
    || typeof found.attachment_manifest_sha256 !== 'string' || !SHA.test(found.attachment_manifest_sha256)
    || typeof found.output_manifest_sha256 !== 'string' || !SHA.test(found.output_manifest_sha256)) invalid()
  return found
}
function pinned(plan: Readonly<Record<string, unknown>>, input: FileDeviceChallengeTrust): void {
  const source = input.source
  if (plan.product_id !== source.check.productId || plan.entitlement_id !== source.check.entitlementId
    || plan.buyer_id !== input.accountId || plan.publication_id !== source.check.publicationId
    || plan.device_id !== input.nodeId || plan.archive_digest !== source.check.archiveDigest
    || plan.archive_version_id !== source.check.archiveVersionId || plan.artifact_digest !== source.artifactDigest
    || plan.reviewed_seller_runtime_digest !== source.reviewedSellerRuntimeDigest) invalid()
}
function times(payload: Readonly<Record<string, unknown>>, seconds: number, requireFresh = true): void {
  const now = Math.floor(Date.now() / 1000)
  if (!Number.isSafeInteger(payload.issued_at) || !Number.isSafeInteger(payload.expires_at)
    || (payload.issued_at as number) > now + 10 || (requireFresh && (payload.expires_at as number) <= now)
    || (payload.issued_at as number) < 1
    || (payload.expires_at as number) <= (payload.issued_at as number)
    || (payload.expires_at as number) - (payload.issued_at as number) > seconds) invalid()
}
function trust(input: FileDeviceChallengeTrust): GenericFileSchema {
  if (!UUID.test(input.nodeId) || !Number.isSafeInteger(input.accountId) || input.accountId < 1
    || !SHA.test(input.contractSha256) || !/^[A-Za-z0-9_.-]{1,64}$/u.test(input.fileAttestorKeyId)
    || input.source.outputKind !== 'artifact_ref' || input.source.acceptedInputKinds?.join(',') !== 'inline'
    || input.source.contractVersion !== 'v1') invalid()
  const fileKey = rawBase64url(input.fileAttestorPublicKey, 32)
  if (input.ordinaryAttestorPublicKeys.some(key => rawBase64url(key, 32).equals(fileKey))) invalid()
  return parseGenericFileSchema(input.fileSchema)
}

/** Verify a fresh independent file-purpose plan against the current source and device.
 * @param value - Untrusted signed plan from the activation response.
 * @param input - Local enrolled file signer, forbidden ordinary keys and current reviewed declaration.
 * @returns A copied plan with an Ed25519 signature and all source, account and file bindings checked.
 */
export function verifyFileDeviceChallengePlan(value: unknown, input: FileDeviceChallengeTrust): FileDeviceChallengeReceipt {
  const schema = trust(input)
  const signed = signedPayload(value, input, PLAN_FIELDS)
  const plan = signed.payload
  pinned(plan, input)
  times(plan, 120)
  binding(plan, input, schema)
  if (plan.schema !== 'qianshou.order-adapter-file-challenge-plan.v1'
    || typeof plan.challenge_nonce !== 'string' || !UUID.test(plan.challenge_nonce)
    || plan.input_kind !== 'inline' || typeof plan.challenge_input_sha256 !== 'string'
    || !SHA.test(plan.challenge_input_sha256)
    || plan.input_ref !== `/file/challenges/${plan.challenge_nonce}/input`) invalid()
  return signed
}

/** Verify a dedicated file device receipt; stored proof still requires current server installation status.
 * @param value - Untrusted signed receipt from the independent attestor or private install marker.
 * @param input - Current source, device, reviewed file declaration and exact installed runtime digest.
 * @returns A copied signed receipt. Explicit requireFresh=false is only for already committed server installations.
 */
export function verifyFileDeviceChallengeReceipt(value: unknown,
  input: FileDeviceChallengeTrust & { readonly runtimeDigest: string; readonly requireFresh?: boolean }): FileDeviceChallengeReceipt {
  const schema = trust(input)
  if (!SHA.test(input.runtimeDigest)) invalid()
  const signed = signedPayload(value, input, RECEIPT_FIELDS)
  const payload = signed.payload
  pinned(payload, input)
  times(payload, 600, input.requireFresh !== false)
  binding(payload, input, schema)
  if (payload.schema !== 'qianshou.order-adapter-file-challenge.v1' || payload.result !== 'passed'
    || payload.runtime_digest !== input.runtimeDigest
    || typeof payload.challenge_nonce !== 'string' || !UUID.test(payload.challenge_nonce)
    || typeof payload.challenge_input_sha256 !== 'string' || !SHA.test(payload.challenge_input_sha256)
    || typeof payload.challenge_result_sha256 !== 'string' || !SHA.test(payload.challenge_result_sha256)) invalid()
  return signed
}
function unexpired(plan: Readonly<Record<string, unknown>>): void {
  if ((plan.expires_at as number) <= Math.floor(Date.now() / 1000)) invalid()
}

/** Resolve only an exact nonce route below the dedicated HTTPS file-service mount.
 * @param origin - Service base returned by Shanghai, including the fixed /file/ mount.
 * @param hostname - Independently configured local file-attestor hostname.
 * @param path - Absolute /file/challenges/{nonce}/input or /result route.
 * @returns An HTTPS URL without user credentials, redirects or caller-selected query fields.
 */
export function fileDeviceAttestorUrl(origin: string, hostname: string, path: string): URL {
  let base: URL
  try { base = new URL(origin) } catch { return invalid() }
  if (base.protocol !== 'https:' || base.hostname !== hostname || base.port
    || base.pathname !== '/file/' || base.search || base.hash || base.username || base.password
    || hostname !== hostname.toLowerCase() || !/^[a-z0-9.-]+$/u.test(hostname)
    || !/^\/file\/challenges\/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\/(?:input|result)$/u.test(path)) invalid()
  return new URL(path, base)
}
async function responseJson(response: Response, maxBytes: number): Promise<Record<string, unknown>> {
  if (!response.ok || response.body === null) {
    try { await response.body?.cancel() } catch { /* The rejected response body must not be consumed. */ }
    throw new CatalogFailure('order-attestor-unavailable')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > maxBytes) invalid()
      chunks.push(part.value)
    }
  } finally {
    try { await reader.cancel() } catch { /* The response has completed or been rejected. */ }
    reader.releaseLock()
  }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))
    return record(JSON.parse(text) as unknown)
  } catch { return invalid() }
}
async function request(url: URL, send: typeof fetch, body?: unknown): Promise<Record<string, unknown>> {
  const encoded = body === undefined ? undefined : canonicalOrderJson(body)
  if (encoded !== undefined && Buffer.byteLength(encoded, 'utf8') > 128 * 1024) invalid()
  let response: Response
  try {
    response = await send(url, { method: body === undefined ? 'GET' : 'POST',
      redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(15_000),
      headers: { accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(encoded === undefined ? {} : { body: encoded }) })
  } catch { throw new CatalogFailure('order-attestor-unavailable') }
  return responseJson(response, body === undefined ? 64 * 1024 : 16 * 1024)
}
function attachments(value: unknown, schema: GenericFileSchema): {
  readonly logical: unknown; readonly byName: ReadonlyMap<string, GenericFileAttachment>; readonly manifest: unknown
} {
  const guest = record(value)
  exact(guest, ['schema', 'input', 'attachments'])
  if (guest.schema !== 'qianshou.quickjs-file-input.v1' || !Array.isArray(guest.attachments)
    || guest.attachments.length !== schema.inputs.length) invalid()
  const byName = new Map<string, GenericFileAttachment>()
  const manifest = guest.attachments.map((item, index) => {
    const found = record(item)
    exact(found, ['name', 'contentType', 'encoding', 'content'])
    const slot = schema.inputs[index]!
    if (found.name !== slot.name || found.encoding !== 'base64'
      || typeof found.contentType !== 'string' || !slot.contentTypes.includes(found.contentType)
      || typeof found.content !== 'string' || found.content.length > Math.ceil(slot.maxBytes / 3) * 4
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(found.content)) invalid()
    const bytes = Buffer.from(found.content, 'base64')
    if (bytes.length < 1 || bytes.length > slot.maxBytes || bytes.toString('base64') !== found.content) invalid()
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    byName.set(slot.name, { contentType: found.contentType, bytes, sha256 })
    return { name: slot.name, content_type: found.contentType, size_bytes: bytes.length, sha256 }
  })
  return { logical: guest.input, byName, manifest }
}

/** Run the independent attachment challenge and verify its dedicated purpose receipt.
 * @param input - Current reviewed file declaration, installed source, local signer roots and authenticated WS port.
 * @returns Verified proof for Shanghai to consume; this function grants no dispatch permission.
 */
export async function runInstalledFileDeviceChallenge(input: InstalledFileDeviceChallengeInput): Promise<{
  readonly receipt: FileDeviceChallengeReceipt
  readonly challengeNonce: string
  readonly challengeInputSha256: string
  readonly challengeResultSha256: string
  readonly runtimeDigest: string
}> {
  if (!isAbsolute(input.home)) invalid()
  const schema = trust(input)
  const signedPlan = verifyFileDeviceChallengePlan(input.signedPlan, input)
  const plan = signedPlan.payload
  const fileBinding = binding(plan, input, schema)
  // Validate the configured HTTPS host before creating or reading an installed runtime.
  const inputUrl = fileDeviceAttestorUrl(input.attestorOrigin, input.attestorHostname, plan.input_ref as string)
  const installed = await installVerifiedOrderAdapterSource(input.source, {
    home: input.home, trustedArchiveHostname: input.trustedArchiveHostname,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  })
  const loaded = await loadInstalledVerifiedOrderAdapterSource(input.source, input.home)
  if (loaded.runtimeDigest !== installed.runtimeDigest
    || loaded.source.declaration.schema !== 'qianshou.local-adapter-candidate.v3'
    || loaded.source.taskDefinition?.fileSchema === undefined
    || canonicalOrderJson(parseGenericFileSchema(loaded.source.taskDefinition.fileSchema)) !== canonicalOrderJson(schema)) invalid()
  unexpired(plan)
  const send = input.fetch ?? fetch
  const envelope = await request(inputUrl, send)
  exact(envelope, ['schema', 'challenge_nonce', 'input_kind', 'input', 'challenge_input_sha256'])
  if (envelope.schema !== 'qianshou.order-adapter-remote-challenge-input.v1'
    || envelope.challenge_nonce !== plan.challenge_nonce || envelope.input_kind !== plan.input_kind
    || envelope.challenge_input_sha256 !== plan.challenge_input_sha256
    || digest(envelope.input) !== plan.challenge_input_sha256) invalid()
  const attachment = attachments(envelope.input, schema)
  if (digest(attachment.manifest) !== fileBinding.attachment_manifest_sha256) invalid()
  const executed = await runGenericOrderFileChallenge(loaded.source,
    Buffer.from(canonicalOrderJson(attachment.logical), 'utf8'), async slot => {
      const found = attachment.byName.get(slot.name)
      if (found === undefined) invalid()
      return found
    })
  const outputManifest = executed.files.map(file => ({ name: file.name, filename: file.filename,
    content_type: file.contentType, size_bytes: file.bytes.length, sha256: file.sha256 }))
  if (digest(outputManifest) !== fileBinding.output_manifest_sha256) invalid()
  unexpired(plan)
  await input.observeNodeChallenge({ challengeNonce: plan.challenge_nonce as string,
    inputDigest: plan.challenge_input_sha256 as string, outputDigest: executed.outputDigest,
    runtimeDigest: loaded.runtimeDigest, artifactDigest: input.source.artifactDigest })
  unexpired(plan)
  const response = await request(fileDeviceAttestorUrl(input.attestorOrigin, input.attestorHostname,
    `/file/challenges/${plan.challenge_nonce}/result`), send, {
    schema: 'qianshou.order-adapter-remote-challenge-result.v1', signed_plan: signedPlan,
    worker_id: input.nodeId, runtime_digest: loaded.runtimeDigest, challenge_output: executed.output,
  })
  exact(response, ['schema', 'status', 'receipt'])
  if (response.schema !== 'qianshou.order-adapter-remote-challenge-result-response.v1'
    || response.status !== 'passed') throw new CatalogFailure('order-attestor-unavailable')
  const receipt = verifyFileDeviceChallengeReceipt(response.receipt, {
    ...input, runtimeDigest: loaded.runtimeDigest,
  })
  const payload = receipt.payload
  if (payload.challenge_nonce !== plan.challenge_nonce
    || payload.challenge_input_sha256 !== plan.challenge_input_sha256
    || payload.challenge_result_sha256 !== executed.outputDigest
    || (payload.issued_at as number) < (plan.issued_at as number)
    || canonicalOrderJson(payload.file_binding) !== canonicalOrderJson(fileBinding)) invalid()
  return { receipt, challengeNonce: plan.challenge_nonce as string,
    challengeInputSha256: plan.challenge_input_sha256 as string, challengeResultSha256: executed.outputDigest,
    runtimeDigest: loaded.runtimeDigest }
}
