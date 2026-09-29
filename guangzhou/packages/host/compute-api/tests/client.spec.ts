import { describe, expect, it } from 'vitest'
import { ComputeApiError, createComputeApiClient, type ComputeApiFetch } from '../src/index.ts'

function response(value: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' }, ...init })
}

describe('compute API client', () => {
  it('calls documented read-only routes with bearer auth', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    const fetcher: ComputeApiFetch = async (input, init) => {
      const url = typeof input === 'string' || input instanceof URL ? input.toString() : input.url
      requests.push(init === undefined ? { url } : { url, init })
      return response(new URL(url).pathname === '/api/v8/workloads' ? [] : { ok: true })
    }
    const api = createComputeApiClient({ baseUrl: 'https://compute.example', accessToken: 'token', maxResponseBytes: 1024, fetch: fetcher })
    await api.me(); await api.taskTypes(); await api.workloads(); await api.workload('w/1').catch((error: unknown) => { expect(error).toBeInstanceOf(ComputeApiError) })
    await api.workload('w-1'); await api.shards('w-1'); await api.result('w-1')
    expect(requests.map(request => request.url)).toEqual([
      'https://compute.example/api/v8/auth/me',
      'https://compute.example/api/v8/developer/task-types',
      'https://compute.example/api/v8/workloads',
      'https://compute.example/api/v8/workloads/w-1',
      'https://compute.example/api/v8/workloads/w-1/shards',
      'https://compute.example/api/v8/workloads/w-1/result',
    ])
    expect(requests[0]?.init?.method).toBe('GET')
    expect(new Headers(requests[0]?.init?.headers).get('authorization')).toBe('Bearer token')
  })

  it('rejects upstream failures without exposing response text', async () => {
    const api = createComputeApiClient({ baseUrl: 'https://compute.example', accessToken: 'token', maxResponseBytes: 1024, fetch: async () => new Response('secret upstream detail', { status: 503 }) })
    await expect(api.me()).rejects.toMatchObject({ code: 'COMPUTE_API_HTTP_503', status: 503 })
    await expect(api.me()).rejects.not.toThrow('secret upstream detail')
  })

  it.each([{ workloads: [] }, { workloads: [{ id: 'w-1', status: 'RUNNING', progress: 0.5 }, { id: 'w-2', status: 'DONE', result: null }] }])('reads an unwrapped workload array and freezes its records: $workloads', async ({ workloads }) => {
    const api = createComputeApiClient({ baseUrl: 'https://compute.example', accessToken: 'token', maxResponseBytes: 1024, fetch: async () => response(workloads) })
    const signal = new AbortController().signal
    const result = await api.workloads(signal)
    expect(result).toEqual(workloads)
    expect(Object.isFrozen(result)).toBe(true)
    expect(result.every(record => Object.isFrozen(record))).toBe(true)
  })

  it.each([{}, { items: [] }, null, 'private-upstream-detail', [null], [[]], [{ id: 'w-1' }, 1]].map(body => ({ body })))('rejects invalid workload lists without exposing their body: $body', async ({ body }) => {
    const api = createComputeApiClient({ baseUrl: 'https://compute.example', accessToken: 'token', maxResponseBytes: 1024, fetch: async () => response(body) })
    await expect(api.workloads()).rejects.toMatchObject({ code: 'COMPUTE_API_RESPONSE_INVALID', status: 200, message: 'COMPUTE_API_RESPONSE_INVALID' })
  })

  it('keeps object validation for every other route', async () => {
    const api = createComputeApiClient({ baseUrl: 'https://compute.example', accessToken: 'token', maxResponseBytes: 1024, fetch: async () => response([]) })
    for (const request of [() => api.me(), () => api.taskTypes(), () => api.workload('w-1'), () => api.shards('w-1'), () => api.result('w-1')]) {
      await expect(request()).rejects.toMatchObject({ code: 'COMPUTE_API_RESPONSE_INVALID' })
    }
  })

  it('bounds workload response bytes and forwards cancellation', async () => {
    const signal = new AbortController().signal
    const api = createComputeApiClient({ baseUrl: 'https://compute.example', accessToken: 'token', maxResponseBytes: 2, fetch: async (_, init) => {
      expect(init?.signal).toBe(signal)
      return response([{ id: 'w-1' }])
    } })
    await expect(api.workloads(signal)).rejects.toMatchObject({ code: 'COMPUTE_API_RESPONSE_TOO_LARGE' })
  })

  it('bounds content length and validates JSON objects', async () => {
    const oversized = createComputeApiClient({ baseUrl: 'https://compute.example', accessToken: 'token', maxResponseBytes: 4, fetch: async () => new Response('{"x":1}', { headers: { 'content-length': '7' } }) })
    await expect(oversized.me()).rejects.toMatchObject({ code: 'COMPUTE_API_RESPONSE_TOO_LARGE' })
    const invalid = createComputeApiClient({ baseUrl: 'https://compute.example', accessToken: 'token', maxResponseBytes: 1024, fetch: async () => new Response('[]') })
    await expect(invalid.me()).rejects.toMatchObject({ code: 'COMPUTE_API_RESPONSE_INVALID' })
    const malformed = createComputeApiClient({ baseUrl: 'https://compute.example', accessToken: 'token', maxResponseBytes: 1024, fetch: async () => new Response('nope') })
    await expect(malformed.me()).rejects.toMatchObject({ code: 'COMPUTE_API_JSON_INVALID' })
  })

  it('rejects unsafe identifiers and base URLs at the adapter edge', async () => {
    const api = createComputeApiClient({ baseUrl: 'https://compute.example', accessToken: 'token', maxResponseBytes: 1024, fetch: async () => response({}) })
    await expect(api.workload('w/secret')).rejects.toMatchObject({ code: 'COMPUTE_API_ID_INVALID' })
    expect(() => createComputeApiClient({ baseUrl: 'https://compute.example/api/v8', accessToken: 'token', maxResponseBytes: 1024 })).toThrow('COMPUTE_API_OPTIONS_INVALID')
    expect(() => createComputeApiClient({ baseUrl: 'ftp://compute.example', accessToken: 'token', maxResponseBytes: 1024 })).toThrow('COMPUTE_API_OPTIONS_INVALID')
  })
})
