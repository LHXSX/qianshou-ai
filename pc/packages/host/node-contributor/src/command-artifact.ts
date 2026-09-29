/** Shared native command execution; task adapters supply configuration, never transport or upload. */
import { execFile, type ExecFileOptions } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { isAbsolute, relative, sep } from 'node:path'
import { promisify } from 'node:util'
import { ComputeError } from '@deepseek-ai/dsh-compute-core'
import type { ArtifactOrderAdapter } from './artifact-order.ts'

const exec = promisify(execFile)
const MAX_BYTES = 16 * 1024 * 1024

/** Trusted command seam; fixtures may replace subprocess execution without touching real owner files. */
export type NativeProgramRunner = (program: string, args: string[], options: ExecFileOptions) => Promise<{ stdout: string }>
export const executeNativeProgram: NativeProgramRunner = async (program, args, options) => {
  const result = await exec(program, args, options)
  return { stdout: String(result.stdout) }
}

/** Standard local output metadata, checked against actual bytes before the shared uploader runs. */
export interface NativeArtifactOutput {
  readonly path: string
  readonly filename: string
  readonly contentType: 'image/gif' | 'video/mp4'
  readonly bytes: number
  readonly sha256: string
}

/** Owner-local invocation resolved after the current binding and prior local trial are checked. */
export interface NativeArtifactCommand {
  readonly program: string
  readonly args: string[]
  readonly env: NodeJS.ProcessEnv
  readonly timeoutMs: number
  normalizeResult(value: unknown): NativeArtifactOutput
  verifyOutput(output: NativeArtifactOutput, signal: AbortSignal): Promise<void>
}

/** A native skill owns the ABI and configuration; dispatch, workspace validation and upload stay shared. */
export interface NativeArtifactCommandBinding extends Omit<ArtifactOrderAdapter, 'run'> {
  command(this: void, input: Parameters<ArtifactOrderAdapter['run']>[0]): Promise<NativeArtifactCommand>
}

/** Execute one configured native command and check its output manifest; no network dispatch or upload here. */
export function createCommandArtifactAdapter(binding: NativeArtifactCommandBinding,
  program: NativeProgramRunner = executeNativeProgram): ArtifactOrderAdapter {
  const { command, ...adapter } = binding
  return { ...adapter, async run(input) {
    input.signal.throwIfAborted()
    const invocation = await command(input)
    const root = await realpath(input.workspacePath)
    const { stdout } = await program(invocation.program, invocation.args, { cwd: root, signal: input.signal,
      timeout: invocation.timeoutMs, maxBuffer: 64 * 1024, windowsHide: true, env: invocation.env })
    const output = invocation.normalizeResult(JSON.parse(stdout))
    const path = await realpath(output.path)
    const offset = relative(root, path)
    const stat = await lstat(output.path)
    if (!offset || offset === '..' || offset.startsWith('..' + sep) || isAbsolute(offset)
      || !stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > MAX_BYTES) {
      throw new ComputeError('COMPUTE_NATIVE_OUTPUT_INVALID', 422)
    }
    const bytes = await readFile(path)
    if (bytes.length !== output.bytes || bytes.length !== stat.size
      || createHash('sha256').update(bytes).digest('hex') !== output.sha256) {
      throw new ComputeError('COMPUTE_NATIVE_OUTPUT_CHANGED', 422)
    }
    await invocation.verifyOutput(output, input.signal)
    input.signal.throwIfAborted()
    return { path, filename: output.filename, contentType: output.contentType }
  } }
}
