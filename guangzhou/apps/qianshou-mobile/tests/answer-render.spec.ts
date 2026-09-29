// @vitest-environment jsdom
/**
 * 回复渲染：Markdown 必须变成**元素**，标记不能露在屏幕上。
 *
 * 这条用例来自用户实报："现在的回复没有排版和美化"。根因是 `AnswerBubble` 把内容
 * `split('\n')` 之后逐行当纯文本画出来，样式表里那一堆 `.md` 规则一条都用不上——
 * DOM 里根本没有 `.md`。所以这里断言到元素级别，而不是只断言"文字还在"。
 */
import { act, createElement, type FC, type ReactElement } from 'react'
import { afterEach, describe, expect, it } from 'vitest'
import { AnswerBubble } from '../src/App.tsx'

let container: HTMLDivElement | undefined
let root: { render: (node: ReactElement) => void; unmount: () => void } | null = null

afterEach(async () => {
  if (root !== null) await act(async () => { root!.unmount() })
  container?.remove()
})

/** 挂载一个回复气泡；`streaming` 模拟"这一条还在流式追加"。 */
async function render(content: string, streaming = false): Promise<HTMLDivElement> {
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const mounted = createRoot(container)
  root = mounted
  const Bubble: FC<{ content: string; streaming: boolean }> = ({ content: text, streaming: isStreaming }) =>
    createElement(AnswerBubble, {
      content: text,
      caret: false,
      react: false,
      liked: null,
      onLike: () => { /* 断言不涉及点赞 */ },
      streaming: isStreaming,
    })
  await act(async () => { mounted.render(createElement(Bubble, { content, streaming })) })
  return container
}

describe('回复走 Markdown 渲染', () => {
  it('标题、列表、粗体都变成元素，标记不露出来', async () => {
    const dom = await render('## 方案对比\n\n- 甲\n- 乙\n\n这是**重点**')
    expect(dom.querySelector('h2')?.textContent).toBe('方案对比')
    expect(dom.querySelectorAll('li')).toHaveLength(2)
    expect(dom.querySelector('strong')?.textContent).toBe('重点')
    const text = dom.textContent ?? ''
    expect(text).not.toContain('##')
    expect(text).not.toContain('**')
    expect(text).not.toContain('- 甲')
  })

  it('表格渲染成真正的 table，不再是竖线堆在段落里', async () => {
    // 收尾的分隔行之后要有一个空行：内容不算"正在增长"时才会整块解析，
    // 这正是收流后的稳态。
    const dom = await render('| 方案 | 成本 |\n| --- | --- |\n| A | 低 |\n\n')
    expect(dom.querySelector('table')).not.toBeNull()
    expect(dom.querySelectorAll('table thead th')).toHaveLength(2)
    expect(dom.querySelectorAll('table tbody td')).toHaveLength(2)
    expect(dom.textContent ?? '').not.toContain('| --- |')
  })

  it('流式中的表格：最后一行暂时是文本，空白行一到就变回表格', async () => {
    // 这是刻意的取舍：还在增长的那一行不能整块解析，否则每来一个字都要拆合整张表。
    const growing = await render('| 方案 | 成本 |\n| --- | --- |\n| A | 低 |', true)
    expect(growing.querySelector('table')).not.toBeNull()
    expect(growing.querySelectorAll('table tbody td')).toHaveLength(0)

    const done = await render('| 方案 | 成本 |\n| --- | --- |\n| A | 低 |\n\n', false)
    expect(done.querySelectorAll('table tbody td')).toHaveLength(2)
  })

  it('有序列表里的子要点嵌在同一个 ol 里，编号是连续的', async () => {
    const dom = await render('1. 第一步\n   - 子要点\n2. 第二步\n\n')
    expect(dom.querySelectorAll('ol')).toHaveLength(1)
    expect(dom.querySelectorAll('ol > li')).toHaveLength(2)
    expect(dom.querySelector('ol > li > ul > li')?.textContent).toBe('子要点')
  })

  it('代码块与引用都有各自的结构', async () => {
    const dom = await render('```ts\nconst x = 1\n```\n\n> 引用一句\n\n')
    expect(dom.querySelector('pre code')?.textContent).toBe('const x = 1')
    expect(dom.querySelector('blockquote')?.textContent).toContain('引用一句')
  })

  it('流式中的尾行：已闭合的行内标记先变成元素，不再等换行', async () => {
    // 尾行还在增长，不能整块解析；但已经闭合的 `**…**` 必须先解析，
    // 否则标记会一直露在屏幕上直到换行为止。
    const dom = await render('前面已经写完的一句\n这是**重点**', true)
    expect(dom.querySelector('.stream-tail')).not.toBeNull()
    expect(dom.querySelector('.stream-tail strong')?.textContent).toBe('重点')
  })

  it('还没闭合的标记不发疯：宁可原样显示，也不吃字', async () => {
    // `**重点` 少一个星号时按纯文本显示。半个标记不能猜，猜错就是吞掉用户的内容。
    const dom = await render('前面一句\n这是**重点', true)
    expect(dom.textContent ?? '').toContain('这是**重点')
  })

  it('收流后不再挂流式类，避免每个增量重播淡入', async () => {
    const dom = await render('写完的一句\n最后一行', false)
    expect(dom.querySelector('.stream-tail')).toBeNull()
  })
})
