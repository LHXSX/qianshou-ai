/** Stable lifecycle failures exposed to deployment adapters. */
export class PluginLifecycleError extends Error {
  /** @param code - Stable failure identifier. */
  constructor(readonly code: string) { super(code); this.name = 'PluginLifecycleError' }
}
