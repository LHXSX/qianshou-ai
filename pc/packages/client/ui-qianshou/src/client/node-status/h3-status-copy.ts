/** Client-only local H3 labels, kept outside the platform-neutral snapshot parser. */
import type { NodeCopyKey } from './locales.ts'
import type { NodeH3VideoStatus } from './h3-status.ts'

const STATUS_COPY: Readonly<Record<string, NodeCopyKey>> = {
  H3_NOT_CHECKED: 'h3PreflightPending',
  H3_REAL_SELF_TEST_REQUIRED: 'h3PreflightTrialRequired',
  H3_NATIVE_SELF_TEST_REQUIRED: 'h3PreflightTrialRequired',
  H3_V2_REAL_SELF_TEST_REQUIRED: 'h3PreflightTrialRequired',
  H3_V2_OWNER_CONFIG_REQUIRED: 'h3PreflightConfigurationInvalid',
  H3_OWNER_CONFIGURATION_CHANGED: 'h3PreflightBindingChanged',
  H3_RUNTIME_SOURCE_CHANGED: 'h3PreflightBindingChanged',
  H3_NATIVE_SELF_TEST_CHANGED: 'h3PreflightBindingChanged',
  H3_SELF_TEST_OUTPUT_CHANGED: 'h3PreflightBindingChanged',
  H3_LOCAL_FILE_CHANGED: 'h3PreflightBindingChanged',
  H3_ADAPTER_UNAVAILABLE: 'h3PreflightAdapterUnavailable',
  H3_EXECUTION_IDENTITY_UNAVAILABLE: 'h3PreflightAdapterUnavailable',
  H3_OWNER_MODEL_NOT_INSTALLED: 'h3PreflightModelMissing',
  H3_OWNER_CONFIG_INVALID: 'h3PreflightConfigurationInvalid',
  H3_OWNER_FIRST_FRAME_INVALID: 'h3PreflightConfigurationInvalid',
  H3_OWNER_WORKFLOW_INVALID: 'h3PreflightConfigurationInvalid',
  H3_OWNER_WORKFLOW_UNAVAILABLE: 'h3PreflightConfigurationInvalid',
  H3_OWNER_OUTPUT_ROOT_INVALID: 'h3PreflightConfigurationInvalid',
  H3_LOCAL_EXECUTABLE_UNAVAILABLE: 'h3PreflightConfigurationInvalid',
  H3_NODE_ADAPTER_MUST_BE_LOOPBACK: 'h3PreflightConfigurationInvalid',
  H3_ATTESTED_WORKFLOW_UNSUPPORTED: 'h3PreflightConfigurationInvalid',
  H3_LOCAL_OUTPUT_INVALID: 'h3PreflightOutputInvalid',
  H3_SETUP_SELF_TEST_PENDING: 'h3SetupUnsettled',
  H3_SETUP_SELF_TEST_UNKNOWN: 'h3SetupUnsettled',
  H3_SETUP_SELF_TEST_UNSETTLED: 'h3SetupUnsettled',
  H3_SETUP_TRIAL_GUARD_INVALID: 'h3SetupRecordNeedsCheck',
  H3_RECIPE_IDENTITY_INVALID: 'h3PreflightBindingChanged',
  H3_EXECUTION_IDENTITY_CHANGED: 'h3PreflightBindingChanged',
}

/**
 * Choose localized text without exposing raw errors, paths, or platform approval claims.
 * @param status - Previously validated local H3 evidence.
 * @returns The local preflight copy key; unknown failures stay unverified.
 */
export function h3VideoStatusKey(status: NodeH3VideoStatus): NodeCopyKey {
  if (status.ready) return 'h3PreflightPassed'
  return STATUS_COPY[status.code] ?? 'h3PreflightFailed'
}
