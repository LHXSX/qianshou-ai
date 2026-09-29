/**
 * Independent verification of one attempt's artifact — the "Verifier" role of
 * `docs/dev-plan/设计-PC能力声明与接单闭环.md` §3: **不许自证**.
 *
 * Why this module exists (both reasons are measured, not hypothetical):
 *
 * 1. Two `word_count` implementations produced *different shapes*, and one of them
 *    fed to the real consumer-side reader (`workload-result.ts` `parseWorkloadResult`)
 *    returned `null` — the user paid, saw `DONE`, and could not open the deliverable.
 *    Nothing in the resident path could catch that, because the only gate between
 *    the executor's claim and the wire was "the receipt has an `outputs` field"
 *    (`resident/runtime.ts:465` receipts, `:486` sends).
 * 2. Verification must be based on a reading taken **before** the product was
 *    claimed, otherwise it is "拿事后读数自造受理" (the C25 lesson, already honoured
 *    by `edge-worker/polled-verification.ts`, whose missing-baseline case is refused
 *    rather than filled in).
 *
 * So this module takes an **artifact reference plus an expected contract**, reads the
 * artifact itself, and decides. The executor's own "success" is carried in the report
 * as {@link ResidentVerificationReport.executorClaim} — evidence to be falsified, never
 * the basis of the verdict.
 *
 * Four outcomes, and the asymmetry between them is the whole point:
 * - `passed` — every check ran and every check held;
 * - `failed` — a check ran and the artifact provably does not meet the contract;
 * - `undetermined` — the facts could not be obtained. **Never a pass**;
 * - `needs-human` — the facts were obtained but the contract cannot judge them.
 *
 * {@link mayDeliverResidentResult} is the single gate: it is true **only** for `passed`,
 * mirroring `isResultAcceptanceObserved` in the polled verifier.
 *
 * This module opens no socket, mints no credential and stores no token. The only side
 * effect is a read of the attempt's own workspace.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ComputeError } from '../errors.ts'
import { parseWorkloadResult } from '../workload-result.ts'
import type { ComputeResidentAttemptExecution, ComputeResidentResultConsumer } from './types.ts'

/** The verdict. Only {@link mayDeliverResidentResult} may be used to act on it. */
export type ResidentVerificationOutcome = 'passed' | 'failed' | 'undetermined' | 'needs-human'

/** Stable verdict code; never an upstream body, never a stack trace. */
export type ResidentVerificationCode =
  | 'RESIDENT_VERIFICATION_PASSED'
  | 'RESIDENT_VERIFICATION_REFERENCE_INVALID'
  | 'RESIDENT_VERIFICATION_ARTIFACT_NAME_MISMATCH'
  | 'RESIDENT_VERIFICATION_CONTRACT_INVALID'
  | 'RESIDENT_VERIFICATION_PRODUCER_REPORTED_FAILURE'
  | 'RESIDENT_VERIFICATION_NO_BASELINE'
  | 'RESIDENT_VERIFICATION_ARTIFACT_MISSING'
  | 'RESIDENT_VERIFICATION_ARTIFACT_UNREADABLE'
  | 'RESIDENT_VERIFICATION_ARTIFACT_EMPTY'
  | 'RESIDENT_VERIFICATION_ARTIFACT_TOO_LARGE'
  | 'RESIDENT_VERIFICATION_DIGEST_MISMATCH'
  | 'RESIDENT_VERIFICATION_BASELINE_UNCHANGED'
  | 'RESIDENT_VERIFICATION_SCHEMA_INVALID'
  | 'RESIDENT_VERIFICATION_READER_UNAVAILABLE'
  | 'RESIDENT_VERIFICATION_READER_NO_DELIVERABLE'
  | 'RESIDENT_VERIFICATION_READER_REJECTED'
  | 'RESIDENT_VERIFICATION_READER_FIELDS_MISSING'
  | 'RESIDENT_VERIFICATION_READER_INDETERMINATE'

/** One check name, in the order the verifier runs them. */
export type ResidentVerificationCheckId =
  | 'reference' | 'contract' | 'producer-claim' | 'baseline' | 'readable' | 'non-empty' | 'digest' | 'schema' | 'consumer-reader'

