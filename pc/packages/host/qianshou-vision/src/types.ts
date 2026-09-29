/** Vision adapter status projected to the browser; the three facts are never merged into one readiness flag. */

/** Assembly of the shared computer-use service and its provider in this Host. */
export type VisionDriverState = 'absent' | 'service-only' | 'registered'

/** Driver assembly observed from the Cordis Context, independent of OS grants and model routes. */
export interface VisionDriverFact {
  state: VisionDriverState
  /** Provider name held by the computer-use registration, or null when none is registered. */
  provider: string | null
  /** Provider-owned permission probe tool, or null when the registered provider publishes none. */
  probeTool: string | null
}

/** Outcome of the provider-owned, non-interactive permission probe. */
export type VisionPermissionState = 'granted' | 'missing' | 'unknown'

/** Why the permission state is `unknown`; never inferred from configuration. */
export type VisionPermissionReason = 'no-provider' | 'no-probe-tool' | 'probe-failed' | 'unrecognized-result'

/** OS desktop grants as the provider reports them for the process that launched this Host. */
export interface VisionPermissionFact {
  state: VisionPermissionState
  accessibility: boolean | null
  screenRecording: boolean | null
  reason: VisionPermissionReason | null
}

/** Why the route's image acceptance is `null`. */
export type VisionRouteReason = 'no-default-model' | 'unresolvable' | 'modalities-undisclosed'

/** Image acceptance of the default model route as its adapter resolves it. */
export interface VisionRouteFact {
  provider: string | null
  model: string | null
  /** Modalities the adapter discloses for this exact route, or null when undisclosed or unresolvable. */
  inputModalities: string[] | null
  /** True only when the resolved modalities include `image`; null when they are unknown. */
  acceptsImage: boolean | null
  reason: VisionRouteReason | null
}

/** One status read; every field is safe to display and contains no credential. */
export interface VisionSnapshot {
  driver: VisionDriverFact
  permissions: VisionPermissionFact
  route: VisionRouteFact
  /** Node platform identifier of this Host; desktop grant names are OS-specific. */
  platform: string
  /** Wall-clock time of this read in milliseconds since the epoch. */
  checkedAt: number
}
