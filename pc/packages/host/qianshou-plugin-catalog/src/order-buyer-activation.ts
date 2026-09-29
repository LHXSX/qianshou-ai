/** One buyer action: request an independent challenge, run it locally, then let Shanghai accept the signed proof. */
import { attestorUrl, runInstalledOrderAdapterChallenge } from './order-remote-challenge.ts'
import type { VerifiedOrderAdapterSource } from './order-products-http.ts'
import { CatalogFailure } from './registry.ts'

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u
const SHA = /^sha256:[0-9a-f]{64}$/u

function invalid(): never { throw new CatalogFailure('order-activation-invalid') }
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
function coreUrl(origin: string, path: string): URL {
  let url: URL
  try { url = new URL(origin) } catch { return invalid() }
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash || url.pathname !== '/') invalid()
  return new URL(path, url)
}
async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (response.body === null) invalid()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const part = await reader.read()
      if (part.done) break
      size += part.value.byteLength
      if (size > 128 * 1024) invalid()
      chunks.push(part.value)
    }
  } finally {
    try { await reader.cancel() } catch { /* Complete or rejected. */ }
    reader.releaseLock()
  }
  try { return record(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown) }
  catch { return invalid() }
}
async function sendJson(url: URL, body: unknown, authorization: string | null,
  send: typeof fetch, failure: 'order-activation-unavailable' | 'order-attestor-unavailable',
  timeoutMs = 15_000):
  Promise<Record<string, unknown>> {
  const bytes = JSON.stringify(body)
  if (bytes === undefined || Buffer.byteLength(bytes) > 128 * 1024) invalid()
  let response: Response
  try {
    response = await send(url, { method: 'POST', redirect: 'error', credentials: 'omit',
      headers: { 'content-type': 'application/json', accept: 'application/json',
        ...(authorization === null ? {} : { authorization: `Bearer ${authorization}` }) },
      body: bytes, signal: AbortSignal.timeout(timeoutMs) })
  } catch { throw new CatalogFailure(failure) }
  if (!response.ok) {
    try { await response.body?.cancel() } catch { /* Ignore an untrusted error body. */ }
    throw new CatalogFailure(failure)
  }
  return boundedJson(response)
}

/** A success requires Shanghai's committed device record; local examples alone never satisfy it. */
export async function activateVerifiedOrderAdapter(input: {
  readonly source: VerifiedOrderAdapterSource
  readonly home: string
  readonly coreOrigin: string
  readonly token: string
  readonly workerId: string
  readonly trustedArchiveHostname: string
  readonly trustedAttestorHostname: string
  /** Acknowledged on the authenticated live worker WebSocket, not a buyer HTTP claim. */
  readonly observeNodeChallenge: (observation: {
    challengeNonce: string; inputDigest: string; outputDigest: string;
    runtimeDigest: string; artifactDigest: string
  }) => Promise<void>
  readonly fetch?: typeof fetch
}): Promise<{ readonly productId: string; readonly deviceId: string;
  readonly runtimeDigest: string; readonly deviceInstalled: true; readonly dispatchEligible: true }> {
  if (!UUID.test(input.workerId) || !input.token || /[\r\n]/u.test(input.token)
    || !input.trustedAttestorHostname) invalid()
  const send = input.fetch ?? fetch
  const productId = input.source.check.productId
  const challenge = await sendJson(coreUrl(input.coreOrigin,
    `/api/v8/order-adapter-products/${productId}/activation-challenge`),
  { worker_id: input.workerId }, input.token, send, 'order-activation-unavailable', 60_000)
  if (challenge.schema !== 'qianshou.order-adapter-activation-challenge.v1'
    || challenge.product_id !== productId || challenge.worker_id !== input.workerId
    || typeof challenge.attestor_origin !== 'string'
    || typeof challenge.attestor_key_id !== 'string'
    || typeof challenge.attestor_public_key !== 'string') invalid()
  const attestorOrigin = challenge.attestor_origin
  // The hostname comes from local operator configuration, not the server response.
  attestorUrl(attestorOrigin, input.trustedAttestorHostname, '/')
  const executed = await runInstalledOrderAdapterChallenge({
    source: input.source, home: input.home,
    trustedArchiveHostname: input.trustedArchiveHostname,
    attestorOrigin, attestorHostname: input.trustedAttestorHostname,
    attestorKeyId: challenge.attestor_key_id,
    attestorPublicKey: challenge.attestor_public_key,
    nodeId: input.workerId, signedPlan: challenge.signed_plan, fetch: send,
  })
  await input.observeNodeChallenge({ challengeNonce: executed.challengeNonce,
    inputDigest: executed.challengeInputSha256, outputDigest: executed.challengeResultSha256,
    runtimeDigest: executed.runtimeDigest, artifactDigest: input.source.artifactDigest })
  const response = await sendJson(attestorUrl(attestorOrigin, input.trustedAttestorHostname,
    `/challenges/${executed.challengeNonce}/result`), {
    schema: 'qianshou.order-adapter-remote-challenge-result.v1',
    signed_plan: challenge.signed_plan, worker_id: input.workerId,
    runtime_digest: executed.runtimeDigest, challenge_output: executed.output,
  }, null, send, 'order-attestor-unavailable')
  if (response.schema !== 'qianshou.order-adapter-remote-challenge-result-response.v1'
    || response.status !== 'passed') {
    throw new CatalogFailure('order-attestor-unavailable')
  }
  const receipt = record(response.receipt)
  const payload = record(receipt.payload)
  if (typeof receipt.key_id !== 'string' || receipt.key_id !== challenge.attestor_key_id
    || typeof receipt.signature !== 'string'
    || payload.schema !== 'qianshou.order-adapter-remote-challenge.v1'
    || payload.result !== 'passed' || payload.product_id !== productId
    || payload.entitlement_id !== input.source.check.entitlementId
    || payload.publication_id !== input.source.check.publicationId
    || payload.device_id !== input.workerId
    || payload.archive_digest !== input.source.check.archiveDigest
    || payload.archive_version_id !== input.source.check.archiveVersionId
    || payload.runtime_digest !== executed.runtimeDigest
    || payload.challenge_nonce !== executed.challengeNonce
    || payload.challenge_input_sha256 !== executed.challengeInputSha256
    || payload.challenge_result_sha256 !== executed.challengeResultSha256) invalid()
  const confirmed = await sendJson(coreUrl(input.coreOrigin,
    `/api/v8/order-adapter-products/${productId}/install-receipt`),
  receipt, input.token, send, 'order-activation-unavailable')
  if (confirmed.product_id !== productId || confirmed.device_id !== input.workerId
    || confirmed.runtime_digest !== executed.runtimeDigest
    || confirmed.device_installed !== true || confirmed.status !== 'installed'
    || !SHA.test(executed.runtimeDigest)) invalid()
  return { productId, deviceId: input.workerId, runtimeDigest: executed.runtimeDigest,
    deviceInstalled: true, dispatchEligible: true }
}
