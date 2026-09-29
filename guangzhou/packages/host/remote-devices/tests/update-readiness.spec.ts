import { afterEach, describe, expect, it, vi } from 'vitest'
import { WorkAdmission } from '@deepseek-ai/dsh-agent'
import { UpdatePreparationError, UpdateReadinessController } from '../src/update-readiness.ts'

const owners: UpdateReadinessController[] = []
afterEach(() => { for (const owner of owners.splice(0)) owner.dispose(); vi.useRealTimers() })
function fixture() {
  const gates = [new WorkAdmission(), new WorkAdmission(), new WorkAdmission()]
  const busy = { agents: 0, jobs: 0, remoteJobs: 0 }
  const owner = new UpdateReadinessController(gates, () => ({ ...busy }))
  owners.push(owner)
  return { owner, gates, busy }
}
function failure(action: () => unknown, code: string): void {
  try { action(); throw new Error('expected refusal') }
  catch (error) { expect(error).toBeInstanceOf(UpdatePreparationError); expect((error as UpdatePreparationError).payload.code).toBe(code) }
}

describe('atomic update leases', () => {
  it('refuses each busy authority, releases all gates, and admits ordinary work after refusal', () => {
    const { owner, gates, busy } = fixture()
    for (const key of ['agents', 'jobs', 'remoteJobs'] as const) {
      busy[key] = 1
      failure(() => owner.prepare(), 'UPDATE_BUSY')
      expect(owner.readiness().maintenance.active).toBe(false)
      for (const gate of gates) gate.acquire()()
      busy[key] = 0
    }
    const release = gates[0]!.acquire()
    failure(() => owner.prepare(), 'UPDATE_BUSY')
    expect(owner.readiness().busy.admissions).toBe(1)
    release()
    expect(owner.readiness().ready).toBe(true)
  })

  it('blocks every real admission authority until the matching cancel, with no indefinite renewal', () => {
    const { owner, gates } = fixture()
    const lease = owner.prepare()
    expect(lease.ttlMs).toBe(30_000)
    for (const gate of gates) {
      expect(() => gate.acquire()).toThrow('本次输入未提交')
      expect(gate.pending).toBe(0)
    }
    failure(() => owner.prepare(), 'UPDATE_PREPARING')
    expect(owner.cancel('stale')).toEqual({ released: false })
    expect(owner.cancel(lease.leaseId)).toEqual({ released: true })
    expect(owner.cancel(lease.leaseId)).toEqual({ released: false })
    for (const gate of gates) gate.acquire()()
    failure(() => owner.prepare(), 'UPDATE_RETRY_LATER')
  })

  it('expires even if the event loop has not run its timer, and never commits over newly admitted work', () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000)
    const { owner, gates, busy } = fixture()
    const lease = owner.prepare()
    vi.setSystemTime(130_001)
    const release = gates[1]!.acquire()
    busy.jobs = 1
    release()
    failure(() => owner.commit(lease.leaseId), 'UPDATE_LEASE_EXPIRED')
    expect(owner.readiness()).toMatchObject({ ready: false, busy: { jobs: 1 }, maintenance: { active: false } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('bounds first-commit extension and makes repeated commits non-renewable', () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000)
    const { owner, gates } = fixture()
    const lease = owner.prepare()
    vi.advanceTimersByTime(29_000)
    expect(owner.commit(lease.leaseId)).toEqual({ committed: true, expiresAt: 144_000 })
    vi.advanceTimersByTime(10_000)
    expect(owner.commit(lease.leaseId).expiresAt).toBe(144_000)
    failure(() => owner.commit('wrong'), 'UPDATE_LEASE_EXPIRED')
    vi.advanceTimersByTime(5_000)
    failure(() => owner.commit(lease.leaseId), 'UPDATE_LEASE_EXPIRED')
    for (const gate of gates) gate.acquire()()
    vi.advanceTimersByTime(5_000)
    expect(owner.prepare().leaseId).not.toBe(lease.leaseId)
  })

  it('refuses when the lease expires during the final synchronous observation', () => {
    vi.useFakeTimers(); vi.setSystemTime(100_000)
    const gate = new WorkAdmission()
    let slow = false
    const owner = new UpdateReadinessController([gate], () => {
      if (slow) vi.setSystemTime(130_001)
      return { agents: 0, jobs: 0, remoteJobs: 0 }
    })
    owners.push(owner)
    const lease = owner.prepare()
    slow = true
    failure(() => owner.commit(lease.leaseId), 'UPDATE_LEASE_EXPIRED')
    gate.acquire()()
    expect(owner.readiness().maintenance.active).toBe(false)
  })

  it('fails closed when observation throws and releases on owner disposal', () => {
    const gate = new WorkAdmission()
    const broken = new UpdateReadinessController([gate], () => { throw new Error('cannot inspect') })
    owners.push(broken)
    expect(() => broken.prepare()).toThrow('cannot inspect')
    gate.acquire()()
    const { owner, gates } = fixture()
    owner.prepare(); owner.dispose()
    for (const source of gates) source.acquire()()
    failure(() => owner.prepare(), 'UPDATE_UNAVAILABLE')
  })

  it('refuses synchronous prepare reentry from a producer guard before side effects start', () => {
    const { owner, gates } = fixture()
    const remove = gates[0]!.register(() => { failure(() => owner.prepare(), 'UPDATE_BUSY') })
    const release = gates[0]!.acquire()
    expect(owner.readiness().maintenance.active).toBe(false)
    release(); remove()
  })
})
