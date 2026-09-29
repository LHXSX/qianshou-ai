import { describe, expect, it } from 'vitest'
import { WorkAdmission } from '../src/admission.ts'

describe('WorkAdmission', () => {
  it('counts before guard callbacks and releases reservations exactly once', () => {
    const gate = new WorkAdmission()
    const seen: number[] = []
    const remove = gate.register(() => { seen.push(gate.pending) })
    const release = gate.acquire()
    expect(seen).toEqual([1])
    expect(gate.pending).toBe(1)
    release(); release()
    expect(gate.pending).toBe(0)
    remove()
    gate.acquire()()
    expect(seen).toEqual([1])
  })

  it('rolls back a refusal and unregisters duplicate callbacks independently', () => {
    const gate = new WorkAdmission()
    const refusal = () => { throw new Error('veto') }
    const first = gate.register(refusal)
    const second = gate.register(refusal)
    first(); first()
    expect(() => gate.acquire()).toThrow('veto')
    expect(gate.pending).toBe(0)
    second()
    gate.acquire()()
    expect(gate.pending).toBe(0)
  })
})
