// @vitest-environment jsdom
/**
 * U1 客户端显示面：在线/离线/计数/中止/收益缺口的正向与反向闸。
 * 反向闸（改坏必须红）：收益为 null 时只许出说明，任何数字都是缺陷。
 */
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NodeStatusController } from '../src/client/node-status/controller.ts'
import { NodeStatusPanel, type NodeStatusPanelProps } from '../src/client/node-status/NodeStatusPanel.tsx'
import { zh } from '../src/client/node-status/locales.ts'
import { parseNodeStatus, type NodePowerState, type NodeStatusReadout, type NodeStatusSnapshot } from '../src/client/node-status/types.ts'
import { createStubTransport, onlineSnapshot } from './fixtures/node-status.fixture.ts'

afterEach(cleanup)

function snapshot(): NodeStatusSnapshot {
  const parsed = parseNodeStatus(onlineSnapshot())
  if (parsed === null) throw new Error('Invalid node status fixture')
  return parsed
}

function panel(readout: NodeStatusReadout, extra: Partial<NodeStatusPanelProps> = {}, power?: NodePowerState) {
  const transport = createStubTransport([readout], power)
  const controller = new NodeStatusController({ transport, intervalMs: 60_000 })
  const props = {
    controller, t: makeTranslate(zh), now: () => Date.parse('2026-09-22T12:31:00.000Z'), ...extra,
  } as unknown as NodeStatusPanelProps
  return { transport, controller, props, view: render(<NodeStatusPanel {...props} />) }
}

