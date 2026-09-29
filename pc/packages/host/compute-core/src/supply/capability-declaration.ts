/** Project a local probe into `qianshou/capability/v1` provides[].impl. Never a hello whitelist key. */
import { IMPLEMENTATIONS_BY_CAPABILITY } from '../capability-registry.ts'
import { advertisedNamesFromProbe, capabilitiesSatisfiedByAdvertised } from '../node-capability.ts'
import type { CapabilityDeclaration, CapabilityImplBinding, CapabilityProvide, LocalSupplyService, SupplyProbeResult } from './types.ts'

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/-/g, '_')
}

/**
 * Choose the registered impl id and measured version for one already-satisfied capability.
 * @param capability - Registry capability name.
 * @param advertised - Software and native-binary names the node reported.
 * @param tools - Verified tool services with measured versions.
 * @returns Binding, or null when no implementation both matches and has a version.
 */
function bindingFor(
  capability: string, advertised: ReadonlySet<string>, tools: readonly LocalSupplyService[],
): CapabilityImplBinding | null {
  for (const impl of IMPLEMENTATIONS_BY_CAPABILITY[capability] ?? []) {
    const hit = impl.names.find(name => advertised.has(normalizeName(name)))
    if (hit === undefined) continue
    const tool = tools.find((service) => {
      const id = normalizeName(service.id)
      return id === normalizeName(hit) || impl.names.some(name => normalizeName(name) === id)
    })
    const version = tool?.version
    if (typeof version !== 'string' || version.trim() === '') continue
    return { runtime: impl.id, version }
  }
  return null
}

/**
 * Project probe facts into the node capability declaration.
 * Capability names match `provided_capabilities` (same advertised set, same matcher).
 * @param probe - Fresh local observations.
 * @returns A declaration that can be persisted on the supply snapshot.
 */
export function projectCapabilityDeclaration(probe: SupplyProbeResult): CapabilityDeclaration {
  const advertisedList = advertisedNamesFromProbe(probe)
  const advertised = new Set(advertisedList.map(normalizeName))
  const measured = probe.localServices.filter(service =>
    (service.kind === 'tool' || service.kind === 'package') && service.verification === 'verified')
  const names = capabilitiesSatisfiedByAdvertised(advertisedList)
  const provides: CapabilityProvide[] = []
  for (const capability of names) {
    const binding = bindingFor(capability, advertised, measured)
    if (binding === null) continue
    provides.push({ capability, impl: binding, health: 'ok' })
  }
  return {
    contract: 'qianshou/capability/v1',
    provides,
    native_binaries: [...new Set(measured.filter(service => service.kind === 'tool').map(service => service.id))],
  }
}
