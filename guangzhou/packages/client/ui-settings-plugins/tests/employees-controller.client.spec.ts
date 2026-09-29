/** Revision fencing and route inheritance of the employee roster. */
import { describe, expect, it, vi } from 'vitest'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { EmployeesCardController, employeeRouteKey, type EmployeesSettings } from '../src/client/employees-card-controller.ts'

const route = { provider: 'configured-provider', model: 'actual-model' }
const catalog = { groups: [{ id: route.provider, name: 'My endpoint', models: [{ id: route.model, name: 'Available model' }] }], failures: [] }
function bench(value: EmployeesSettings = {
  defaultRoute: null, employees: [{ id: 'engineer', name: '工程', role: '实现并验证变更', route: null }],
}) {
  const host = stubSettingsScope<EmployeesSettings>()
  const models = vi.fn(() => Promise.resolve({ ok: true as const, value: catalog }))
  const controller = new EmployeesCardController(host.scope, { remote: { session: { modelCatalog: models } } } as never, () => '新伙伴')
  host.publish({ status: 'ready', writable: true, revision: 7, value, user: {} })
  const face = controller.inject()
  const snapshot = () => face.hooks.employeesCard.getSnapshot()
  const accept = () => {
    host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
      const next = { ...host.scope.getSnapshot().value }
      for (const op of ops) if (op.op === 'set') Object.assign(next, { [op.path[0]!]: op.value })
      host.publish({ value: next as EmployeesSettings, revision: 8 })
    })
  }
  return { host, controller, face, snapshot, models, accept }
}

describe('employee roster controller', () => {
  it('stages responsibilities and exact routes; atomically saves at the draft revision', async () => {
    const b = bench()
    await vi.waitFor(() => { expect(b.snapshot().catalogStatus).toBe('ready') })
    b.accept()
    b.face.editEmployee('engineer', 'role', '完成实现、测试和证据')
    b.face.setRoute(null, employeeRouteKey(route))
    b.face.setRoute('engineer', employeeRouteKey(route))
    expect(b.host.mutate).not.toHaveBeenCalled()
    b.face.save()
    await vi.waitFor(() => { expect(b.snapshot().dirty).toBe(false) })
    expect(b.host.mutate).toHaveBeenCalledWith([
      { op: 'set', path: ['defaultRoute'], value: route },
      { op: 'set', path: ['employees'], value: [{ id: 'engineer', name: '工程', role: '完成实现、测试和证据', route }] },
    ], 7)
    b.controller.dispose()
  })

  it('keeps missing saved routes visible and allows inheritance without a catalog route', async () => {
    const missing = { provider: 'offline-provider', model: 'old-model' }
    const b = bench({ defaultRoute: missing, employees: [{ id: 'writer', name: '写作', role: '写文稿', route: missing }] })
    await vi.waitFor(() => { expect(b.snapshot().catalogStatus).toBe('ready') })
    expect(b.snapshot().models.find(model => model.provider === missing.provider)).toMatchObject({ available: false })
    b.face.setRoute('writer', employeeRouteKey(route))
    b.face.setRoute('writer', employeeRouteKey(missing))
    expect(b.snapshot().employees[0]!.route).toEqual(route)
    b.face.setRoute('writer', '')
    b.face.setRoute(null, '')
    expect(b.snapshot()).toMatchObject({ defaultRoute: null, employees: [{ route: null }] })
    b.controller.dispose()
  })

  it('does not overwrite a newer roster, and discard restores the latest Host view', () => {
    const b = bench()
    b.face.editEmployee('engineer', 'name', '我的工程师')
    b.host.publish({ revision: 9, value: { defaultRoute: null, employees: [{ id: 'reviewer', name: '审校', role: '检查结果', route: null }] } })
    expect(b.snapshot().conflicted).toBe(true)
    b.face.save()
    expect(b.host.mutate).not.toHaveBeenCalled()
    b.face.discard()
    expect(b.snapshot()).toMatchObject({ conflicted: false, dirty: false, employees: [{ id: 'reviewer' }] })
    b.controller.dispose()
  })

  it('requires a responsibility, creates unique stable IDs, and caps the roster at 24', () => {
    const b = bench()
    b.face.addEmployee()
    b.face.addEmployee()
    expect(b.snapshot().employees.map(employee => employee.id)).toEqual(['engineer', 'employee-1', 'employee-2'])
    expect(b.snapshot().invalid).toBe(true)
    b.face.save()
    expect(b.host.mutate).not.toHaveBeenCalled()
    for (let index = 0; index < 30; index += 1) b.face.addEmployee()
    expect(b.snapshot().employees).toHaveLength(24)
    expect(new Set(b.snapshot().employees.map(employee => employee.id)).size).toBe(24)
    b.face.discard()
    expect(b.snapshot().employees).toHaveLength(1)
    b.controller.dispose()
  })

  it('preserves rejected drafts and disables edits for read-only settings', async () => {
    const b = bench()
    b.face.editEmployee('engineer', 'name', '工程二号')
    b.face.save()
    await vi.waitFor(() => { expect(b.snapshot().failed).toBe(true) })
    expect(b.snapshot()).toMatchObject({ dirty: true, saving: false, employees: [{ name: '工程二号' }] })
    b.face.discard()
    b.host.publish({ writable: false })
    b.face.addEmployee()
    b.face.removeEmployee('engineer')
    b.face.editEmployee('engineer', 'name', '不可修改')
    expect(b.snapshot()).toMatchObject({ dirty: false, employees: [{ name: '工程' }] })
    b.controller.dispose()
  })

  it('retains settings on catalog failure and ignores a stale response after reset', async () => {
    const b = bench()
    await vi.waitFor(() => { expect(b.snapshot().catalogStatus).toBe('ready') })
    let resolve!: (value: { ok: true; value: typeof catalog }) => void
    b.models.mockImplementationOnce(() => new Promise((accept) => { resolve = accept }))
    b.controller.refreshCatalog()
    b.face.editEmployee('engineer', 'name', '暂存')
    b.models.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'offline', {}) } as never)
    b.controller.resetConnection()
    await vi.waitFor(() => { expect(b.snapshot().catalogStatus).toBe('error') })
    resolve({ ok: true, value: catalog })
    await Promise.resolve()
    expect(b.snapshot()).toMatchObject({ catalogStatus: 'error', dirty: false, employees: [{ name: '工程' }] })
    b.controller.dispose()
  })
})
