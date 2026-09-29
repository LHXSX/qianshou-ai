import { afterEach, expect, it, vi } from 'vitest'
import { exactPackageVersion, sameUpdateCurrent, UpdatePlans } from '../src/update-plans.ts'

afterEach(() => { vi.useRealTimers() })

it('bounds inspection retention, detaches caller records and expires without leaving active targets', () => {
  vi.useFakeTimers()
  const plans = new UpdatePlans()
  const current = { name: 'fixture', version: '1.0.0', spec: '^1.0.0', enabled: true }
  const target = { name: 'fixture', version: '2.0.0', spec: 'fixture@2.0.0' }
  const first = plans.add(current, target)
  target.spec = 'attacker@2.0.0'
  expect(plans.get(first.inspectionId)?.target.spec).toBe('fixture@2.0.0')
  for (let i = 0; i < 32; i++) plans.add(current, target)
  expect(plans.get(first.inspectionId)).toBeUndefined()
  const retained = plans.add(current, target)
  vi.advanceTimersByTime(15 * 60_000)
  expect(plans.get(retained.inspectionId)).toBeUndefined()
  const last = plans.add(current, target)
  plans.clear()
  expect(plans.get(last.inspectionId)).toBeUndefined()
})

it('requires the inspected dependency, version and selection and rejects mutable version labels', () => {
  const current = { name: 'fixture', version: '1.0.0', spec: '^1', enabled: true }
  expect(sameUpdateCurrent(current, { ...current })).toBe(true)
  for (const changed of [{ version: '1.0.1' }, { spec: '~1' }, { enabled: false }, { name: 'other' }]) {
    expect(sameUpdateCurrent(current, { ...current, ...changed })).toBe(false)
  }
  for (const value of ['latest', '^1.2.3', '1.2', '01.2.3', '../bundle']) expect(exactPackageVersion(value)).toBe(false)
  for (const value of ['1.2.3', '0.0.1-alpha.2', '2.0.0+build.3']) expect(exactPackageVersion(value)).toBe(true)
})
