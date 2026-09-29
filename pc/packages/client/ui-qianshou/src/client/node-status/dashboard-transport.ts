/** Renderer-side reader for the authenticated, Host-sanitized node dashboard route. */
import type { IntakeDashboardData } from './IntakeDashboard.tsx'

export interface IntakeDashboardTransport {
  read(workerId: string, offset: number, signal?: AbortSignal): Promise<IntakeDashboardData>
}

export interface IntakeDashboardTransportOptions {
  readonly baseUri?: string
  readonly fetchImpl?: typeof fetch
}

/** No Shanghai origin or account token ever enters the renderer. */
export function createIntakeDashboardTransport(options: IntakeDashboardTransportOptions = {}): IntakeDashboardTransport {
  const request = options.fetchImpl ?? fetch
  return {
    async read(workerId, offset, signal) {
      if (!/^[A-Za-z0-9._-]{6,128}$/u.test(workerId) || workerId.includes('..')
        || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) throw new Error('DASHBOARD_REQUEST_INVALID')
      const baseUri = options.baseUri ?? (typeof document === 'undefined' ? 'http://127.0.0.1/' : document.baseURI)
      const url = new URL('/api/qianshou/compute/node/dashboard', baseUri)
      url.searchParams.set('worker_id', workerId)
      url.searchParams.set('offset', String(offset))
      const response = await request(url.toString(), {
        method: 'GET', credentials: 'same-origin', cache: 'no-store', headers: { accept: 'application/json' },
        ...(signal === undefined ? {} : { signal }),
      })
      if (!response.ok) throw new Error('DASHBOARD_UNAVAILABLE')
      return parseIntakeDashboard(await response.json(), workerId)
    },
  }
}

/** Reject malformed same-origin responses before they become visible metrics. */
export function parseIntakeDashboard(value: unknown, workerId: string): IntakeDashboardData {
  const body = record(value)
  if (body.schema !== 'qianshou.node-dashboard.v1' || body.worker_id !== workerId
    || body.history_scope !== 'current_shard_assignment' || body.plugin_calls !== null
    || !Array.isArray(body.items) || body.items.length > 100) throw new Error('DASHBOARD_RESPONSE_INVALID')
  const counts = record(body.counts)
  const earnings = record(body.earnings)
  if (earnings.currency !== 'CNY' || !amount(earnings.settled_node_compute)) throw new Error('DASHBOARD_RESPONSE_INVALID')
  const limit = whole(body.limit)
  if (limit < 1 || limit > 100 || body.items.length > limit) throw new Error('DASHBOARD_RESPONSE_INVALID')
  const items = body.items.map((value) => {
    const item = record(value)
    if (!amount(item.settled_node_compute_cny)) throw new Error('DASHBOARD_RESPONSE_INVALID')
    return {
      shard_id: bounded(item.shard_id, 128), workload_id: bounded(item.workload_id, 128),
      task_type: bounded(item.task_type, 128, true), status: bounded(item.status, 32),
      attempts: whole(item.attempts),
      dispatched_at: instant(item.dispatched_at), started_at: instant(item.started_at),
      completed_at: instant(item.completed_at), elapsed_ms: nullableWhole(item.elapsed_ms),
      settled_node_compute_cny: item.settled_node_compute_cny,
    }
  })
  return {
    schema: 'qianshou.node-dashboard.v1', worker_id: workerId, history_scope: 'current_shard_assignment',
    counts: {
      executions: whole(counts.executions), orders: whole(counts.orders),
      succeeded: whole(counts.succeeded), failed: whole(counts.failed),
      cancelled: whole(counts.cancelled), pending_resolution: whole(counts.pending_resolution),
      avg_success_elapsed_ms: nullableWhole(counts.avg_success_elapsed_ms),
    },
    earnings: { currency: 'CNY', settled_node_compute: earnings.settled_node_compute },
    plugin_calls: null, plugin_calls_note: bounded(body.plugin_calls_note, 256, true),
    total: whole(body.total), limit, offset: whole(body.offset), items,
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('DASHBOARD_RESPONSE_INVALID')
  return value as Record<string, unknown>
}

function whole(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('DASHBOARD_RESPONSE_INVALID')
  return value
}

function nullableWhole(value: unknown): number | null { return value === null ? null : whole(value) }

function bounded(value: unknown, length: number, empty = false): string {
  if (typeof value !== 'string' || value.length > length || (!empty && value.length === 0)) throw new Error('DASHBOARD_RESPONSE_INVALID')
  return value
}

function instant(value: unknown): string | null {
  if (value === null) return null
  if (typeof value !== 'string' || value.length > 64 || !Number.isFinite(Date.parse(value))) throw new Error('DASHBOARD_RESPONSE_INVALID')
  return value
}

function amount(value: unknown): value is string { return typeof value === 'string' && value.length < 32 && /^\d+(?:\.\d{1,4})?$/u.test(value) }
