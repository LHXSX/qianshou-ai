import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EdgeSupplyApi } from '../../src/supply/edge-api.ts'
import { requestJson, safeOrigin } from '../../src/supply/http.ts'
import { createProbeCommand, probeGpus, probeLocalSupply, type ProbeCommand } from '../../src/supply/local-probe.ts'

const options = { timeoutMs: 1000, maxResponseBytes: 65536 }
const workload = { id: 'w-1', name: 'task', status: 'WAITING_FOR_WORKERS', progress: 0, total_shards: 1,
  completed_shards: 0, failed_shards: 0, created_at: '2026-09-15T00:00:00Z', completed_at: null,
  spec: { private_payload: 'not public' }, result: null }
function client(body: unknown, tokenProvider: () => string | undefined = () => 'fixture-token') {
  const fetcher = vi.fn<typeof fetch>(async () => new Response(JSON.stringify(body)))
  const api = new EdgeSupplyApi({ ...options, baseUrl: 'https://edge.example', tokenProvider, fetch: fetcher })
  return { api, fetcher }
}
describe('audited Edge HTTP shapes', () => {
  it('accepts direct workload arrays and strips private payloads', async () => {
    const { api } = client([workload]); const result = await api.queryWorkloads()
    expect(result[0]).toMatchObject({ id: 'w-1', status: 'WAITING_FOR_WORKERS' })
    expect(result[0]).not.toHaveProperty('spec'); expect(result[0]).not.toHaveProperty('updatedAt'); api.close()
  })
  it('does not broadly accept object envelopes for the array endpoint', async () => {
    const { api } = client({ ok: true, items: [workload] })
    await expect(api.queryWorkloads()).rejects.toThrow('EDGE_RESPONSE_INVALID'); api.close()
  })
  it('requires the catalogue envelope and projects no invented availability or version', async () => {
    const { api } = client({ ok: true, items: [{ task_type: 'word_count', description: 'Count words', executor: 'python',
      runtimes: ['python3'], required_software: [], requires_gpu: false, min_memory_mb: 256 }], total: 1 })
    const result = await api.queryCapabilities(); expect(result[0]?.taskType).toBe('word_count')
    expect(result[0]).not.toHaveProperty('available'); expect(result[0]).not.toHaveProperty('version'); api.close()
  })
  it('returns only the identity field needed by compute', async () => {
    const { api } = client({ ok: true, account: { id: 100, email: 'private@example.test', profile: { x: 'secret' } } })
    expect(await api.queryIdentity()).toEqual({ accountId: 100 }); api.close()
  })
  it('keeps real server prices as decimals and identifies quote as non-reserving', async () => {
    const { api, fetcher } = client({ task_type: 'word_count', unit: 'file', workload: 2, total_yuan: '0.10', total_cp: '1.00',
      node_cp: '0.80', platform_cp: '0.10', channel_cp: '0.05', risk_pool_cp: '0.05', settings_version: 7, currency: 'CNY', min_charge_applied: true })
    const quote = await api.queryQuote({ taskType: 'word_count', workload: 2, speed: 't24', quality: 'standard' })
    expect(quote).toMatchObject({ authority: 'estimate-only', totalCp: '1.00', totalYuan: '0.10' })
    expect(String(fetcher.mock.calls[0]?.[0])).toBe('https://edge.example/api/v8/economy/quote')
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ task_type: 'word_count', workload: 2, speed: 't24', quality: 'standard' })
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', credentials: 'omit' }); api.close()
  })
  it.each([() => undefined, () => { throw new Error('credential storage private'); }])('fails before HTTP without a token provider value', async provider => {
    const { api, fetcher } = client({}, provider); await expect(api.queryIdentity()).rejects.toThrow('SUPPLY_AUTH_REQUIRED')
    expect(fetcher).not.toHaveBeenCalled(); api.close()
  })
  it('rejects paths and prevents further requests after close', async () => {
    const { api, fetcher } = client(workload); await expect(api.queryWorkload('../auth/me')).rejects.toThrow('EDGE_WORKLOAD_ID_INVALID')
    api.close(); await expect(api.queryWorkloads()).rejects.toThrow('SUPPLY_CLOSED'); expect(fetcher).not.toHaveBeenCalled()
  })
})
describe('bounded real HTTP fixture', () => {
  const servers: ReturnType<typeof createServer>[] = []
  afterEach(async () => { for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) } })
  async function serve(handler: RequestListener) {
    const server = createServer(handler); servers.push(server); server.listen(0, '127.0.0.1'); await once(server, 'listening')
    return new URL(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  }
  it('does not expose upstream error bodies or follow redirects', async () => {
    const url = await serve((_request, response) => { response.writeHead(401); response.end('credential=do-not-return') })
    await expect(requestJson(url, {}, options)).rejects.toThrow('SUPPLY_AUTH_REQUIRED')
    const redirect = await serve((_request, response) => { response.writeHead(302, { location: url.toString() }); response.end() })
    await expect(requestJson(redirect, {}, options)).rejects.toThrow('SUPPLY_HTTP_FAILED')
  })
  it('bounds streamed bodies before parsing', async () => {
    const url = await serve((_request, response) => { response.write('['); response.end('0'.repeat(1000)) })
    await expect(requestJson(url, {}, { ...options, maxResponseBytes: 100 })).rejects.toThrow('SUPPLY_RESPONSE_TOO_LARGE')
  })
  it('close terminates a pending real request', async () => {
    let started!: () => void; const began = new Promise<void>(resolve => { started = resolve })
    const url = await serve((_request, response) => { response.writeHead(200); response.write('{'); started() })
    const api = new EdgeSupplyApi({ ...options, baseUrl: url.toString(), tokenProvider: () => 'fixture' })
    const request = api.queryIdentity(); const failure = expect(request).rejects.toThrow('SUPPLY_ABORTED')
    await began; api.close(); await failure
  })
  it.each(['http://example.com', 'https://user:pass@example.com', 'https://example.com/path', 'https://example.com?token=x', 'http://localhost'])('rejects unsafe origins', value => {
    expect(() => safeOrigin(value)).toThrow('SUPPLY_CONFIG_INVALID')
  })
})
describe('local capabilities', () => {
  it.each([
    ['v25.8.1\n', '25.8.1'], ['git version 2.50.1 (Apple Git-155)', '2.50.1'],
    ['ffmpeg version 8.0.1 Copyright (c)', '8.0.1'],
  ])('keeps complete tool versions from real version-line formats', async (line, version) => {
    const result = await probeLocalSupply({ ...options, tools: [{ id: 'version', name: 'Version probe', command: 'version-tool', args: [] }],
      readHostActivity: () => ({ foregroundTaskActive: null, voiceActive: null }) }, undefined, async () => line)
    expect(result.localServices[0]?.version).toBe(version)
  })
  it('uses real subprocess success and marks missing binaries unavailable', async () => {
    const run = createProbeCommand(options)
    expect(await run(process.execPath, ['--version'])).toMatch(/^v\d+/)
    await expect(run('/nonexistent/qianshou-test-probe', [])).rejects.toThrow('LOCAL_PROBE_UNAVAILABLE')
  })
  it('does not equate listed local model files with runnable inference', async () => {
    const run: ProbeCommand = async command => {
      if (command.includes('system_profiler')) return JSON.stringify({ SPDisplaysDataType: [] })
      if (command.includes('ioreg')) return '"HIDIdleTime" = 60000000000'
      return 'Python 3.12.1'
    }
    const result = await probeLocalSupply({ ...options, tools: [{ id: 'python', name: 'Python', command: 'python3', args: ['--version'] }],
      readHostActivity: () => ({ foregroundTaskActive: null, voiceActive: null }), ollamaOrigin: 'http://127.0.0.1:11434',
      fetch: async () => new Response(JSON.stringify({ models: [{ name: 'model', digest: 'a'.repeat(64) }] })) }, undefined, run)
    expect(result.hardware.logicalCores).toBeGreaterThan(0); expect(result.localServices[0]?.verification).toBe('verified')
    expect(result.localServices[1]?.verification).toBe('pending'); expect(result.activity.foregroundTaskActive).toBeNull()
  })
  it('never counts shared Apple system RAM as dedicated GPU memory', async () => {
    const run: ProbeCommand = async () => JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M4', spdisplays_vendor: 'Apple',
      spdisplays_ndrvs: [{ serial: 'private' }] }] })
    expect(await probeGpus('darwin', run)).toEqual([{ name: 'Apple M4', vendor: 'Apple', memoryBytes: null }])
  })
})
