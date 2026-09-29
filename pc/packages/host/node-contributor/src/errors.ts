/** Stable node-contributor failures raised before any host effect. */
export class NodeContributorError extends Error {
  /** @param code - Stable failure identifier. @param options - Optional cause chain. */
  constructor(readonly code: string, options?: ErrorOptions) {
    super(code, options)
    this.name = 'NodeContributorError'
  }
}
