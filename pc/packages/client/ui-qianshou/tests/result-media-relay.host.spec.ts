import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_RESULT_MEDIA_ORIGIN, RESULT_MEDIA_PATH, resultMediaOrigin,
  resultMediaRoutes } from '../src/relay/result-media-relay.ts'

const taskId = 'task_123'
const assetId = 'a'.repeat(64)
const pathFor = (type: string) => `${RESULT_MEDIA_PATH}?task_id=${taskId}&asset_id=${assetId}&type=${type}`
const path = pathFor('mp4')
const accountId = 41
const publicationId = '11111111-2222-4333-8444-555555555555'
const firstFrameKey = `v8/account-${accountId}/reviewed-video/input/${'e'.repeat(32)}/frame.png`

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function ownerDetail(reviewed = false, resultType = 'mp4', resultAsset = assetId): Record<string, unknown> {
  const manifest = { schema: 'artifact.v1', workload_id: taskId, account_id: accountId,
    object_key: `v8/account-${accountId}/workload-${taskId}/shard-shard-1/result/result-1/result.${resultType}`,
    object_version_id: 'version-1', result_id: 'result-1', shard_id: 'shard-1',
    filename: `result.${resultType}`, content_type: resultType === 'mp4' ? 'video/mp4'
      : resultType === 'webm' ? 'video/webm' : 'video/quicktime', size_bytes: 4, sha256: resultAsset }
  return { id: taskId, owner_id: accountId, status: 'DONE',
    spec: { task_type: reviewed ? 'owner_video_v1' : 'video_compress',
      verification_policy: reviewed ? 'semantic' : 'artifact',
      input_kind: reviewed ? 'multi_file' : 'inline', input_refs: reviewed ? [firstFrameKey] : [],
      requirements: reviewed ? {
        _reviewed_task_contract: { schema: 'qianshou.reviewed-workload-contract.v1',
          publication_id: publicationId, artifact_digest: `sha256:${'b'.repeat(64)}`,
          package_digest: `sha256:${'c'.repeat(64)}`, contract_sha256: `sha256:${'d'.repeat(64)}`,
          result_strategy: 'external-media.v1', output_kind: 'artifact_ref' },
        reviewed_publication: { schema: 'qianshou.reviewed-publication-selection.v1',
          publication_id: publicationId, artifact_digest: `sha256:${'b'.repeat(64)}`,
          contract_sha256: `sha256:${'d'.repeat(64)}` },
        _reviewed_video_input_binding: { schema: 'qianshou.reviewed-video-input-binding.v1',
          account_id: accountId, task_type: 'owner_video_v1', file_sha256: `sha256:${'e'.repeat(64)}`,
          file: { objectKey: firstFrameKey, objectVersionId: 'version-1',
            sha256: 'f'.repeat(64), contentType: 'image/png' } },
      } : {} },
    result: { output_ref: JSON.stringify(manifest), inline_output: null } }
}

function fixture(fetchImpl: typeof fetch, token: string | null = 'private-account-token', mediaOrigin?: string,
  controls: { detail?: () => Response; identity?: () => Response } = {}) {
  const account = { ensureAccessToken: vi.fn(async () => token) }
  const controlFetch = vi.fn<typeof fetch>(async (url, init) => {
    const pathname = new URL(String(url)).pathname
    if (pathname === `/api/v8/workloads/${taskId}`) return controls.detail?.() ?? json(ownerDetail())
    if (pathname === '/api/v8/auth/me') return controls.identity?.() ?? json({ ok: true, account: { id: accountId } })
    return fetchImpl(url, init)
  })
  const route = resultMediaRoutes(account, { coreOrigin: 'https://shanghai.example.test',
    ...(mediaOrigin === undefined ? {} : { mediaOrigin }), fetchImpl: controlFetch })[0]!
  return { account, route, controlFetch }
}

