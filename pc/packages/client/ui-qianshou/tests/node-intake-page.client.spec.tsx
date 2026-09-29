// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NodeIntakePage } from '../src/client/node-status/NodeIntakePage.tsx'
import { OrderSourcesPanel } from '../src/client/node-status/OrderSourcesPanel.tsx'
import type { IntakeOrderSources } from '../src/client/node-status/supply-transport.ts'
import type { IntakeDashboardData } from '../src/client/node-status/IntakeDashboard.tsx'
import { NodeStatusController } from '../src/client/node-status/controller.ts'
import { createIntakeSupplyTransport } from '../src/client/node-status/supply-transport.ts'
import type { H3CanonicalSetupTransport } from '../src/client/node-status/h3-canonical-setup-transport.ts'
import { zh } from '../src/client/node-status/locales.ts'
import { parseNodeStatus } from '../src/client/node-status/types.ts'
import { createStubTransport, onlineSnapshot } from './fixtures/node-status.fixture.ts'

afterEach(cleanup)

describe('intake navigation surface', () => {
  it('explains an unresolved cross-account trial without inventing configured or ready state', async () => {
    const raw = onlineSnapshot()
    const snapshot = parseNodeStatus({ ...raw, connection: { ...(raw.connection as Record<string, unknown>), mode: 'paused' },
      current: null, tasks: [], intakeReasons: ['LOCAL_ORDER_PLUGIN_UNAVAILABLE'],
      h3Video: { configured: false, ready: false, code: 'H3_SETUP_SELF_TEST_UNKNOWN' } })
    if (snapshot === null) throw new Error('Invalid node fixture')
    const transport = createStubTransport([{ kind: 'snapshot', snapshot }], { running: true, managed: true, mode: 'paused' })
    const controller = new NodeStatusController({ transport, intervalMs: 60_000 })
    const supplyTransport = { read: async () => ({ mode: 'idle' as const, maxConcurrency: 1,
      enabledServiceCount: 1, enabledServiceIds: ['node'] }), set: vi.fn(), setTextService: vi.fn() }
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)}
      supplyTransport={supplyTransport} dashboard={null} />)
    await act(async () => { await controller.poll() })
    await waitFor(() => { expect(view.container.textContent).toContain(zh.h3SetupUnsettled) })
    expect(view.container.textContent).not.toContain('H3_SETUP_SELF_TEST_UNKNOWN')
    expect(transport.commands).toEqual([])
    expect(supplyTransport.set).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('enables an approved author source in this page and refreshes its actual saved grant', async () => {
    const snapshot = parseNodeStatus(onlineSnapshot())
    if (!snapshot) throw new Error('Invalid node fixture')
    const controller = new NodeStatusController({ transport: createStubTransport([{ kind: 'snapshot', snapshot }],
      { running: true, managed: true, mode: 'running' }), intervalMs: 60_000 })
    let enabled = false
    const order = () => ({ mode: enabled ? 'idle' as const : 'off' as const, maxConcurrency: 1,
      enabledServiceCount: enabled ? 1 : 0, enabledServiceIds: enabled ? ['node'] : [] })
    const activateAuthorSource = vi.fn(async () => { enabled = true; return order() })
    const supplyTransport = { read: async () => order(), set: vi.fn(), setTextService: vi.fn(), activateAuthorSource,
      listSources: async (): Promise<IntakeOrderSources> => ({ complete: true, sources: [{
        id: 'skill:user-agents:char-counter', kind: 'skill', source: 'user-agents', title: '字符统计', description: '统计文字',
        authorProductId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a', category: 'text', loadState: enabled ? 'active' : 'unknown',
        capabilityId: enabled ? 'text.char_counter' : null, taskType: 'char_counter_v1', serviceId: enabled ? 'node' : null,
        selectable: false, eligible: enabled, enabled, reason: enabled ? 'ready' : 'publication-approved',
      }] }) }
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} supplyTransport={supplyTransport} dashboard={null} />)
    await act(async () => { await controller.poll() })
    fireEvent.click(await view.findByRole('button', { name: zh.orderAuthorEnable }))
    await waitFor(() => expect(activateAuthorSource).toHaveBeenCalledExactlyOnceWith('skill:user-agents:char-counter'))
    await waitFor(() => expect(view.container.querySelector('[data-intake-service-count="1"]')).toBeTruthy())
    expect(supplyTransport.setTextService).not.toHaveBeenCalled()
    expect(supplyTransport.set).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('shows installed skill categories and purposes in Chinese without changing order eligibility', () => {
    const sources: IntakeOrderSources['sources'] = ([
      { id: 'skill:user-agents:autopilot', kind: 'skill', source: 'user-agents', title: 'autopilot',
        description: 'Keep a PR merge-ready', category: null },
      { id: 'skill:user-agents:office-pptx', kind: 'skill', source: 'user-agents', title: 'office-pptx',
        description: 'Create PowerPoint presentations', category: null },
      { id: 'skill:user-dsh:my-helper', kind: 'skill', source: 'user-dsh', title: '我的图片助手',
        description: '生成宣传图', category: null },
      { id: 'bundle:dshmarket', kind: 'plugin', source: 'profile-bundle', title: 'dshmarket',
        description: 'Visual plugin market — 逛一下', category: null },
    ] as const).map(item => ({ ...item,
      loadState: 'active' as const, capabilityId: null, taskType: null,
      serviceId: null, selectable: false, eligible: false, enabled: false,
      reason: 'platform-task-unmapped' as const }))
    const view = render(<OrderSourcesPanel t={makeTranslate(zh)} phase="ready" data={{ complete: true, sources }}
      granted={false} busy={false} busyMessage={null} selectionSupported={true} error={null}
      onRefresh={() => {}} onToggle={() => {}} onSelect={() => {}} />)
    expect(view.getByText('维护合并请求')).toBeTruthy()
    expect(view.getByText('检查审查意见、冲突与构建结果')).toBeTruthy()
    expect(view.getByText('PPT 技能')).toBeTruthy()
    expect(view.getByText('制作演示文稿')).toBeTruthy()
    expect(view.getByText('我的图片助手')).toBeTruthy()
    expect(view.getByText('插件市场')).toBeTruthy()
    expect(view.getByText('浏览、搜索和安装社区插件')).toBeTruthy()
    expect(view.container.querySelector('[data-order-source-id="bundle:dshmarket"]')?.textContent)
      .not.toContain('Visual plugin market')
    expect(view.getByRole('group', { name: zh.orderCategoryLabel }).querySelectorAll('button')).toHaveLength(3)
    expect(view.getByRole('button', { name: '工具 · 3' })).toBeTruthy()
    expect(view.getByRole('button', { name: '文 · 0' })).toBeTruthy()
    expect(view.getByRole('button', { name: '图 · 1' })).toBeTruthy()
    expect(view.container.querySelector('[data-order-readiness="current"]')?.textContent)
      .toContain(`${zh.orderReadinessEligible}0`)
    expect(view.container.querySelector('[data-order-readiness="current"]')?.textContent)
      .toContain(`${zh.orderReadinessNeedsSetup}4`)
    expect(view.container.querySelector('[data-order-source-id="skill:user-agents:autopilot"]')?.textContent).toContain('/autopilot')
    expect(view.container.querySelector('[data-order-source-eligible="true"]')).toBeNull()
  })

  it('keeps an incomplete capability inventory unknown and H3 details behind its own entry', async () => {
    const sources: IntakeOrderSources = { complete: true, sources: [{ id: 'skill:user-dsh:another-model',
      kind: 'skill', source: 'user-dsh', title: '另一个模型', description: '生成视频', category: 'video',
      loadState: 'active', capabilityId: 'video.render', taskType: 'video_other', serviceId: 'node',
      selectable: false, eligible: true, enabled: true, reason: 'ready' }] }
    const stale = render(<OrderSourcesPanel t={makeTranslate(zh)} phase="unavailable" data={sources}
      granted={true} ownerOn={true} busy={false} busyMessage={null} selectionSupported={true} error={null}
      onRefresh={() => {}} onToggle={() => {}} onSelect={() => {}} />)
    expect(stale.container.querySelector('[data-order-readiness="unknown"]')?.textContent)
      .toContain(zh.orderReadinessUnknown)
    expect(stale.container.querySelector('[data-order-readiness="unknown"]')?.textContent).not.toContain('1')
    stale.unmount()

    const controller = new NodeStatusController({ transport: createStubTransport([]), storage: null })
    const inspect = vi.fn<H3CanonicalSetupTransport['inspect']>(async () => {
      throw new Error('unavailable')
    })
    const transport = { inspect } as unknown as H3CanonicalSetupTransport
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)}
      h3CanonicalTransport={transport} dashboard={null} />)
    expect(view.getByText(zh.intakeAddCapabilityIntro)).toBeTruthy()
    const status = view.container.querySelector('[data-intake-status]')
    const h3 = view.container.querySelector('[data-h3-canonical-setup]')
    expect(status && h3 && status.compareDocumentPosition(h3) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(view.queryByText(zh.h3CanonicalWorkflowRequirement)).toBeNull()
    expect(inspect).not.toHaveBeenCalled()
    expect((view.container.querySelector('[data-intake-setup-list]') as HTMLDetailsElement).open).toBe(false)
    fireEvent.click(view.getByText(zh.intakeAddCapability))
    fireEvent.click(view.getByRole('button', { name: zh.h3CanonicalOpen }))
    await waitFor(() => expect(inspect).toHaveBeenCalledOnce())
    expect(view.getByText(zh.h3CanonicalWorkflowRequirement)).toBeTruthy()
    controller.dispose()
  })

  it('uses the saved owner policy as the sole switch and keeps running work untouched when pausing new orders', async () => {
    const snapshot = parseNodeStatus(onlineSnapshot())
    if (snapshot === null) throw new Error('Invalid node status fixture')
    const transport = createStubTransport([{ kind: 'snapshot', snapshot }], { running: true, managed: true, mode: 'running' })
    const controller = new NodeStatusController({ transport, intervalMs: 60_000 })
    let enabled = true
    const set = vi.fn(async (next: boolean) => {
      enabled = next
      return { mode: next ? 'idle' as const : 'off' as const, maxConcurrency: 2, enabledServiceCount: 1, enabledServiceIds: ['node'] }
    })
    const supplyTransport = { read: async () => ({ mode: enabled ? 'idle' as const : 'off' as const, maxConcurrency: 2,
      enabledServiceCount: 1, enabledServiceIds: ['node'] }), set, setTextService: vi.fn() }
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)}
      supplyTransport={supplyTransport} dashboard={null} />)
    await act(async () => { await controller.poll() })
    expect(await view.findByRole('heading', { name: '已准备接单' })).toBeTruthy()
    const toggle = view.getByRole('switch', { name: '接单总开关' })
    await act(async () => { fireEvent.click(toggle) })
    expect(set).toHaveBeenCalledExactlyOnceWith(false)
    expect(toggle.getAttribute('aria-checked')).toBe('false')
    expect(view.getByRole('heading', { name: '接单已关闭' })).toBeTruthy()
    expect(view.container.textContent).toContain('已暂停新订单；进行中的任务仍会继续完成。')
    expect(view.container.textContent).toContain('word_count')
    expect(view.getByRole('switch', { name: '词频统计接单' }).getAttribute('aria-checked')).toBe('true')
    expect(supplyTransport.setTextService).not.toHaveBeenCalled()
    expect(transport.commands).toEqual([])
    expect(transport.powers).toEqual([])
  })

  it('keeps unknown grants disabled and shows an honest unsynced state instead of zero totals', () => {
    const controller = new NodeStatusController({ transport: createStubTransport([]), intervalMs: 60_000 })
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} />)
    expect(view.getByRole('heading', { name: '接单' })).toBeTruthy()
    expect(view.getByRole('heading', { name: '接单状态待同步' })).toBeTruthy()
    expect(view.getByText('正在核对本机保存的接单设置，暂不能确认是否接单。')).toBeTruthy()
    expect(view.getByText('暂未识别到本机节点，连接后可查看这台设备的记录。')).toBeTruthy()
    expect(view.container.querySelector('[data-node-counters]')).toBeNull()
    expect(view.getByRole('switch', { name: '词频统计接单' }).hasAttribute('disabled')).toBe(true)
    expect(view.container.querySelector('[data-intake-text-service-switch="unknown"]')).toBeTruthy()
  })

  it('offers only verified word_count authorization and keeps the master switch untouched', async () => {
    const raw = onlineSnapshot()
    const snapshot = parseNodeStatus({ ...raw, connection: { ...(raw.connection as Record<string, unknown>), mode: 'paused' }, current: null, tasks: [] })
    if (snapshot === null) throw new Error('Invalid paused node status fixture')
    const controller = new NodeStatusController({
      transport: createStubTransport([{ kind: 'snapshot', snapshot }], { running: false, managed: true, mode: 'paused' }),
      intervalMs: 60_000,
    })
    let granted = false
    const supplyTransport = {
      read: async () => ({ mode: 'idle' as const, maxConcurrency: 1, enabledServiceCount: granted ? 1 : 0,
        enabledServiceIds: granted ? ['node'] : [] }),
      set: vi.fn(),
      setTextService: vi.fn(async (enabled: boolean) => {
        granted = enabled
        return { mode: 'idle' as const, maxConcurrency: 1, enabledServiceCount: granted ? 1 : 0,
          enabledServiceIds: granted ? ['node'] : [] }
      }),
    }
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)}
      supplyTransport={supplyTransport} dashboard={null} />)
    await act(async () => { await controller.poll() })
    expect(await view.findByRole('heading', { name: '尚无获准接单能力' })).toBeTruthy()
    expect(view.container.textContent).toContain('还没有完成本机验证并获准接单的能力')
    expect(view.container.querySelector('[data-intake-service-count="0"]')?.textContent).toContain('获准接单服务 · 0 项')
    expect(view.getByRole('switch', { name: '接单总开关' }).getAttribute('aria-checked')).toBe('true')
    expect(view.container.textContent).toContain('只统计每个词出现的次数')
    expect(view.container.textContent).toContain('字符数或字节数插件不适用。授权不保证订单或收入。')
    await act(async () => { fireEvent.click(view.getByRole('switch', { name: '词频统计接单' })) })
    expect(supplyTransport.setTextService).toHaveBeenCalledExactlyOnceWith(true)
    expect(view.getByRole('switch', { name: '词频统计接单' }).getAttribute('aria-checked')).toBe('true')
    expect(view.getByRole('switch', { name: '接单总开关' }).getAttribute('aria-checked')).toBe('true')
    expect(view.container.querySelector('[data-intake-service-count="1"]')).toBeTruthy()
    expect(view.container.textContent).toContain('仍需节点准入与平台匹配，不能保证有订单。')
    expect(supplyTransport.set).not.toHaveBeenCalled()
  })

  it('does not show a grant when the Host rejects an unverified local runner', async () => {
    const raw = onlineSnapshot()
    const snapshot = parseNodeStatus({ ...raw, connection: { ...(raw.connection as Record<string, unknown>), mode: 'paused' }, current: null, tasks: [] })
    if (snapshot === null) throw new Error('Invalid paused node status fixture')
    const controller = new NodeStatusController({
      transport: createStubTransport([{ kind: 'snapshot', snapshot }], { running: false, managed: true, mode: 'paused' }),
      intervalMs: 60_000,
    })
    const supplyTransport = {
      read: vi.fn(async () => ({ mode: 'idle' as const, maxConcurrency: 1, enabledServiceCount: 0, enabledServiceIds: [] })),
      set: vi.fn(),
      setTextService: vi.fn(async () => { throw new Error('QIANSHOU_CATALOG_service-unavailable') }),
    }
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} supplyTransport={supplyTransport} dashboard={null} />)
    await act(async () => { await controller.poll() })
    expect(await view.findByRole('heading', { name: '尚无获准接单能力' })).toBeTruthy()
    await act(async () => { fireEvent.click(view.getByRole('switch', { name: '词频统计接单' })) })
    expect(supplyTransport.setTextService).toHaveBeenCalledExactlyOnceWith(true)
    expect(supplyTransport.read).toHaveBeenCalledTimes(3)
    expect(view.getByRole('switch', { name: '词频统计接单' }).getAttribute('aria-checked')).toBe('false')
    expect(view.getByRole('alert').textContent).toContain('当前接单执行器或本机环境自检未通过')
    expect(supplyTransport.set).not.toHaveBeenCalled()
  })

  it('does not mistake another service grant for word_count readiness', async () => {
    const snapshot = parseNodeStatus(onlineSnapshot())
    if (snapshot === null) throw new Error('Invalid node status fixture')
    const controller = new NodeStatusController({
      transport: createStubTransport([{ kind: 'snapshot', snapshot }], { running: true, managed: true, mode: 'running' }),
      intervalMs: 60_000,
    })
    const supplyTransport = { read: async () => ({ mode: 'idle' as const, maxConcurrency: 1,
      enabledServiceCount: 1, enabledServiceIds: ['git'] }), set: vi.fn(), setTextService: vi.fn() }
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} supplyTransport={supplyTransport} dashboard={null} />)
    await act(async () => { await controller.poll() })
    expect(await view.findByRole('heading', { name: '尚无获准接单能力' })).toBeTruthy()
    expect(view.getByRole('switch', { name: '词频统计接单' }).getAttribute('aria-checked')).toBe('false')
    expect(view.container.querySelector('[data-intake-service-count="1"]')).toBeTruthy()
  })

  it('keeps grant revocation available when the saved executor cannot be projected', async () => {
    const controller = new NodeStatusController({ transport: createStubTransport([]), intervalMs: 60_000 })
    let granted = true
    const setTextService = vi.fn(async (enabled: boolean) => {
      granted = enabled
      return { mode: 'idle' as const, maxConcurrency: 1, enabledServiceCount: granted ? 1 : 0,
        enabledServiceIds: granted ? ['node'] : [] }
    })
    const supplyTransport = {
      read: async () => ({ mode: 'idle' as const, maxConcurrency: 1, enabledServiceCount: granted ? 1 : 0,
        enabledServiceIds: granted ? ['node'] : [] }),
      set: vi.fn(), setTextService,
      listSources: async () => ({ complete: false, sources: [] }),
    }
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)}
      supplyTransport={supplyTransport} dashboard={null} />)
    const revoke = await view.findByRole('switch', { name: '词频统计接单' })
    expect(revoke.getAttribute('aria-checked')).toBe('true')
    expect(view.container.textContent).toContain('当前选中的本机接单执行器未通过验证')
    await act(async () => { fireEvent.click(revoke) })
    expect(setTextService).toHaveBeenCalledExactlyOnceWith(false)
    expect(view.getByRole('switch', { name: '接单总开关' }).getAttribute('aria-checked')).toBe('true')
  })

  it('explains an authorized but paused node from live owner admission reasons', async () => {
    const raw = onlineSnapshot()
    const snapshot = parseNodeStatus({ ...raw, intakeReason: 'owner-policy-blocked', intakeReasons: ['USER_ACTIVE'],
      connection: { ...(raw.connection as Record<string, unknown>), mode: 'paused' }, current: null, tasks: [] })
    if (snapshot === null) throw new Error('Invalid paused node status fixture')
    const controller = new NodeStatusController({
      transport: createStubTransport([{ kind: 'snapshot', snapshot }], { running: false, managed: true, mode: 'paused' }),
      intervalMs: 60_000,
    })
    const supplyTransport = { read: async () => ({ mode: 'idle' as const, maxConcurrency: 1,
      enabledServiceCount: 1, enabledServiceIds: ['node'] }), set: vi.fn(), setTextService: vi.fn() }
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} supplyTransport={supplyTransport} dashboard={null} />)
    await act(async () => { await controller.poll() })
    expect(await view.findByRole('heading', { name: '已授权能力，等待电脑空闲' })).toBeTruthy()
    expect(view.container.textContent).toContain('电脑正在使用')
    expect(view.container.textContent).toContain('默认空闲时长为 60 秒')
    expect(view.getByRole('switch', { name: '词频统计接单' }).getAttribute('aria-checked')).toBe('true')
  })

  it('shows installed abilities from different origins while only an adapted runner can receive a grant', async () => {
    const raw = onlineSnapshot()
    const snapshot = parseNodeStatus({ ...raw, intakeReasons: ['USER_ACTIVE'],
      connection: { ...(raw.connection as Record<string, unknown>), mode: 'paused' }, current: null, tasks: [] })
    if (snapshot === null) throw new Error('Invalid paused node status fixture')
    const controller = new NodeStatusController({
      transport: createStubTransport([{ kind: 'snapshot', snapshot }], { running: false, managed: true, mode: 'paused' }),
      intervalMs: 60_000,
    })
    let granted = false
    let runnable = true
    const order = () => ({ mode: 'idle', maxConcurrency: 1, enabledServiceCount: granted ? 1 : 0,
      enabledServiceIds: granted ? ['node'] : [] })
    const orderSources = vi.fn(async () => ({ ok: true as const, value: { complete: true, order: order(), sources: [
      { id: 'builtin:word_count', kind: 'builtin', source: 'builtin', title: '本机词频统计',
        description: '词频计算', category: 'text', loadState: 'active', capabilityId: null, taskType: null,
        serviceId: null, selectable: false, eligible: false, enabled: false, reason: 'not-selected' },
      { id: 'bundle:video-name', kind: 'plugin', source: 'profile-bundle', title: '视频渲染插件',
        description: '作者安装的插件', category: null, loadState: 'active', capabilityId: 'text.transform', taskType: 'word_count',
        serviceId: 'node', selectable: false, eligible: runnable, enabled: granted, reason: runnable ? 'ready' : 'executor-unverified' },
      { id: 'bundle:old-counter', kind: 'plugin', source: 'profile-bundle', title: '字符数插件',
        description: '统计字符数', category: null, loadState: 'active', capabilityId: null, taskType: null,
        serviceId: null, selectable: false, eligible: false, enabled: false, reason: 'platform-task-unmapped' },
      { id: 'skill:user-dsh:video-helper', kind: 'skill', source: 'user-dsh', title: '视频助手',
        description: '自制技能', category: 'video', loadState: 'unknown', capabilityId: null, taskType: null,
        serviceId: null, selectable: false, eligible: false, enabled: false, reason: 'platform-task-unmapped' },
      { id: 'skill:user-agents:story-helper', kind: 'skill', source: 'user-agents', title: '故事助手',
        description: '其他来源的技能', category: null, loadState: 'unknown', capabilityId: null, taskType: null,
        serviceId: null, selectable: false, eligible: false, enabled: false, reason: 'platform-task-unmapped' },
    ] } }))
    const setLocalServiceEnabled = vi.fn(async ({ enabled }: { enabled: boolean }) => {
      granted = enabled
      return { ok: true as const, value: order() }
    })
    const supplyTransport = createIntakeSupplyTransport({
      myCapabilities: async () => ({ ok: true, value: { order: order() } }), orderSources,
      setOwnerSupplyEnabled: async () => ({ ok: true, value: order() }), setLocalServiceEnabled,
    })
    const planOrderAdapter = vi.fn(async (_prompt: string) => true)
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} supplyTransport={supplyTransport}
      planOrderAdapter={planOrderAdapter} dashboard={null} />)
    await act(async () => { await controller.poll() })
    expect(await view.findByText('视频助手')).toBeTruthy()
    const videoCard = view.container.querySelector('[data-order-source-id="skill:user-dsh:video-helper"]') as HTMLElement
    expect(within(videoCard).getByText('缺接单适配器')).toBeTruthy()
    expect(within(videoCard).getByText('已安装，但缺少平台任务类型、无人值守执行入口和本机自检；当前不能授权接单。')).toBeTruthy()
    fireEvent.click(within(videoCard).getByText(zh.orderAdapterRequirementsTitle))
    expect(within(videoCard).getByText(zh.orderAdapterPlanScope)).toBeTruthy()
    await act(async () => { fireEvent.click(within(videoCard).getByRole('button', { name: zh.orderAdapterPlan })) })
    expect(planOrderAdapter).toHaveBeenCalledTimes(1)
    expect(planOrderAdapter.mock.calls[0]?.[0]).toContain('名称="视频助手"')
    expect(planOrderAdapter.mock.calls[0]?.[0]).toContain('不得伪造审核、授权、订单或收入')
    expect(view.container.querySelector('[data-order-source-id="bundle:old-counter"] [role="switch"]')).toBeNull()
    expect(view.container.querySelector('[data-order-source-id="bundle:video-name"]')?.getAttribute('data-order-source-category')).toBe('text')
    expect(view.container.querySelector('[data-order-source-id="bundle:old-counter"]')?.getAttribute('data-order-source-category')).toBe('other')
    expect(view.container.querySelector('[data-order-source-id="skill:user-dsh:video-helper"]')?.getAttribute('data-order-source-category')).toBe('video')
    fireEvent.click(view.getByRole('button', { name: '工具 · 3' }))
    expect(view.getByText('视频助手')).toBeTruthy()
    expect(view.queryByText('视频渲染插件')).toBeNull()
    fireEvent.click(view.getByRole('button', { name: '工具 · 3' }))
    await act(async () => { fireEvent.click(view.getByRole('switch', { name: '视频渲染插件' })) })
    expect(setLocalServiceEnabled).toHaveBeenCalledExactlyOnceWith({ serviceId: 'node', enabled: true })
    await waitFor(() => { expect(view.getByRole('switch', { name: '视频渲染插件' }).getAttribute('aria-checked')).toBe('true') })
    expect(view.getByRole('heading', { name: '已授权能力，等待电脑空闲' })).toBeTruthy()
    expect(view.container.textContent).toContain('电脑正在使用')
    expect(orderSources).toHaveBeenCalledTimes(3)
    runnable = false
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(orderSources).toHaveBeenCalledTimes(4) })
    const selectedSwitch = await view.findByRole('switch', { name: '视频渲染插件' })
    expect(selectedSwitch.hasAttribute('disabled')).toBe(false)
    expect(view.container.textContent).toContain('当前选中的本机接单执行器未通过验证')
    await act(async () => { fireEvent.click(selectedSwitch) })
    expect(setLocalServiceEnabled).toHaveBeenLastCalledWith({ serviceId: 'node', enabled: false })
    await waitFor(() => { expect(view.getByRole('switch', { name: '视频渲染插件' }).hasAttribute('disabled')).toBe(true) })
  })

  it('selects a verified candidate before separately asking for its order grant', async () => {
    const controller = new NodeStatusController({ transport: createStubTransport([]), intervalMs: 60_000 })
    let selected: 'builtin' | 'plugin' = 'builtin'
    let granted = false
    let selectionAttempts = 0
    const order = () => ({ mode: 'idle', maxConcurrency: 1, enabledServiceCount: granted ? 1 : 0,
      enabledServiceIds: granted ? ['node'] : [] })
    const selectOrderSource = vi.fn(async ({ sourceId }: { sourceId: string }) => {
      if (sourceId !== 'bundle:wordfreq') throw new Error('unexpected selection')
      if (++selectionAttempts === 1) return { ok: false as const, error: { message: 'QIANSHOU_CATALOG_order-source-busy' } }
      selected = 'plugin'
      return { ok: true as const, value: { selectedSourceId: sourceId, taskType: 'text_sort',
        capabilityId: 'text.transform', requiresGrant: true } }
    })
    const setLocalServiceEnabled = vi.fn(async ({ enabled }: { enabled: boolean }) => {
      granted = enabled
      return { ok: true as const, value: order() }
    })
    const supplyTransport = createIntakeSupplyTransport({
      myCapabilities: async () => ({ ok: true, value: { order: order() } }),
      orderSources: async () => ({ ok: true, value: { order: order(), complete: true, sources: [
        { id: 'builtin:word_count', kind: 'builtin', source: 'builtin', title: '本机词频统计', description: '',
          category: 'text', loadState: 'active', capabilityId: selected === 'builtin' ? 'text.transform' : null,
          taskType: selected === 'builtin' ? 'word_count' : null, serviceId: selected === 'builtin' ? 'node' : null,
          selectable: selected !== 'builtin', eligible: selected === 'builtin', enabled: false,
          reason: selected === 'builtin' ? 'ready' : 'not-selected' },
        { id: 'bundle:wordfreq', kind: 'plugin', source: 'profile-bundle', title: '已安装排序插件', description: '',
          category: null, loadState: 'active', capabilityId: selected === 'plugin' ? 'text.transform' : null,
          taskType: selected === 'plugin' ? 'text_sort' : null, serviceId: selected === 'plugin' ? 'node' : null,
          selectable: selected !== 'plugin', eligible: selected === 'plugin', enabled: granted,
          reason: selected === 'plugin' ? 'ready' : 'not-selected' },
      ] } }),
      setOwnerSupplyEnabled: async () => ({ ok: true, value: order() }), selectOrderSource, setLocalServiceEnabled,
    })
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} supplyTransport={supplyTransport} dashboard={null} />)
    expect(await view.findByRole('button', { name: '选为接单执行器 · 已安装排序插件' })).toBeTruthy()
    await act(async () => { fireEvent.click(view.getByRole('button', { name: '选为接单执行器 · 已安装排序插件' })) })
    expect(selectOrderSource).toHaveBeenCalledExactlyOnceWith({ sourceId: 'bundle:wordfreq' })
    expect(view.getByRole('alert').textContent).toContain('仍有订单正在运行')
    expect(setLocalServiceEnabled).not.toHaveBeenCalled()
    await act(async () => { fireEvent.click(await view.findByRole('button', { name: '选为接单执行器 · 已安装排序插件' })) })
    expect(selectOrderSource).toHaveBeenCalledTimes(2)
    expect(setLocalServiceEnabled).not.toHaveBeenCalled()
    expect(view.getByRole('switch', { name: '接单总开关' }).getAttribute('aria-checked')).toBe('true')
    const chosenSwitch = await view.findByRole('switch', { name: '已安装排序插件' })
    expect(view.container.textContent).toContain('平台任务 text_sort')
    expect(chosenSwitch.getAttribute('aria-checked')).toBe('false')
    await act(async () => { fireEvent.click(chosenSwitch) })
    expect(setLocalServiceEnabled).toHaveBeenCalledExactlyOnceWith({ serviceId: 'node', enabled: true })
  })

  it('keeps the master switch off when the local word_count grant is saved', async () => {
    const controller = new NodeStatusController({ transport: createStubTransport([]), intervalMs: 60_000 })
    let granted = false
    const supplyTransport = {
      read: async () => ({ mode: 'off' as const, maxConcurrency: 1, enabledServiceCount: granted ? 1 : 0,
        enabledServiceIds: granted ? ['node'] : [] }),
      set: vi.fn(),
      setTextService: vi.fn(async (enabled: boolean) => {
        granted = enabled
        return { mode: 'off' as const, maxConcurrency: 1, enabledServiceCount: granted ? 1 : 0,
          enabledServiceIds: granted ? ['node'] : [] }
      }),
    }
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} supplyTransport={supplyTransport} dashboard={null} />)
    expect(await view.findByRole('heading', { name: '接单已关闭' })).toBeTruthy()
    await act(async () => { fireEvent.click(view.getByRole('switch', { name: '词频统计接单' })) })
    expect(supplyTransport.setTextService).toHaveBeenCalledExactlyOnceWith(true)
    expect(view.getByRole('switch', { name: '词频统计接单' }).getAttribute('aria-checked')).toBe('true')
    expect(view.getByRole('switch', { name: '接单总开关' }).getAttribute('aria-checked')).toBe('false')
    expect(view.getByRole('heading', { name: '接单已关闭' })).toBeTruthy()
    expect(view.container.textContent).toContain('接单总开关仍关闭')
    expect(supplyTransport.set).not.toHaveBeenCalled()
  })

  it('prioritizes a missing account session while still showing the zero-service count', async () => {
    const raw = onlineSnapshot()
    const snapshot = parseNodeStatus({ ...raw, connection: { ...(raw.connection as Record<string, unknown>), mode: 'paused' }, current: null, tasks: [] })
    if (snapshot === null) throw new Error('Invalid paused node status fixture')
    const controller = new NodeStatusController({
      transport: createStubTransport([{ kind: 'snapshot', snapshot }], { running: false, managed: true, mode: 'paused', code: 'NODE_SWITCH_NO_SESSION' }),
      intervalMs: 60_000,
    })
    const supplyTransport = { read: async () => ({ mode: 'idle' as const, maxConcurrency: 1, enabledServiceCount: 0, enabledServiceIds: [] }),
      set: async () => ({ mode: 'idle' as const, maxConcurrency: 1, enabledServiceCount: 0, enabledServiceIds: [] }),
      setTextService: vi.fn() }
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)}
      supplyTransport={supplyTransport} dashboard={null} />)
    await act(async () => { await controller.poll() })
    expect(await view.findByRole('heading', { name: '暂未具备接单条件' })).toBeTruthy()
    expect(view.container.textContent).toContain('请先登录千手账号')
    expect(view.container.querySelector('[data-intake-service-count="0"]')).toBeTruthy()
  })

  it('shows real local running work and keeps process diagnostics below node details without six counters', async () => {
    const snapshot = parseNodeStatus(onlineSnapshot())
    if (snapshot === null) throw new Error('Invalid node status fixture')
    const controller = new NodeStatusController({ transport: createStubTransport([{ kind: 'snapshot', snapshot }]), intervalMs: 60_000 })
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} dashboardTransport={{ read: () => Promise.reject(new Error('offline')) }} />)
    await act(async () => { await controller.poll() })
    expect(view.getByRole('heading', { name: '正在进行' })).toBeTruthy()
    expect(view.container.textContent).toContain('word_count')
    expect(view.container.textContent).toContain('40%')
    fireEvent.click(view.getByText('节点详情'))
    expect(view.container.querySelector('[data-node-diagnostics="true"]')).toBeTruthy()
    expect(view.container.textContent).toContain('0b4fc9a1-2202-56ad-bd0c-abccec2822f6')
    expect(view.container.querySelector('[data-node-counters]')).toBeNull()
    expect(view.container.querySelector('[data-node-earnings]')).toBeNull()
    expect(await view.findByText('平台记录暂不可用，请稍后刷新。')).toBeTruthy()
  })

  it('renders only supplied server receipts as historical results and actual income', () => {
    const dashboard: IntakeDashboardData = {
      schema: 'qianshou.node-dashboard.v1', worker_id: 'worker-1', history_scope: 'current_shard_assignment',
      counts: { executions: 4, orders: 3, succeeded: 2, failed: 1, cancelled: 0, pending_resolution: 1, avg_success_elapsed_ms: 32_000 },
      earnings: { currency: 'CNY', settled_node_compute: '25.5000' }, plugin_calls: null,
      plugin_calls_note: '插件执行尚无可核实的订单事件，暂不计次。',
      total: 4, limit: 20, offset: 0,
      items: [{ shard_id: 'shard-1', workload_id: 'workload-1', task_type: 'text.transform', status: 'done', attempts: 1, dispatched_at: '2026-09-23T07:59:30Z', started_at: '2026-09-23T07:59:30Z', completed_at: '2026-09-23T08:00:00Z', elapsed_ms: 30_000, settled_node_compute_cny: '8.5000' }],
    }
    const controller = new NodeStatusController({ transport: createStubTransport([]), intervalMs: 60_000 })
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} dashboard={dashboard} />)
    expect(view.getByRole('heading', { name: '接单状态待同步' })).toBeTruthy()
    expect(view.container.textContent).toContain('25.5000 CNY')
    expect(view.container.textContent).toContain('8.5000 CNY')
    expect(view.container.textContent).toContain('当前归属记录')
    expect(view.container.textContent).toContain('暂无可核实记录')
  })

  it('loads the current worker through the Host, then refreshes and pages server records', async () => {
    const snapshot = parseNodeStatus(onlineSnapshot())
    if (snapshot === null || snapshot.connection.workerId === null) throw new Error('Invalid node status fixture')
    const workerId = snapshot.connection.workerId
    const item = { shard_id: 'shard-1', workload_id: 'workload-1', task_type: 'text.transform', status: 'done', attempts: 1,
      dispatched_at: '2026-09-23T07:59:30Z', started_at: '2026-09-23T07:59:30Z', completed_at: '2026-09-23T08:00:00Z',
      elapsed_ms: 30_000, settled_node_compute_cny: '0.4875' }
    const read = vi.fn(async (_id: string, offset: number): Promise<IntakeDashboardData> => ({
      schema: 'qianshou.node-dashboard.v1', worker_id: workerId, history_scope: 'current_shard_assignment',
      counts: { executions: 21, orders: 21, succeeded: 21, failed: 0, cancelled: 0, pending_resolution: 0, avg_success_elapsed_ms: 30_000 },
      earnings: { currency: 'CNY', settled_node_compute: '10.2375' }, plugin_calls: null, plugin_calls_note: '',
      total: 21, limit: 20, offset,
      items: offset === 0 ? Array.from({ length: 20 }, (_, index) => ({ ...item, shard_id: `shard-${String(index)}` })) : [{ ...item, shard_id: 'shard-20' }],
    }))
    const controller = new NodeStatusController({ transport: createStubTransport([{ kind: 'snapshot', snapshot }]), intervalMs: 60_000 })
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} dashboardTransport={{ read }} />)
    await act(async () => { await controller.poll() })
    expect(await view.findByText('10.2375 CNY')).toBeTruthy()
    expect(read).toHaveBeenCalledWith(workerId, 0, expect.anything())
    fireEvent.click(view.getByRole('button', { name: '下一页' }))
    await waitFor(() => { expect(read).toHaveBeenCalledWith(workerId, 20, expect.anything()) })
    expect(await view.findByText('21–21 / 21')).toBeTruthy()
    fireEvent.click(view.getByRole('button', { name: '刷新' }))
    await waitFor(() => { expect(read).toHaveBeenCalledTimes(3) })
  })

  it('picks up a newly settled order without requiring a manual refresh', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      const nodeSnapshot = parseNodeStatus(onlineSnapshot())
      if (nodeSnapshot === null || nodeSnapshot.connection.workerId === null) throw new Error('Invalid node fixture')
      const workerId = nodeSnapshot.connection.workerId
      let settled = false
      const read = vi.fn(async (): Promise<IntakeDashboardData> => ({
        schema: 'qianshou.node-dashboard.v1', worker_id: workerId, history_scope: 'current_shard_assignment',
        counts: { executions: settled ? 1 : 0, orders: settled ? 1 : 0, succeeded: settled ? 1 : 0,
          failed: 0, cancelled: 0, pending_resolution: 0, avg_success_elapsed_ms: settled ? 2 : null },
        earnings: { currency: 'CNY', settled_node_compute: settled ? '0.4875' : '0.0000' },
        plugin_calls: null, plugin_calls_note: '', total: settled ? 1 : 0, limit: 20, offset: 0,
        items: settled ? [{ shard_id: 'shard-new', workload_id: 'wl-new', task_type: 'word_count',
          status: 'done', attempts: 1, dispatched_at: '2026-09-25T00:02:49Z',
          started_at: '2026-09-25T00:02:50Z', completed_at: '2026-09-25T00:02:50Z',
          elapsed_ms: 2, settled_node_compute_cny: '0.4875' }] : [],
      }))
      const controller = new NodeStatusController({ transport: createStubTransport([{ kind: 'snapshot', snapshot: nodeSnapshot }]), intervalMs: 60_000 })
      const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} dashboardTransport={{ read }} />)
      await act(async () => { await controller.poll() })
      expect(await view.findByText('平台暂无这台设备的任务记录。')).toBeTruthy()
      settled = true
      await act(async () => { vi.advanceTimersByTime(10_000); await Promise.resolve() })
      expect(await view.findByText('0.4875 CNY')).toBeTruthy()
      expect(view.getByText('词频统计')).toBeTruthy()
      expect(read).toHaveBeenCalledTimes(2)
    } finally { vi.useRealTimers() }
  })
})
