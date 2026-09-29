// @vitest-environment jsdom
/**
 * 流式状态与渲染的验收测试：相位分流、停止的收尾、以及"每个增量只动尾行"。
 *
 * 与 `dual-mode.spec.ts` 的分工：那份验证"独立对话 + 遥控器"两条能力共存；
 * 这份验证对话本身的**观感与开销**——用可手动驱动的假流精确控制每一帧：
 * 1. 相位按 `thinking → replying → idle` 走，三种状态在界面上各有各的文案；
 * 2. 用户按停止后，半截回答**保留**，且**不出现错误样式**；
 * 3. 长回复流式追加时，已定稿的行块不随每个增量重渲染（`memo` 命中）；
 * 4. `prefers-reduced-motion` 下没有无限动画（样式表兜底覆盖了每个动画类）。
 *
 * 用 `.spec.ts` 而不是 `.spec.tsx`：仓库根 vitest 配置里手机端这一条 include 只收
 * `*.spec.ts`，所以这里用 `createElement` 写元素。
 */
import { act, createElement, Profiler, type FC, type ReactElement } from 'react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { App, SettledLines, settledRenderCount, type AppProps } from '../src/App.tsx'
import { ChatController, type ChatPhase, type StreamChatFn } from '../src/chat.ts'
import { ChatFailure, FAILURE_COPY, type SendOptions, type StreamHandlers } from '../src/llm.ts'
import { installStorage } from './storage.ts'

const AppElement: FC<AppProps> = App

const READY = { providerId: 'deepseek', baseUrl: 'https://local.test/v1', model: 'deepseek-chat' }

/** 一次被捕获的建流：测试自己决定什么时候吐字、什么时候收尾或失败。 */
interface CapturedStream {
  readonly options: SendOptions
  readonly handlers: StreamHandlers
}

/**
 * 可手动驱动的假流。
 *
 * 与 `dual-mode.spec.ts` 里"立刻回完"的假流不同，这里把回调留给测试，
 * 因此能停在"已发出请求、还没吐第一个字"的那一帧上——这正是 `thinking`
 * 与 `replying` 的分界，也是界面最容易被做丢的一帧。
 */
function manualStream(): { stream: StreamChatFn; captured: CapturedStream[] } {
  const captured: CapturedStream[] = []
  const stream: StreamChatFn = (options, handlers) => {
    captured.push({ options, handlers })
    return {
      // 真实 `streamChat` 被中止时也是走 onError('aborted')，这里照抄同一路径。
      abort: () => { handlers.onError(new ChatFailure('aborted', FAILURE_COPY.aborted)) },
      completed: Promise.resolve(),
    }
  }
  return { stream, captured }
}

let container: HTMLDivElement | undefined
let root: { render: (node: ReactElement) => void; unmount: () => void } | null = null

beforeEach(() => { installStorage() })

afterEach(async () => {
  if (root !== null) await act(async () => { root!.unmount() })
  container?.remove()
  root = null
  container = undefined
})