function incoming(url = path, range?: string): Request {
  return new Request(`http://127.0.0.1${url}`,
    range === undefined ? {} : { headers: { range } })
}

function grant(): Response {
  return new Response(JSON.stringify({ ok: true, grant: 'short_signed_grant' }), {
    headers: { 'content-type': 'application/json' },
  })
}

function media(bytes: string, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(bytes, { status, headers: { 'content-type': 'video/mp4',
    'content-length': String(bytes.length), ...extra } })
}

describe('same-origin result media relay', () => {
  it('uses the pinned Guangzhou result origin in an ordinary desktop install', async () => {
    const upstream = vi.fn<typeof fetch>(async url => String(url).includes('media-view-grant')
      ? grant() : media('png!'))
    const { route } = fixture(upstream)
    expect((await route.fetch(incoming())).status).toBe(200)
    expect(String(upstream.mock.calls[1]?.[0])).toBe(
      `${DEFAULT_RESULT_MEDIA_ORIGIN}/media/result?task_id=${taskId}&asset_id=${assetId}`)
  })
  it('obtains a private central server grant and forwards a bounded video Range directly to Guangzhou', async () => {
    const upstream = vi.fn<typeof fetch>(async url => String(url).includes('media-view-grant')
      ? grant() : media('abcd', 206, { 'content-range': 'bytes 0-3/10' }))
    const { route, account, controlFetch } = fixture(upstream, 'private-account-token', 'https://guangzhou.example.test')
    expect(route).toMatchObject({ path: RESULT_MEDIA_PATH, methods: ['GET'], requestBody: 'buffered' })
    const response = await route.fetch(incoming(path, 'bytes=0-3'))
    expect(response.status).toBe(206)
    expect(await response.text()).toBe('abcd')
    expect(response.headers.get('content-range')).toBe('bytes 0-3/10')
    expect(response.headers.get('content-type')).toBe('video/mp4')
    expect(response.headers.get('cache-control')).toBe('private, no-store')
    expect(JSON.stringify([...response.headers])).not.toContain('private-account-token')
    expect(JSON.stringify([...response.headers])).not.toContain('short_signed_grant')
    expect(account.ensureAccessToken).toHaveBeenCalledOnce()
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(controlFetch.mock.calls.map(([target]) => new URL(String(target)).pathname)).toEqual([
      `/api/v8/workloads/${taskId}`, '/api/v8/auth/me',
      `/api/v8/workloads/${taskId}/media-view-grant`, '/media/result',
    ])
    expect(controlFetch.mock.calls.slice(0, 2).map(([, init]) => init?.headers)).toEqual([
      { authorization: 'Bearer private-account-token', accept: 'application/json' },
      { authorization: 'Bearer private-account-token', accept: 'application/json' },
    ])
    const [controlUrl, controlInit] = upstream.mock.calls[0]!
    expect(String(controlUrl)).toBe(`https://shanghai.example.test/api/v8/workloads/${taskId}/media-view-grant?asset_id=${assetId}`)
    expect(controlInit).toMatchObject({ credentials: 'omit', redirect: 'error',
      headers: { authorization: 'Bearer private-account-token', accept: 'application/json' } })
    const [mediaUrl, mediaInit] = upstream.mock.calls[1]!
    expect(String(mediaUrl)).toBe(`https://guangzhou.example.test/media/result?task_id=${taskId}&asset_id=${assetId}`)
    expect(mediaInit).toMatchObject({ credentials: 'omit', redirect: 'error',
      headers: { authorization: 'Bearer short_signed_grant', accept: 'video/mp4', range: 'bytes=0-3' } })
  })

  it.each(['video/webm', 'image/png'])(
    'rejects a .mp4 reference delivered as %s', async (contentType) => {
      const upstream = vi.fn<typeof fetch>(async url => String(url).includes('media-view-grant')
        ? grant() : media('abcd', 200, { 'content-type': contentType }))
      const { route } = fixture(upstream, 'token', 'https://guangzhou.example.test')
      const response = await route.fetch(incoming())
      expect(response.status).toBe(502)
      expect((await response.json())?.code).toBe('RESULT_MEDIA_UPSTREAM_INVALID')
      expect(upstream).toHaveBeenCalledTimes(2)
    },
  )

  it.each([
    ['mp4', 'video/mp4'], ['webm', 'video/webm'], ['mov', 'video/quicktime'],
  ])('serves an authorized %s reference with matching %s', async (type, contentType) => {
    const upstream = vi.fn<typeof fetch>(async url => String(url).includes('media-view-grant')
      ? grant() : media('abcd', 200, { 'content-type': contentType }))
    const { route } = fixture(upstream, 'token', 'https://guangzhou.example.test',
      { detail: () => json(ownerDetail(false, type)) })
    const response = await route.fetch(incoming(pathFor(type)))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe(contentType)
    expect(await response.text()).toBe('abcd')
    expect(upstream.mock.calls[1]?.[1]?.headers).toMatchObject({ accept: contentType })
  })

  it.each([
    ['reviewed video task type', { task_type: 'owner_video_v1' }],
    ['semantic verification', { verification_policy: 'semantic' }],
  ])('rejects %s when all frozen review markers are missing', async (_case, changedSpec) => {
    const upstream = vi.fn<typeof fetch>()
    const detail = ownerDetail(false, 'webm')
    const { route } = fixture(upstream, 'token', 'https://guangzhou.example.test',
      { detail: () => json({ ...detail, spec: { ...(detail.spec as Record<string, unknown>), ...changedSpec } }) })
    const response = await route.fetch(incoming(pathFor('webm')))
    expect(response.status).toBe(502)
    expect((await response.json())?.code).toBe('RESULT_MEDIA_OWNER_UNVERIFIED')
    expect(upstream).not.toHaveBeenCalled()
  })

  it('admits a reviewed MP4 only when the owner result binds the same asset', async () => {
    const upstream = vi.fn<typeof fetch>(async url => String(url).includes('media-view-grant')
      ? grant() : media('abcd'))
    const { route, controlFetch } = fixture(upstream, 'token', 'https://guangzhou.example.test',
      { detail: () => json(ownerDetail(true)) })
    const response = await route.fetch(incoming())
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('abcd')
    expect(upstream).toHaveBeenCalledTimes(2)
    expect(controlFetch.mock.calls.map(([target]) => new URL(String(target)).pathname)).toEqual([
      `/api/v8/workloads/${taskId}`, '/api/v8/auth/me',
      `/api/v8/workloads/${taskId}/media-view-grant`, '/media/result',
    ])
  })

  it.each([['webm', 'video/webm'], ['mov', 'video/quicktime']])(
    'rejects a direct reviewed %s reference before asking Shanghai for a grant', async (type) => {
      const upstream = vi.fn<typeof fetch>()
      const { route, controlFetch } = fixture(upstream, 'token', 'https://guangzhou.example.test',
        { detail: () => json(ownerDetail(true, type)) })
      const response = await route.fetch(incoming(pathFor(type)))
      expect(response.status).toBe(502)
      expect((await response.json())?.code).toBe('RESULT_MEDIA_OWNER_UNVERIFIED')
      expect(upstream).not.toHaveBeenCalled()
      expect(controlFetch).toHaveBeenCalledTimes(2)
    },
  )

  it('rejects a reviewed MP4 with another owner asset or a damaged review marker', async () => {
    const valid = ownerDetail(true)
    const spec = valid.spec as { requirements: Record<string, unknown> }
    const cases = [
      ownerDetail(true, 'mp4', 'b'.repeat(64)),
      ownerDetail(true, 'webm'),
      { ...valid, spec: { ...spec, requirements: { reviewed_publication: spec.requirements.reviewed_publication } } },
      { ...valid, spec: { ...spec, requirements: { ...spec.requirements,
        _reviewed_video_input_binding: undefined } } },
      { ...valid, result: { output_ref: null } },
      { ...valid, status: 'RUNNING' },
    ]
    for (const detail of cases) {
      const upstream = vi.fn<typeof fetch>()
      const { route } = fixture(upstream, 'token', 'https://guangzhou.example.test',
        { detail: () => json(detail) })
      expect((await route.fetch(incoming())).status).toBe(502)
      expect(upstream).not.toHaveBeenCalled()
    }
  })

  it('fails closed when video owner detail or current account identity is unknown', async () => {
    const cases = [
      { detail: () => json({ detail: 'missing' }, 404) },
      { detail: () => new Response('<html>login</html>', { headers: { 'content-type': 'text/html' } }) },
      { detail: () => json({ ...ownerDetail(), owner_id: accountId + 1 }) },
      { identity: () => json({ ok: true, account: { id: accountId + 1 } }) },
      { identity: () => json({ detail: 'unavailable' }, 502) },
    ]
    for (const controls of cases) {
      const upstream = vi.fn<typeof fetch>()
      const { route } = fixture(upstream, 'token', 'https://guangzhou.example.test', controls)
      expect((await route.fetch(incoming(pathFor('webm')))).status).toBe(502)
      expect(upstream).not.toHaveBeenCalled()
    }
  })

  it('never falls back to a developer grant for a reviewed MP4', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response(null, { status: 404 }))
    const { route } = fixture(upstream, 'token', 'https://guangzhou.example.test',
      { detail: () => json(ownerDetail(true)) })
    expect((await route.fetch(incoming())).status).toBe(404)
    expect(upstream).toHaveBeenCalledOnce()
    expect(String(upstream.mock.calls[0]?.[0])).toContain(`/api/v8/workloads/${taskId}/media-view-grant`)
  })

  it('uses the developer-task grant only after a definite workload-route miss', async () => {
    const upstream = vi.fn<typeof fetch>(async (url) => {
      if (String(url).includes('/workloads/')) return new Response(null, { status: 404 })
      if (String(url).includes('/developer/tasks/')) return grant()
      return media('abcd')
    })
    const { route } = fixture(upstream, 'token', 'https://guangzhou.example.test')
    const response = await route.fetch(incoming())
    expect(response.status).toBe(200)
    expect(upstream).toHaveBeenCalledTimes(3)
    expect(String(upstream.mock.calls[1]?.[0])).toBe(
      `https://shanghai.example.test/api/v8/developer/tasks/${taskId}/media-view-grant?asset_id=${assetId}`)
    upstream.mockClear()
    upstream.mockImplementationOnce(async () => new Response(null, { status: 403 }))
    expect((await route.fetch(incoming())).status).toBe(401)
    expect(upstream).toHaveBeenCalledTimes(1)
  })

  it('fails closed without a pinned Guangzhou origin or a signed-in account', async () => {
    const upstream = vi.fn<typeof fetch>()
    const notConfigured = fixture(upstream, 'token', '')
    expect((await notConfigured.route.fetch(incoming())).status).toBe(503)
    expect(upstream).not.toHaveBeenCalled()
    const signedOut = fixture(upstream, null, 'https://guangzhou.example.test')
    expect((await signedOut.route.fetch(incoming())).status).toBe(401)
    expect(upstream).not.toHaveBeenCalled()
    expect(() => resultMediaOrigin('http://example.test')).toThrow()
    expect(() => resultMediaOrigin('https://media.example.test/other')).toThrow()
    expect(() => resultMediaOrigin('https://user:pass@media.example.test')).toThrow()
  })

  it.each(['https://shanghai.example.test', 'https://shanghai.example.test:9443'])(
    'rejects media delivery on the control host %s before obtaining a grant', async (mediaOrigin) => {
      const upstream = vi.fn<typeof fetch>()
      const { route, account } = fixture(upstream, 'token', mediaOrigin)
      expect((await route.fetch(incoming())).status).toBe(503)
      expect(account.ensureAccessToken).not.toHaveBeenCalled()
      expect(upstream).not.toHaveBeenCalled()
    },
  )

  it('rejects ambiguous IDs, extra query parameters and multi-range before any upstream request', async () => {
    const upstream = vi.fn<typeof fetch>()
    const { route } = fixture(upstream, 'token', 'https://guangzhou.example.test')
    for (const url of [
      `${RESULT_MEDIA_PATH}?task_id=${taskId}&asset_id=${assetId}`,
      `${path}&type=mp4`,
      pathFor('avi'),
      pathFor('MP4'),
      pathFor('__proto__'),
      `${path}&asset_id=${assetId}`,
      `${path}&target=https://evil.example`,
      `${RESULT_MEDIA_PATH}?task_id=../escape&asset_id=${assetId}`,
      `${RESULT_MEDIA_PATH}?task_id=${taskId}&asset_id=sha256:${assetId}`,
    ]) expect((await route.fetch(incoming(url))).status).toBe(400)
    for (const range of ['bytes=0-3,6-9', 'bytes=0-9999999999', 'items=0-3', 'bytes=-0']) {
      expect((await route.fetch(incoming(path, range))).status).toBe(416)
    }
    expect(upstream).not.toHaveBeenCalled()
  })

  it('does not expose malformed grants, redirects, HTML, oversized bodies or upstream errors', async () => {
    const upstream = vi.fn<typeof fetch>(async () => new Response('<html>login</html>', {
      headers: { 'content-type': 'text/html' },
    }))
    const { route } = fixture(upstream, 'token', 'https://guangzhou.example.test')
    expect((await route.fetch(incoming())).status).toBe(502)
    upstream.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true, grant: 'bad.jwt' }), {
      headers: { 'content-type': 'application/json' },
    }))
    expect((await route.fetch(incoming())).status).toBe(502)
    upstream.mockImplementationOnce(async () => { throw new Error('private redirect or socket detail') })
    expect((await route.fetch(incoming())).status).toBe(502)
    upstream.mockImplementationOnce(async () => new Response(JSON.stringify({ ok: true, grant: 'x'.repeat(13_000) }), {
      headers: { 'content-type': 'application/json' },
    }))
    expect((await route.fetch(incoming())).status).toBe(502)
    expect(upstream).toHaveBeenCalledTimes(4)
  })

  it('rejects unsupported types, false byte lengths, bad content ranges and gzip', async () => {
    const cases = [
      media('<html>', 200, { 'content-type': 'text/html' }),
      media('abcd', 200, { 'content-length': '67108865' }),
      media('abcd', 200, { 'content-length': '3' }),
      media('abcd', 200, { 'content-encoding': 'gzip' }),
      media('abcd', 206, { 'content-range': 'bytes 1-4/10' }),
    ]
    for (const candidate of cases) {
      const upstream = vi.fn<typeof fetch>(async url => String(url).includes('media-view-grant')
        ? grant() : candidate)
      const { route } = fixture(upstream, 'token', 'https://guangzhou.example.test')
      const response = await route.fetch(incoming(path, candidate.status === 206 ? 'bytes=0-3' : undefined))
      expect(response.status).toBe(502)
      expect((await response.text())).not.toContain('short_signed_grant')
    }
  })

  it('preserves a validated 416 response for a single byte range', async () => {
    const upstream = vi.fn<typeof fetch>(async url => String(url).includes('media-view-grant')
      ? grant() : new Response(null, { status: 416, headers: { 'content-range': 'bytes */10' } }))
    const { route } = fixture(upstream, 'token', 'https://guangzhou.example.test')
    const response = await route.fetch(incoming(path, 'bytes=9-10'))
    expect(response.status).toBe(416)
    expect(response.headers.get('content-range')).toBe('bytes */10')
  })
})
