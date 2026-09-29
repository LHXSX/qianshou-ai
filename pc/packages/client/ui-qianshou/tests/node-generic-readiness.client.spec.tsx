// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NodeIntakePage } from '../src/client/node-status/NodeIntakePage.tsx'
import { OrderSourcesPanel } from '../src/client/node-status/OrderSourcesPanel.tsx'
import { NodeStatusController } from '../src/client/node-status/controller.ts'
import type { IntakeOrderSources } from '../src/client/node-status/supply-transport.ts'
import { zh } from '../src/client/node-status/locales.ts'
import { parseNodeStatus } from '../src/client/node-status/types.ts'
import { createStubTransport, onlineSnapshot } from './fixtures/node-status.fixture.ts'

afterEach(cleanup)

const videoSource = (enabled: boolean): IntakeOrderSources['sources'][number] => ({
  id: 'skill:user-dsh:another-video-model', kind: 'skill', source: 'user-dsh',
  title: '另一种视频模型', description: '用另一套已审核工作流生成视频', category: 'video',
  loadState: 'active', capabilityId: 'video.render', taskType: 'video_other_v1',
  serviceId: 'node', selectable: false, eligible: true, enabled, reason: 'ready',
})

describe('heterogeneous node readiness', () => {
  it('does not claim an incomplete inventory is accepting even with a stale eligible video row', async () => {
    const snapshot = parseNodeStatus(onlineSnapshot())
    if (snapshot === null) throw new Error('Invalid node fixture')
    const controller = new NodeStatusController({ transport: createStubTransport(
      [{ kind: 'snapshot', snapshot }], { running: true, managed: true, mode: 'running' }), intervalMs: 60_000 })
    const set = vi.fn()
    const setTextService = vi.fn()
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} dashboard={null}
      supplyTransport={{
        read: async () => ({ mode: 'idle' as const, maxConcurrency: 1,
          enabledServiceCount: 1, enabledServiceIds: ['node'] }),
        listSources: async () => ({ complete: false, sources: [videoSource(true)] }),
        set, setTextService,
      }} />)
    await act(async () => { await controller.poll() })
    await waitFor(() => expect(view.container.querySelector('[data-order-sources-state="ready"]')).toBeTruthy())
    expect(view.container.querySelector('[data-intake-status]')?.getAttribute('data-intake-status')).toBe('unknown')
    expect(view.getByRole('heading', { name: zh.intakeUnknown })).toBeTruthy()
    expect(view.queryByRole('heading', { name: zh.intakeAccepting })).toBeNull()
    expect(view.container.querySelector('[data-order-readiness="unknown"]')).toBeTruthy()
    expect(view.container.querySelector('[data-order-source-id="skill:user-dsh:another-video-model"]')
      ?.getAttribute('data-order-source-eligible')).toBe('false')
    expect(view.container.textContent).toContain(zh.orderSourceQualificationPending)
    // Already-saved grants may still be revoked while a partial inventory is being repaired.
    const revoke = view.getByRole('switch', { name: '另一种视频模型' })
    expect(revoke.getAttribute('aria-checked')).toBe('true')
    expect(revoke.hasAttribute('disabled')).toBe(false)
    expect(set).not.toHaveBeenCalled()
    expect(setTextService).not.toHaveBeenCalled()
    controller.dispose()
  })

  it('keeps unknown video sources in the list but disables new grants and selection', () => {
    const onToggle = vi.fn()
    const onSelect = vi.fn()
    const onActivateAuthor = vi.fn()
    const partial: IntakeOrderSources = { complete: false, sources: [videoSource(false), {
      id: 'skill:user-agents:other-video', kind: 'skill', source: 'user-agents',
      title: '别的视频工作流', description: '用不同的模型生成视频', category: 'video',
      loadState: 'active', capabilityId: 'video.render', taskType: 'other_video_v1',
      serviceId: null, selectable: true, eligible: false, enabled: false, reason: 'not-selected',
    }, {
      id: 'skill:user-agents:approved-video', kind: 'skill', source: 'user-agents',
      title: '已审核视频技能', description: '另一种受理的视频', category: 'video',
      authorProductId: 'b9418e38-b3a5-5722-8005-cc7afbe2a21a',
      loadState: 'active', capabilityId: 'video.render', taskType: 'approved_video_v1',
      serviceId: null, selectable: false, eligible: false, enabled: false, reason: 'publication-approved',
    }] }
    const view = render(<OrderSourcesPanel t={makeTranslate(zh)} phase="ready" data={partial}
      granted={false} ownerOn={false} busy={false} busyMessage={null} selectionSupported error={null}
      onRefresh={() => {}} onToggle={onToggle} onSelect={onSelect} onActivateAuthor={onActivateAuthor} />)
    expect(view.container.querySelector('[data-order-readiness="unknown"]')).toBeTruthy()
    expect(view.getByRole('switch', { name: '另一种视频模型' }).hasAttribute('disabled')).toBe(true)
    expect(view.getByRole('button', { name: `${zh.orderSourceSelect} · 别的视频工作流` }).hasAttribute('disabled')).toBe(true)
    expect(view.container.querySelector('[data-order-source-activate="skill:user-agents:approved-video"]')?.hasAttribute('disabled')).toBe(true)
    fireEvent.click(view.getByRole('switch', { name: '另一种视频模型' }))
    expect(onToggle).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    expect(onActivateAuthor).not.toHaveBeenCalled()
    expect(view.container.textContent).not.toContain('H3 所需的五类模型文件')
  })

  it('does not turn on the master switch from an incomplete inventory', async () => {
    const snapshot = parseNodeStatus(onlineSnapshot())
    if (snapshot === null) throw new Error('Invalid node fixture')
    const controller = new NodeStatusController({ transport: createStubTransport(
      [{ kind: 'snapshot', snapshot }], { running: true, managed: true, mode: 'running' }), intervalMs: 60_000 })
    const set = vi.fn()
    const setTextService = vi.fn()
    const view = render(<NodeIntakePage controller={controller} t={makeTranslate(zh)} dashboard={null}
      supplyTransport={{
        read: async () => ({ mode: 'off' as const, maxConcurrency: 1,
          enabledServiceCount: 0, enabledServiceIds: [] }),
        listSources: async () => ({ complete: false, sources: [videoSource(false)] }),
        set, setTextService,
      }} />)
    await act(async () => { await controller.poll() })
    await waitFor(() => expect(view.container.querySelector('[data-order-sources-state="ready"]')).toBeTruthy())
    expect(view.getByRole('switch', { name: zh.intakeMasterSwitch }).hasAttribute('disabled')).toBe(true)
    expect(view.getByRole('switch', { name: '另一种视频模型' }).hasAttribute('disabled')).toBe(true)
    expect(set).not.toHaveBeenCalled()
    expect(setTextService).not.toHaveBeenCalled()
    controller.dispose()
  })
})
