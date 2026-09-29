/** Bounded CLI execution through the existing process-tree owner. */
import type { SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'

/** Execution configuration resolved once by the connection plugin. */
export interface ProcessLimits { cwd: string; timeoutMs: number; outputBytes: number; graceMs: number }
/** Public process output after a successful and fully drained exit. */
export interface CliOutput { stdout: string }

/** Run fixed argv and await owned process-tree quiescence on every outcome.
 * @param subprocess - Installed Host process provider.
 * @param command - Configured executable name or absolute path.
 * @param args - Direct arguments; never interpolated into a shell.
 * @param unavailableCode - Provider-specific diagnostic for a missing configured executable.
 * @param limits - Deadline, byte cap and local directory.
 * @param signal - Operation cancellation.
 * @returns Bounded successful stdout; raw stderr never crosses to HTTP or model logs.
 */
export async function runCli(subprocess: SubprocessRuntime, command: string, args: string[], unavailableCode: 'SSH_UNAVAILABLE' | 'GH_UNAVAILABLE', limits: ProcessLimits, signal: AbortSignal): Promise<CliOutput> {
  signal.throwIfAborted()
  const executable = await subprocess.resolveExecutable(command, undefined, signal).catch(() => {
    signal.throwIfAborted(); throw new Error(unavailableCode)
  })
  signal.throwIfAborted()
  const child = subprocess.spawn({ argv: [executable, ...args], cwd: limits.cwd,
    stdio: { stdin: 'ignore', stdout: { maxBytes: limits.outputBytes }, stderr: { maxBytes: 4096 } },
    graceMs: limits.graceMs, signal,
    env: { GH_PROMPT_DISABLED: '1', GH_PAGER: 'cat', PAGER: 'cat', GIT_TERMINAL_PROMPT: '0' },
  })
  try {
    const outcome = await child.done
    signal.throwIfAborted()
    if (outcome.exitCode !== 0 || outcome.signal !== null) throw new Error('CONNECTION_AUTH_OR_NETWORK_FAILED')
    const output = child.collected.stdout?.readFrom(0)
    if (output === undefined || output.lossy) throw new Error('CONNECTION_OUTPUT_LIMIT')
    return { stdout: output.text }
  } finally {
    child.terminate()
    await child.waitForExit()
  }
}
