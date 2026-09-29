/** Exact buyer runtime identity, usable only with Shanghai's device-scoped receipt. */
import { loadInstalledVerifiedOrderAdapterSource } from './order-buyer-install.ts'
import type { GenericOrderSource } from './generic-order-source.ts'
import type { VerifiedOrderAdapterSource } from './order-products-http.ts'
import type { OrderAdapterBuyerEntitlement } from './types.ts'

export interface VerifiedPurchasedOrderRuntime {
  productId: string
  entitlementId: string
  taskType: string
  capabilityId: string
  outputKind: 'inline_json'
  artifactDigest: string
  packageDigest: string
  runtimeDigest: string
  contractVersion: 'v1'
}

export async function loadOwnedInstalledRuntime(entitlement: OrderAdapterBuyerEntitlement,
  signed: VerifiedOrderAdapterSource, home: string): Promise<{
    runtime: VerifiedPurchasedOrderRuntime; source: GenericOrderSource
  } | null> {
  if (entitlement.status !== 'installed' || !entitlement.deviceInstalled
    || entitlement.runtimeDigest === null
    || signed.check.productId !== entitlement.productId
    || signed.check.entitlementId !== entitlement.entitlementId
    || signed.acceptedInputKinds?.join(',') !== 'inline'
    || signed.outputKind !== 'inline_json' || signed.contractVersion !== 'v1') return null
  const installed = await loadInstalledVerifiedOrderAdapterSource(signed, home)
  if (installed.runtimeDigest !== entitlement.runtimeDigest) return null
  const params = installed.source.taskDefinition?.paramsSchema
  if (params !== undefined && params !== null && (Object.keys((params.properties as Record<string, unknown>) ?? {}).length > 0
    || (params.required as unknown[]).length > 0)) return null
  return { runtime: {
    productId: entitlement.productId, entitlementId: entitlement.entitlementId,
    taskType: signed.taskType, capabilityId: signed.capabilityId,
    outputKind: 'inline_json', artifactDigest: signed.artifactDigest,
    packageDigest: signed.reviewedSellerRuntimeDigest,
    runtimeDigest: installed.runtimeDigest, contractVersion: 'v1',
  }, source: installed.source }
}
