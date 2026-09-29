// @vitest-environment jsdom
/**
 * U1「正在努力跑」用小猫动画；`prefers-reduced-motion: reduce` 时必须退成静态首帧。
 */
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { NodeStatusController } from '../src/client/node-status/controller.ts'
import { NodeStatusPanel, type NodeStatusPanelProps } from '../src/client/node-status/NodeStatusPanel.tsx'
import { CAT_FRAME_MS, CAT_FRAME_COUNT } from '../src/client/node-status/cat-frames.ts'
import { zh } from '../src/client/node-status/locales.ts'
import { parseNodeStatus, type NodeStatusReadout, type NodeStatusSnapshot } from '../src/client/node-status/types.ts'
import { createStubTransport, onlineSnapshot } from './fixtures/node-status.fixture.ts'

afterEach(cleanup)

function snapshot(): NodeStatusSnapshot {
  const parsed = parseNodeStatus(onlineSnapshot())
  if (parsed === null) throw new Error('Invalid node status fixture')
  return parsed
}

const online: NodeStatusReadout = { kind: 'snapshot', snapshot: snapshot() }

async function mount(reducedMotion: boolean) {
  const transport = createStubTransport([online])
  const controller = new NodeStatusController({ transport, intervalMs: 60_000 })
  await controller.poll()
  const props = { controller, t: makeTranslate(zh), reducedMotion } as unknown as NodeStatusPanelProps
  const view = render(<NodeStatusPanel {...props} />)
  return { view, props }
}

describe('U1 小猫动画', () => {
  it('正在跑时逐帧前进（90ms 一帧，循环），尺寸不变形', async () => {
    vi.useFakeTimers()
    try {
      const { view } = await mount(false)
      const cat = view.container.querySelector('[data-node-cat]')
      expect(cat).toBeTruthy()
      expect(cat?.getAttribute('data-cat-frame')).toBe('0')
      act(() => { vi.advanceTimersByTime(CAT_FRAME_MS) })
      expect(cat?.getAttribute('data-cat-frame')).toBe('1')
      act(() => { vi.advanceTimersByTime(CAT_FRAME_MS * (CAT_FRAME_COUNT - 1)) })
      expect(cat?.getAttribute('data-cat-frame')).toBe('0')
      const image = view.container.querySelector<HTMLImageElement>('[data-node-cat] img')
      expect(image?.getAttribute('width')).toBe('18')
      expect(image?.getAttribute('height')).toBe('18')
    } finally {
      vi.useRealTimers()
    }
  })

  it('减少动效下改成静态首帧，一秒都不许再动', async () => {
    vi.useFakeTimers()
    try {
      const { view } = await mount(true)
      const cat = view.container.querySelector('[data-node-cat]')
      expect(cat?.getAttribute('data-cat-frame')).toBe('0')
      expect(cat?.getAttribute('data-cat-motion')).toBe('reduced')
      act(() => { vi.advanceTimersByTime(CAT_FRAME_MS * 20) })
      expect(cat?.getAttribute('data-cat-frame')).toBe('0')
    } finally {
      vi.useRealTimers()
    }
  })

  it('没有正在跑的任务时不出动画（不是拿动画当装饰）', async () => {
    const idle: NodeStatusSnapshot = { ...snapshot(), current: null, tasks: [] }
    const transport = createStubTransport([{ kind: 'snapshot', snapshot: idle }])
    const controller = new NodeStatusController({ transport, intervalMs: 60_000 })
    await controller.poll()
    const view = render(<NodeStatusPanel {...({ controller, t: makeTranslate(zh) } as unknown as NodeStatusPanelProps)} />)
    expect(view.container.querySelector('[data-node-cat]')).toBeNull()
  })
})
