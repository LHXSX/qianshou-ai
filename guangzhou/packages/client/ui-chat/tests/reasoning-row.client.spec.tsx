// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { makeTranslate } from '@deepseek-ai/dsh-client-test-runtime'
import { zh as commonZh } from '@deepseek-ai/dsh-client-locale/src/locales/zh.ts'
import { zh } from '../src/client/locale.ts'
import { AssistantMarkdown, type AssistantMarkdownProps } from '../src/client/chat/AssistantMarkdown.tsx'

afterEach(() => {
  cleanup()
})

const t = makeTranslate(zh, commonZh)
const renderMessageImages: AssistantMarkdownProps['renderMessageImages'] = () => null

describe('ReasoningRow', () => {
  it('keeps a stable status as streaming tokens arrive and changes it only when settled', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    const summary = view.getByText('分析中，展开查看思考过程')
    expect(view.queryByText(/Newest reasoning tokens/)).toBeNull()
    expect(view.queryByRole('region')).toBeNull()

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving' }]}
        streaming
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('分析中，展开查看思考过程')).toBe(summary)
    expect(view.queryByText(/Newest reasoning tokens/)).toBeNull()

    view.rerender(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nNewest reasoning tokens keep arriving\n' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    expect(view.getByText('思考记录，按需展开')).toBeTruthy()
    expect(view.queryByText('分析中，展开查看思考过程')).toBeNull()
    expect(view.queryByText(/Inspect the session/)).toBeNull()
  })

  it('expands from the stable summary and closes through the Think title', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    const row = view.getByRole('button')

    fireEvent.click(view.getByText('思考记录，按需展开'))
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getByText(/Check persistence/)).toBeTruthy()

    fireEvent.click(view.getByText('思考'))
    expect(row.getAttribute('aria-expanded')).toBe('false')
  })

  it.each([
    {
      label: 'settled',
      text: '**Comparing checkout and merge bases**\nKeep **reviewing**',
      streaming: false,
    },
    {
      label: 'streaming',
      text: 'Inspect the session\n**Comparing checkout and merge bases**',
      streaming: true,
    },
  ])('keeps $label raw reasoning out of the collapsed row and preserves it in a focusable expanded region', ({ text, streaming }) => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text }]}
        streaming={streaming}
        renderMessageImages={renderMessageImages}
      />,
    )

    expect(view.queryByText(/Comparing checkout and merge bases/)).toBeNull()

    fireEvent.click(view.getByText('思考'))
    const details = view.getByRole('region', { name: '思考过程' })
    expect(details.textContent).toBe(text)
    expect(details.tabIndex).toBe(0)
    details.focus()
    expect(document.activeElement).toBe(details)
  })

  it('expanded Think drops the inline summary and renders plain prose, no IN card', () => {
    const view = render(
      <AssistantMarkdown
        t={t}
        blocks={[{ kind: 'reasoning', text: 'Inspect the session\nCheck persistence' }]}
        streaming={false}
        renderMessageImages={renderMessageImages}
      />,
    )
    fireEvent.click(view.getByText('思考'))
    expect(view.getAllByText(/Inspect the session/)).toHaveLength(1)
    expect(view.queryByText('思考记录，按需展开')).toBeNull()
    expect(view.queryByText('IN')).toBeNull()
    expect(view.container.querySelector('[class*="ioCard"]')).toBeNull()
    expect(view.container.querySelector('[class*="thinkBody"]')).not.toBeNull()
  })

  it('toggles the disclosure with Enter and Space without exposing a second transcript copy', () => {
    const view = render(<AssistantMarkdown t={t} blocks={[{ kind: 'reasoning', text: 'Inspect the session' }]}
      streaming={false} renderMessageImages={renderMessageImages} />)
    const row = view.getByRole('button')
    row.focus()
    fireEvent.keyDown(row, { key: 'Enter' })
    expect(row.getAttribute('aria-expanded')).toBe('true')
    expect(view.getAllByText('Inspect the session')).toHaveLength(1)
    fireEvent.keyDown(row, { key: ' ' })
    expect(row.getAttribute('aria-expanded')).toBe('false')
    expect(view.queryByRole('region')).toBeNull()
  })
})
