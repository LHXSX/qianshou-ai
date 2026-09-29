/** Execute an independently planned random challenge in the installed buyer runtime. */
import { createHash, createPublicKey, verify } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { runGenericOrderChallenge } from './generic-order-adapter.ts'
import { readGenericOrderSource } from './generic-order-source.ts'
import { installVerifiedOrderAdapterSource } from './order-buyer-install.ts'
import type { VerifiedOrderAdapterSource } from './order-products-http.ts'
import { CatalogFailure } from './registry.ts'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const SHA = /^sha256:[0-9a-f]{64}$/u
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
const PLAN_FIELDS = new Set(['schema', 'challenge_nonce', 'product_id', 'entitlement_id',
  'buyer_id', 'publication_id', 'device_id', 'archive_digest', 'archive_version_id',
  'artifact_digest', 'reviewed_seller_runtime_digest', 'input_kind',
  'challenge_input_sha256', 'input_ref', 'issued_at', 'expires_at'])

type Plan = Readonly<Record<string, unknown>>
type Envelope = { readonly key_id: string; readonly payload: Plan; readonly signature: string }

function invalid(): never { throw new CatalogFailure('order-install-manifest-invalid') }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const row = value as Record<string, unknown>
    return `{${Object.keys(row).sort().map(key => `${JSON.stringify(key)}:${canonical(row[key])}`).join(',')}}`
  }
  const result = JSON.stringify(value)
  if (result === undefined) invalid()
  return result
}
function rawBase64url(value: unknown, length: number): Buffer {
  if (typeof value !== 'string' || value.length > 128 || !/^[A-Za-z0-9_-]+={0,2}$/u.test(value)) invalid()
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.length !== length || bytes.toString('base64url') !== value.replace(/=+$/u, '')) invalid()
  return bytes
}
function verifiedPlan(value: unknown, input: { readonly attestorKeyId: string;
  readonly attestorPublicKey: string; readonly nodeId: string;
  readonly source: VerifiedOrderAdapterSource; readonly now: number }): Plan {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== 'key_id,payload,signature') invalid()
  const envelope = value as Envelope
  if (envelope.key_id !== input.attestorKeyId || envelope.payload === null
    || typeof envelope.payload !== 'object' || Array.isArray(envelope.payload)
    || Object.keys(envelope.payload).length !== PLAN_FIELDS.size
    || Object.keys(envelope.payload).some(key => !PLAN_FIELDS.has(key))) invalid()
  const publicKey = createPublicKey({ key: Buffer.concat([
    SPKI_ED25519_PREFIX, rawBase64url(input.attestorPublicKey, 32),
  ]), format: 'der', type: 'spki' })
  if (!verify(null, Buffer.from(canonical(envelope.payload), 'utf8'), publicKey,
    rawBase64url(envelope.signature, 64))) invalid()
  const plan = envelope.payload
  const source = input.source
  if (plan.schema !== 'qianshou.order-adapter-remote-challenge-plan.v1'
    || typeof plan.challenge_nonce !== 'string' || !UUID.test(plan.challenge_nonce)
    || plan.product_id !== source.check.productId
    || plan.entitlement_id !== source.check.entitlementId
    || plan.publication_id !== source.check.publicationId
    || plan.device_id !== input.nodeId
    || plan.archive_digest !== source.check.archiveDigest
    || plan.archive_version_id !== source.check.archiveVersionId
    || plan.artifact_digest !== source.artifactDigest
    || plan.reviewed_seller_runtime_digest !== source.reviewedSellerRuntimeDigest
    || plan.input_kind !== 'inline'
    || typeof plan.challenge_input_sha256 !== 'string'
    || !SHA.test(plan.challenge_input_sha256)
    || plan.input_ref !== `/challenges/${plan.challenge_nonce}/input`
    || !Number.isSafeInteger(plan.buyer_id) || (plan.buyer_id as number) < 1
    || !Number.isSafeInteger(plan.issued_at) || !Number.isSafeInteger(plan.expires_at)
    || (plan.issued_at as number) > input.now + 10
    || (plan.expires_at as number) <= input.now
    || (plan.expires_at as number) - (plan.issued_at as number) > 120) invalid()
  return plan
}

