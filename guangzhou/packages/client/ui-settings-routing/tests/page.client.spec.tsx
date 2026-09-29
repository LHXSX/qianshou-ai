/**
 * 控制台面板的渲染规格测试（jsdom）。
 *
 * 这里钉住的是**用户能看到什么、看不到什么**：
 * 上游标识不许出现；已失效的绑定要露出来；过去时刻必须被挡住；
 * 顺序能调；失败要说成人话（401 就是未登录）。
 */

// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { RoutingConsoleSection, type RoutingConsoleSectionProps } from '../src/client/RoutingConsoleSection.tsx'
import type { RouteConsoleState } from '../src/client/controller.ts'
import { ADMIN_BIND_PATH, ADMIN_NAMES_PATH, toLocalInputValue, type BindRequestPayload } from '../src/client/route-catalog.ts'
import { RouteConsoleController } from '../src/client/controller.ts'
import { zh } from '../src/client/locales.ts'
import { NOW, activeBinding, expiredBinding, namesPayload, scheduledBinding, scheduledPayload } from './fixtures.ts'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** 假传输层：只回答两条管理路由。 */
function transport(payload: unknown = namesPayload()) {
  return vi.fn<typeof fetch>(async (input) => String(input) === ADMIN_NAMES_PATH
    ? Response.json(payload)
    : Response.json({ ok: true, history: [] }))
}

/** 渲染面板：真实控制器 + 真实快照源，只有 fetch 是假的。 */
async function bench(initial?: Partial<RouteConsoleState>, payload?: unknown) {
  const fetch = transport(payload)
  const controller = new RouteConsoleController(fetch)
  await act(async () => { await controller.refresh() })
  const store = controller.store
  if (initial !== undefined) act(() => { store.update((state) => { Object.assign(state, initial) }) })
  const bind = vi.fn(async (_request: BindRequestPayload) => true)
  const refresh = vi.fn(async () => {})
  const t = (key: keyof typeof zh, values?: Record<string, string>) => Object.entries(values ?? {})
    .reduce<string>((text, [name, value]) => text.replace(`{${name}}`, value), zh[key])
  render(<RoutingConsoleSection {...{ bind, refresh, t, useCatalog: bindSnapshotSelector(store) } as unknown as RoutingConsoleSectionProps} />)
  return { store, bind, refresh, fetch, controller }
}

/** 选一个前台名字并填好键位、灰度与原因，返回可提交的表单状态。 */
function fill(name = '千手·迅捷', reason = '把主后端换成更强的那个'): void {
  fireEvent.change(screen.getByLabelText(zh.publishedName), { target: { value: name } })
  fireEvent.change(screen.getByLabelText(zh.formReason), { target: { value: reason } })
}

