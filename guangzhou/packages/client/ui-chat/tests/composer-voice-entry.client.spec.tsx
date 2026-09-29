// @vitest-environment jsdom
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { ComposerVoiceEntry, type ComposerVoiceEntryProps } from '../src/client/chat/voice/ComposerVoiceEntry.tsx'

afterEach(cleanup)

function bench(overrides: Partial<ComposerVoiceEntryProps> = {}) {
  const props: ComposerVoiceEntryProps = {
    t: makeTranslate(zh, commonZh), delivery: 'manager', isSubagent: false,
    onStartConversation: vi.fn(), onStartDictation: vi.fn(), onDeliveryChange: vi.fn(), ...overrides,
  }
  return { ...render(<ComposerVoiceEntry {...props} />), props }
}

describe('composer voice entry', () => {
  it('opens no microphone or menu on mount and starts the existing voice controller on an explicit gesture', () => {
    const view = bench()
    const start = view.getByRole('button', { name: '开始语音对话' })
    expect(start.getAttribute('aria-description')).toBe('语音管家')
    expect(view.queryByRole('menu')).toBeNull()
    expect(view.queryByText('仅听写')).toBeNull()
    expect(view.props.onStartConversation).not.toHaveBeenCalled()
    expect(view.props.onStartDictation).not.toHaveBeenCalled()
    fireEvent.click(start)
    expect(view.props.onStartConversation).toHaveBeenCalledOnce()
    expect(view.props.onStartDictation).not.toHaveBeenCalled()
  })

  it('changes delivery without starting capture and closes the options menu', () => {
    const view = bench()
    fireEvent.click(view.getByRole('button', { name: '语音投递' }))
    fireEvent.click(view.getByRole('menuitem', { name: '并行派工' }))
    expect(view.props.onDeliveryChange).toHaveBeenCalledExactlyOnceWith('parallel')
    expect(view.queryByRole('menu')).toBeNull()
    expect(view.props.onStartConversation).not.toHaveBeenCalled()
    expect(view.props.onStartDictation).not.toHaveBeenCalled()
  })

  it('keeps dictation available as a separate explicit action', () => {
    const view = bench()
    fireEvent.click(view.getByRole('button', { name: '语音投递' }))
    fireEvent.click(view.getByRole('menuitem', { name: '仅听写' }))
    expect(view.props.onStartDictation).toHaveBeenCalledOnce()
    expect(view.props.onStartConversation).not.toHaveBeenCalled()
    expect(view.props.onDeliveryChange).not.toHaveBeenCalled()
    expect(view.queryByRole('menu')).toBeNull()
  })

  it('preserves subagent delivery restrictions while allowing current-task speech and dictation', () => {
    const view = bench({ isSubagent: true, delivery: 'current' })
    fireEvent.click(view.getByRole('button', { name: '语音投递' }))
    const manager = view.getByRole('menuitem', { name: '语音管家' }) as HTMLButtonElement
    const parallel = view.getByRole('menuitem', { name: '并行派工' }) as HTMLButtonElement
    expect(manager.disabled).toBe(true)
    expect(parallel.disabled).toBe(true)
    fireEvent.click(manager)
    expect(view.props.onDeliveryChange).not.toHaveBeenCalled()
    fireEvent.click(view.getByRole('menuitem', { name: '补充当前任务' }))
    expect(view.props.onDeliveryChange).toHaveBeenCalledExactlyOnceWith('current')
  })

  it('closes on Escape and returns keyboard focus to the options button', () => {
    const view = bench()
    const options = view.getByRole('button', { name: '语音投递' })
    fireEvent.click(options)
    fireEvent.keyDown(view.getByRole('menu'), { key: 'Escape' })
    expect(view.queryByRole('menu')).toBeNull()
    expect(document.activeElement).toBe(options)
    expect(view.props.onStartConversation).not.toHaveBeenCalled()
  })
})