describe('U1 节点状态显示面', () => {
  it('在线快照把连接/正在跑什么/计数/最近拒绝/最近结果逐项渲染出来', async () => {
    const online: NodeStatusReadout = { kind: 'snapshot', snapshot: snapshot() }
    const f = panel(online)
    await act(async () => { await f.controller.poll() })
    const text = f.view.container.textContent ?? ''
    // 连接状态 + 在线时长
    expect(text).toContain('已连接')
    expect(text).toContain('00:20:06')
    expect(text).toContain('https://qianshousuanli.com')
    expect(text).toContain('167')
    // 正在跑什么：类型/分片/尝试/开始时间/进度
    expect(text).toContain('word_count')
    expect(text).toContain('shard-live-1')
    expect(f.view.container.querySelector('[data-node-current]')?.getAttribute('data-attempt')).toBe('1')
    expect(text).toContain('40%')
    // 六项累计计数
    const counters = f.view.container.querySelector('[data-node-counters]')?.textContent ?? ''
    expect(counters).toContain('3') // 收到
    expect(counters).toContain('2') // 接受
    expect(counters).toContain('1') // 成功
    // 最近一次拒绝原因（原文，不许吞掉）
    expect(text).toContain('输入字段缺失 primary_text')
    expect(text).toContain('shard-bad')
    // 最近结果 + 核验态
    expect(f.view.container.querySelector('[data-verification="workload-completed-shard-observed"]')).toBeTruthy()
    expect(text).toContain('可结算')
    expect(f.view.container.querySelector('[data-verification="unobservable"]')).toBeTruthy()
    expect(text).toContain('未知')
  })

  it('节点诊断只读，不出现第二个接单开关；没登录时说明原因', async () => {
    const offline = panel({ kind: 'unreachable', code: 'NODE_UNREACHABLE' })
    await act(async () => { await offline.controller.poll() })
    expect(offline.view.container.querySelector('[role="switch"]')).toBeNull()
    expect(offline.view.container.querySelector('[data-node-power="off"]')).toBeTruthy()
    expect(offline.view.container.textContent).toContain('节点未运行')

    const signedOut = panel(
      { kind: 'unreachable', code: 'NODE_UNREACHABLE' },
      {},
      { running: false, managed: false, mode: null, code: 'NODE_SWITCH_NO_SESSION' },
    )
    await act(async () => { await signedOut.controller.poll() })
    expect(signedOut.view.container.textContent).toContain('请先登录千手账号')
  })

  it('端点不通时显示「节点未运行」，不是报错也不是空白', async () => {
    const f = panel({ kind: 'unreachable', code: 'NODE_UNREACHABLE' })
    await act(async () => { await f.controller.poll() })
    const text = f.view.container.textContent ?? ''
    expect(text).toContain('节点未运行')
    expect(f.view.container.querySelector('[data-node-phase="offline"]')).toBeTruthy()
    expect(text).not.toMatch(/Error|失败原因：undefined/)
  })

  it('中继未注册与节点未运行分开报，不混成一句话', async () => {
    const f = panel({ kind: 'unreachable', code: 'RELAY_MISSING' })
    await act(async () => { await f.controller.poll() })
    const text = f.view.container.textContent ?? ''
    expect(text).toContain('客户端未接线')
    expect(f.view.container.querySelector('[data-node-phase="not-wired"]')).toBeTruthy()
  })

  it('从未读到过快照时是「从未启动」，与「节点未运行」区分开', () => {
    const f = panel({ kind: 'unreachable', code: 'NODE_UNREACHABLE' })
    expect(f.view.container.querySelector('[data-node-phase="never-started"]')).toBeTruthy()
    expect(f.view.container.textContent).toContain('从未启动')
  })

  it('计数与状态随快照变化：运行中 → 在线待命，计数跟着走', async () => {
    const f = panel({ kind: 'snapshot', snapshot: snapshot() })
    await act(async () => { await f.controller.poll() })
    expect(f.view.container.querySelector('[data-node-phase="running"]')?.textContent).toContain('运行中')
    const base = snapshot()
    const idle: NodeStatusSnapshot = {
      ...base, current: null, tasks: [], counters: { ...base.counters, succeeded: 2 },
    }
    f.controller.accept({ kind: 'snapshot', snapshot: idle })
    f.view.rerender(<NodeStatusPanel {...f.props} />)
    expect(f.view.container.querySelector('[data-node-phase="standby"]')?.textContent).toContain('在线待命')
    expect(f.view.container.querySelector('[data-node-counters]')?.textContent).toContain('2')
  })

  it('任务标签四种结局各自不同，全压成一句话就是缺陷', async () => {
    const f = panel({ kind: 'snapshot', snapshot: snapshot() })
    await act(async () => { await f.controller.poll() })
    const rows = [...f.view.container.querySelectorAll('[data-outcome]')].map(row => row.getAttribute('data-outcome'))
    expect(rows).toContain('succeeded')
    expect(rows).toContain('failed')
    const labels = [...f.view.container.querySelectorAll('[data-outcome]')].map(row => row.textContent)
    const succeeded = labels.find(label => label?.includes('shard-done'))
    const failed = labels.find(label => label?.includes('shard-bad'))
    expect(succeeded).toContain('已完成')
    expect(failed).toContain('已失败')
    expect(succeeded).not.toEqual(failed)
  })

  it('中止按钮发出端点真实契约的命令（target，不是第二套命令）', async () => {
    const f = panel({ kind: 'snapshot', snapshot: snapshot() })
    await act(async () => { await f.controller.poll() })
    fireEvent.click(f.view.getByRole('button', { name: '中止全部' }))
    await vi.waitFor(() => expect(f.transport.commands).toHaveLength(1))
    expect(f.transport.commands[0]).toEqual({ command: 'abort', target: 'all' })
    fireEvent.click(f.view.getByRole('button', { name: '中止此分片' }))
    await vi.waitFor(() => expect(f.transport.commands).toHaveLength(2))
    expect(f.transport.commands[1]).toEqual({ command: 'abort', target: 'shard-live-1' })
  })

  it('反向闸：收益为 null 时只出说明，一个数字都不许编', async () => {
    const f = panel({ kind: 'snapshot', snapshot: snapshot() })
    await act(async () => { await f.controller.poll() })
    const earnings = f.view.container.querySelector('[data-node-earnings]')
    expect(earnings?.getAttribute('data-node-earnings')).toBe('null')
    expect(earnings?.textContent).toContain('派单帧不带报价')
    expect(earnings?.getAttribute('data-node-earnings-note')).toBe(snapshot().earnings.note)
    expect(earnings?.textContent).not.toMatch(/[0-9]/)
    expect(earnings?.textContent).not.toMatch(/¥|￥/)
  })
})