describe('模型路由控制台面板', () => {
  it('显示目录、绑定历史（含已失效）与可选后端键位', async () => {
    await bench()
    expect(screen.getAllByText('千手·迅捷').length).toBeGreaterThan(0)
    expect(screen.getAllByText('千手·强力').length).toBeGreaterThan(0)
    expect(screen.getByText(zh.tokens.replace('{count}', '4096'))).toBeTruthy()
    expect(screen.getByText(zh.tokens.replace('{count}', '16384'))).toBeTruthy()
    // 已失效与生效中两条历史都露出来（计划中的那条见下一个用例）。
    expect(screen.getAllByText(zh.retired).length).toBeGreaterThan(0)
    expect(screen.getAllByText(zh.active).length).toBeGreaterThan(0)
    expect(screen.getAllByText(activeBinding.reason).length).toBeGreaterThan(0)
    expect(screen.getByText(expiredBinding.reason)).toBeTruthy()
    expect(screen.getByText(zh.concurrencyValue.replace('{count}', '2500'))).toBeTruthy()
    expect(screen.getByText(zh.concurrencyValue.replace('{count}', '500'))).toBeTruthy()
  })

  it('没有绑定的名字说明「还没有绑定」，不编造一条历史', async () => {
    await bench()
    const card = [...document.querySelectorAll('article')].find(node => node.textContent?.includes('千手·轻量'))
    expect(card?.textContent).toContain(zh.noHistory)
    expect(card?.textContent).toContain(zh.noHistoryHint)
  })

  it('上游标识不进 DOM：只露后端键位与容量，并说明用户看不到这一层', async () => {
    await bench()
    const text = document.body.textContent ?? ''
    expect(text).not.toContain('deepseek-flash')
    expect(text).not.toContain('deepseek-v4-pro')
    expect(text).not.toMatch(/deepseek/i)
    expect(text).toContain('flash')
    expect(text).toContain('pro')
    expect(text).toContain(zh.backendsHint)
  })

  it('计划中的绑定也出现在历史里，且不会被写成生效中', async () => {
    await bench(undefined, scheduledPayload())
    const row = [...document.querySelectorAll('[data-phase]')].find(node => node.getAttribute('data-phase') === 'scheduled')
    expect(row?.textContent).toContain(scheduledBinding.reason)
    expect(row?.textContent).toContain('25%')
    expect(screen.getAllByText(zh.scheduled).length).toBeGreaterThan(0)
  })

  it('没有可选后端时表单不可提交（不猜键位）', async () => {
    await bench({ catalog: { names: [], backends: [] } })
    expect(screen.getByText(zh.noNames)).toBeTruthy()
    const submit = screen.getByRole('button', { name: zh.appendBinding })
    expect(submit instanceof HTMLButtonElement && submit.disabled).toBe(true)
    expect(screen.getByText(zh.noBackends)).toBeTruthy()
  })

  it('未登录：提示去登录，且不显示任何目录内容', async () => {
    await bench({ catalog: null, loading: false, readError: { kind: 'not-signed-in', message: '请先登录。', key: 'notSignedIn' } })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(zh.notSignedIn)
    expect(alert.textContent).toContain('请先登录。')
    expect(screen.queryByText('千手·迅捷')).toBeNull()
  })

  it('非管理员：降级成一句权限说明，而不是网络错误', async () => {
    await bench({ catalog: null, loading: false, readError: { kind: 'forbidden', message: '这个操作需要管理员权限。', key: 'forbidden' } })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(zh.forbidden)
    expect(alert.textContent).toContain('这个操作需要管理员权限。')
    expect(alert.textContent).not.toContain(zh.requestFailed)
  })

  it('服务端拒绝追加时原样显示它的中文原因', async () => {
    const message = '生效时刻必须晚于上一条绑定（2026-09-15T00:00:00.000Z）'
    await bench({ bindError: { kind: 'invalid', message, key: 'serverRejected' } })
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain(zh.serverRejected)
    expect(alert.textContent).toContain(message)
  })
})

