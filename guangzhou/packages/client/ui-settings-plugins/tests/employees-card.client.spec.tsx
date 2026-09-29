// @vitest-environment jsdom

/** Form controls retain locale copy, route identity, and draft-only actions. */
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { EmployeesCard, type EmployeesCardProps } from '../src/client/EmployeesCard.tsx'
import { employeeRouteKey, type EmployeesCardState } from '../src/client/employees-card-controller.ts'
import { zh } from '../src/client/locales.ts'

afterEach(cleanup)

function bench(overrides: Partial<EmployeesCardState> = {}) {
  const route = { provider: 'my-endpoint', model: 'current-model' }
  const state: EmployeesCardState = {
    available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false,
    defaultRoute: null, employees: [{ id: 'engineer', name: '工程', role: '实现和验证', route: null }],
    models: [{ ...route, key: employeeRouteKey(route), providerName: '真实接口', modelName: '当前模型', available: true }],
    catalogStatus: 'ready', catalogPartial: false, conflicted: false, ...overrides,
  }
  const store = createSnapshotStore(state)
  const actions = {
    addEmployee: vi.fn(), removeEmployee: vi.fn(), editEmployee: vi.fn(), setRoute: vi.fn(),
    retryCatalog: vi.fn(), save: vi.fn(), discard: vi.fn(),
  }
  const props = {
    ...actions, t: (key: keyof typeof zh) => zh[key], useEmployeesCard: bindSnapshotSelector(store),
  } as unknown as EmployeesCardProps
  render(<EmployeesCard {...props} />)
  const open = screen.queryByRole('button', { name: `${zh.expand}: ${zh.employeesTitle}` })
  if (open) fireEvent.click(open)
  return { store, actions, route }
}

describe('employee settings card', () => {
  it('shows real model choices and stages edits without automatic saving', () => {
    const { actions, route } = bench()
    expect(screen.getByText('1 位员工')).toBeTruthy()
    fireEvent.change(screen.getByLabelText('姓名'), { target: { value: '我的工程师' } })
    fireEvent.change(screen.getByLabelText('职责'), { target: { value: '完成代码与测试' } })
    fireEvent.change(screen.getByLabelText('团队默认模型'), { target: { value: employeeRouteKey(route) } })
    fireEvent.change(screen.getByLabelText('模型接口与模型'), { target: { value: employeeRouteKey(route) } })
    expect(actions.editEmployee.mock.calls).toEqual([['engineer', 'name', '我的工程师'], ['engineer', 'role', '完成代码与测试']])
    expect(actions.setRoute.mock.calls).toEqual([[null, employeeRouteKey(route)], ['engineer', employeeRouteKey(route)]])
    expect(actions.save).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: zh.save })).toHaveProperty('disabled', true)
  })

  it('exposes explicit add/remove and disables save while a draft conflicts', () => {
    const { actions, store } = bench({ dirty: true })
    fireEvent.click(screen.getByRole('button', { name: '添加员工' }))
    fireEvent.click(screen.getByRole('button', { name: '移除员工 工程' }))
    expect(actions.addEmployee).toHaveBeenCalledOnce()
    expect(actions.removeEmployee).toHaveBeenCalledWith('engineer')
    act(() => { store.set({ ...store.getSnapshot(), conflicted: true }) })
    expect(screen.getByText(zh.employeesConflict)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.save })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: '添加员工' })).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: zh.discard }))
    expect(actions.discard).toHaveBeenCalledOnce()
  })

  it('shows unavailable stored routes and retains inheritance when the directory fails', () => {
    const route = { provider: 'offline', model: 'saved' }
    const { actions } = bench({
      catalogStatus: 'error', defaultRoute: route,
      models: [{ ...route, key: employeeRouteKey(route), providerName: 'offline', modelName: 'saved', available: false }],
    })
    expect(screen.getByLabelText('团队默认模型')).toHaveProperty('value', employeeRouteKey(route))
    expect(screen.getAllByRole('option', { name: /当前不可用/ })[0]).toHaveProperty('disabled', true)
    fireEvent.click(screen.getByRole('button', { name: '刷新模型' }))
    expect(actions.retryCatalog).toHaveBeenCalledOnce()
    fireEvent.change(screen.getByLabelText('团队默认模型'), { target: { value: '' } })
    expect(actions.setRoute).toHaveBeenCalledWith(null, '')
  })

  it('renders nothing when the Host does not serve employee settings', () => {
    bench({ available: false })
    expect(screen.queryByText(zh.employeesTitle)).toBeNull()
  })
})