/**
 * Every check, in execution order.
 *
 * Exported so callers can compare a report's {@link ResidentVerificationReport.unreached}
 * list against the full pipeline: what was never measured is named, not implied.
 */
export const RESIDENT_VERIFICATION_CHECKS: readonly ResidentVerificationCheckId[] = Object.freeze([
  'reference', 'contract', 'producer-claim', 'baseline', 'readable', 'non-empty', 'digest', 'schema', 'consumer-reader',
])

/** Result of one executed check. */
export interface ResidentVerificationCheck {
  readonly id: ResidentVerificationCheckId
  readonly passed: boolean
  /** Local diagnostic text; safe to log, never sent upstream. */
  readonly detail: string
}

/** Which artifact inside which attempt workspace. `name` is a file name, never a path. */
export interface ResidentArtifactReference {
  readonly workspacePath: string
  readonly name: string
}

/** The executor's own claim about the artifact. Recorded as evidence only. */
export interface ResidentArtifactClaim {
  /** What the executor reported. `false` is authoritative and can never be upgraded to a pass. */
  readonly reportedSuccess: boolean
  /** Bytes the executor claimed, or null when it claimed none. */
  readonly bytes: number | null
  /** sha256 the executor claimed, or null when it claimed none. */
  readonly sha256: string | null
}

/** The field types a contract may pin. Deliberately small: no regex, no coercion. */
export type ResidentArtifactFieldType = 'string' | 'number' | 'boolean' | 'array' | 'object'

/** Closed-shape expectation for a JSON artifact. */
export interface ResidentArtifactSchema {
  /** Top-level key → required type. A missing key is a violation. */
  readonly required: Readonly<Record<string, ResidentArtifactFieldType>>
  /** When false, a top-level key outside {@link required} is a violation. */
  readonly allowAdditional: boolean
}

/** What a real consumer-side reader sees. `readable: false` means "the consumer gets nothing". */
export type ResidentConsumerRead =
  | {
    readonly readable: true
    /** Field names the consumer projects out of the payload. */
    readonly fields: Readonly<Record<string, unknown>>
    /** The deliverable text the consumer would show. */
    readonly deliverable: string
  }
  | { readonly readable: false }

/** Input one consumer-side read receives. */
export interface ResidentConsumerReadInput {
  /** Identity the reader must see in the envelope; defaults to the artifact name. */
  readonly workloadId: string
  /** The artifact's own UTF-8 text, exactly as the executor produced it. */
  readonly text: string
  readonly maxInlineBytes: number
}

/**
 * The reader the *consumer* uses.
 *
 * This is the load-bearing seam: a contract can only claim "the consumer will read this"
 * by naming the same reader the consumer runs. A producer-side shape assertion cannot
 * stand in for it — that is exactly the N9 gap.
 */
export interface ResidentConsumerSideReader {
  readonly id: string
  read(input: ResidentConsumerReadInput): ResidentConsumerRead
}

/** Expected contract for one artifact. */
export interface ResidentVerificationContract {
  /** File name the attempt is expected to produce inside its workspace. */
  readonly artifactName: string
  /** Byte floor; 0 or a non-integer is a contract defect, checked at {@link verifyResidentArtifact}. */
  readonly minBytes: number
  /** Byte ceiling. */
  readonly maxBytes: number
  /** JSON shape, or null when the artifact is not pinned to a shape. */
  readonly schema: ResidentArtifactSchema | null
  /** The consumer's reader, or null when no reader is registered for this artifact kind. */
  readonly reader: ResidentConsumerSideReader | null
  /** Field names {@link reader} must expose. Empty means "any readable deliverable". */
  readonly requiredReaderFields: readonly string[]
  /** Byte ceiling handed to the reader. */
  readonly maxInlineBytes: number
}

/**
 * Reads the artifact's bytes. Injectable so tests can drive an unreadable disk,
 * and so a future remote workspace can be read by the verifier itself.
 */
export interface ResidentArtifactBytesReader {
  read(absolutePath: string): Promise<Uint8Array>
}

/** Default reader: the attempt workspace on this machine. */
export const nodeArtifactBytesReader: ResidentArtifactBytesReader = Object.freeze({
  read: async (absolutePath: string): Promise<Uint8Array> => new Uint8Array(await readFile(absolutePath)),
})

