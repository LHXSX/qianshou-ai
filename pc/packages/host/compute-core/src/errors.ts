/** Stable public failures exclude upstream response bodies and credentials. */
export class ComputeError extends Error {
  /** Construct a safe diagnostic for the authenticated local route.
   * @param code - Machine-readable failure identifier.
   * @param status - Local HTTP response status.
   * @param detail - Local-only diagnostic appended to `message`; routes serialize `code` alone, so it never reaches a client.
   */
  constructor(readonly code: string, readonly status = 400, detail?: string) { super(detail === undefined ? code : `${code}: ${detail}`) }
}
