// @vitest-environment jsdom
/**
 * 手机端界面接到电脑窗口运行时：发送进入 PcWindow 队列，状态页显示电脑连接。
 *
 * 用 `.spec.ts` 而不是 `.spec.tsx`：仓库根 vitest 配置里手机端这一条 include 只收
 * `*.spec.ts`，所以这里用 `createElement` 写元素。
 */
import { act, createElement, type FC, type ReactElement } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { PcWindowHttpPort } from '@deepseek-ai/dsh-client-pc-window-bridge'
import { App, type AppProps } from '../src/App.tsx'
import { MemoryWindowJournalStore, PhoneWindowRuntime } from '../src/window-runtime.ts'

/**
 * 收窄成 `FC<AppProps>` 之后再 `createElement`。
 *
 * `AppProps` 的属性全是可选的，而 `createElement` 对函数组件的重载要求
 * `Attributes & P`；直接传 `App` 时重载解析会落到 DOM 那一支并报
 * 「没有共同属性」。标注一次就消除了这个歧义，且不改动任何被断言的类型。
 */
const AppElement: FC<AppProps> = App

const BINDING = {
  accountId: 'local-owner',
  pcId: 'this-pc',
  sessionId: 'session-primary',
  sourceDeviceId: 'phone-test',
}
const ONLINE = { state: 'online', allowedActions: ['dispatch', 'append', 'cancel'] }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function mockGateway(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/bootstrap')) return jsonResponse({ binding: BINDING, access: ONLINE })
    if (url.includes('/access')) return jsonResponse(ONLINE)
    if (url.includes('/submit')) {
      return jsonResponse({
        receipt: {
          requestId: 'req-ui-1', origin: BINDING, revision: 1, state: 'received', reason: 'session-admitted',
        },
      })
    }
    return jsonResponse({
      binding: BINDING, fromCursor: null, nextCursor: 'qianshou.pc-window.cursor.v1:1', receipts: [], notReceivedIds: [],
    })
  }) as typeof fetch
}

let container: HTMLDivElement | undefined
let root: { render: (node: ReactElement) => void; unmount: () => void } | null = null

afterEach(async () => {
  if (root !== null) await act(async () => { root!.unmount() })
  container?.remove()
  vi.unstubAllGlobals()
})

async function flush(rounds = 3): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

function appElement(props: AppProps): ReactElement {
  return createElement(AppElement, { ...props })
}

function byLabel(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  if (found === null) {
    const available = [...document.querySelectorAll('[aria-label]')].map(node => node.getAttribute('aria-label'))
    throw new Error(`找不到「${label}」；当前可用的 aria-label：${JSON.stringify(available)}`)
  }
  return found
}

async function mount(): Promise<PhoneWindowRuntime> {
  const runtime = await PhoneWindowRuntime.open({
    port: new PcWindowHttpPort({ baseUrl: 'http://pc.test', fetch: mockGateway() }),
    store: new MemoryWindowJournalStore(),
    deviceId: 'phone-test',
    now: () => 1_700_000_000_000,
    requestId: () => 'req-ui-1' as SessionRequestId,
  })
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const mounted = createRoot(container)
  root = mounted
  await act(async () => { mounted.render(appElement({ runtime })) })
  await flush()
  return runtime
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => { node.click() })
  await flush()
}

async function type(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush()
}

describe('composer delivers to the PC window runtime', () => {
  it('sends composer text as a PC dispatch and shows the delivery label', async () => {
    const runtime = await mount()
    const input = document.querySelector('input')
    if (input === null) throw new Error('找不到输入框')
    await type(input, '在电脑上继续')
    await click(byLabel('发送'))
    await flush(6)
    expect(runtime.snapshot().records).toHaveLength(1)
    expect(container!.textContent).toContain('在电脑上继续')
  })

  it('opens the PC connection settings from the status chip', async () => {
    await mount()
    await click(byLabel('选择模型'))
    await click(document.querySelector('.picker-more') as HTMLElement)
    expect(container!.textContent).toContain('电脑连接')
    expect(container!.textContent).toContain('重新连接')
  })
})
