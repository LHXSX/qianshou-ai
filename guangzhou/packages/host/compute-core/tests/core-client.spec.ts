import { describe, expect, it, vi } from 'vitest'
import { QianshouCoreClient, type CoreClientConfig } from '../src/core-client.ts'

const config: CoreClientConfig = {
  baseUrl: 'https://core.example.test',
  timeoutMs: 500,
  maxResponseBytes: 32_000,
}

function json(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers({ 'content-type': 'application/json' })
  new Headers(init?.headers).forEach((value, key) => { headers.set(key, value) })
  return new Response(JSON.stringify(value), {
    ...init,
    headers,
  })
}

const identity = {
  ok: true,
  account: { id: 41, username: 'member', role: 'enterprise', status: 'active', email: 'ignored', password_hash: 'discard' },
}

function clientFor(body: unknown, overrides: Partial<CoreClientConfig> = {}) {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(body))
  const client = new QianshouCoreClient({ ...config, ...overrides }, () => 'test-access', fetcher)
  return { client, fetcher }
}

describe('core API reads', () => {
  it('uses a verified auth path, disallows redirects, and projects only identity display fields', async () => {
    const { client, fetcher } = clientFor(identity)
    expect(await client.getIdentity()).toEqual({ accountId: 41, username: 'member', role: 'enterprise', status: 'active' })
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/auth/me'))
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'GET', redirect: 'error', headers: { Authorization: 'Bearer test-access' },
    })
    await client.close()
  })

  it('marks catalogue entries as requestable without inventing node counts, prices, or versions', async () => {
    const { client, fetcher } = clientFor({
      ok: true, items: [{ task_type: 'ocr_image', description: 'OCR images', api_key: 'discard', requires_gpu: false }], total: 1,
    })
    expect(await client.getCapabilities()).toEqual([
      { id: 'ocr_image', name: 'ocr_image', description: 'OCR images', delivery: 'remote', available: true },
    ])
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/developer/task-types'))
    await client.close()
  })

  it.each([
    ['RUNNING', null, false],
    ['DONE', { output_ref: 'private-result', token: 'discard' }, true],
    ['DONE', null, false],
    ['QUARANTINED', { output_ref: 'private-result' }, false],
    ['WAITING_FOR_WORKERS', null, false],
  ])('keeps %s progress without exposing task inputs or result contents', async (status, result, resultAvailable) => {
    const { client, fetcher } = clientFor({
      id: 'workload-1', status, progress: 0.5, result, spec: { inline_input: 'private input' },
    })
    expect(await client.getWorkload('workload-1')).toEqual({ id: 'workload-1', status, progress: 0.5, resultAvailable })
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/workloads/workload-1'))
    await client.close()
  })

  it('rejects mismatched workload identity and malformed progress rather than forging a receipt', async () => {
    for (const body of [
      { id: 'other-task', status: 'DONE', progress: 1, result: {} },
      { id: 'workload-1', status: 'RUNNING', progress: 120, result: null },
      { id: 'workload-1', status: 'DONE', progress: 1, result: 'raw result' },
    ]) {
      const { client } = clientFor(body)
      await expect(client.getWorkload('workload-1')).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE' })
      await client.close()
    }
  })

  it('does not turn hostile task identifiers into paths or query parameters', async () => {
    const { client, fetcher } = clientFor({})
    for (const id of ['../auth/me', '..', 'x?token=value', '/auth/me', 'x%2fy', 'x\nnext']) {
      await expect(client.getWorkload(id)).rejects.toMatchObject({ code: 'CORE_INVALID_WORKLOAD_ID' })
    }
    expect(fetcher).not.toHaveBeenCalled()
    await client.close()
  })

  it('posts the observed developer-task route and never posts /api/v8/workloads', async () => {
    const created = {
      ok: true, id: 'workload-1', task_id: 'workload-1', workload_id: 'workload-1',
      status: 'CREATED', progress: 0, reused: false,
    }
    const { client, fetcher } = clientFor(created)
    const body = {
      task_type: 'image.batch', input_kind: 'inline' as const, input_ref: '' as const, input_refs: [] as [],
      inline_input: 'goal', params: {} as Record<string, never>, name: '' as const, budget: '0.50',
      timeout_s: 300 as const, max_shards: 1, auto_shard: false, idempotency_key: 'a'.repeat(64),
      callback_url: '' as const, callback_secret: '' as const,
    }
    expect(await client.createDeveloperTask(body)).toEqual({
      id: 'workload-1', status: 'CREATED', progress: 0, resultAvailable: false,
    })
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/developer/tasks'))
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      method: 'POST', redirect: 'error',
      headers: { Authorization: 'Bearer test-access', Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    expect(String(fetcher.mock.calls[0]?.[0])).not.toContain('/api/v8/workloads')
    await client.close()
  })

  it('reads accepted input kinds without inventing file uploads', async () => {
    const { client, fetcher } = clientFor({
      ok: true,
      items: [{ task_type: 'ocr_image', description: 'OCR', accepted_input_kinds: ['inline'], default_input_kind: 'inline' }],
      total: 1,
    })
    expect(await client.getDeveloperTaskTypes()).toEqual([
      { taskType: 'ocr_image', acceptedInputKinds: ['inline'], defaultInputKind: 'inline' },
    ])
    expect(fetcher.mock.calls[0]?.[0]).toEqual(new URL('https://core.example.test/api/v8/developer/task-types'))
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ method: 'GET' })
    await client.close()
  })

  it('keeps 409 and 422 status codes so the ledger can distinguish in-flight from validation', async () => {
    for (const status of [409, 422]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ detail: 'private' }, { status }))
      const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
      await expect(client.createDeveloperTask({
        task_type: 'image.batch', input_kind: 'inline', input_ref: '', input_refs: [], inline_input: 'g',
        params: {}, name: '', budget: '0.50', timeout_s: 300, max_shards: 1, auto_shard: false,
        idempotency_key: 'k', callback_url: '', callback_secret: '',
      })).rejects.toMatchObject({ code: `CORE_HTTP_${status}`, status })
      await client.close()
    }
  })

  it('requires credentials before transport and suppresses credential-provider errors', async () => {
    const fetcher = vi.fn<typeof fetch>()
    for (const provider of [
      () => undefined,
      () => 'test-access\nsecret',
      () => { throw new Error('credential provider private value') },
      async () => undefined,
    ]) {
      const client = new QianshouCoreClient(config, provider, fetcher)
      await expect(client.getIdentity()).rejects.toThrow(/^CORE_CREDENTIALS_/u)
      await client.close()
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('sends the token returned by an async credential provider', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(identity))
    const client = new QianshouCoreClient(config, async () => 'async-access', fetcher)
    await client.getIdentity()
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
      headers: { Authorization: 'Bearer async-access' },
    })
    await client.close()
  })

  it('preserves HTTP status diagnostics without publishing upstream response bodies', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json({ detail: 'private upstream secret' }, { status: 401 }))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    await expect(client.getIdentity()).rejects.toMatchObject({ code: 'CORE_HTTP_401', message: 'CORE_HTTP_401', status: 401 })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it('sanitizes network failures and never retries a failed read implicitly', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('https://private/?token=private'))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    await expect(client.getIdentity()).rejects.toMatchObject({ code: 'CORE_UNAVAILABLE', message: 'CORE_UNAVAILABLE' })
    expect(fetcher).toHaveBeenCalledTimes(1)
    await client.close()
  })

  it('checks UTF-8 bytes at the exact complete-response limit', async () => {
    const body = { ...identity, account: { ...identity.account, username: '用户' } }
    const size = new TextEncoder().encode(JSON.stringify(body)).byteLength
    const exact = clientFor(body, { maxResponseBytes: size })
    await expect(exact.client.getIdentity()).resolves.toMatchObject({ username: '用户' })
    await exact.client.close()
    const short = clientFor(body, { maxResponseBytes: size - 1 })
    await expect(short.client.getIdentity()).rejects.toMatchObject({ code: 'CORE_RESPONSE_TOO_LARGE' })
    await short.client.close()
  })

  it('rejects an oversized declared body before parsing it', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json(identity, { headers: { 'content-length': '100000' } }))
    const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
    await expect(client.getIdentity()).rejects.toMatchObject({ code: 'CORE_RESPONSE_TOO_LARGE' })
    await client.close()
  })

  it('rejects malformed response JSON and catalogue wrappers without copying them into errors', async () => {
    for (const response of [new Response('private malformed JSON'), json({ ok: true, items: 'private' }), json({ ok: false })]) {
      const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
      const client = new QianshouCoreClient(config, () => 'test-access', fetcher)
      await expect(client.getCapabilities()).rejects.toMatchObject({ code: 'CORE_INVALID_RESPONSE', message: 'CORE_INVALID_RESPONSE' })
      await client.close()
    }
  })
})

