/** Short, non-renewable update leases over real work admission owners. */
import type { Context } from '@deepseek-ai/cordis'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { WorkAdmission } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { randomUUID } from 'node:crypto'
import type { DeviceCoordinator } from './coordinator.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** A short update lease refuses new work without changing existing tasks. */
    'update/preparing': { expiresAt: number }
  }
}

/** Counts span every owner; they contain neither prompts nor device credentials. */
export interface UpdateBusyCounts { agents: number; jobs: number; remoteJobs: number; admissions: number }

/** Live readiness, including the bounded maintenance hold and reacquisition delay. */
export interface UpdateReadiness {
  ready: boolean
  busy: UpdateBusyCounts
  maintenance: { active: boolean; expiresAt: number | null; availableAt: number | null }
}

/** Authenticated HTTP failure with stable machine-readable update semantics. */
export class UpdatePreparationError extends Error {
  /**
   * @param status - HTTP status.
   * @param payload - Public failure fields.
   */
  constructor(readonly status: number, readonly payload: Readonly<Record<string, unknown>>) {
    super(String(payload.code))
  }
}

/** Random process-local capability for one bounded preparation attempt. */
export type UpdateLeaseId = string & Branded<'UpdateLeaseId'>

type Lease = { id: UpdateLeaseId; expiresAt: number; committed: boolean; releases: Array<() => void> }

/** Own one process-local hold; disposal and a maximum 45-second lifetime release every gate. */
export class UpdateReadinessController {
  private lease: Lease | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private availableAt = 0
  private disposed = false

  /**
   * @param admissions - Actual admission authorities; each reservation precedes all producer side effects.
   * @param readBusy - Synchronous authoritative counts; throwing refuses preparation.
   */
  constructor(private readonly admissions: readonly WorkAdmission[], private readonly readBusy: () => Omit<UpdateBusyCounts, 'admissions'>) {}

  /**
   * Inspect current work without taking a hold.
   * @returns Current counts after releasing an elapsed lease.
   */
  readiness(): UpdateReadiness {
    this.expire()
    const busy = { ...this.readBusy(), admissions: this.admissions.reduce((total, source) => total + source.pending, 0) }
    return {
      ready: this.lease === undefined && Object.values(busy).every(count => count === 0),
      busy,
      maintenance: {
        active: this.lease !== undefined,
        expiresAt: this.lease?.expiresAt ?? null,
        availableAt: this.availableAt > Date.now() ? this.availableAt : null,
      },
    }
  }

  /**
   * Install admission vetoes and atomically inspect every owner.
   * @returns A fresh 30-second lease only when no work is active.
   */
  prepare(): { leaseId: UpdateLeaseId; expiresAt: number; ttlMs: number } {
    if (this.disposed) throw new UpdatePreparationError(503, { code: 'UPDATE_UNAVAILABLE' })
    this.expire()
    if (this.lease) throw new UpdatePreparationError(409, { code: 'UPDATE_PREPARING', expiresAt: this.lease.expiresAt })
    if (this.availableAt > Date.now()) throw new UpdatePreparationError(429, { code: 'UPDATE_RETRY_LATER', availableAt: this.availableAt })
    // Install before observation: synchronous callbacks cannot admit work between these two steps.
    const lease: Lease = { id: randomUUID() as UpdateLeaseId, expiresAt: Date.now() + 30_000, committed: false, releases: [] }
    this.lease = lease
    try {
      for (const source of this.admissions) lease.releases.push(source.register(() => {
        this.expire()
        if (this.lease === lease) throw new RemoteError('update/preparing', '正在准备更新，请稍后重试；本次输入未提交。', { expiresAt: lease.expiresAt })
      }))
      const readiness = this.readiness()
      this.expire()
      if (this.lease !== lease) throw new UpdatePreparationError(409, { code: 'UPDATE_LEASE_EXPIRED' })
      if (Object.values(readiness.busy).some(count => count !== 0)) {
        this.release(false)
        throw new UpdatePreparationError(409, { code: 'UPDATE_BUSY', readiness: this.readiness() })
      }
      this.scheduleExpiry()
      return { leaseId: lease.id, expiresAt: lease.expiresAt, ttlMs: 30_000 }
    } catch (error: unknown) {
      this.release(false)
      throw error
    }
  }

