/** Read-only inspection of an explicitly selected loopback ComfyUI installation. */
import { createHash } from 'node:crypto'
import { NodeContributorError } from './errors.ts'

const GROUPS = ['checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'loras'] as const

/** Local observations never grant dispatch eligibility or publish private filenames. */
export interface LocalMediaDiscovery {
  readonly adapter: 'comfyui'
  readonly revision: string
  readonly discovered: true
  readonly dispatchReady: false
  readonly requiresWorkflowVerification: true
  readonly devices: readonly { name: string; type: string; totalVramMb: number; freeVramMb: number }[]
  readonly models: readonly { group: typeof GROUPS[number]; name: string }[]
}

function fail(code: string): never { throw new NodeContributorError(`MEDIA_DISCOVERY_${code}`) }
function row(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail('RESPONSE_INVALID')
  return value as Record<string, unknown>
}
function label(value: unknown): string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 256 || /[\x00-\x1f\x7f]/u.test(value)) fail('RESPONSE_INVALID')
  return value
}
function mb(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail('RESPONSE_INVALID')
  return Math.floor(value / 1048576)
}

/** Accept only a direct local origin; redirects and remote destinations are refused.
 * @param origin - Owner-selected loopback ComfyUI origin.
 * @returns Normalized origin for fixed read-only routes.
 */
export function localMediaOrigin(origin: string): string {
  let url: URL
  try { url = new URL(origin) } catch { fail('ORIGIN_INVALID') }
  if (url.protocol !== 'http:' || !['127.0.0.1', '[::1]'].includes(url.hostname)
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash || !url.port) fail('ORIGIN_INVALID')
  return url.origin
}

async function json(origin: string, path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(origin + path, { signal, redirect: 'error', credentials: 'omit', cache: 'no-store',
    headers: { Accept: 'application/json' } })
  if (!response.ok || !response.headers.get('content-type')?.startsWith('application/json')) {
    await response.body?.cancel(); fail('UNAVAILABLE')
  }
  const reader = response.body?.getReader()
  if (reader === undefined) fail('RESPONSE_INVALID')
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const next = await reader.read()
      if (next.done) break
      length += next.value.length
      if (length > 262144) fail('RESPONSE_TOO_LARGE')
      chunks.push(next.value)
    }
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }
  catch { fail('RESPONSE_INVALID') }
}

/** Inspect device memory and supported model groups without starting or enrolling a workflow.
 * @param selectedOrigin - Explicit loopback endpoint, never a URL from a remote task.
 * @param options - Read deadline and caller cancellation.
 * @returns Redacted local inventory; unavailable or malformed endpoints raise a finite error code.
 */
export async function discoverLocalMedia(selectedOrigin: string,
  options: { timeoutMs: number; signal: AbortSignal }): Promise<LocalMediaDiscovery> {
  const origin = localMediaOrigin(selectedOrigin)
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100 || options.timeoutMs > 30000) fail('DEADLINE_INVALID')
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)])
  try {
    const stats = row(await json(origin, '/system_stats', signal))
    if (!Array.isArray(stats.devices) || stats.devices.length > 16) fail('RESPONSE_INVALID')
    const devices = stats.devices.map((value) => {
      const device = row(value)
      const totalVramMb = mb(device.vram_total); const freeVramMb = mb(device.vram_free)
      if (freeVramMb > totalVramMb) fail('RESPONSE_INVALID')
      return { name: label(device.name), type: label(device.type), totalVramMb, freeVramMb }
    })
    const available = await json(origin, '/models', signal)
    if (!Array.isArray(available) || available.length > 128 || available.some(value => typeof value !== 'string')) fail('RESPONSE_INVALID')
    const models: { group: typeof GROUPS[number]; name: string }[] = []
    for (const group of GROUPS) {
      if (!available.includes(group)) continue
      const names = await json(origin, '/models/' + group, signal)
      if (!Array.isArray(names) || names.length > 1000) fail('RESPONSE_INVALID')
      for (const value of names) {
        const name = label(value)
        // Names remain local. Absolute paths and traversal are never accepted as model identifiers.
        if (/^(?:\/|\\|[A-Za-z]:)/u.test(name) || name.split(/[\/\\]/u).includes('..')) fail('RESPONSE_INVALID')
        models.push({ group, name })
      }
    }
    models.sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name))
    const revision = createHash('sha256').update(JSON.stringify({ adapter: 'comfyui',
      devices: devices.map(({ name, type, totalVramMb }) => ({ name, type, totalVramMb })), models })).digest('hex')
    return { adapter: 'comfyui', revision, discovered: true, dispatchReady: false,
      requiresWorkflowVerification: true, devices, models }
  } catch (error) {
    if (error instanceof NodeContributorError) throw error
    fail(options.signal.aborted ? 'CANCELLED' : 'UNAVAILABLE')
  }
}