/**
 * The pre-claim reading.
 *
 * `present: false` is the legitimate pre-send state for a fresh workspace and is what
 * makes "this attempt produced it" checkable. `present: true` with the same digest as
 * the delivery means the artifact predates the attempt. A `null` baseline (the read
 * itself failed) makes acceptance impossible to claim, so the verdict is `undetermined`.
 */
export type ResidentVerificationBaseline =
  | { readonly present: false; readonly observedAt: string }
  | { readonly present: true; readonly bytes: number; readonly sha256: string; readonly observedAt: string }

/** Complete record of one verification. Frozen: a verdict is evidence, not a draft. */
export interface ResidentVerificationReport {
  readonly outcome: ResidentVerificationOutcome
  readonly code: ResidentVerificationCode
  readonly artifact: { readonly name: string; readonly bytes: number | null; readonly sha256: string | null }
  readonly baseline: ResidentVerificationBaseline | null
  /** The executor's claim, preserved so a wrong claim can be compared later. Never the verdict. */
  readonly executorClaim: ResidentArtifactClaim
  /** Checks that ran, each with its own result. */
  readonly checks: readonly ResidentVerificationCheck[]
  /** Checks that never ran. A non-empty list means the verdict rests on less than the full pipeline. */
  readonly unreached: readonly ResidentVerificationCheckId[]
  readonly consumer: {
    readonly readerId: string | null
    readonly fields: readonly string[]
    readonly deliverable: string | null
  }
  readonly observedAt: string
}

/** Inputs of one verification. */
export interface ResidentVerificationInput {
  readonly reference: ResidentArtifactReference
  readonly contract: ResidentVerificationContract
  /**
   * The pre-claim reading from {@link captureResidentVerificationBaseline}, or null when it
   * could not be taken. Null is refused, not filled in.
   */
  readonly baseline: ResidentVerificationBaseline | null
  readonly claim: ResidentArtifactClaim
  /** Artifact byte source; defaults to {@link nodeArtifactBytesReader}. */
  readonly artifactReader?: ResidentArtifactBytesReader
  /** Identity handed to the consumer-side reader; defaults to the artifact name. */
  readonly workloadId?: string
  /** Injectable clock for the report timestamp. */
  readonly clock?: () => number
}

/** Stable local failure codes the delivery decorator throws. */
export const RESIDENT_VERIFICATION_FAILURE_CODES = Object.freeze({
  failed: 'COMPUTE_OUTPUT_VERIFICATION_FAILED',
  undetermined: 'COMPUTE_OUTPUT_VERIFICATION_UNDETERMINED',
  'needs-human': 'COMPUTE_OUTPUT_VERIFICATION_NEEDS_HUMAN',
  /** The inner consumer handed back an empty output list; an empty delivery is not a completion. */
  noOutput: 'COMPUTE_OUTPUT_VERIFICATION_NO_OUTPUT',
  /** No contract was available, so there was no basis to judge: refuse rather than assume. */
  noContract: 'COMPUTE_OUTPUT_VERIFICATION_CONTRACT_MISSING',
} as const)

/**
 * Whether the result may leave this process.
 *
 * The reverse-regression gate of this work package: **everything that is not `passed` is
 * false**, including `undetermined` and `needs-human`. Mirrors
 * `isResultAcceptanceObserved` in `edge-worker/polled-verification.ts`.
 * @param report - Any verification report, or just its outcome.
 * @returns True only for an all-checks-passed artifact.
 */
export function mayDeliverResidentResult(report: Pick<ResidentVerificationReport, 'outcome'>): boolean {
  return report.outcome === 'passed'
}

/**
 * Take the pre-claim reading of one artifact.
 *
 * Call this **before** the attempt is allowed to claim a result. A digest read afterwards
 * cannot distinguish "this attempt produced it" from "an older file was already there",
 * which is why the verifier compares against this reading instead of trusting one taken later.
 * @param input - Artifact reference, optional byte source and clock.
 * @returns The baseline, or null when the read failed for a reason other than absence.
 */
