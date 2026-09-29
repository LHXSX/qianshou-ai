/** File activation uses locally enrolled purpose roots and an authenticated WS observation. */
import { loadInstalledVerifiedOrderAdapterSource } from './order-buyer-install.ts'
import { runInstalledFileDeviceChallenge, type FileDeviceChallengeObservation } from './order-file-device-challenge.ts'
import { saveFileDeviceInstallReceipt, type FileRuntimeRoots } from './order-file-runtime.ts'
import { parseGenericFileSchema } from './generic-file-contract.ts'
import type { VerifiedOrderAdapterSource } from './order-products-http.ts'
import { CatalogFailure } from './registry.ts'

function invalid(): never { throw new CatalogFailure('order-activation-invalid') }
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid()
  return value as Record<string, unknown>
}
async function post(origin: string, path: string, token: string, body: unknown,
  send: typeof fetch): Promise<Record<string, unknown>> {
  let base: URL
  try { base = new URL(origin) } catch { return invalid() }
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(base.hostname)))
    || base.pathname !== '/' || base.search || base.hash || base.username || base.password
    || !token || /[\r\n]/u.test(token)) invalid()
  const response = await send(new URL(path, base), { method: 'POST', redirect: 'error', credentials: 'omit',
    headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60_000) })
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined)
    throw new CatalogFailure('order-activation-unavailable')
  }
  const reader = response.body.getReader()
  const parts: Uint8Array[] = []; let size = 0
  try {
    for (;;) {
      const part = await reader.read(); if (part.done) break
      size += part.value.length; if (size > 16 * 1024) invalid()
      parts.push(part.value)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  try { return row(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts))) as unknown) }
  catch { return invalid() }
}
/** Install and commit one independently verified file-capable device; examples alone never authorize it.
 * @param input - Current source, account, worker and local purpose roots; all media exchanges stay off Shanghai.
 * @returns Exact committed runtime identity. Fresh providers separately recheck its server receipt and local bytes.
 */
export async function activateVerifiedFileOrderAdapter(input: FileRuntimeRoots & {
  source: VerifiedOrderAdapterSource; home: string; coreOrigin: string; token: string;
  workerId: string; accountId: number; trustedArchiveHostname: string; trustedFileAttestorHostname: string;
  observeNodeChallenge: (value: FileDeviceChallengeObservation) => Promise<void>;
  assertCurrent: () => Promise<void>; fetch?: typeof fetch
}): Promise<{ productId: string; deviceId: string; runtimeDigest: string;
  deviceInstalled: true; dispatchEligible: true }> {
  let core: URL
  try { core = new URL(input.coreOrigin) } catch { return invalid() }
  if (input.nonFilePurposeKeys.length === 0 || !/^[a-z0-9.-]+$/u.test(input.trustedFileAttestorHostname)
    || input.trustedFileAttestorHostname === core.hostname || input.trustedArchiveHostname === core.hostname) invalid()
  const installed = await loadInstalledVerifiedOrderAdapterSource(input.source, input.home)
  const fileSchema = parseGenericFileSchema(installed.source.taskDefinition?.fileSchema)
  const params = installed.source.taskDefinition?.paramsSchema
  if (params && (Object.keys(params.properties as object).length > 0 || (params.required as unknown[]).length > 0)) invalid()
  const productId = input.source.check.productId
  const send = input.fetch ?? fetch
  const challenge = await post(input.coreOrigin, `/api/v8/order-adapter-products/${productId}/activation-challenge`,
    input.token, { worker_id: input.workerId }, send)
  const keyId = challenge.attestor_key_id
  const key = typeof keyId === 'string' ? input.fileAttestorKeys[keyId] : undefined
  if (challenge.schema !== 'qianshou.order-adapter-activation-challenge.v1'
    || challenge.product_id !== productId || challenge.worker_id !== input.workerId
    || typeof challenge.attestor_origin !== 'string' || !key || challenge.attestor_public_key !== key) invalid()
  const binding = row(row(row(challenge.signed_plan).payload).file_binding)
  if (typeof binding.contract_sha256 !== 'string') invalid()
  await input.assertCurrent()
  const executed = await runInstalledFileDeviceChallenge({ source: input.source, home: input.home,
    trustedArchiveHostname: input.trustedArchiveHostname, attestorOrigin: challenge.attestor_origin,
    attestorHostname: input.trustedFileAttestorHostname, fileAttestorKeyId: keyId as string,
    fileAttestorPublicKey: key, ordinaryAttestorPublicKeys: input.nonFilePurposeKeys,
    nodeId: input.workerId, accountId: input.accountId, contractSha256: binding.contract_sha256,
    fileSchema, signedPlan: challenge.signed_plan, observeNodeChallenge: async observation => {
      await input.assertCurrent(); await input.observeNodeChallenge(observation)
    }, fetch: send })
  await input.assertCurrent()
  const confirmed = await post(input.coreOrigin, `/api/v8/order-adapter-products/${productId}/install-receipt`,
    input.token, executed.receipt, send)
  if (confirmed.product_id !== productId || confirmed.device_id !== input.workerId
    || confirmed.runtime_digest !== executed.runtimeDigest || confirmed.device_installed !== true
    || confirmed.status !== 'installed') invalid()
  await input.assertCurrent()
  const reopened = await loadInstalledVerifiedOrderAdapterSource(input.source, input.home)
  if (reopened.runtimeDigest !== executed.runtimeDigest) invalid()
  await input.assertCurrent()
  await saveFileDeviceInstallReceipt(reopened.source, executed.receipt, input.assertCurrent)
  return { productId, deviceId: input.workerId, runtimeDigest: executed.runtimeDigest,
    deviceInstalled: true, dispatchEligible: true }
}
