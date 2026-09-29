// @vitest-environment jsdom
import { useEffect } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { FloatingVoicePanel } from '../src/client/chat/voice/FloatingVoicePanel.tsx'
import type { CharacterFrame } from '../src/client/chat/voice/character-position.ts'

vi.mock('../src/client/chat/voice/VRMCompanion.tsx', () => ({
  VRMCompanion: ({ frame, speaking, modelUrl }: { frame: CharacterFrame; speaking: boolean; modelUrl: string }) =>
    <span role="img" aria-label="VRM character" data-testid="vrm" data-model={modelUrl}
      data-action={frame.action} data-speaking={speaking} />,
}))

afterEach(() => { cleanup(); vi.restoreAllMocks() })
const t = makeTranslate(zh, commonZh)

function setup() {
  const close = vi.fn(); const interrupt = vi.fn(); const mounted = vi.fn(); const unmounted = vi.fn()
  function Controls() {
    useEffect(() => { mounted(); return unmounted }, [])
    return <button type="button">Current voice setting</button>
  }
  const props = { t, state: 'listening', status: '正在聆听', onClose: close, onInterrupt: interrupt, children: <Controls /> }
  const view = render(<FloatingVoicePanel {...props} />)
  return { ...view, close, interrupt, mounted, unmounted, props }
}

describe('VRM voice companion integration', () => {
  it('keeps real controls mounted while compact, and closes only through the owner action', () => {
    const h = setup()
    expect(screen.getByTestId('vrm').getAttribute('data-model')).toBe('/qianshou/voice-companion.vrm')
    expect(screen.queryByRole('button', { name: 'Current voice setting' })).toBeNull()
    expect(h.mounted).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: '更多语音控制' }))
    expect(screen.getByRole('button', { name: 'Current voice setting' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '收起语音控制' }))
    expect(h.unmounted).not.toHaveBeenCalled()
    expect(h.close).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: '结束语音' }))
    expect(h.close).toHaveBeenCalledOnce()
  })

  it.each([
    ['listening', 'listening'], ['speaking', 'speaking'], ['thinking', 'busy'],
    ['executing', 'busy'], ['starting', 'busy'], ['paused', 'idle'],
  ])('projects %s to %s without fabricating a task', (state, expected) => {
    const h = setup()
    h.rerender(<FloatingVoicePanel {...h.props} state={state} status="真实控制器状态" />)
    expect(screen.getByRole('complementary', { name: '千手互动角色' }).getAttribute('data-state')).toBe(expected)
    expect(screen.getByTestId('vrm').getAttribute('data-speaking')).toBe(String(state === 'speaking'))
    expect(screen.getByRole('status').textContent).toBe('真实控制器状态')
    expect(h.close).not.toHaveBeenCalled()
    expect(h.interrupt).not.toHaveBeenCalled()
  })

  it('allows immediate interruption while the voice settings remain tucked away', () => {
    const h = setup()
    h.rerender(<FloatingVoicePanel {...h.props} state="speaking" status="正在朗读回复" />)
    fireEvent.click(screen.getByRole('button', { name: '立即打断' }))
    expect(h.interrupt).toHaveBeenCalledOnce()
    expect(h.close).not.toHaveBeenCalled()
    expect(screen.queryByRole('button', { name: 'Current voice setting' })).toBeNull()
  })

  it('reveals paused errors and resume controls without stealing focus', () => {
    const h = setup()
    const move = screen.getByRole('button', { name: '移动角色' }); move.focus()
    h.rerender(<FloatingVoicePanel {...h.props} state="paused" status="语音已暂停">
      <p role="alert">麦克风需要恢复</p><button type="button">继续聆听</button>
    </FloatingVoicePanel>)
    expect(screen.getByRole('alert').textContent).toBe('麦克风需要恢复')
    expect(screen.getByRole('button', { name: '继续聆听' })).toBeTruthy()
    expect(document.activeElement).toBe(move)
    expect(h.close).not.toHaveBeenCalled()
  })
})