export async function captureResidentVerificationBaseline(input: {
  readonly reference: ResidentArtifactReference
  readonly artifactReader?: ResidentArtifactBytesReader
  readonly clock?: () => number
}): Promise<ResidentVerificationBaseline | null> {
  const observedAt = new Date((input.clock ?? Date.now)()).toISOString()
  if (!isArtifactName(input.reference.name)) return null
  const reader = input.artifactReader ?? nodeArtifactBytesReader
  try {
    const bytes = await reader.read(join(input.reference.workspacePath, input.reference.name))
    return Object.freeze({ present: true as const, bytes: bytes.byteLength, sha256: sha256Of(bytes), observedAt })
  } catch (error) {
    // Absence is a fact about a fresh workspace; anything else is a read we could not make.
    return isAbsent(error) ? Object.freeze({ present: false as const, observedAt }) : null
  }
}

/**
 * Verify one artifact against its contract, reading it here rather than taking the executor's word.
 * @param input - Reference, contract, pre-claim baseline and the executor's claim.
 * @returns A frozen four-state verdict; `undetermined` and `needs-human` are never a pass.
 */
export async function verifyResidentArtifact(input: ResidentVerificationInput): Promise<ResidentVerificationReport> {
  const { reference, contract, baseline, claim } = input
  const reader = input.artifactReader ?? nodeArtifactBytesReader
  const observedAt = new Date((input.clock ?? Date.now)()).toISOString()
  const workloadId = input.workloadId ?? reference.name
  const checks: ResidentVerificationCheck[] = []
  const artifact: { name: string; bytes: number | null; sha256: string | null } = {
    name: reference.name, bytes: null, sha256: null,
  }
  const consumer: { readerId: string | null; fields: readonly string[]; deliverable: string | null } = {
    readerId: contract.reader?.id ?? null, fields: Object.freeze([]), deliverable: null,
  }
  const record = (id: ResidentVerificationCheckId, passed: boolean, detail: string): void => {
    checks.push(Object.freeze({ id, passed, detail }))
  }
  const finish = (outcome: ResidentVerificationOutcome, code: ResidentVerificationCode): ResidentVerificationReport => {
    const reached = new Set(checks.map(check => check.id))
    return Object.freeze({
      outcome,
      code,
      artifact: Object.freeze({ ...artifact }),
      baseline,
      executorClaim: Object.freeze({ ...claim }),
      checks: Object.freeze([...checks]),
      unreached: Object.freeze(RESIDENT_VERIFICATION_CHECKS.filter(id => !reached.has(id))),
      consumer: Object.freeze({ ...consumer }),
      observedAt,
    })
  }

  if (!isArtifactName(reference.name)) {
    record('reference', false, 'artifact name is not a bare file name')
    return finish('failed', 'RESIDENT_VERIFICATION_REFERENCE_INVALID')
  }
  if (reference.name !== contract.artifactName) {
    record('reference', false, `artifact ${reference.name} is not the contracted ${contract.artifactName}`)
    return finish('failed', 'RESIDENT_VERIFICATION_ARTIFACT_NAME_MISMATCH')
  }
  record('reference', true, `artifact ${reference.name}`)

  // A contract that cannot be evaluated is a contract defect, not an artifact defect:
  // the facts may be fine, but no machine can say so, so a person must.
  if (!isContractEvaluable(contract)) {
    record('contract', false, 'contract bounds are not evaluable')
    return finish('needs-human', 'RESIDENT_VERIFICATION_CONTRACT_INVALID')
  }
  record('contract', true, `bytes in [${contract.minBytes}, ${contract.maxBytes}]`)

  // The producer's own failure is authoritative: a verifier must never upgrade it to a pass.
  if (!claim.reportedSuccess) {
    record('producer-claim', false, 'the producer itself reported failure')
    return finish('failed', 'RESIDENT_VERIFICATION_PRODUCER_REPORTED_FAILURE')
  }
  record('producer-claim', true, 'the producer reported success (evidence only)')

  if (baseline === null) {
    record('baseline', false, 'no pre-claim reading was taken, so acceptance cannot be claimed')
    return finish('undetermined', 'RESIDENT_VERIFICATION_NO_BASELINE')
  }
  record('baseline', true, baseline.present
    ? `artifact already present before the attempt (${baseline.bytes} bytes)`
    : 'artifact absent before the attempt')

  let bytes: Uint8Array
  try {
    bytes = await reader.read(join(reference.workspacePath, reference.name))
  } catch (error) {
    if (isAbsent(error)) {
      record('readable', false, 'the claimed artifact does not exist in the workspace')
      return finish('failed', 'RESIDENT_VERIFICATION_ARTIFACT_MISSING')
    }
    record('readable', false, `the artifact could not be read here: ${describe(error)}`)
    return finish('undetermined', 'RESIDENT_VERIFICATION_ARTIFACT_UNREADABLE')
  }
  artifact.bytes = bytes.byteLength
  artifact.sha256 = sha256Of(bytes)
  record('readable', true, `${artifact.bytes} bytes read by the verifier itself`)

  if (bytes.byteLength < contract.minBytes || bytes.byteLength === 0) {
    record('non-empty', false, `${bytes.byteLength} bytes is below the ${contract.minBytes}-byte floor`)
    return finish('failed', 'RESIDENT_VERIFICATION_ARTIFACT_EMPTY')
  }
  if (bytes.byteLength > contract.maxBytes) {
    record('non-empty', false, `${bytes.byteLength} bytes exceeds the ${contract.maxBytes}-byte ceiling`)
    return finish('failed', 'RESIDENT_VERIFICATION_ARTIFACT_TOO_LARGE')
  }
  record('non-empty', true, `${bytes.byteLength} bytes, non-empty`)

  if (claim.sha256 !== null && claim.sha256 !== artifact.sha256) {
    record('digest', false, 'the claimed sha256 is not the digest of the bytes on disk')
    return finish('failed', 'RESIDENT_VERIFICATION_DIGEST_MISMATCH')
  }
  record('digest', true, claim.sha256 === null
    ? 'no digest was claimed; the measured digest is recorded instead'
    : 'the claimed sha256 matches the measured digest')

  // Same bytes as the pre-claim reading means this attempt did not produce the artifact.
  if (baseline.present && baseline.sha256 === artifact.sha256) {
    record('baseline', false, 'the artifact is byte-identical to the pre-attempt reading')
    return finish('failed', 'RESIDENT_VERIFICATION_BASELINE_UNCHANGED')
  }

  const text = new TextDecoder('utf-8').decode(bytes)
  const schemaViolation = contract.schema === null ? null : checkSchema(text, contract.schema)
  if (schemaViolation !== null) {
    record('schema', false, schemaViolation)
    return finish('failed', 'RESIDENT_VERIFICATION_SCHEMA_INVALID')
  }
  record('schema', true, contract.schema === null ? 'no shape was pinned by the contract' : 'the JSON shape matches the contract')

  if (contract.reader === null) {
    record('consumer-reader', false, 'no consumer-side reader is registered for this artifact kind')
    return finish('needs-human', 'RESIDENT_VERIFICATION_READER_UNAVAILABLE')
  }
  let read: ResidentConsumerRead
  try {
    read = contract.reader.read({ workloadId, text, maxInlineBytes: contract.maxInlineBytes })
  } catch (error) {
    // The reader's own contract verdict is a determinate rejection; anything else means
    // the reader itself could not answer, which would be a guess if it were called a failure.
    if (error instanceof ComputeError) {
      record('consumer-reader', false, `the consumer-side reader rejected the payload (${error.code})`)
      return finish('failed', 'RESIDENT_VERIFICATION_READER_REJECTED')
    }
    record('consumer-reader', false, `the consumer-side reader did not answer: ${describe(error)}`)
    return finish('undetermined', 'RESIDENT_VERIFICATION_READER_INDETERMINATE')
  }
  if (!read.readable) {
    record('consumer-reader', false, `reader ${contract.reader.id} produces no deliverable from this payload`)
    return finish('failed', 'RESIDENT_VERIFICATION_READER_NO_DELIVERABLE')
  }
  consumer.fields = Object.freeze(Object.keys(read.fields).sort())
  consumer.deliverable = read.deliverable
  const missing = contract.requiredReaderFields.filter(field => !(field in read.fields))
  if (missing.length > 0) {
    record('consumer-reader', false, `reader ${contract.reader.id} omits required field(s): ${missing.join(', ')}`)
    return finish('failed', 'RESIDENT_VERIFICATION_READER_FIELDS_MISSING')
  }
  record('consumer-reader', true, `reader ${contract.reader.id} delivers ${read.deliverable.length} chars`)
  return finish('passed', 'RESIDENT_VERIFICATION_PASSED')
}

