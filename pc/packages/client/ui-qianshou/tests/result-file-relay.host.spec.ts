import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { RESULT_FILE_PATH, resultFileRoutes } from '../src/relay/result-file-relay.ts'

const task = '11111111-1111-4111-8111-111111111111'
const bytes = new Uint8Array([0, 255, 1, 42])
const digest = createHash('sha256').update(bytes).digest('hex')
const path = `${RESULT_FILE_PATH}?task_id=${task}&asset_id=${digest}`

function grant(changes: Record<string, unknown> = {}): Response {
  const now = Math.floor(Date.now() / 1000)
  const payload = { shard_id: task, result_id: task, worker_id: task, receipt_id: task, attempt: 1, task_type: 'adapter.generic_file',
    contract_sha256: `sha256:${digest}`, receipt_sha256: `sha256:${digest}`, file_schema_sha256: digest,
    bucket: 'file-test-bucket', object_version_id: 'locked-version-1', content_type: 'application/octet-stream',
    object_key: `v8/account-7/workload-${task}/shard-${task}/result/${task}/output.bin`, schema: 'qianshou.file-download-grant.v1', audience: 'guangzhou-result-file', purpose: 'qianshou:file-result-download',
    policy_id: 'independent-file-bytes.v1', account_id: 7, task_id: task, workload_id: task, asset_id: digest, sha256: digest,
    filename: 'output.bin', size_bytes: bytes.length, result_finalized: true, file_bytes_attested: true,
    issued_at: now, expires_at: now + 60, ...changes }
  const token = Buffer.from(JSON.stringify({ key_id: 'isolated-file-root',
    payload: Object.fromEntries(Object.keys(payload).sort().map(key => [key, payload[key as keyof typeof payload]])),
    signature: Buffer.alloc(64, 1).toString('base64url') })).toString('base64url')
  return new Response(JSON.stringify({ ok: true, grant: token }), { headers: { 'content-type': 'application/json' } })
}

function file(body: BodyInit = bytes.slice(), extra: Record<string, string> = {}): Response {
  return new Response(body, { headers: { 'content-type': 'application/octet-stream', 'content-length': String(bytes.length),
    'content-disposition': 'attachment; filename="output.bin"', 'x-content-type-options': 'nosniff',
    'x-qianshou-content-sha256': digest, ...extra } })
}

function fixture(fetchImpl: typeof fetch, options: { owner?: () => Promise<number | null>; fileOrigin?: string; enabled?: boolean } = {}) {
  const account = { ensureAccessToken: vi.fn(async () => 'isolated-private-account-token') }
  const route = resultFileRoutes(account, { enabled: options.enabled ?? true, coreOrigin: 'https://shanghai.test',
    fileOrigin: options.fileOrigin ?? 'https://guangzhou.test', accountIdOf: options.owner ?? (async () => 7), fetchImpl })[0]!
  return { route, account }
}

it('delivers bounded file bytes as an attachment and hides every private control reference', async () => {
  const fetcher = vi.fn<typeof fetch>(async target => String(target).includes('file-download-grant') ? grant() : file())
  const { route } = fixture(fetcher)
  const response = await route.fetch(new Request(`http://127.0.0.1${path}`))
  expect(response.status).toBe(200)
  expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes)
  expect(response.headers.get('content-type')).toBe('application/octet-stream')
  expect(response.headers.get('content-disposition')).toBe('attachment; filename="output.bin"')
  expect(response.headers.get('cache-control')).toBe('private, no-store')
  expect(JSON.stringify([...response.headers])).not.toMatch(/grant|cos|token|object_key/u)
  expect(String(fetcher.mock.calls[0]?.[0])).toBe(`https://shanghai.test/api/v8/workloads/${task}/file-download-grant?asset_id=${digest}`)
  expect(String(fetcher.mock.calls[1]?.[0])).toBe(`https://guangzhou.test/file/result?task_id=${task}&asset_id=${digest}`)
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { authorization: 'Bearer isolated-private-account-token' } })
})

it.each(['https://shanghai.test', 'https://www.shanghai.test', 'https://guangzhou.test/path', 'https://user:pass@guangzhou.test'])(
  'keeps unsafe destination %s closed before resolving a token', async fileOrigin => {
    const fetcher = vi.fn<typeof fetch>(); const { route, account } = fixture(fetcher, { fileOrigin })
    expect((await route.fetch(new Request(`http://127.0.0.1${path}`))).status).toBe(503)
    expect(account.ensureAccessToken).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled()
  })

it('keeps the new purpose disabled by default and rejects absent accounts', async () => {
  const fetcher = vi.fn<typeof fetch>()
  const { route } = fixture(fetcher, { enabled: false })
  expect((await route.fetch(new Request(`http://127.0.0.1${path}`))).status).toBe(503)
  const signedOut = fixture(fetcher, { owner: async () => null })
  expect((await signedOut.route.fetch(new Request(`http://127.0.0.1${path}`))).status).toBe(401)
  expect(fetcher).not.toHaveBeenCalled()
})

