/** Operator trust discovery is separate from publication and artifact responses. */
import type { KeyObject } from 'node:crypto'
import { nativeH3AttestorKeys } from './native-h3-bindings-http.ts'
import { CatalogFailure } from './registry.ts'

/** Separate enrolled Ed25519 roots for review challenges, device proofs and upload issuance. */
export interface NativeH3PurposeKeys {
  readonly challenge: ReadonlyMap<string, KeyObject>
  readonly attestor: ReadonlyMap<string, KeyObject>
  readonly issuance: ReadonlyMap<string, KeyObject>
}
function invalid(): never { throw new CatalogFailure('order-platform-contract') }
function records(value: unknown): Record<string, string> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  const row = value as Record<string, unknown>
  if (Object.values(row).some(value => typeof value !== 'string')) invalid()
  return row as Record<string, string>
}

/** Resolve distinct purpose roots from configuration or the authenticated HTTPS trust endpoint.
 * @param input - Control origin/token, configured key sets, cancellation and current-identity checks.
 * @returns Three nonempty validated key maps with no public key shared across purposes.
 */
export async function fetchNativeH3PurposeKeys(input: {
  origin: string
  token: string
  signal: AbortSignal
  configured: { challenge?: Record<string, string>; attestor?: Record<string, string>; issuance?: Record<string, string> }
  assertCurrent(): Promise<void>
  fetch?: typeof fetch
}): Promise<NativeH3PurposeKeys> {
  let origin: URL
  try { origin = new URL(input.origin) } catch { return invalid() }
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/'
    || origin.search || origin.hash || !input.token || /[\r\n]/u.test(input.token)) invalid()
  const configured = input.configured
  let discovered: { challenge: Record<string, string>; attestor: Record<string, string>; issuance: Record<string, string> }
    = { challenge: {}, attestor: {}, issuance: {} }
  if ([configured.challenge, configured.attestor, configured.issuance].some(keys => !Object.keys(keys ?? {}).length)) {
    input.signal.throwIfAborted()
    await input.assertCurrent()
    let response: Response
    try {
      response = await (input.fetch ?? fetch)(new URL('/api/v8/task-adapter-publications/native-proof-trust', origin), {
        method: 'GET', redirect: 'error', credentials: 'omit', cache: 'no-store',
        signal: AbortSignal.any([input.signal, AbortSignal.timeout(15_000)]),
        headers: { accept: 'application/json', authorization: `Bearer ${input.token}` },
      })
    } catch { throw new CatalogFailure('order-platform-unavailable') }
    if (!response.ok) {
      try { await response.body?.cancel() } catch { /* Never consume untrusted remote errors. */ }
      throw new CatalogFailure(response.status === 401 || response.status === 403 ? 'order-auth-required'
        : response.status === 404 ? 'order-platform-route-unavailable' : 'order-platform-unavailable')
    }
    const reader = response.body?.getReader()
    if (reader === undefined) invalid()
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      for (;;) {
        const part = await reader.read()
        if (part.done) break
        length += part.value.byteLength
        if (length > 16 * 1024) invalid()
        chunks.push(part.value)
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
    let value: unknown
    try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))) as unknown }
    catch { return invalid() }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
    const row = value as Record<string, unknown>
    if (Object.keys(row).sort().join(',') !== 'challenge_keys,device_attestor_keys,schema,upload_issuance_keys'
      || row.schema !== 'qianshou.native-h3-proof-trust.v1') invalid()
    discovered = { challenge: records(row.challenge_keys), attestor: records(row.device_attestor_keys),
      issuance: records(row.upload_issuance_keys) }
    await input.assertCurrent()
    input.signal.throwIfAborted()
  }
  const raw = [configured.challenge, configured.attestor, configured.issuance]
    .map((keys, index) => Object.keys(keys ?? {}).length ? keys ?? {} :
      [discovered.challenge, discovered.attestor, discovered.issuance][index] ?? {})
  const parsed = raw.map(nativeH3AttestorKeys)
  if (parsed.some(keys => keys.size === 0)) invalid()
  const seen = new Set<string>()
  for (const keys of raw) {
    for (const key of new Set(Object.values(keys))) {
      if (seen.has(key)) invalid()
      seen.add(key)
    }
  }
  const [challenge, attestor, issuance] = parsed
  if (challenge === undefined || attestor === undefined || issuance === undefined) invalid()
  return { challenge, attestor, issuance }
}