/**
 * The consumer's own reader, rebuilt from the deliverable reader the platform runs.
 *
 * `parseWorkloadResult` is handed the same envelope the developer-task route answers with
 * (`{id, status, result}`), so this reader cannot drift from what a real consumer does: it
 * calls that function. A payload the developer-task route reads as `null` reads as
 * `readable: false` here, which is precisely the N9 delivery the user could not open.
 * @returns A reader identified as `developer-task-result`.
 */
export function developerTaskResultReader(): ResidentConsumerSideReader {
  return Object.freeze({
    id: 'developer-task-result',
    read: ({ workloadId, text, maxInlineBytes }: ResidentConsumerReadInput): ResidentConsumerRead => {
      let inner: unknown
      try {
        inner = JSON.parse(text)
      } catch {
        // Not JSON at all: the developer-task route has no `result` object to read.
        return Object.freeze({ readable: false as const })
      }
      const parsed = parseWorkloadResult(workloadId, { id: workloadId, status: 'DONE', result: inner }, maxInlineBytes)
      if (parsed.inlineOutput === null) return Object.freeze({ readable: false as const })
      return Object.freeze({
        readable: true as const,
        fields: Object.freeze({ inlineOutput: parsed.inlineOutput, artifactRef: parsed.artifactRef }),
        deliverable: parsed.inlineOutput,
      })
    },
  })
}