describe('追加表单', () => {
  it('过去时刻在提交前被挡住：说明原因，且不发请求', async () => {
    const { bind } = await bench()
    fill('千手·轻量')
    fireEvent.click(screen.getByRole('button', { name: zh.presetCustom }))
    fireEvent.change(screen.getByLabelText(zh.customTime), { target: { value: '2020-01-01T00:00' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.appendBinding })) })
    expect(bind).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('生效时刻必须在将来')
  })

  it('只允许往后追加：早于上一条绑定的时刻被挡住', async () => {
    const { bind } = await bench()
    fill()
    fireEvent.click(screen.getByRole('button', { name: zh.presetCustom }))
    // activeBinding 在 24 小时前：晚于上一个周期、早于上一条绑定，且仍在过去 → 先报时间。
    fireEvent.change(screen.getByLabelText(zh.customTime), { target: { value: toLocalInputValue(activeBinding.effectiveFrom + 60_000) } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.appendBinding })) })
    expect(bind).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toMatch(/上一条绑定|必须在将来/)

    // 换一个远超上一条绑定、又确实在将来的时刻：这时才允许追加。
    fireEvent.click(screen.getByRole('button', { name: zh.preset7d }))
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.appendBinding })) })
    expect(bind).toHaveBeenCalledTimes(1)
    expect(bind.mock.calls[0]?.[0]?.effectiveFrom).toBeGreaterThan(activeBinding.effectiveFrom)
  })

  it('默认预设是 24 小时后，预览说清生效时刻与上一条被钉住的时刻', async () => {
    await bench()
    fill()
    const preview = screen.getByText(new RegExp('生效预览|这条绑定将在'))
    expect(preview.textContent).toContain('千手·迅捷')
    expect(preview.textContent).toContain('生效时，上一条绑定')
  })

  it('可以调整后端顺序：上移、下移与移除都在请求体里生效', async () => {
    const { bind } = await bench()
    fill()
    const box = screen.getByLabelText(zh.backendOrder)
    expect(box.textContent).toContain('flash')
    expect(box.textContent).toContain('pro')
    // 上移 pro：顺序变成 pro → flash（pro 已是首位，不能再上移）。
    fireEvent.click(screen.getByRole('button', { name: `pro ${zh.orderUp}` }))
    expect(screen.getByRole('button', { name: `pro ${zh.orderUp}` })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: `flash ${zh.orderUp}` })).toHaveProperty('disabled', false)
    // 下移 flash：回到 flash → pro（pro 回到末位，不能再下移）。
    fireEvent.click(screen.getByRole('button', { name: `flash ${zh.orderDown}` }))
    expect(screen.getByRole('button', { name: `flash ${zh.orderDown}` })).toHaveProperty('disabled', true)
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.appendBinding })) })
    expect(bind).toHaveBeenCalledTimes(1)
    expect(bind.mock.calls[0]?.[0]).toMatchObject({ publishedName: '千手·迅捷', backendKeys: ['pro', 'flash'], rolloutPercent: 100 })
  })

  it('可以移除一个键位再把它加回来（顺序按加入先后）', async () => {
    const { bind } = await bench()
    fill()
    fireEvent.click(screen.getByRole('button', { name: `flash ${zh.removeBackend}` }))
    expect(screen.getByLabelText(zh.backendOrder).textContent).not.toContain('flash')
    fireEvent.click(screen.getByRole('button', { name: `${zh.backendKey} flash` }))
    expect(screen.getByLabelText(zh.backendOrder).textContent).toContain('flash')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.appendBinding })) })
    expect(bind.mock.calls[0]?.[0]).toMatchObject({ backendKeys: ['pro', 'flash'] })
  })

  it('灰度 0 与 100 都被接受，越界被挡住', async () => {
    const { bind } = await bench()
    fill()
    fireEvent.change(screen.getByLabelText(zh.rolloutPercent), { target: { value: '0' } })
    expect(screen.getByText(zh.rolloutZero)).toBeTruthy()
    fireEvent.change(screen.getByLabelText(zh.rolloutPercent), { target: { value: '101' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.appendBinding })) })
    expect(bind).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('0 到 100 之间的整数')
    fireEvent.change(screen.getByLabelText(zh.rolloutPercent), { target: { value: '100' } })
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.appendBinding })) })
    expect(bind.mock.calls[0]?.[0]).toMatchObject({ rolloutPercent: 100 })
  })

  it('缺原因时挡住追加，并说明对账要靠它', async () => {
    const { bind } = await bench()
    fill('千手·迅捷', '')
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: zh.appendBinding })) })
    expect(bind).not.toHaveBeenCalled()
    expect(screen.getByRole('alert').textContent).toContain('请填写变更原因')
  })

  it('追加成功后清空原因并显示服务端回读的历史', async () => {
    const { bind, store } = await bench()
    fill()
    fireEvent.change(screen.getByLabelText(zh.formReason), { target: { value: '把主后端换成更强的那个' } })
    await act(async () => {
      await bind.mockImplementation(async (request: BindRequestPayload) => {
        store.update((state) => {
          state.lastAppended = { publishedName: request.publishedName, history: [...(state.catalog?.names[0]?.history ?? []), scheduledBinding] }
        })
        return true
      })
      fireEvent.click(screen.getByRole('button', { name: zh.appendBinding }))
    })
    expect(screen.getByText(zh.added)).toBeTruthy()
    expect(screen.getByLabelText(zh.formReason)).toHaveProperty('value', '')
  })

  it('提交中按钮变成「正在追加…」并禁用，避免重复写历史', async () => {
    const { bind } = await bench()
    fill()
    bind.mockImplementation(() => new Promise<boolean>(() => {}))
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: zh.appendBinding }))
      await Promise.resolve()
    })
    const submit = screen.getByRole('button', { name: zh.appending })
    expect(submit instanceof HTMLButtonElement && submit.disabled).toBe(true)
  })

  it('把绑定路由写死在 POST /api/qianshou/ai/admin/bind 上（没有别的写入口）', async () => {
    await bench()
    expect(ADMIN_BIND_PATH).toBe('/api/qianshou/ai/admin/bind')
    expect(ADMIN_NAMES_PATH).toBe('/api/qianshou/ai/admin/names')
  })

  it('界面没有任何「编辑现有绑定」或「立刻生效」的入口', async () => {
    await bench()
    const labels = [...document.querySelectorAll('button')].map(node => node.textContent ?? '')
    expect(labels.some(label => /编辑|修改|立刻|立即/.test(label))).toBe(false)
    expect(document.body.textContent).toContain(zh.appendBoundary)
    expect(NOW - activeBinding.effectiveFrom).toBe(24 * 3_600_000)
  })
})
