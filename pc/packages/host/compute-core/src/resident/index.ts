/**
 * Resident node runtime: the assembled "idle-time task acceptance" loop.
 *
 * Module map:
 * - {@link ResidentNodeRuntime} — lifecycle, tick, admission, execution, return, drain;
 * - `admission.ts` — local lifecycle/lease gate and control-plane ordering;
 * - `failure.ts` — failure classification that can never claim a result;
 * - `types.ts` — every injected seam, including the control-plane port the host binds;
 * - `../transport/memory-session.ts` — in-memory session conformance double.
 */
export { ResidentNodeRuntime } from './runtime.ts'
export { admitResidentOffer, residentAttemptOf } from './admission.ts'
export type { ResidentAdmissionGate, ResidentAdmissionInput, ResidentAdmissionOptions } from './admission.ts'
export {
  classifyResidentFailure,
  leaseForbidsEvents,
  RESIDENT_FAILURE_CODES,
  RESIDENT_FAILURE_DISPOSITIONS,
  resolveResidentFailureTransition,
  withResidentDisposition,
} from './failure.ts'
export { createInlineSessionConsumer, unavailableIsolatedInlineRunner } from './inline-session-consumer.ts'
export {
  createIsolatedInlineRunner,
  hasIsolatedInlineRunner,
  ISOLATED_INLINE_TASK_TYPES,
} from './isolated-inline-runner.ts'
export type { IsolatedAgentSession, IsolatedInlineRunnerOptions } from './isolated-inline-runner.ts'
export type { IsolatedInlineRunner, InlineSessionConsumerOptions } from './inline-session-consumer.ts'
export { RESIDENT_CONTRIBUTOR_CONTRACT_VERSION } from './types.ts'
export { createFileOrderConsumer, type FileOrderRuntimePorts, type FileOrderRuntimeRunner } from './file-order-consumer.ts'
export type {
  ComputeResidentAttemptExecution,
  ComputeResidentAttemptSource,
  ComputeResidentResultConsumer,
  ComputeResidentWorkspace,
  ComputeResidentWorkspaceOutputs,
  ComputeResidentWorkspaceProvider,
  ResidentAcceptResult,
  ResidentAdmissionReason,
  ResidentAttempt,
  ResidentAttemptFailure,
  ResidentAttemptRecord,
  ResidentInFlightAttempt,
  ResidentCapability,
  ResidentCapabilitySource,
  ResidentControlPort,
  ResidentDecisionEvent,
  ResidentEarningsEventReference,
  ResidentFailureCode,
  ResidentFailureDisposition,
  ResidentInboundFrame,
  ResidentLifecycleState,
  ResidentOfferCandidate,
  ResidentOfferOutcome,
  ResidentOfferRequest,
  ResidentOfferVerification,
  ResidentPrecheckInput,
  ResidentPrecheckResult,
  ResidentResourceObservation,
  ResidentResourceObserver,
  ResidentRuntime,
  ResidentRuntimeConfig,
  ResidentSession,
  ResidentSessionConnector,
  ResidentStopReceipt,
  ResidentTaskEvent,
  ResidentTickOutcome,
  ResidentVerifiedOutput,
} from './types.ts'