/** Shape the scheduler's `word_count` executor answers with; measured from `isolated-inline-runner.ts`. */
const WORD_COUNT_SCHEMA: ResidentArtifactSchema = Object.freeze({
  required: Object.freeze({
    status: 'string' as const,
    schema_version: 'string' as const,
    task_type: 'string' as const,
    result_lines: 'array' as const,
  }),
  allowAdditional: true,
})

/**
 * The contract a `word_count` artifact is delivered under.
 * @param overrides - Field overrides, e.g. `{ schema: null }` to prove the reader alone catches a shape error.
 * @returns A frozen contract bound to the real developer-task reader.
 */
export function wordCountResultContract(
  overrides: Partial<ResidentVerificationContract> = {},
): ResidentVerificationContract {
  return Object.freeze({
    artifactName: 'result.txt',
    minBytes: 1,
    maxBytes: 1 << 20,
    schema: WORD_COUNT_SCHEMA,
    reader: developerTaskResultReader(),
    requiredReaderFields: Object.freeze(['inlineOutput']),
    maxInlineBytes: 1 << 20,
    ...overrides,
  })
}

/** Wiring for {@link createVerifiedResultConsumer}. */
export interface VerifiedResultConsumerOptions {
  /** The executor-facing consumer whose outputs must be re-verified before they leave. */
  readonly inner: ComputeResidentResultConsumer
  /**
   * The contract for one attempt. Returning null refuses the delivery: with no contract
   * there is no basis to judge, and assuming one is exactly the defect this module removes.
   */
  readonly contractFor: (execution: ComputeResidentAttemptExecution) => ResidentVerificationContract | null
  /** Artifact byte source; defaults to {@link nodeArtifactBytesReader}. */
  readonly artifactReader?: ResidentArtifactBytesReader
  /** Clock for baseline and report timestamps. */
  readonly clock?: () => number
  /** Called with every report, passing and failing alike, so the owner can see what was judged. */
  readonly onReport?: (report: ResidentVerificationReport, execution: ComputeResidentAttemptExecution) => void
}

/**
 * Wrap a result consumer so nothing leaves before the verifier has read it itself.
 *
 * This is the single integration point of E5, and it is placed at
 * `ComputeResidentResultConsumer` because that is the narrowest seam on the 回传 path:
 * `resident/runtime.ts:465` is where the executor's outputs are produced and `:486` is
 * where they become `task.return.outputs`. Wrapping the seam means the runtime, the task
 * store and the transport stay untouched, and a deployment that forgets to wrap gets the
 * old behaviour rather than a silently unverified one.
 *
 * Every non-`passed` verdict throws a `COMPUTE_OUTPUT_*` code, which
 * `resident/failure.ts:57-59` already classifies as `OUTPUT_INVALID`/`TERMINAL` — so a
 * blocked delivery becomes a recorded failure, never a completion, and never an empty
 * output list that a reader would silently render as nothing.
 * @param options - Inner consumer, contract lookup, byte source, clock and report sink.
 * @returns A consumer that releases only artifacts the verifier passed.
 */