it.each([{ account_id: 8 }, { purpose: 'qianshou:file-bytes-verifier' }, { schema: 'qianshou.media-view-grant.v1' },
  { audience: 'guangzhou-result-media' }, { task_id: 'other' }, { file_bytes_attested: false }, { size_bytes: 16385 },
  { expires_at: 1 }, { filename: '../escape' }, { extra: true }, { worker_id: 'other' }, { attempt: 0 },
  { object_version_id: 'null' }, { object_key: 'v8/account-8/result/stolen' }, { receipt_sha256: digest }])('rejects private grant binding %j before Guangzhou', async changes => {
  const fetcher = vi.fn<typeof fetch>(async () => grant(changes)); const { route } = fixture(fetcher)
  expect((await route.fetch(new Request(`http://127.0.0.1${path}`))).status).toBe(502)
  expect(fetcher).toHaveBeenCalledOnce()
})

it.each([{ 'content-type': 'text/html' }, { 'content-disposition': 'inline' }, { 'content-length': '5' },
  { 'content-encoding': 'gzip' }, { 'x-content-type-options': 'unsafe' }, { 'x-qianshou-content-sha256': 'b'.repeat(64) }])(
  'rejects unsafe upstream headers %j', async headers => {
    const fetcher = vi.fn<typeof fetch>(async url => String(url).includes('file-download-grant') ? grant() : file(bytes.slice(), headers))
    const { route } = fixture(fetcher)
    expect((await route.fetch(new Request(`http://127.0.0.1${path}`))).status).toBe(502)
  })

it('recomputes the actual bytes and never substitutes a public object URL', async () => {
  const fetcher = vi.fn<typeof fetch>(async url => String(url).includes('file-download-grant') ? grant() : file(new Uint8Array([1, 2, 3, 4])))
  const { route } = fixture(fetcher)
  expect((await route.fetch(new Request(`http://127.0.0.1${path}`))).status).toBe(502)
  fetcher.mockClear()
  for (const url of [`${path}&url=https://cos.test`, `${path}&object_key=secret`, `${path}&grant=stolen`, `${path}&asset_id=${digest}`]) {
    expect((await route.fetch(new Request(`http://127.0.0.1${url}`))).status).toBe(400)
  }
  expect((await route.fetch(new Request(`http://127.0.0.1${path}`, { headers: { range: 'bytes=0-1' } }))).status).toBe(400)
  expect(fetcher).not.toHaveBeenCalled()
})

it('stops before Guangzhou if the owner switches during the control request', async () => {
  let owner = 7
  const fetcher = vi.fn<typeof fetch>(async () => { owner = 8; return grant() })
  const { route } = fixture(fetcher, { owner: async () => owner })
  expect((await route.fetch(new Request(`http://127.0.0.1${path}`))).status).toBe(401)
  expect(fetcher).toHaveBeenCalledOnce()
})

it.each(['incoming', 'account'] as const)('cancels the real open response stream on %s lifecycle change', async kind => {
  let owner = 7, cancelled = false
  const shutdown = new AbortController()
  const stream = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true } })
  const fetcher = vi.fn<typeof fetch>(async url => String(url).includes('file-download-grant') ? grant() : file(stream))
  const { route } = fixture(fetcher, { owner: async () => owner })
  const pending = route.fetch(new Request(`http://127.0.0.1${path}`, { signal: shutdown.signal }))
  await expect.poll(() => stream.locked).toBe(true)
  if (kind === 'incoming') shutdown.abort(); else owner = 8
  const response = await pending
  expect(response.status).toBe(kind === 'incoming' ? 499 : 401)
  expect(cancelled).toBe(true)
  expect(shutdown.signal.aborted).toBe(kind === 'incoming')
  expect(await response.text()).not.toContain('isolated-private-account-token')
})

it('closes returned upstream bodies if identity changes before acquiring the reader', async () => {
  let owner = 7, cancelled = false
  const stream = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true } })
  const fetcher = vi.fn<typeof fetch>(async url => {
    if (String(url).includes('file-download-grant')) return grant()
    owner = 8
    return file(stream)
  })
  const { route } = fixture(fetcher, { owner: async () => owner })
  expect((await route.fetch(new Request(`http://127.0.0.1${path}`))).status).toBe(401)
  expect(cancelled).toBe(true)
})

it.each(['account', 'incoming'] as const)('rejects success if %s changes during asynchronous response cleanup', async kind => {
  let owner = 7, cleanupStarted = false
  let release: (() => void) | undefined
  const cleanup = new Promise<void>(resolve => { release = resolve })
  const shutdown = new AbortController()
  const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes.slice()); controller.close() } })
  const originalCancel = stream.cancel.bind(stream)
  stream.cancel = async reason => { cleanupStarted = true; await cleanup; await originalCancel(reason) }
  const fetcher = vi.fn<typeof fetch>(async url => String(url).includes('file-download-grant') ? grant() : file(stream))
  const { route } = fixture(fetcher, { owner: async () => owner })
  const pending = route.fetch(new Request(`http://127.0.0.1${path}`, { signal: shutdown.signal }))
  await expect.poll(() => cleanupStarted).toBe(true)
  if (kind === 'account') owner = 8; else shutdown.abort()
  release!()
  const response = await pending
  expect(response.status).toBe(kind === 'account' ? 401 : 499)
  expect(await response.text()).not.toContain('output.bin')
})