async function flush(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

function byLabel(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  if (found === null) throw new Error(`找不到「${label}」`)
  return found
}

/** 挂载并进入对话屏；返回建流句柄，测试用它逐帧驱动。 */
async function openChat(stream: StreamChatFn): Promise<{ controller: ChatController; captured: CapturedStream[] }> {
  const captured: CapturedStream[] = []
  const wrapped: StreamChatFn = (options, handlers) => {
    const handle = stream(options, handlers)
    captured.push({ options, handlers })
    return handle
  }
  const controller = new ChatController({ settings: READY, secret: 'sk-test', sessions: [], stream: wrapped })
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const mounted = createRoot(container)
  root = mounted
  await act(async () => { mounted.render(createElement(AppElement, { controller })) })
  await flush(6)
  const suggest = document.querySelector<HTMLElement>('.suggest')
  if (suggest === null) throw new Error('首页没有建议卡片')
  await act(async () => { suggest.click() })
  await flush()
  return { controller, captured }
}

async function sendText(value: string): Promise<void> {
  const input = document.querySelector('input')
  if (input === null) throw new Error('找不到输入框')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
  await act(async () => { byLabel('发送').click() })
  await flush(2)
}

function statusLine(): string {
  return document.querySelector('.status-line')?.textContent ?? ''
}

function body(): string {
  return container?.textContent ?? ''
}

/**
 * 取出一个 CSS at-block 的完整内容（含嵌套规则）。
 *
 * 不能用 `\{[^}]*\}`：它会在第一个 `}` 就停住，于是一条被子规则刚好"看起来
 * 已覆盖"的样式表也能骗过断言——这正是这个测试要防的事。
 * @param css - 样式表原文。
 * @param header - at-block 的头部，例如 `@media (prefers-reduced-motion: reduce)`。
 * @returns 花括号内的内容；找不到该块时返回空串。
 */
function mediaBlock(css: string, header: string): string {
  const start = css.indexOf(`${header} {`)
  if (start === -1) return ''
  let depth = 0
  for (let index = css.indexOf('{', start); index < css.length; index += 1) {
    if (css[index] === '{') depth += 1
    else if (css[index] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(start, index + 1)
    }
  }
  return ''
}

describe('流式状态：相位、收尾与渲染开销', () => {
  it('相位按 thinking → replying → idle 走，界面文案逐档跟上', async () => {
    const { stream, captured } = manualStream()
    const { controller } = await openChat(stream)

    expect(controller.snapshot().phase).toBe('idle')
    await sendText('给我一段长回答')
    // 请求已发出、一个字都还没来：这是最容易被做丢的一帧。
    expect(controller.snapshot().phase).toBe('thinking')
    expect(statusLine()).toBe('思考中')
    expect(document.querySelectorAll('.thinking-dots i')).toHaveLength(3)
    expect(document.querySelector('.caret')).toBeNull()

    await act(async () => { captured[0]?.handlers.onDelta('第一段') })
    expect(controller.snapshot().phase).toBe('replying')
    expect(statusLine()).toBe('正在回复…')
    // 已经在吐字：光标出现，动态指示收起。
    expect(document.querySelector('.caret')).not.toBeNull()
    expect(document.querySelector('.thinking-dots')).toBeNull()

    await act(async () => { captured[0]?.handlers.onDone() })
    expect(controller.snapshot().phase).toBe('idle')
    expect(statusLine()).toBe('就绪')
    expect(document.querySelector('.caret')).toBeNull()
  })

  it('上一轮失败之后重新发送时，界面显示的是"正在回复"而不是上一条错误', async () => {
    const { stream, captured } = manualStream()
    const { controller } = await openChat(stream)

    await sendText('第一条')
    await act(async () => {
      captured[0]?.handlers.onError(new ChatFailure('server-error', FAILURE_COPY['server-error']))
    })
    await flush()
    expect(controller.snapshot().phase).toBe('failed')
    expect(body()).toContain(FAILURE_COPY['server-error'])

    // 第二条：failure 还没被清掉，但相位必须跟着新一轮的收流状态走。
    await sendText('第二条')
    expect(controller.snapshot().phase).toBe('thinking')
    expect(body()).not.toContain(FAILURE_COPY['server-error'])
    expect(statusLine()).toBe('思考中')

    await act(async () => { captured[1]?.handlers.onDelta('这次好了') })
    expect(controller.snapshot().phase).toBe('replying')
    expect(statusLine()).toBe('正在回复…')
  })

  it('用户按停止：半截回答保留、状态是"已停止"、且没有错误样式', async () => {
    const { stream, captured } = manualStream()
    const { controller } = await openChat(stream)

    await sendText('写一半就停')
    await act(async () => { captured[0]?.handlers.onDelta('这是已经到达的半截回答') })
    expect(statusLine()).toBe('正在回复…')

    await act(async () => { byLabel('停止').click() })
    await flush()

    expect(controller.snapshot().phase).toBe('aborted')
    const phase: ChatPhase = controller.snapshot().phase
    expect(phase).toBe('aborted')
    // 半截文字不能被清掉。
    expect(body()).toContain('这是已经到达的半截回答')
    expect(statusLine()).toBe('已停止')
    // 停止不是失败：没有错误块、没有错误色、没有失败文案。
    expect(document.querySelector('.failure')).toBeNull()
    expect(document.querySelector('.status-line')?.className).not.toContain('failed')
    expect(body()).not.toContain(FAILURE_COPY.aborted)
  })

  it('失败时保留已经到达的文字，错误另起一条提示而不是覆盖正文', async () => {
    const { stream, captured } = manualStream()
    await openChat(stream)

    await sendText('写一半就断')
    await act(async () => { captured[0]?.handlers.onDelta('已经到达的开头') })
    await act(async () => {
      captured[0]?.handlers.onError(new ChatFailure('network', FAILURE_COPY.network))
    })
    await flush()

    expect(body()).toContain('已经到达的开头')
    const failure = document.querySelector('.failure')
    expect(failure).not.toBeNull()
    expect(failure?.textContent).toContain(FAILURE_COPY.network)
    // 正文与错误提示是两个节点：错误没有把气泡内容顶掉。
    expect(document.querySelector('.msg .answer')?.textContent).toContain('已经到达的开头')
  })

  it('长回复流式追加时，已定稿的行块不随每个增量重渲染', async () => {
    const { stream, captured } = manualStream()
    await openChat(stream)

    const lines = ['一、先看问题', '二、再看约束', '三、最后给方案']
    const reply = lines.join('\n')
    settledRenderCount.value = 0
    await sendText('长一点')
    await act(async () => { captured[0]?.handlers.onDelta('') })
    const before = settledRenderCount.value
    expect(before).toBeGreaterThan(0)

    // 逐字送达：38 个增量、只跨过 2 个换行。
    for (const char of reply) {
      await act(async () => { captured[0]?.handlers.onDelta(char) })
    }
    const renders = settledRenderCount.value - before

    expect(body()).toContain('三、最后给方案')
    // 关键断言：定稿行的重渲染次数跟着**换行数**走，而不是跟着增量数走。
    expect(renders).toBeLessThanOrEqual(lines.length)
    expect(renders).toBeLessThan(reply.length / 4)
  })

  it('memo 命中：文本没变时已定稿块不渲染，文本变了才渲染一次', async () => {
    container = document.createElement('div')
    document.body.append(container)
    const { createRoot } = await import('react-dom/client')
    ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const mounted = createRoot(container)
    root = mounted
    const commits: string[] = []
    const tree = (text: string): ReactElement => createElement(
      Profiler,
      { id: 'settled', onRender: () => { commits.push(text) } },
      createElement(SettledLines, { text }),
    )

    settledRenderCount.value = 0
    await act(async () => { mounted.render(tree('第一行\n第二行')) })
    const first = settledRenderCount.value
    expect(first).toBeGreaterThan(0)

    // 同样的文本：memo 命中，组件体不再执行。
    await act(async () => { mounted.render(tree('第一行\n第二行')) })
    expect(settledRenderCount.value).toBe(first)

    // 文本变化：渲染一次。
    await act(async () => { mounted.render(tree('第一行\n第二行\n第三行')) })
    expect(settledRenderCount.value).toBe(first + 1)
    expect(container.textContent).toContain('第三行')
  })

  it('prefers-reduced-motion 覆盖了每一个无限动画类，且界面不用内联动画绕过它', async () => {
    const { stream, captured } = manualStream()
    await openChat(stream)
    await sendText('让它停在思考中')
    expect(document.querySelector('.thinking-dots')).not.toBeNull()

    // 界面这一侧：不许有任何元素用内联 animation 绕过样式表。
    const inlineAnimated = [...document.querySelectorAll<HTMLElement>('[style]')]
      .filter(node => node.style.animation !== '' || node.style.animationName !== '')
    expect(inlineAnimated).toHaveLength(0)

    // 样式表这一侧：每个会无限动的类都要在减少动效块里被关掉。
    // 这个文件跑在默认（node）环境里，vitest 会把 `import.meta.url` 换成 http 协议，
    // 不能直接喂给 readFileSync。所以按两个候选路径找：从包目录跑、从仓库根跑都在其中。
    // 用"能读到"作为判据，而不是猜当前工作目录——猜错就变成"文件不存在"的假失败。
    const candidates = [
      resolve(process.cwd(), 'src/styles.css'),
      resolve(process.cwd(), 'apps/qianshou-mobile/src/styles.css'),
    ]
    const stylesPath = candidates.find(candidate => existsSync(candidate))
    if (stylesPath === undefined) throw new Error(`找不到样式表，试过：${candidates.join('、')}`)
    const css = readFileSync(stylesPath, 'utf8')
    const reduced = mediaBlock(css, '@media (prefers-reduced-motion: reduce)')
    expect(reduced.length).toBeGreaterThan(0)
    for (const selector of ['.caret', '.status-swap', '.thinking-dots i']) {
      expect(reduced).toContain(selector)
    }
    expect(reduced).toContain('animation: none')
    void captured
  })
})