export function createVerifiedResultConsumer(options: VerifiedResultConsumerOptions): ComputeResidentResultConsumer {
  const reader = options.artifactReader ?? nodeArtifactBytesReader
  return {
    consume: async ({ execution, workspace, signal }) => {
      const contract = options.contractFor(execution)
      if (contract === null) throw new ComputeError(RESIDENT_VERIFICATION_FAILURE_CODES.noContract, 502)
      const reference: ResidentArtifactReference = { workspacePath: workspace.path, name: contract.artifactName }
      // Baselines are taken before the inner consumer runs, so a file it does not
      // produce itself cannot be presented as this attempt's output.
      const baseline = await captureResidentVerificationBaseline({
        reference, artifactReader: reader, ...(options.clock === undefined ? {} : { clock: options.clock }),
      })
      const receipt = await options.inner.consume({ execution, workspace, signal })
      if (receipt.outputs.length === 0) throw new ComputeError(RESIDENT_VERIFICATION_FAILURE_CODES.noOutput, 502)
      const verified: { name: string; bytes: number; sha256: string }[] = []
      for (const output of receipt.outputs) {
        const report = await verifyResidentArtifact({
          reference: { workspacePath: workspace.path, name: output.name },
          contract,
          baseline,
          claim: { reportedSuccess: true, bytes: output.bytes, sha256: output.sha256 },
          artifactReader: reader,
          ...(options.clock === undefined ? {} : { clock: options.clock }),
        })
        options.onReport?.(report, execution)
        if (report.outcome !== 'passed') {
          throw new ComputeError(RESIDENT_VERIFICATION_FAILURE_CODES[report.outcome], 502, report.code)
        }
        verified.push({
          name: output.name,
          bytes: report.artifact.bytes ?? output.bytes,
          sha256: report.artifact.sha256 ?? output.sha256,
        })
      }
      return { outputs: Object.freeze(verified.map(output => Object.freeze(output))) }
    },
  }
}

/** A bare file name: no separators, no traversal, no control characters. */
function isArtifactName(name: string): boolean {
  return name.length > 0 && name.length <= 255 && name !== '.' && name !== '..'
    && !/[/\\\u0000-\u001f\u007f]/u.test(name)
}

/** Whether every bound can actually be evaluated against a byte count. */
function isContractEvaluable(contract: ResidentVerificationContract): boolean {
  return Number.isSafeInteger(contract.minBytes) && contract.minBytes >= 1
    && Number.isSafeInteger(contract.maxBytes) && contract.maxBytes >= contract.minBytes
    && Number.isSafeInteger(contract.maxInlineBytes) && contract.maxInlineBytes >= 1
    && isArtifactName(contract.artifactName)
    && contract.requiredReaderFields.every(field => typeof field === 'string' && field.length > 0)
}

/** Check one JSON document against a contract schema; null when it conforms. */
function checkSchema(text: string, schema: ResidentArtifactSchema): string | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'the artifact is not JSON, so the contracted shape cannot be met'
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return 'the artifact is JSON but not a JSON object'
  const value = parsed as Record<string, unknown>
  for (const [key, expected] of Object.entries(schema.required)) {
    if (!(key in value)) return `required field ${key} is absent`
    const actual = typeOf(value[key])
    if (actual !== expected) return `field ${key} is ${actual}, contracted type is ${expected}`
  }
  if (!schema.allowAdditional) {
    const extra = Object.keys(value).filter(key => !(key in schema.required))
    if (extra.length > 0) return `undeclared field(s): ${extra.join(', ')}`
  }
  return null
}

/** Observed JSON type of one value, using the same names the contract uses. */
function typeOf(value: unknown): ResidentArtifactFieldType | 'null' | 'other' {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const kind = typeof value
  if (kind === 'string' || kind === 'number' || kind === 'boolean') return kind
  return kind === 'object' ? 'object' : 'other'
}

/** sha256 of the exact bytes that were read. */
function sha256Of(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/** Whether a read failed because nothing is there, as opposed to failing to read. */
function isAbsent(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/** Local-only diagnostic text; never a stack trace and never upstream content. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message.split('\n')[0] ?? error.name : 'non-error throw'
}
