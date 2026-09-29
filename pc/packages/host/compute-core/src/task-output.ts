/** Verify local result files before handing references to an artifact-transfer provider. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, realpath } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import type { ComputeExecutionResult, ComputeOutputReference } from './executor.ts'
import { ComputeError } from './errors.ts'

/** Check actual files against plugin metadata and the assignment's aggregate output limit.
 * @param workspacePath - Private directory owned by the current attempt.
 * @param result - Plugin output references; relative paths resolve only inside the workspace.
 * @param maxOutputBytes - Assignment's total output allowance.
 * @param signal - Task cancellation checked between file reads.
 * @returns Sanitized references for verified regular files, with canonical workspace paths.
 */
export async function verifyTaskOutputs(
  workspacePath: string,
  result: ComputeExecutionResult,
  maxOutputBytes: number,
  signal: AbortSignal,
): Promise<ComputeExecutionResult> {
  const root = await realpath(workspacePath)
  const outputs: ComputeOutputReference[] = []
  const seen = new Set<string>()
  let total = 0
  for (const output of result.outputs) {
    signal.throwIfAborted()
    const requested = resolve(root, output.path)
    assertContained(root, requested)
    const path = await realpath(requested)
    assertContained(root, path)
    if ((await lstat(requested)).isSymbolicLink() || seen.has(path)) throw new ComputeError('COMPUTE_OUTPUT_PATH_INVALID', 422)
    seen.add(path)
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
    try {
      const before = await file.stat()
      if (!before.isFile() || before.nlink !== 1 || !Number.isSafeInteger(before.size) || before.size !== output.bytes) throw new ComputeError('COMPUTE_OUTPUT_FILE_INVALID', 422)
      total += before.size
      if (!Number.isSafeInteger(total) || total > maxOutputBytes) throw new ComputeError('COMPUTE_OUTPUT_LIMIT_EXCEEDED', 413)
      const hash = createHash('sha256')
      const buffer = Buffer.alloc(64 * 1024)
      let bytes = 0
      while (true) {
        signal.throwIfAborted()
        const read = await file.read(buffer, 0, buffer.length, bytes)
        if (!read.bytesRead) break
        bytes += read.bytesRead
        if (bytes > before.size) throw new ComputeError('COMPUTE_OUTPUT_FILE_CHANGED', 422)
        hash.update(buffer.subarray(0, read.bytesRead))
      }
      const after = await file.stat()
      if (bytes !== before.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new ComputeError('COMPUTE_OUTPUT_FILE_CHANGED', 422)
      if (hash.digest('hex') !== output.sha256) throw new ComputeError('COMPUTE_OUTPUT_DIGEST_MISMATCH', 422)
      outputs.push(Object.freeze({ name: output.name, path, bytes, sha256: output.sha256 }))
    } finally { await file.close() }
  }
  signal.throwIfAborted()
  return Object.freeze({
    outputs: Object.freeze(outputs),
    ...(result.metadata === undefined ? {} : { metadata: Object.freeze({ ...result.metadata }) }),
  })
}

function assertContained(root: string, path: string): void {
  const local = relative(root, path)
  if (!local || local === '..' || local.startsWith('..' + sep) || isAbsolute(local)) throw new ComputeError('COMPUTE_OUTPUT_PATH_INVALID', 422)
}
