/** Read-only local H3 evidence, independent from platform review and node admission. */
/** Exact optional readiness extension returned by the existing Host status endpoint. */
export interface NodeH3VideoStatus {
  readonly configured: boolean
  readonly ready: boolean
  readonly code: string
}

const TRIAL_BLOCKING_CODES = new Set([
  'H3_SETUP_SELF_TEST_PENDING', 'H3_SETUP_SELF_TEST_UNKNOWN',
  'H3_SETUP_SELF_TEST_UNSETTLED', 'H3_SETUP_TRIAL_GUARD_INVALID',
])

/** Identify a retained local trial barrier without implying a configured or ready provider.
 * @param status - Validated Host evidence; the configured fact remains unchanged.
 * @returns Whether the bounded trial status blocks new intake.
 */
export function h3TrialBlocksIntake(status: NodeH3VideoStatus): boolean {
  return !status.ready && TRIAL_BLOCKING_CODES.has(status.code)
}

/**
 * Admit only a consistent local readiness record; malformed extensions are isolated.
 * @param value - Untrusted h3Video field from a node snapshot.
 * @returns Validated local evidence, or null without invalidating the node snapshot.
 */
export function parseH3VideoStatus(value: unknown): NodeH3VideoStatus | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  if (Object.keys(record).sort().join(',') !== 'code,configured,ready'
    || typeof record.configured !== 'boolean' || typeof record.ready !== 'boolean'
    || typeof record.code !== 'string' || !/^H3_[A-Z0-9_]{1,76}$/u.test(record.code)) return null
  const verified = record.code === 'H3_REAL_SELF_TEST_VERIFIED' || record.code === 'H3_V2_REAL_SELF_TEST_VERIFIED'
  if (record.ready !== verified
    || (!record.configured && (record.ready || (record.code !== 'H3_OWNER_CONFIG_NOT_CONFIGURED'
      && !TRIAL_BLOCKING_CODES.has(record.code))))
    || (record.configured && record.code === 'H3_OWNER_CONFIG_NOT_CONFIGURED')) return null
  return { configured: record.configured, ready: record.ready, code: record.code }
}
