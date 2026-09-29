/** Read-only SSH/GitHub connection capability, provider and authenticated UI routes. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { ConnectionsRegistry } from './registry.ts'
import { registerRoutes } from './routes.ts'
export { ConnectionsRegistry } from './registry.ts'
export type * from './types.ts'

/** Deployment-owned storage, local executables and request bounds. */
export interface Config {
  /** Absolute connection-state file; empty uses the DSH_HOME qianshou default. */
  statePath?: string
  /** OpenSSH executable name or absolute path. */
  sshCommand?: string
  /** GitHub CLI executable name or absolute path. */
  ghCommand?: string
  /** Upstream process timeout in milliseconds (1000–60000). */
  timeoutMs?: number
  /** Maximum captured stdout or stderr bytes per process. */
  outputBytes?: number
  /** Grace period for terminating an upstream process in milliseconds. */
  graceMs?: number
  /** Maximum number of connection operations running concurrently. */
  maxConcurrent?: number
}
/** Runtime-validated deployment configuration. */
export const Config: z<Config> = z.object({
  statePath: z.string().default(''), sshCommand: z.string().default('ssh'), ghCommand: z.string().default('gh'),
  timeoutMs: z.number().min(1000).max(60000).default(15000), outputBytes: z.number().step(1).min(4096).max(1048576).default(262144),
  graceMs: z.number().min(100).max(5000).default(1000), maxConcurrent: z.number().step(1).min(1).max(16).default(4),
})
/** Cordis plugin identity. */
export const name = 'qianshou-connections'
/** Services required for live authorization, process ownership and browser authentication. */
export const inject = ['connection', 'subprocess', 'credentials', 'agents', 'agentPresets']

/** Load connection metadata and install reversible Host capabilities.
 * @param ctx - Authenticated Host composition.
 * @param config - Validated deployment settings.
 * @returns Completion after metadata validation and route registration.
 */
export async function apply(ctx: Context, config: Config = {}): Promise<void> {
  const home = process.env.DSH_HOME ?? join(homedir(), '.deepseek-harness')
  const resolved = { statePath: config.statePath || join(home, 'qianshou', 'connections.json'), cwd: home,
    sshCommand: config.sshCommand ?? 'ssh', ghCommand: config.ghCommand ?? 'gh', timeoutMs: config.timeoutMs ?? 15000,
    outputBytes: config.outputBytes ?? 262144, graceMs: config.graceMs ?? 1000, maxConcurrent: config.maxConcurrent ?? 4 }
  if (!isAbsolute(resolved.statePath) || !isAbsolute(resolved.cwd)) throw new Error('connections: statePath and DSH_HOME must be absolute')
  const registry = await ConnectionsRegistry.open(ctx, resolved)
  ctx.provide('connections', registry)
  registerRoutes(ctx, registry)
  ctx.on('credentials/reference-updated', ref => registry.credentialChanged(ref))
  ctx.effect(() => () => registry.close(), 'connections: drain owned operations')
}
