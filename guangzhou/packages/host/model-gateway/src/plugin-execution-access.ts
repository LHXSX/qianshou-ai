/** Account-bound self-use access to a reviewed program, isolated from CSV licenses and sales. */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, open, unlink } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, isAbsolute, join } from 'node:path'
import type { Principal } from './admin-routes.ts'
import { readReviewedExecutionArtifact, type PluginSubmissionOptions } from './plugin-submissions.ts'

export const PLUGIN_EXECUTION_ACCESS_PATH = '/qianshou-market/execution-access'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u
const SHA256 = /^[0-9a-f]{64}$/u
const ACCOUNT_BEARER = /^Bearer ([\x21-\x7e]{16,4096})$/u
const DOWNLOAD_BEARER = /^Bearer ([A-Za-z0-9_-]{43})$/u
const MAX_POST_BYTES = 1024
const MAX_LICENSE_BYTES = 2048
const MAX_TOKENS = 1000
const TOKEN_LIFETIME_MS = 5 * 60 * 1000

interface SelfLicense {
  readonly format: 'qianshou.execution-self-license.v1'
  readonly licenseId: string
  readonly submissionId: string
  readonly accountId: string
  readonly releaseId: string
  readonly packageSha256: string
  readonly grantedAt: number
  readonly scope: 'self-use-review-candidate'
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}
function only(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}
function licenseFile(dir: string, submissionId: string): string {
  return join(dir, `${submissionId}.execution-self-license.json`)
}
function headers(): Record<string, string> {
  return { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff' }
}
function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, headers())
  response.end(JSON.stringify(body))
}
function licenseValid(raw: unknown, expected: { readonly submissionId: string; readonly accountId: string;
  readonly releaseId: string; readonly packageSha256: string }): raw is SelfLicense {
  const row = object(raw)
  return row !== null && only(row, ['format', 'licenseId', 'submissionId', 'accountId',
    'releaseId', 'packageSha256', 'grantedAt', 'scope'])
    && row['format'] === 'qianshou.execution-self-license.v1'
    && typeof row['licenseId'] === 'string' && UUID.test(row['licenseId'])
    && row['submissionId'] === expected.submissionId && row['accountId'] === expected.accountId
    && row['releaseId'] === expected.releaseId && row['packageSha256'] === expected.packageSha256
    && typeof row['grantedAt'] === 'number' && Number.isSafeInteger(row['grantedAt'])
    && row['grantedAt'] > 0
    && row['scope'] === 'self-use-review-candidate'
}
async function readLicense(path: string, expected: Parameters<typeof licenseValid>[1]): Promise<SelfLicense | null> {
  let handle: Awaited<ReturnType<typeof open>>
  try { handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW) }
  catch (error) {
    if (object(error)?.['code'] === 'ENOENT') return null
    throw error
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.size > MAX_LICENSE_BYTES || (info.mode & 0o077) !== 0) {
      throw new Error('PLUGIN_EXECUTION_LICENSE_INVALID')
    }
    const bytes = await handle.readFile()
    if (bytes.length > MAX_LICENSE_BYTES) throw new Error('PLUGIN_EXECUTION_LICENSE_INVALID')
    let raw: unknown
    try { raw = JSON.parse(bytes.toString('utf8')) as unknown }
    catch { throw new Error('PLUGIN_EXECUTION_LICENSE_INVALID') }
    if (!licenseValid(raw, expected)) throw new Error('PLUGIN_EXECUTION_LICENSE_INVALID')
    return raw
  } finally { await handle.close() }
}
async function createLicense(path: string, value: SelfLicense): Promise<void> {
  const parent = dirname(path)
  const temporary = `${path}.${randomUUID()}.tmp`
  const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600)
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync() }
  finally { await handle.close() }
  try {
    await link(temporary, path)
    const directory = await open(parent, constants.O_RDONLY | constants.O_NOFOLLOW)
    try { await directory.sync() }
    finally { await directory.close() }
  } finally { await unlink(temporary).catch(() => undefined) }
}
async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try { await handle.sync() }
  finally { await handle.close() }
}
async function boundedPost(request: IncomingMessage): Promise<Record<string, unknown> | null> {
  const size = Number(request.headers['content-length'] ?? '0')
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_POST_BYTES
    || typeof request.headers['content-type'] !== 'string'
    || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers['content-type'])
    || request.headers['content-encoding'] !== undefined) return null
  const chunks: Buffer[] = []
  let length = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    length += bytes.length
    if (length > MAX_POST_BYTES) return null
    chunks.push(bytes)
  }
  try {
    const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, length))
    return object(JSON.parse(decoded) as unknown)
  } catch { return null }
}

