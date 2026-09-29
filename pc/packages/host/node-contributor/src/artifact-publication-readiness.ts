/** Published adapter gate: a local output proof alone never enables remote dispatch. */

const TASK_TYPE = /^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/u
const DIGEST = /^sha256:[0-9a-f]{64}$/u

function safeOrigin(value: string): URL {
  const url = new URL(value)
  const local = url.hostname === '127.0.0.1' || url.hostname === '[::1]'
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || (url.protocol !== 'https:' && !(url.protocol === 'http:' && local))) throw new Error('invalid origin')
  return url
}

/** Bounded private status read. Its only caller turns every transport failure into a closed gate. */
async function readJson(url: URL, token: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<unknown> {
  const deadline = AbortSignal.timeout(10_000)
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline
  const response = await fetcher(url, { method: 'GET', headers: { authorization: `Bearer ${token}` },
    redirect: 'error', credentials: 'omit', signal: combined })
  if (!response.ok || response.body === null) {
    try { await response.body?.cancel() } catch { /* Untrusted response is not surfaced. */ }
    throw new Error('platform unavailable')
  }
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      combined.throwIfAborted()
      const part = await reader.read()
      if (part.done) break
      total += part.value.byteLength
      if (total > 8192) throw new Error('response too large')
      chunks.push(part.value)
    }
    combined.throwIfAborted()
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  } finally {
    try { await reader.cancel() } catch { /* Reader may be closed. */ }
    reader.releaseLock()
  }
}

export interface ArtifactPublicationReadinessInput {
  readonly origin: string
  readonly token: string
  readonly ownerId: number
  readonly taskType: string
  readonly artifactDigest: string
  readonly packageDigest: string
  readonly fetch?: typeof fetch
  readonly signal?: AbortSignal
}

export interface ArtifactPublicationReadiness {
  readonly ready: boolean
  readonly publicationId: string | null
}

/**
 * Only an owner-scoped platform receipt for the exact installed digest opens this gate.
 * Missing route, expired login, malformed data, network failures and stale digests all mean false.
 */
export async function readArtifactPublicationReadiness(input: ArtifactPublicationReadinessInput): Promise<ArtifactPublicationReadiness> {
  const closed = { ready: false, publicationId: null } as const
  if (!TASK_TYPE.test(input.taskType) || !DIGEST.test(input.artifactDigest)
    || !DIGEST.test(input.packageDigest)
    || !Number.isSafeInteger(input.ownerId) || input.ownerId < 1 || !input.token) return closed
  try {
    const origin = safeOrigin(input.origin)
    const response = await readJson(new URL(`/api/v8/task-adapter-publications/readiness/${input.taskType}`, origin),
      input.token, input.fetch ?? fetch, input.signal)
    if (response === null || typeof response !== 'object' || Array.isArray(response)) return closed
    const row = response as Record<string, unknown>
    if (row.task_type !== input.taskType || row.ready !== true || row.owner_id !== input.ownerId
      || row.approved_artifact_digest !== input.artifactDigest
      || row.approved_package_digest !== input.packageDigest
      || typeof row.publication_id !== 'string' || row.publication_id.trim().length === 0
      || row.publication_id.length > 256) return closed
    return { ready: true, publicationId: row.publication_id }
  } catch { return closed }
}
