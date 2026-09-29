/**
 * U1 中继（宿主侧）：渲染进程不能直连回环端点（端点拒绝带 Origin 的请求），
 * 因此由宿主 Node 侧代打，客户端只走同源 `/qianshou-node/*`。
 * 本文件用**真实 HTTP 套接字**验证，不用假 fetch。
 */
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { agentAcceptSnapshot } from '../src/relay/agent-status.ts'
import { createNodeRelay, resolveNodeRelayConfig } from '../src/relay/node-relay.ts'
import { parseNodeStatus } from '../src/client/node-status/types.ts'

const servers: Server[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
  const server = createServer(handler)
  servers.push(server)
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

const snapshot = { schema: 'qianshou.node-status.v1', pid: 1, connection: { state: 'online' } }

function relayServer(upstream: string, proof = ''): Promise<string> {
  const relay = createNodeRelay({ upstream, proof, timeoutMs: 2000 })
  return listen((request, response) => { void relay.handle(request, response) })
}

describe('U1 本机节点中继', () => {
  it('转发快照原文，并且从不把浏览器 Origin 带给端点（端点的门不动）', async () => {
    const seen: Array<{ origin?: string; path: string }> = []
    const upstream = await listen((request, response) => {
      seen.push({ ...(request.headers.origin === undefined ? {} : { origin: request.headers.origin }), path: request.url ?? '' })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(snapshot))
    })
    const relay = await relayServer(upstream)
    const response = await fetch(`${relay}/qianshou-node/status`)
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual(snapshot)
    expect(seen).toEqual([{ path: '/status' }])
  })

  it('带 Origin 打中继自己也被拒（中继不是一道后门）', async () => {
    const upstream = await listen((_request, response) => { response.writeHead(200); response.end('{}') })
    const relay = await relayServer(upstream)
    const response = await fetch(`${relay}/qianshou-node/status`, { headers: { origin: 'https://evil.example' } })
    expect(response.status).toBe(403)
    expect((await response.json() as { code: string }).code).toBe('RELAY_ORIGIN_REFUSED')
  })

  it('中止命令按端点真实契约转发（target），口令只从环境变量来', async () => {
    const seen: Array<{ headers: Record<string, unknown>; body: string }> = []
    const upstream = await listen((request, response) => {
      let body = ''
      request.on('data', chunk => { body += String(chunk) })
      request.on('end', () => {
        seen.push({ headers: request.headers, body })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ ok: true, command: 'abort' }))
      })
    })
    const relay = await relayServer(upstream, 'proof-from-env')
    const response = await fetch(`${relay}/qianshou-node/command`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ command: 'abort', target: 'all' }),
    })
    expect(response.status).toBe(200)
    expect(seen).toHaveLength(1)
    expect(seen[0]?.body).toBe(JSON.stringify({ command: 'abort', target: 'all' }))
    expect(seen[0]?.headers['x-owner-proof']).toBe('proof-from-env')
    expect(seen[0]?.headers.origin).toBeUndefined()
  })

  it('节点没在跑时明确回答"未运行"，不是 500', async () => {
    const closed = await listen((_request, response) => { response.writeHead(200); response.end('{}') })
    const relay = createNodeRelay({ upstream: 'http://127.0.0.1:1/', proof: '', timeoutMs: 500 })
    const server = await listen((request, response) => { void relay.handle(request, response) })
    const response = await fetch(`${server}/qianshou-node/status`)
    expect(closed).toBeTruthy()
    expect(response.status).toBe(503)
    expect((await response.json() as { code: string }).code).toBe('NODE_UNREACHABLE')
  })

  it('电源开关不转发给节点，也不接受带 Origin 的请求', async () => {
    const seen: string[] = []
    const upstream = await listen((request, response) => {
      seen.push(request.url ?? '')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end('{}')
    })
    const relay = createNodeRelay({
      upstream, proof: '', timeoutMs: 2000,
      power: {
        view: () => ({ running: true, managed: true, mode: 'running' }),
        set: on => Promise.resolve({ running: on, managed: on, mode: on ? 'running' as const : null }),
      },
    })
    const server = await listen((request, response) => { void relay.handle(request, response) })
    const on = await fetch(`${server}/qianshou-node/power`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: false }),
    })
    expect(on.status).toBe(200)
    expect(await on.json()).toEqual({ running: false, managed: false, mode: null })
    const refused = await fetch(`${server}/qianshou-node/power`, { headers: { origin: 'https://evil.example' } })
    expect(refused.status).toBe(403)
    expect(seen).toEqual([])
  })

  it('没注入电源时 /power 不是一条上游路由', async () => {
    const seen: string[] = []
    const upstream = await listen((request, response) => {
      seen.push(request.url ?? '')
      response.writeHead(200)
      response.end('{}')
    })
    const relay = await relayServer(upstream)
    const response = await fetch(`${relay}/qianshou-node/power`)
    expect(response.status).toBe(404)
    expect(seen).toEqual([])
  })

  it('专员状态由本进程回答，不转发给数词进程', async () => {
    const seen: string[] = []
    const upstream = await listen((request, response) => {
      seen.push(request.url ?? '')
      response.writeHead(200)
      response.end('{}')
    })
    const relay = createNodeRelay({
      upstream, proof: '', timeoutMs: 2000,
      agentStatus: () => ({ schema: 'qianshou.node-status.v1', pid: 7, connection: { state: 'online' } }),
    })
    const server = await listen((request, response) => { void relay.handle(request, response) })
    const response = await fetch(`${server}/qianshou-node/status`)
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ schema: 'qianshou.node-status.v1', pid: 7 })
    expect(seen).toEqual([])
    const parsed = parseNodeStatus(agentAcceptSnapshot({
      pid: 7, startedAtMs: 1_000, nowMs: 4_000, intake: 'running', driver: 'running',
      workerId: 'w1', ownerId: 167, core: 'https://qianshousuanli.com',
    }))
    expect(parsed?.connection.state).toBe('online')
    expect(parsed?.connection.mode).toBe('running')
    expect(parsed?.counters.offersReceived).toBe(0)
    expect(parsed?.current).toBeNull()
    expect(parsed?.earnings.estimatedNodeYuan).toBeNull()
    const paused = parseNodeStatus(agentAcceptSnapshot({
      pid: 7, startedAtMs: 1_000, nowMs: 4_000, intake: 'paused', driver: 'running',
      workerId: 'w1', ownerId: 167, core: 'https://qianshousuanli.com',
      intakeReason: 'owner-policy-blocked', intakeReasons: ['USER_ACTIVE'],
    }))
    expect(paused?.intakeReason).toBe('owner-policy-blocked')
    expect(paused?.intakeReasons).toEqual(['USER_ACTIVE'])
    expect(paused?.connection.mode).toBe('paused')
    const taskStartedAt = '2026-09-23T06:00:00.000Z'
    const running = agentAcceptSnapshot({
      pid: 7, startedAtMs: 1_000, nowMs: Date.parse(taskStartedAt) + 5_000, intake: 'running', driver: 'running',
      workerId: 'w1', ownerId: 167, core: 'https://qianshousuanli.com',
      running: [{
        taskId: 'workload-1.shard-1', attempt: 1, taskType: 'word_count',
        progress: 0, progressEvents: 2, startedAt: taskStartedAt,
      }],
    })
    expect(running.current).toMatchObject({
      shardId: 'shard-1', workloadId: 'workload-1', taskType: 'word_count',
      progressPct: 0, progressEvents: 2, phase: 'working', elapsedMs: 5_000,
    })
  })

  it('端口与口令只从环境变量读，缺省端口就是 47615', () => {
    expect(resolveNodeRelayConfig({})).toMatchObject({ upstream: 'http://127.0.0.1:47615/', proof: '' })
    expect(resolveNodeRelayConfig({ QIANSHOU_NODE_STATUS_PORT: '47999', QIANSHOU_NODE_OWNER_PROOF: 'secret' }))
      .toMatchObject({ upstream: 'http://127.0.0.1:47999/', proof: 'secret' })
    expect(resolveNodeRelayConfig({ QIANSHOU_NODE_STATUS_PORT: 'not-a-port' })).toMatchObject({ upstream: 'http://127.0.0.1:47615/' })
  })
})
