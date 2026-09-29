/**
 * Isolated inline runners: an injected agent session for every type the
 * operator listed, and a local `word_count` document only when that landing
 * was not listed.
 *
 * `word_count` and `text.transform` are one landing. Listing either one sends
 * both to the agent. The agent session is never the CEO default route. The
 * admitted prompt is the user message, and the assistant reply is the result.
 * On this landing the reply is carried in `result_lines` and `summary_text`
 * so the publisher can read it. A missing agent or an unlisted type throws `COMPUTE_ISOLATED_SESSION_UNAVAILABLE`
 * and does not open a model request. The local counter is not used to replace
 * that reply.
 */
import { createHash } from 'node:crypto'
import { capabilityIdIfRegistered } from '../developer-task.ts'
import { ComputeError } from '../errors.ts'
import { ComputeCapabilityId } from '../protocol.ts'
import type { IsolatedInlineRunner } from './inline-session-consumer.ts'

/** Task types this process can run without a model. */
export const ISOLATED_INLINE_TASK_TYPES = Object.freeze(['word_count'] as const)
/** Semantic id this runner owns; preferred landing stays `word_count`. */
export const TEXT_TRANSFORM_CAPABILITY_ID = ComputeCapabilityId('text.transform')

/** One isolated agent turn that must not inherit a parent conversation. */
export interface IsolatedAgentSession {
  /**
   * Run one admitted inline assignment in a fresh agent session.
   * @param input - Catalogue type, inline UTF-8 and the attempt abort signal.
   * @returns UTF-8 text for `result.txt` and the Edge inline output.
   */
  run(input: { taskType: string; inlineInput: string; signal: AbortSignal }): Promise<{ text: string }>
}

/** Optional agent session and the catalogue types it may run. */
export interface IsolatedInlineRunnerOptions {
  /** Isolated agent driver; omitted types other than `word_count` stay unavailable. */
  readonly agent?: IsolatedAgentSession
  /** Catalogue types the injected agent may run. */
  readonly agentTaskTypes?: readonly string[]
}

/**
 * Built-in `word_count` landing, or {@link TEXT_TRANSFORM_CAPABILITY_ID}.
 * Other `text.transform` landings (`base64_decode` / `json_validate` / `text_sort`) stay unavailable.
 * @param taskType - Catalogue landing or registry semantic id.
 * @returns True when this process can run the scheduler-shaped word-count document.
 */
function isBuiltInWordCount(taskType: string): boolean {
  return (ISOLATED_INLINE_TASK_TYPES as readonly string[]).includes(taskType) || taskType === TEXT_TRANSFORM_CAPABILITY_ID
}

/**
 * Whether this process can run one task type locally or through an injected agent.
 * @param taskType - Catalogue or operator-supplied type id.
 * @param agentTaskTypes - Types the injected agent session is allowed to run.
 * @returns True for `word_count`, its semantic id `text.transform`, or a listed agent type.
 */
export function hasIsolatedInlineRunner(taskType: string, agentTaskTypes: readonly string[] = []): boolean {
  return isBuiltInWordCount(taskType) || agentTaskTypes.includes(taskType)
}

/**
 * Registry capability ids this process can actually run from the listed landings.
 * Landing names such as `word_count` are not returned; unregistered types are omitted.
 * @param allowedTaskTypes - Catalogue types this node lists on the connector.
 * @param agentTaskTypes - Types the injected agent session is allowed to run.
 * @returns Sorted semantic ids. Empty when no listed type both runs and is registered.
 */
export function runnerOwnedCapabilityIds(
  allowedTaskTypes: readonly string[],
  agentTaskTypes: readonly string[] = [],
  verifiedLocalTaskTypes: readonly string[] = [],
): readonly string[] {
  const ids = new Set<string>()
  for (const taskType of allowedTaskTypes) {
    if (!hasIsolatedInlineRunner(taskType, agentTaskTypes) && !verifiedLocalTaskTypes.includes(taskType)) continue
    const id = capabilityIdIfRegistered(taskType)
    if (id !== undefined) ids.add(id)
  }
  return [...ids].sort()
}

/**
 * Dispatch one admitted inline assignment to a local runner or injected agent.
 * Unknown types throw `COMPUTE_ISOLATED_SESSION_UNAVAILABLE` and do not call a model.
 * @param options - Optional isolated agent session and its advertised types.
 * @returns An isolated runner keyed by `taskType`.
 */
