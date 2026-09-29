// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { createIntakeDashboardTransport, parseIntakeDashboard } from '../src/client/node-status/dashboard-transport.ts'

const workerId = 'worker-001'

function payload() {
  return {
    schema: 'qianshou.node-dashboard.v1', worker_id: workerId, history_scope: 'current_shard_assignment',
    counts: { executions: 57, orders: 29, succeeded: 35, failed: 7, cancelled: 3, pending_resolution: 12, avg_success_elapsed_ms: 4900 },
    earnings: { currency: 'CNY', settled_node_compute: '3.9000' }, plugin_calls: null,
    plugin_calls_note: '尚无可核实插件执行', total: 57, limit: 20, offset: 20,
    items: [{ shard_id: 'shard-1', workload_id: 'workload-1', task_type: 'llm_chat', status: 'done', attempts: 1,
      dispatched_at: '2026-09-23T03:00:00Z', started_at: '2026-09-23T03:00:01Z', completed_at: '2026-09-23T03:00:05Z',
      elapsed_ms: 4000, settled_node_compute_cny: '0.4875', output_preview: 'publisher secret' }],
  }
}

describe('authenticated node dashboard reader', () => {
  it('calls only the same-origin Host route and keeps just approved display fields', async () => {
    const request = vi.fn(async () => Response.json(payload()))
    const reader = createIntakeDashboardTransport({ baseUri: 'dsh-app://app/', fetchImpl: request as unknown as typeof fetch })
    const result = await reader.read(workerId, 20)
    expect(request).toHaveBeenCalledOnce()
    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('dsh-app://app/api/qianshou/compute/node/dashboard?worker_id=worker-001&offset=20')
    expect(init.credentials).toBe('same-origin')
    expect(result.earnings.settled_node_compute).toBe('3.9000')
    expect(result.items[0]?.settled_node_compute_cny).toBe('0.4875')
    expect('output_preview' in (result.items[0] ?? {})).toBe(false)
  })

  it('rejects a different worker or malformed figures before the UI can show them', () => {
    expect(() => parseIntakeDashboard({ ...payload(), worker_id: 'someone-else' }, workerId)).toThrow('DASHBOARD_RESPONSE_INVALID')
    expect(() => parseIntakeDashboard({ ...payload(), earnings: { currency: 'CNY', settled_node_compute: 'not-money' } }, workerId)).toThrow('DASHBOARD_RESPONSE_INVALID')
  })
})
