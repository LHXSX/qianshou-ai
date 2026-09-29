/** Concrete OpenSSH and public GitHub read providers. */
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-subprocess'
import type {} from '@deepseek-ai/dsh-credentials'
import { z } from 'zod'
import { runCli } from './process.ts'
import type { ProcessLimits } from './process.ts'
import type { GithubConnection, GithubRepositoryPage, SshConnection, SshInspection } from './types.ts'

/** Host-only resolved provider settings. */
export interface ProviderConfig extends ProcessLimits { sshCommand: string; ghCommand: string }
const githubUser = z.object({ login: z.string().min(1).max(100) })
const repoSchema = z.object({ name: z.string().max(200), full_name: z.string().max(300), private: z.boolean(),
  html_url: z.string().url().refine(value => new URL(value).origin === 'https://github.com'), default_branch: z.string().max(200).nullable() })

/** Read a bounded JSON GitHub response without exposing tokens or server diagnostics.
 * @param ctx - Host services.
 * @param connection - Saved GitHub authentication method.
 * @param endpoint - Fixed implementation-owned endpoint path.
 * @param config - Bounded provider settings.
 * @param signal - Operation cancellation and deadline.
 * @returns Parsed upstream JSON.
 */
async function githubJson(ctx: Context, connection: GithubConnection, endpoint: string, config: ProviderConfig, signal: AbortSignal): Promise<unknown> {
  if (connection.github.auth === 'gh') {
    const result = await runCli(ctx.subprocess, config.ghCommand, ['api', '--hostname', 'github.com', '--method', 'GET', endpoint], 'GH_UNAVAILABLE', config, signal)
    try { return JSON.parse(result.stdout) }
    catch { throw new Error('INVALID_GITHUB_RESPONSE') }
  }
  const ref = connection.github.credentialRef
  if (ref === undefined) throw new Error('CREDENTIAL_UNAVAILABLE')
  const hit = await ctx.credentials.resolve(credentialRef(ref))
  signal.throwIfAborted()
  if (!hit?.value) throw new Error('CREDENTIAL_UNAVAILABLE')
  const response = await fetch(`https://api.github.com/${endpoint}`, { signal, redirect: 'error', headers: {
    Authorization: `Bearer ${hit.value}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28',
  } }).catch(() => { signal.throwIfAborted(); throw new Error('CONNECTION_AUTH_OR_NETWORK_FAILED') })
  if (!response.ok) { await response.body?.cancel(); throw new Error(response.status === 401 || response.status === 403 ? 'GITHUB_AUTH_REJECTED' : 'GITHUB_REQUEST_FAILED') }
  const reader = response.body?.getReader()
  if (!reader) throw new Error('INVALID_GITHUB_RESPONSE')
  const chunks: Uint8Array[] = []; let length = 0; let done = false
  try {
    for (;;) {
      signal.throwIfAborted()
      const part = await reader.read()
      if (part.done) { done = true; break }
      length += part.value.length
      if (length > config.outputBytes) throw new Error('CONNECTION_OUTPUT_LIMIT')
      chunks.push(part.value)
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) }
    catch { throw new Error('INVALID_GITHUB_RESPONSE') }
  } finally { if (!done) await reader.cancel().catch(() => {}); reader.releaseLock() }
}

/** Verify the authenticated public GitHub identity with a real user endpoint.
 * @param ctx - Host services.
 * @param connection - Saved GitHub connection.
 * @param config - Provider settings.
 * @param signal - Operation cancellation.
 * @returns Confirmed account login.
 */
export async function githubIdentity(ctx: Context, connection: GithubConnection, config: ProviderConfig, signal: AbortSignal): Promise<string> {
  const parsed = githubUser.safeParse(await githubJson(ctx, connection, 'user', config, signal))
  if (!parsed.success) throw new Error('INVALID_GITHUB_RESPONSE')
  return parsed.data.login
}

/** Read one real repository page available to the authenticated account.
 * @param ctx - Host services.
 * @param connection - Saved GitHub connection.
 * @param page - One-based upstream page.
 * @param config - Provider settings.
 * @param signal - Operation cancellation.
 * @returns Bounded public repository metadata and an optional next page.
 */
export async function githubRepositories(ctx: Context, connection: GithubConnection, page: number, config: ProviderConfig, signal: AbortSignal): Promise<GithubRepositoryPage> {
  const parsed = z.array(repoSchema).max(50).safeParse(await githubJson(ctx, connection, `user/repos?per_page=50&page=${page}&sort=updated`, config, signal))
  if (!parsed.success) throw new Error('INVALID_GITHUB_RESPONSE')
  return { repositories: parsed.data.map(repo => ({ name: repo.name, fullName: repo.full_name, private: repo.private, url: repo.html_url, defaultBranch: repo.default_branch })),
    nextPage: parsed.data.length === 50 && page < 1000 ? page + 1 : null }
}

/** Inspect a trusted OpenSSH destination with one fixed read-only command.
 * @param ctx - Host services.
 * @param connection - Saved destination and optional absolute identity-file path.
 * @param config - Local process configuration.
 * @param signal - Operation cancellation.
 * @returns Remote OS, login directory and user from the actual SSH response.
 */
export async function inspectSsh(ctx: Context, connection: SshConnection, config: ProviderConfig, signal: AbortSignal): Promise<SshInspection> {
  const target = connection.ssh
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'PermitLocalCommand=no',
    '-o', 'ClearAllForwardings=yes', '-o', 'ForwardAgent=no', '-o', 'ControlMaster=no', '-o', 'ControlPath=none',
    '-o', `ConnectTimeout=${Math.max(1, Math.floor(config.timeoutMs / 1000))}`, '-p', String(target.port), '-l', target.user]
  if (target.keyPath !== undefined) args.push('-i', target.keyPath, '-o', 'IdentitiesOnly=yes')
  args.push('--', target.host, 'uname -s && pwd && id -un')
  const result = await runCli(ctx.subprocess, config.sshCommand, args, 'SSH_UNAVAILABLE', config, signal)
  const lines = result.stdout.trim().split(/\r?\n/)
  if (lines.length !== 3 || lines.some(line => line.length === 0 || line.length > 4096 || /[\0-\x08\x0b-\x1f]/.test(line))) throw new Error('INVALID_SSH_RESPONSE')
  return { platform: lines[0]!, directory: lines[1]!, user: lines[2]! }
}