export function createIsolatedInlineRunner(options: IsolatedInlineRunnerOptions = {}): IsolatedInlineRunner {
  const agentTypes = new Set(options.agentTaskTypes ?? [])
  return async ({ taskType, inlineInput, signal }) => {
    if (signal.aborted) throw new ComputeError('COMPUTE_INLINE_SESSION_ABORTED', 499)
    if (options.agent !== undefined && agentOwns(taskType, agentTypes)) {
      const result = await options.agent.run({ taskType, inlineInput, signal })
      if (!isBuiltInWordCount(taskType)) return result
      return { text: carryReply(result.text) }
    }
    if (isBuiltInWordCount(taskType)) return { text: runWordCount(inlineInput) }
    throw new ComputeError('COMPUTE_ISOLATED_SESSION_UNAVAILABLE', 503)
  }
}

/**
 * Whether the injected agent runs this type.
 * `word_count` and `text.transform` are one landing: listing either sends both.
 * @param taskType - Catalogue landing or semantic id on the assignment.
 * @param agentTypes - Types named for the isolated session.
 * @returns True when this assignment must not use the local counter.
 */
function agentOwns(taskType: string, agentTypes: ReadonlySet<string>): boolean {
  if (agentTypes.has(taskType)) return true
  if (!isBuiltInWordCount(taskType)) return false
  for (const listed of agentTypes) {
    if (isBuiltInWordCount(listed)) return true
  }
  return false
}

/**
 * Carry one specialist reply in the document this landing already returns.
 * The reply text is copied into `summary_text` and a single `result_lines` entry.
 * @param reply - Assistant text from the isolated session.
 * @returns UTF-8 JSON for `result.txt` and the Edge inline output.
 */
function carryReply(reply: string): string {
  return JSON.stringify({
    status: 'ok',
    schema_version: 'v1',
    task_type: 'word_count',
    summary_text: reply,
    result_lines: [reply],
  })
}

/** Token pattern of the scheduler's own `word_count` executor (`[\w\u4e00-\u9fff]+` with Unicode). */
const WORD_COUNT_TOKEN = /[\p{L}\p{N}_]+/gu
/** `top_n` default of that executor, used verbatim because the offer seam carries no `top_n`. */
const WORD_COUNT_TOP_N = 100
/** Schema version the merged payload reports. */
const WORD_COUNT_SCHEMA_VERSION = 'v1'

/** Fingerprint the loaded built-in adapter code and its output-affecting constants. */
export const BUILTIN_WORD_COUNT_ADAPTER_DIGEST = createHash('sha256')
  .update([runWordCount.toString(), WORD_COUNT_TOKEN.source, WORD_COUNT_TOKEN.flags,
    String(WORD_COUNT_TOP_N), WORD_COUNT_SCHEMA_VERSION].join('\0'))
  .digest('hex')

/**
 * Run `word_count` in the shape the scheduler actually merges.
 *
 * The contract is copied from the scheduler's own executor, read read-only from
 * `GET /api/v8/scripts/word_count.py/source` (2026-09-17): the shard result is a JSON
 * document, and the platform merges its `result_lines` (`aggregator: lines_merge`).
 * This process used to answer with a bare number ("4"); the merger cannot parse that,
 * so a finished, paid task merged to `result_lines: []` and `unique_tokens: 0` and the
 * user received an empty deliverable.
 *
 * Two facts are reported honestly rather than reproduced: this process has no Python and
 * no jieba dictionary, so CJK runs stay whole tokens exactly as that script behaves
 * without jieba, and `jieba_enabled` is `false` instead of being claimed.
 * @param inlineInput - Inline UTF-8 slice the scheduler sent for this shard.
 * @returns The UTF-8 JSON document that becomes `result.txt` and the Edge inline output.
 */
function runWordCount(inlineInput: string): string {
  const started = Date.now()
  // The script lowercases before matching; its `Counter.most_common` is count-descending
  // with first-seen order kept for ties, which is what a stable sort over insertion order gives.
  const counts = new Map<string, number>()
  for (const match of inlineInput.toLowerCase().matchAll(WORD_COUNT_TOKEN)) {
    counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((left, right) => right[1] - left[1]).slice(0, WORD_COUNT_TOP_N)
  let total = 0
  for (const count of counts.values()) total += count
  return JSON.stringify({
    status: 'ok',
    schema_version: WORD_COUNT_SCHEMA_VERSION,
    task_type: 'word_count',
    elapsed_ms: Math.max(0, Date.now() - started),
    summary: {
      input_bytes: Buffer.byteLength(inlineInput, 'utf8'),
      total_tokens: total,
      unique_tokens: counts.size,
      top_n_returned: top.length,
      jieba_enabled: false,
    },
    result_lines: top.map(([token, count]) => `${token}\t${count}`),
  })
}