  /**
   * Recheck after slow package validation; the first commit allows at most 15 further seconds to exit.
   * @param leaseId - Exact still-active preparation identity.
   * @returns The unchanged identity's final expiry; repeat commits never extend it.
   */
  commit(leaseId: string): { committed: true; expiresAt: number } {
    this.expire()
    const lease = this.lease
    if (!lease || lease.id !== leaseId) throw new UpdatePreparationError(409, { code: 'UPDATE_LEASE_EXPIRED' })
    let readiness: UpdateReadiness
    try { readiness = this.readiness() }
    catch (error: unknown) { this.release(true); throw error }
    this.expire()
    if (this.lease !== lease) throw new UpdatePreparationError(409, { code: 'UPDATE_LEASE_EXPIRED' })
    if (Object.values(readiness.busy).some(count => count !== 0)) {
      this.release(true)
      throw new UpdatePreparationError(409, { code: 'UPDATE_BUSY', readiness: this.readiness() })
    }
    if (!lease.committed) {
      lease.committed = true
      lease.expiresAt = Math.max(lease.expiresAt, Date.now() + 15_000)
      this.scheduleExpiry()
    }
    return { committed: true, expiresAt: lease.expiresAt }
  }

  /**
   * Release only the addressed preparation attempt.
   * @param leaseId - Exact active identity.
   * @returns Whether this request released that lease.
   */
  cancel(leaseId: string): { released: boolean } {
    this.expire()
    if (this.lease?.id !== leaseId) return { released: false }
    this.release(true)
    return { released: true }
  }

  /** Unregister admission guards and timers when the owning plugin exits. */
  dispose(): void { this.disposed = true; this.release(false) }

  private expire(): void {
    if (this.lease && this.lease.expiresAt <= Date.now()) this.release(true)
  }

  private scheduleExpiry(): void {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => { this.expire() }, Math.max(0, (this.lease?.expiresAt ?? 0) - Date.now()))
    this.timer.unref()
  }

  private release(cooldown: boolean): void {
    const lease = this.lease
    this.lease = undefined
    clearTimeout(this.timer)
    this.timer = undefined
    if (!lease) return
    for (const release of lease.releases.reverse()) release()
    // Limits repeated update requests; ordinary work is never subject to this delay.
    if (cooldown) this.availableAt = Date.now() + 5_000
  }
}

/**
 * Register maintenance routes through Connection authentication and own their full teardown.
 * @param ctx - Injected agents/jobs/connection owner.
 * @param coordinator - The same coordinator used by the HTTP and model-tool task producers.
 */
export function registerUpdateReadiness(ctx: Context, coordinator: DeviceCoordinator): void {
  const owner = new UpdateReadinessController(
    [ctx.agents.admission, ctx.jobs.admission, coordinator.admission],
    () => ({
      agents: ctx.agents.list().filter(agent => agent.status === 'running' || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0).length,
      jobs: ctx.jobs.activeCount,
      remoteJobs: coordinator.activeCount,
    }),
  )
  ctx.effect(() => () => { owner.dispose() }, 'qianshou: update admission hold')
  const routes: Array<{ suffix: string; method: 'GET' | 'POST'; run: (body: Record<string, unknown>) => unknown }> = [
    { suffix: 'readiness', method: 'GET', run: () => owner.readiness() },
    { suffix: 'prepare', method: 'POST', run: () => owner.prepare() },
    { suffix: 'commit', method: 'POST', run: body => owner.commit(leaseId(body)) },
    { suffix: 'cancel', method: 'POST', run: body => owner.cancel(leaseId(body)) },
  ]
  for (const route of routes) ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/qianshou/update-${route.suffix}`, methods: [route.method], requestBody: 'buffered',
    fetch: async (request) => {
      const headers = { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' }
      try {
        const body: unknown = route.method === 'POST' ? await request.json() : {}
        if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new UpdatePreparationError(400, { code: 'UPDATE_INVALID_REQUEST' })
        return Response.json(route.run(body as Record<string, unknown>), { status: route.suffix === 'prepare' ? 201 : 200, headers })
      } catch (error: unknown) {
        if (error instanceof UpdatePreparationError) return Response.json(error.payload, { status: error.status, headers })
        return Response.json({ code: error instanceof SyntaxError ? 'UPDATE_INVALID_REQUEST' : 'UPDATE_UNAVAILABLE' }, { status: error instanceof SyntaxError ? 400 : 503, headers })
      }
    },
  }), `qianshou: update-${route.suffix}`)
}

function leaseId(body: Record<string, unknown>): string {
  if (typeof body.leaseId !== 'string' || !/^[a-f0-9-]{36}$/u.test(body.leaseId)) throw new UpdatePreparationError(400, { code: 'UPDATE_INVALID_REQUEST' })
  return body.leaseId
}
