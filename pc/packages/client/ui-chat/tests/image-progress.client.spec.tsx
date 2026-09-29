// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'
import { imageProgressValue } from '../src/client/chat/image-progress.ts'
import { zh } from '../src/client/locale.ts'

const t: AssistantMarkdownProps['t'] = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('image progress', () => {
  it('fills toward the wait ceiling', () => {
    expect(imageProgressValue(0)).toBe(4)
    expect(imageProgressValue(45_000)).toBe(92)
    expect(imageProgressValue(90_000)).toBe(92)
  })

  it('shows a progress bar for the picture wait sentence and prose for anything else', () => {
    vi.useFakeTimers()
    const view = render(<AssistantMarkdown
      t={t}
      streaming
      blocks={[{ kind: 'text', text: '正在出图' }]}
      renderMessageImages={renderMessageImages}
    />)
    const bar = view.getByRole('progressbar', { name: '正在出图' })
    expect(bar.getAttribute('aria-valuenow')).toBe('4')
    act(() => { vi.advanceTimersByTime(45_000) })
    expect(bar.getAttribute('aria-valuenow')).toBe('92')
    view.unmount()
    const prose = render(<AssistantMarkdown
      t={t}
      streaming={false}
      blocks={[{ kind: 'text', text: '正在出图' }]}
      renderMessageImages={renderMessageImages}
    />)
    expect(prose.queryByRole('progressbar')).toBeNull()
    expect(prose.getByText('正在出图')).toBeTruthy()
  })
})