/** Grant only the reviewed author's own account a durable private trial license and exact digest download.
 * @param options - Existing private review storage, fresh Shanghai Bearer verifier and clock.
 * @returns One strict public HTTP route for self-use claim and short-lived bytes access.
 */
export function createPluginExecutionAccessRoute(options: {
  readonly submissionOptions: PluginSubmissionOptions
  readonly authenticate: (request: Request) => Promise<Principal | null>
  readonly now?: () => number
}): { readonly kind: 'exact'; readonly path: typeof PLUGIN_EXECUTION_ACCESS_PATH;
  readonly handler: (request: IncomingMessage, response: ServerResponse) => Promise<void> } {
  const dir = options.submissionOptions.stagingDir
  if (dir !== undefined && !isAbsolute(dir)) throw new Error('PLUGIN_EXECUTION_ACCESS_PATH_INVALID')
  const now = options.now ?? Date.now
  const tokens = new Map<string, { readonly submissionId: string; readonly accountId: string;
    readonly packageSha256: string; readonly expiresAt: number }>()
  let pending: Promise<void> = Promise.resolve()
  return { kind: 'exact', path: PLUGIN_EXECUTION_ACCESS_PATH,
    handler: async (incoming, outgoing) => {
      try {
        if (dir === undefined) return send(outgoing, 503, { ok: false, code: 'PLUGIN_EXECUTION_ACCESS_UNAVAILABLE' })
        if (incoming.headers.origin !== undefined || incoming.headers.cookie !== undefined
          || incoming.headers['sec-fetch-site'] === 'cross-site') {
          return send(outgoing, 403, { ok: false, code: 'CROSS_ORIGIN_FORBIDDEN' })
        }
        const authHeaders = incoming.rawHeaders.filter((value, index) =>
          index % 2 === 0 && value.toLowerCase() === 'authorization')
        if (authHeaders.length !== 1 || typeof incoming.headers.authorization !== 'string') {
          return send(outgoing, 401, { ok: false, code: 'LOGIN_REQUIRED' })
        }
        if (incoming.method === 'POST') {
          if (incoming.url !== PLUGIN_EXECUTION_ACCESS_PATH) {
            return send(outgoing, 400, { ok: false, code: 'BAD_REQUEST' })
          }
          if (!ACCOUNT_BEARER.test(incoming.headers.authorization)) {
            return send(outgoing, 401, { ok: false, code: 'LOGIN_REQUIRED' })
          }
          const body = await boundedPost(incoming)
          if (body === null || !only(body, ['action', 'submissionId', 'packageSha256'])
            || body['action'] !== 'claim' || typeof body['submissionId'] !== 'string'
            || !UUID.test(body['submissionId']) || typeof body['packageSha256'] !== 'string'
            || !SHA256.test(body['packageSha256'])) {
            return send(outgoing, 400, { ok: false, code: 'BAD_REQUEST' })
          }
          const request = new Request(`https://qianshou.local${PLUGIN_EXECUTION_ACCESS_PATH}`, {
            method: 'POST', headers: { authorization: incoming.headers.authorization },
          })
          let principal: Principal | null
          try { principal = await options.authenticate(request) }
          catch { return send(outgoing, 503, { ok: false, code: 'ACCOUNT_VERIFICATION_UNAVAILABLE' }) }
          if (principal === null) return send(outgoing, 401, { ok: false, code: 'LOGIN_REQUIRED' })
          const accountId = principal.accountId
          const submissionId = body['submissionId']
          const packageSha256 = body['packageSha256']
          const task = pending.then(async () => {
            const reviewed = await readReviewedExecutionArtifact(options.submissionOptions, submissionId)
            if (reviewed === null) return send(outgoing, 404, { ok: false, code: 'PLUGIN_EXECUTION_NOT_REVIEWED' })
            const candidate = reviewed.candidate
            if (candidate.packageSha256 !== packageSha256 || candidate.accountId !== accountId) {
              return send(outgoing, 403, { ok: false, code: 'PLUGIN_EXECUTION_NOT_OWNED' })
            }
            const expected = { submissionId, accountId,
              releaseId: candidate.releaseId, packageSha256 }
            const path = licenseFile(dir, submissionId)
            let license = await readLicense(path, expected)
            if (license === null) {
              const created: SelfLicense = { format: 'qianshou.execution-self-license.v1',
                licenseId: randomUUID(), submissionId, accountId,
                releaseId: candidate.releaseId, packageSha256, grantedAt: now(),
                scope: 'self-use-review-candidate' }
              try { await createLicense(path, created) }
              catch (error) {
                if (object(error)?.['code'] !== 'EEXIST') throw error
              }
              license = await readLicense(path, expected)
              if (license === null) throw new Error('PLUGIN_EXECUTION_LICENSE_MISSING')
            }
            // A prior response may have failed after linking the entry but before syncing the directory.
            await syncDirectory(dir)
            for (const [hash, grant] of tokens) if (grant.expiresAt <= now()) tokens.delete(hash)
            if (tokens.size >= MAX_TOKENS) throw new Error('PLUGIN_EXECUTION_TOKEN_LIMIT')
            const token = randomBytes(32).toString('base64url')
            const expiresAt = now() + TOKEN_LIFETIME_MS
            tokens.set(createHash('sha256').update(token).digest('hex'),
              { submissionId, accountId, packageSha256, expiresAt })
            return send(outgoing, 200, { ok: true, candidate, releaseId: candidate.releaseId,
              pluginId: candidate.pluginId, version: candidate.version, packageSha256,
              license, installable: false, saleable: false, dispatchable: false,
              download: { url: `${PLUGIN_EXECUTION_ACCESS_PATH}?submission=${submissionId}&sha256=${packageSha256}`,
                token, expiresAt } })
          })
          pending = task.then(() => undefined, () => undefined)
          return await task
        }
        if (incoming.method === 'GET') {
          if ((incoming.headers['content-length'] !== undefined && incoming.headers['content-length'] !== '0')
            || incoming.headers['transfer-encoding'] !== undefined) {
            return send(outgoing, 400, { ok: false, code: 'BAD_REQUEST' })
          }
          const token = DOWNLOAD_BEARER.exec(incoming.headers.authorization)?.[1]
          if (token === undefined) return send(outgoing, 403, { ok: false, code: 'PLUGIN_EXECUTION_DOWNLOAD_FORBIDDEN' })
          if (!incoming.url?.startsWith(`${PLUGIN_EXECUTION_ACCESS_PATH}?`)) {
            return send(outgoing, 400, { ok: false, code: 'BAD_REQUEST' })
          }
          const url = new URL(incoming.url, 'https://qianshou.local')
          const keys = [...url.searchParams.keys()]
          const submissionId = url.searchParams.get('submission')
          const packageSha256 = url.searchParams.get('sha256')
          if (url.pathname !== PLUGIN_EXECUTION_ACCESS_PATH || keys.length !== 2
            || !keys.includes('submission') || !keys.includes('sha256')
            || submissionId === null || !UUID.test(submissionId)
            || packageSha256 === null || !SHA256.test(packageSha256)) {
            return send(outgoing, 400, { ok: false, code: 'BAD_REQUEST' })
          }
          const hash = createHash('sha256').update(token).digest('hex')
          const grant = tokens.get(hash)
          if (grant === undefined || grant.expiresAt <= now() || grant.submissionId !== submissionId
            || grant.packageSha256 !== packageSha256) {
            return send(outgoing, 403, { ok: false, code: 'PLUGIN_EXECUTION_DOWNLOAD_FORBIDDEN' })
          }
          const reviewed = await readReviewedExecutionArtifact(options.submissionOptions, submissionId)
          if (reviewed === null || reviewed.candidate.accountId !== grant.accountId
            || reviewed.candidate.packageSha256 !== packageSha256) {
            return send(outgoing, 503, { ok: false, code: 'PLUGIN_EXECUTION_ARTIFACT_CHANGED' })
          }
          const license = await readLicense(licenseFile(dir, submissionId), {
            submissionId, accountId: grant.accountId,
            releaseId: reviewed.candidate.releaseId, packageSha256 })
          if (license === null) return send(outgoing, 403, { ok: false, code: 'PLUGIN_EXECUTION_DOWNLOAD_FORBIDDEN' })
          outgoing.writeHead(200, { 'content-type': 'application/json',
            'content-length': String(reviewed.bytes.length),
            'x-qianshou-package-sha256': packageSha256,
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
          outgoing.end(reviewed.bytes)
          return
        }
        return send(outgoing, 405, { ok: false, code: 'METHOD_NOT_ALLOWED' })
      } catch {
        if (outgoing.headersSent) outgoing.destroy()
        else send(outgoing, 503, { ok: false, code: 'PLUGIN_EXECUTION_ACCESS_UNAVAILABLE' })
      }
    } }
}
