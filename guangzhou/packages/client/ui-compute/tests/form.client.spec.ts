import { describe, expect, it } from 'vitest'
import { planRequest, type PlanForm } from '../src/client/form.ts'
import { capability } from './fixtures.ts'
const form: PlanForm = { capabilityId: capability.id, goal: ' 处理图片 ', budget: '0.29', nodeMode: 'auto', nodes: '' }
describe('compute plan requirements', () => {
  it('converts yuan without floating point rounding and preserves zero budget as no paid work', () => {
    expect(planRequest(form, [capability])).toEqual({ capabilityId: capability.id, goal: '处理图片', budgetMinor: 29, currency: 'CNY', maxNodes: null })
    expect(planRequest({ ...form, budget: '0' }, [capability])?.budgetMinor).toBe(0)
    expect(planRequest({ ...form, budget: '12.3', nodeMode: 'manual', nodes: '4' }, [capability])).toMatchObject({ budgetMinor: 1230, maxNodes: 4 })
  })
  it.each(['', '-1', '0.001', 'NaN', '1e3', '9007199254740992', ' 5'])('rejects invalid budget %s', (budget) => {
    expect(planRequest({ ...form, budget }, [capability])).toBeNull()
  })
  it.each(['', '0', '-1', '1.5', '65', 'Infinity', '1e1'])('rejects invalid manual nodes %s', (nodes) => {
    expect(planRequest({ ...form, nodeMode: 'manual', nodes }, [capability])).toBeNull()
  })
  it('binds only a currently available capability and a nonempty goal', () => {
    expect(planRequest(form, [])).toBeNull()
    expect(planRequest(form, [{ ...capability, available: false }])).toBeNull()
    expect(planRequest({ ...form, goal: ' ' }, [capability])).toBeNull()
  })
})
