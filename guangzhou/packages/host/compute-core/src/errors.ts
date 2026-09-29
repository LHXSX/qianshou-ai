/** Stable public failures exclude upstream response bodies and credentials. */
export class ComputeError extends Error {
  /** Construct a safe diagnostic for the authenticated local route.
   * @param code - Machine-readable failure identifier.
   * @param status - Local HTTP response status.
   */
  constructor(readonly code: string, readonly status = 400) { super(code) }
}
