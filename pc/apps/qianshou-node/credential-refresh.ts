/**
 * The only refresh-token writer for a rotated platform pair.
 *
 * The platform invalidates a refresh token on the first successful
 * `POST /api/v8/auth/refresh`. Returning that pair before it is on disk is
 * how a process loses the only remaining credential. This function writes the
 * new pair with a rename, then returns it. A failed write leaves the previous
 * file bytes in place.
 */
import { readFile } from 'node:fs/promises'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'

/** Injected refresh call. Tests pass this; production passes a fetch wrapper. */
export interface RefreshTransport {
  /** @param body - The current refresh token, and nothing else. */
  (body: { readonly refresh_token: string }): Promise<{ readonly status: number; readonly text: string }>
}

/** What the caller may do after one refresh attempt. Tokens appear only on `rotated`. */
export type RefreshResult =
  | { readonly state: 'rotated'; readonly accessToken: string; readonly refreshToken: string }
  | { readonly state: 'relogin'; readonly code: 'AUTH_REFRESH_REJECTED' | 'AUTH_REFRESH_UNREADABLE'; readonly raw: string }
  | { readonly state: 'persist-failed'; readonly code: 'AUTH_REFRESH_PERSIST_FAILED' }

/** One store plus the transport that talks to the platform. */
export interface RefreshCredentialOptions {
  /** Account file that already holds `refreshToken`, or will after the first success. */
  readonly storePath: string
  readonly transport: RefreshTransport
  /** Used only when the file has no `refreshToken` yet. */
  readonly currentRefreshToken?: string
  /** Test seam. Production uses {@link writeFileAtomic}. */
  readonly write?: (filename: string, content: string) => Promise<void>
}

const inflight = new Map<string, Promise<RefreshResult>>()

/**
 * Refresh once, persist the new pair, then return it.
 *
 * Concurrent callers of the same path share one in-flight attempt. The file
 * lock covers a second process. A 401 or a body that is not a token pair does
 * not touch the file. The raw body is kept on those failures so a later read
 * can show what the platform actually sent.
 * @param options - Store path, transport, and the optional seed token.
 * @returns The rotated pair, a re-login state, or a persist failure.
 */
export function refreshRotatedCredential(options: RefreshCredentialOptions): Promise<RefreshResult> {
  const existing = inflight.get(options.storePath)
  if (existing) return existing
  const attempt = rotate(options).finally(() => { inflight.delete(options.storePath) })
  inflight.set(options.storePath, attempt)
  return attempt
}

async function rotate(options: RefreshCredentialOptions): Promise<RefreshResult> {
  await mkdir(dirname(options.storePath), { recursive: true })
  return withFileLock(options.storePath, async () => {
    const previous = await readPrevious(options.storePath)
    const current = previous.refreshToken ?? options.currentRefreshToken
    if (current === undefined || current.length === 0) {
      return { state: 'relogin', code: 'AUTH_REFRESH_UNREADABLE', raw: '' }
    }
    const response = await options.transport({ refresh_token: current })
    if (response.status === 401 || response.status === 403) {
      return { state: 'relogin', code: 'AUTH_REFRESH_REJECTED', raw: response.text }
    }
    const parsed = readTokenPair(response.text)
    if (response.status !== 200 || parsed === null) {
      return { state: 'relogin', code: 'AUTH_REFRESH_UNREADABLE', raw: response.text }
    }
    let next: string
    try { next = mergeAccount(previous.text, parsed.accessToken, parsed.refreshToken) }
    catch { return { state: 'persist-failed', code: 'AUTH_REFRESH_PERSIST_FAILED' } }
    const write = options.write ?? ((filename, content) => writeFileAtomic(filename, content, { mode: 0o600 }))
    try {
      await write(options.storePath, next)
    } catch {
      return { state: 'persist-failed', code: 'AUTH_REFRESH_PERSIST_FAILED' }
    }
    return { state: 'rotated', accessToken: parsed.accessToken, refreshToken: parsed.refreshToken }
  }, { waitMs: 15_000 })
}

async function readPrevious(storePath: string): Promise<{ readonly text: string; readonly refreshToken: string | undefined }> {
  let text = ''
  try { text = await readFile(storePath, 'utf8') } catch { text = '' }
  let refreshToken: string | undefined
  try {
    const parsed: unknown = JSON.parse(text)
    if (record(parsed) && typeof parsed.refreshToken === 'string' && parsed.refreshToken.length > 0) refreshToken = parsed.refreshToken
  } catch { /* A missing or unreadable file is not a token. */ }
  return { text, refreshToken }
}

function mergeAccount(previous: string, accessToken: string, refreshToken: string): string {
  let base: Record<string, unknown> = {}
  if (previous.trim() !== '') {
    const parsed: unknown = JSON.parse(previous)
    if (!record(parsed)) throw new Error('AUTH_REFRESH_PERSIST_FAILED')
    base = { ...parsed }
  }
  base.accessToken = accessToken
  base.refreshToken = refreshToken
  return `${JSON.stringify(base)}\n`
}

function readTokenPair(text: string): { readonly accessToken: string; readonly refreshToken: string } | null {
  let value: unknown
  try { value = JSON.parse(text) } catch { return null }
  if (!record(value) || value.ok !== true || !record(value.tokens)) return null
  const accessToken = value.tokens.access_token
  const refreshToken = value.tokens.refresh_token
  if (!token(accessToken) || !token(refreshToken)) return null
  return { accessToken, refreshToken }
}

function token(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 8192 && !/[\r\n]/.test(value)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
