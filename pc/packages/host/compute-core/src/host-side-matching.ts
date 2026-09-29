/**
 * Matching source for registry capabilities whose implementations list empty
 * `package_names`. Software-name matching cannot prove these.
 *
 * `accelerator.gpu` is a placement probe (VRAM floors), not a runnable task.
 * `text.transform` is advertised on hello by the isolated runner (HX-68).
 * `image.generate` is advertised only when this process bound the H3 plugin.
 * `media.compose` is a named local film host, not a pool software package.
 */
import { ADVERTISEMENT_PROOF_BY_CAPABILITY } from './capability-registry.ts'

/** How the pool is allowed to learn an empty-`package_names` capability. */
export const HOST_SIDE_MATCHING_KINDS = Object.freeze([
  'placement-probe',
  'hello-union',
  'plugin-hello',
  'local-service',
] as const)

/** One of {@link HOST_SIDE_MATCHING_KINDS}. */
export type HostSideMatchingKind = (typeof HOST_SIDE_MATCHING_KINDS)[number]

/**
 * Every registry capability that currently has an empty-`package_names`
 * implementation. A new such row without a key here repeats the
 * `text.transform` hole: path B is empty and path A never hears a hello.
 */
export const HOST_SIDE_MATCHING = Object.freeze({
  'accelerator.gpu': 'placement-probe',
  'image.generate': 'plugin-hello',
  'legal.doc.bundle': 'local-service',
  'media.compose': 'local-service',
  'text.transform': 'hello-union',
  'video.render': 'plugin-hello',
} as const satisfies Record<string, HostSideMatchingKind>)

/**
 * Read the registry's explicit advertisement proof requirement.
 * Missing or unknown entries cannot be proven by installed software. A positive
 * result preserves name matching only; the executing node still needs a bound executor.
 *
 * @param capabilityId Registry capability id.
 * @returns True only when the registry permits installed-software matching.
 */
export function softwareNamesProveCapability(capabilityId: string): boolean {
  return ADVERTISEMENT_PROOF_BY_CAPABILITY[capabilityId] === 'software-probe'
}

/**
 * Live dispatch for these ids must see a healthy `provided_capabilities` ad.
 * Package names (python3 on SH01) must not admit the node.
 *
 * @returns Capability ids whose {@link HOST_SIDE_MATCHING} kind is `hello-union`.
 */
export function helloUnionCapabilityIds(): string[] {
  return Object.entries(HOST_SIDE_MATCHING)
    .filter(([, kind]) => kind === 'hello-union')
    .map(([id]) => id)
    .sort()
}
