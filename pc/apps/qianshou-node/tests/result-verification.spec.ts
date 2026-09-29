/**
 * 节点侧核验装配的真实验证：用**真的 HTTP**读平台形状的 `GET /api/v8/workloads/{id}`。
 *
 * 这里钉的是一整条闭环，而不是模块内部的算术：
 * 基线在发出前读 → 发出后轮询 → 只有计数前进才拿到 `settleable`；
 * 读不到基线 / 计数不动 / 网络错，一律不得变成成功。
 */
import { createServer, type RequestListener } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { EdgeTaskIdentity } from '@deepseek-ai/dsh-compute-core'
import { DEFAULT_NODE_VERIFICATION_WINDOW, createNodeResultVerification } from '../workload-verification.ts'

const identity: EdgeTaskIdentity = { workerId: 'worker-1', workloadId: 'workload-1', shardId: 'shard-1', attempt: 0 }
/** 生产窗口按秒计；用例把等待压到 1 毫秒，形状不变。预算开宽是为了不让机器负载抖动造成假红。 */
const window = { ...DEFAULT_NODE_VERIFICATION_WINDOW, timeoutMs: 60_000, maxPolls: 4, initialDelayMs: 1, maxDelayMs: 2 }

const servers: ReturnType<typeof createServer>[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
})

/** 起一个只服务工作负载详情路由的真 HTTP 服务；`readings` 依次被消费。 */
async function serve(readings: readonly Record<string, unknown>[], handler?: RequestListener) {
  let index = 0
  const seen: string[] = []
  const server = createServer(handler ?? ((request, response) => {
    seen.push(String(request.url))
    const body = readings[Math.min(index, readings.length - 1)]!
    index += 1
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(body))
  }))
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  servers.push(server)
  return { origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen }
}

/** 平台详情投影的原生形状（`supply/edge-api.ts:parseWorkload` 认的那一份）。 */
function projection(completed: number, failed: number) {
  return { id: 'workload-1', name: 'task', status: 'RUNNING', progress: 0, total_shards: 1,
    completed_shards: completed, failed_shards: failed, created_at: '2026-09-22T00:00:00Z', completed_at: null }
}

describe('node-side polled verification over the real read side', () => {
  it('leaves sent-awaiting-verification once the platform projection counts the shard', async () => {
    const { origin, seen } = await serve([projection(0, 0), projection(1, 0)])
    const verification = createNodeResultVerification({ baseUrl: origin, tokenProvider: () => 'fixture-token',
      timeoutMs: 1000, maxResponseBytes: 65536, window, reader: undefined })
    const before = await verification.before(identity)
    expect(before).toEqual({ completedShards: 0, failedShards: 0 })
    const verified = await verification.verify(identity, before)
    expect(verified).toMatchObject({ outcome: 'workload-completed-shard-observed', disposition: 'settleable',
      attribution: 'workload-aggregate-only', identity })
    // 真的走了平台那条详情路由，每次读都会问一次。
    expect(seen.length).toBeGreaterThanOrEqual(2)
    expect(seen.every(url => url === '/api/v8/workloads/workload-1')).toBe(true)
    verification.close()
  })

  it('keeps an unread baseline null and refuses to report acceptance from it', async () => {
    const { origin } = await serve([], (_request, response) => { response.writeHead(403); response.end('{}') })
    const verification = createNodeResultVerification({ baseUrl: origin, tokenProvider: () => 'fixture-token',
      timeoutMs: 1000, maxResponseBytes: 65536, window })
    // 403 ⇒ 基线读不到 ⇒ null；绝不用"发出之后的第一份读数"顶替。
    expect(await verification.before(identity)).toBeNull()
    const verified = await verification.verify(identity, null)
    expect(verified).toMatchObject({ outcome: 'unobservable', code: 'EDGE_VERIFICATION_NO_BASELINE', polls: 0 })
    verification.close()
  })

  it('reports a bounded unknown, never success, when the read side is unreachable', async () => {
    const verification = createNodeResultVerification({ baseUrl: 'http://127.0.0.1:1', tokenProvider: () => 'fixture-token',
      timeoutMs: 200, maxResponseBytes: 65536, window: { ...window, maxPolls: 2 } })
    const verified = await verification.verify(identity, { completedShards: 0, failedShards: 0 })
    expect(verified).toMatchObject({ outcome: 'unobservable', disposition: 'indeterminate', polls: 2, after: null })
    expect(verified.code).not.toBeNull()
    verification.close()
  })

  it('keeps a counted failed shard retryable instead of accepted', async () => {
    const { origin } = await serve([projection(0, 1)])
    const verification = createNodeResultVerification({ baseUrl: origin, tokenProvider: () => 'fixture-token',
      timeoutMs: 1000, maxResponseBytes: 65536, window })
    const verified = await verification.verify(identity, { completedShards: 0, failedShards: 0 })
    expect(verified).toMatchObject({ outcome: 'workload-failed-shard-observed', disposition: 'retryable' })
    verification.close()
  })
})
