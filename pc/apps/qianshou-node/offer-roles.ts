/**
 * Scout, worker, verifier, and courier for one inline offer.
 *
 * The worker's own success flag never authorizes a send. The verifier reads
 * the artifact file and the same consumer reader that opens a deliverable.
 * The courier sends only when that verdict is `passed`.
 */
import { readFile } from 'node:fs/promises'
import { parseWorkloadResult } from '@deepseek-ai/dsh-compute-core/workload-result.ts'

/** How many inline offers may run in this process at once. */
/**
 * 同时在跑的内联任务上限。
 *
 * 为什么不再是写死的 1：平台会把一个工作负载的分片**在同一秒内推下来**
 * （实测：4 个分片在 8 毫秒内全部到达），上限 1 会把其余分片一律
 * `EDGE_CONCURRENCY_LIMIT` 打回、靠平台重派（实测 attempt 1→2）才做完。
 * 调高后同秒分片直接并行，不再来回重派。
 *
 * 取值：环境变量 `QIANSHOU_NODE_MAX_CONCURRENT`，默认 4；非法或越界（1..64）回落默认值。
 * 仍然**有界**——不设上限会让一台机器被同时推来的分片压垮。
 */
export const OFFER_CONCURRENCY_LIMIT = ((): number => {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.QIANSHOU_NODE_MAX_CONCURRENT
  const parsed = Number.parseInt(raw ?? '', 10)
  if (Number.isInteger(parsed) && parsed >= 1 && parsed <= 64) return parsed
  return 4
})()

/** Verdict the courier is allowed to see. `undetermined` is not a pass. */
export type ArtifactVerdict = {
  readonly outcome: 'passed' | 'failed' | 'undetermined'
  readonly code: string
}

let activeOffers = 0

/**
 * Suggest installed names. This return value cannot change a declaration or open intake.
 * @param software - Names a probe already reported.
 * @returns A frozen suggestion list whose gate flags stay false.
 */
export function scoutLocalSuggestions(software: readonly string[]): {
  readonly suggestions: readonly string[]
  readonly mayChangeDeclaration: false
  readonly mayOpenGate: false
} {
  return { suggestions: Object.freeze([...software]), mayChangeDeclaration: false, mayOpenGate: false }
}

/**
 * Run one worker. A throw becomes a crash record and does not escape.
 * @param run - The isolated inline execution.
 * @returns The worker text plus its claim, or a crash that carries no text.
 */
export async function runBoundedWorker(
  run: () => Promise<string>,
): Promise<{ readonly claimedOk: true; readonly text: string } | { readonly claimedOk: false; readonly crashed: true }> {
  try {
    return { claimedOk: true, text: await run() }
  } catch {
    return { claimedOk: false, crashed: true }
  }
}

/**
 * Reserve one concurrency slot.
 * @returns False when the process is already at {@link OFFER_CONCURRENCY_LIMIT}.
 */
export function tryEnterOffer(): boolean {
  if (activeOffers >= OFFER_CONCURRENCY_LIMIT) return false
  activeOffers += 1
  return true
}

/** Release one slot taken by {@link tryEnterOffer}. */
export function leaveOffer(): void {
  activeOffers = Math.max(0, activeOffers - 1)
}

/**
 * Read an artifact file and judge it with the consumer reader.
 *
 * The worker's claim is not a parameter. A missing or unreadable file is
 * `undetermined`. A file the reader cannot turn into deliverable text is
 * `failed`.
 * @param artifactPath - The task directory file this process just wrote.
 * @returns The verdict the courier must consult.
 */
export async function verifyArtifactFile(artifactPath: string): Promise<ArtifactVerdict> {
  let text: string
  try {
    text = await readFile(artifactPath, 'utf8')
  } catch {
    return { outcome: 'undetermined', code: 'EDGE_ARTIFACT_UNREADABLE' }
  }
  let parsed: unknown
  try { parsed = JSON.parse(text) } catch {
    return { outcome: 'undetermined', code: 'EDGE_ARTIFACT_UNREADABLE' }
  }
  try {
    const read = parseWorkloadResult('artifact', {
      ok: true, id: 'artifact', status: 'DONE', result: parsed,
    }, 1_048_576)
    if (read.inlineOutput === null || read.inlineOutput.length === 0) {
      return { outcome: 'failed', code: 'EDGE_ARTIFACT_UNREADABLE' }
    }
  } catch {
    return { outcome: 'undetermined', code: 'EDGE_ARTIFACT_UNREADABLE' }
  }
  return { outcome: 'passed', code: 'EDGE_ARTIFACT_VERIFIED' }
}

/**
 * Whether the courier may put this artifact on the wire.
 *
 * `workerClaimedOk` is accepted so a caller can pass the worker flag and still
 * be ignored: only `passed` delivers.
 * @param verdict - The verifier's own reading.
 * @param _workerClaimedOk - The worker's claim. It does not affect the result.
 * @returns True only when the verifier passed.
 */
export function courierAccepts(verdict: Pick<ArtifactVerdict, 'outcome'>, _workerClaimedOk: boolean): boolean {
  return verdict.outcome === 'passed'
}