describe('core transport ownership', () => {
  function waitingClient(timeoutMs = 500) {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (_input, init) => {
      const signal = init?.signal
      return new Promise<Response>((_resolve, reject) => {
        const rejectAbort = () => {
          const reason: unknown = signal?.reason
          reject(reason instanceof Error ? reason : new Error('aborted'))
        }
        if (signal?.aborted) rejectAbort()
        else signal?.addEventListener('abort', rejectAbort, { once: true })
      })
    })
    return { client: new QianshouCoreClient({ ...config, timeoutMs }, () => 'test-access', fetcher), fetcher }
  }

  it('cancels an in-flight read when the caller aborts, without forwarding the caller reason', async () => {
    const { client, fetcher } = waitingClient()
    const controller = new AbortController()
    const pending = client.getIdentity(controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CORE_REQUEST_ABORTED', message: 'CORE_REQUEST_ABORTED' })
    await Promise.resolve()
    expect(fetcher).toHaveBeenCalledTimes(1)
    controller.abort('private caller reason')
    await rejected
    await client.close()
  })

  it('does not start transport when the caller aborts while the credential provider is still pending', async () => {
    let settle: ((value: string) => void) | undefined
    const fetcher = vi.fn<typeof fetch>()
    const client = new QianshouCoreClient(config, () => new Promise<string>((resolve) => { settle = resolve }), fetcher)
    const controller = new AbortController()
    const pending = client.getIdentity(controller.signal)
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
    controller.abort('private caller reason')
    await expect(pending).rejects.toMatchObject({ code: 'CORE_REQUEST_ABORTED', message: 'CORE_REQUEST_ABORTED' })
    settle?.('late-access')
    await Promise.resolve()
    expect(fetcher).not.toHaveBeenCalled()
    await client.close()
  })

  it('does not start transport for an already aborted caller', async () => {
    const { client, fetcher } = waitingClient()
    const controller = new AbortController()
    controller.abort()
    await expect(client.getIdentity(controller.signal)).rejects.toMatchObject({ code: 'CORE_REQUEST_ABORTED' })
    expect(fetcher).not.toHaveBeenCalled()
    await client.close()
  })

  it('close aborts all active requests, awaits cleanup, and refuses later reads', async () => {
    const { client } = waitingClient()
    const first = expect(client.getIdentity()).rejects.toMatchObject({ code: 'CORE_CLIENT_CLOSED' })
    const second = expect(client.getCapabilities()).rejects.toMatchObject({ code: 'CORE_CLIENT_CLOSED' })
    await Promise.resolve()
    await client.close()
    await Promise.all([first, second])
    await expect(client.getIdentity()).rejects.toMatchObject({ code: 'CORE_CLIENT_CLOSED' })
    await client.close()
  })

  it('reports a bounded timeout', async () => {
    const { client } = waitingClient(5)
    await expect(client.getIdentity()).rejects.toMatchObject({ code: 'CORE_REQUEST_TIMEOUT', status: 504 })
    await client.close()
  })

  it.each([
    'http://core.example.test', 'https://user:pass@core.example.test',
    'https://core.example.test/api/v8', 'https://core.example.test?token=value',
    'https://core.example.test#fragment', 'file:///tmp/core', 'invalid',
  ])('rejects unsafe or ambiguous origins: %s', (baseUrl) => {
    expect(() => new QianshouCoreClient({ ...config, baseUrl }, () => 'test-access')).toThrow('CORE_INVALID_ORIGIN')
  })

  it.each(['http://127.0.0.1:8000', 'http://localhost:8000', 'http://[::1]:8000'])(
    'supports explicit loopback fixtures: %s',
    async (baseUrl) => {
      const { client } = clientFor(identity, { baseUrl })
      await expect(client.getIdentity()).resolves.toMatchObject({ accountId: 41 })
      await client.close()
    },
  )
})