export function attestorUrl(origin: string, hostname: string, path: string): URL {
  let base: URL
  try { base = new URL(origin) } catch { return invalid() }
  if (base.protocol !== 'https:' || base.hostname !== hostname || base.port
    || base.pathname !== '/' || base.search || base.hash || base.username || base.password
    || hostname !== hostname.toLowerCase() || !/^[a-z0-9.-]+$/u.test(hostname)) invalid()
  return new URL(path, base)
}

async function challengeBytes(url: URL, send: typeof fetch): Promise<Buffer> {
  let response: Response
  try { response = await send(url, { method: 'GET', redirect: 'error', credentials: 'omit',
    signal: AbortSignal.timeout(10_000) }) }
  catch { throw new CatalogFailure('order-runtime-unavailable') }
  if (!response.ok || response.body === null) throw new CatalogFailure('order-runtime-unavailable')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.length
      if (size > 64 * 1024) invalid()
      chunks.push(chunk.value)
    }
  } finally {
    try { await reader.cancel() } catch { /* Response complete. */ }
    reader.releaseLock()
  }
  if (size < 1) invalid()
  return Buffer.concat(chunks)
}

/** Return bounded output to the independent verifier; never grant dispatch locally. */
export async function runInstalledOrderAdapterChallenge(input: {
  readonly source: VerifiedOrderAdapterSource
  readonly home: string
  readonly trustedArchiveHostname: string
  readonly attestorOrigin: string
  readonly attestorHostname: string
  readonly attestorKeyId: string
  readonly attestorPublicKey: string
  readonly nodeId: string
  readonly signedPlan: unknown
  readonly fetch?: typeof fetch
}): Promise<{ readonly challengeNonce: string; readonly challengeInputSha256: string;
  readonly challengeResultSha256: string; readonly runtimeDigest: string;
  readonly output: unknown }> {
  if (!isAbsolute(input.home)) invalid()
  const plan = verifiedPlan(input.signedPlan, { attestorKeyId: input.attestorKeyId,
    attestorPublicKey: input.attestorPublicKey, nodeId: input.nodeId,
    source: input.source, now: Math.floor(Date.now() / 1000) })
  const installed = await installVerifiedOrderAdapterSource(input.source, {
    home: input.home, trustedArchiveHostname: input.trustedArchiveHostname,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  })
  const version = createHash('sha256').update(input.source.check.archiveVersionId).digest('hex')
  const root = join(await realpath(input.home), 'qianshou', 'order-adapter-runtime',
    input.source.check.productId, input.source.check.entitlementId, version)
  const source = await readGenericOrderSource(join(root, 'SKILL.md'))
  if (`sha256:${source.digest}` !== input.source.artifactDigest) invalid()
  const url = attestorUrl(input.attestorOrigin, input.attestorHostname, plan.input_ref as string)
  const bytes = await challengeBytes(url, input.fetch ?? fetch)
  let envelope: Record<string, unknown>
  try { envelope = JSON.parse(bytes.toString('utf8')) as Record<string, unknown> }
  catch { return invalid() }
  if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)
    || Object.keys(envelope).sort().join(',')
      !== 'challenge_input_sha256,challenge_nonce,input,input_kind,schema'
    || envelope.schema !== 'qianshou.order-adapter-remote-challenge-input.v1'
    || envelope.challenge_nonce !== plan.challenge_nonce
    || envelope.input_kind !== plan.input_kind
    || envelope.challenge_input_sha256 !== plan.challenge_input_sha256) invalid()
  const challengeInput = Buffer.from(canonical(envelope.input), 'utf8')
  if (`sha256:${createHash('sha256').update(challengeInput).digest('hex')}`
    !== plan.challenge_input_sha256) invalid()
  const { output, outputDigest } = await runGenericOrderChallenge(source, challengeInput)
  return { challengeNonce: plan.challenge_nonce as string,
    challengeInputSha256: plan.challenge_input_sha256 as string,
    challengeResultSha256: outputDigest, runtimeDigest: installed.runtimeDigest, output }
}
