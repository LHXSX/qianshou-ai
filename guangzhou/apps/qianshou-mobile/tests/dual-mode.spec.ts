// @vitest-environment jsdom
/**
 * 手机端「独立对话 + 遥控器」两条能力共存的验收测试。
 *
 * 与 `app.spec.ts` 的分工：那份验证遥控投递（电脑可达时的既有行为）；这份验证
 * CEO 列出的验收场景——两边都在、能互相降级、空态不崩：
 * 1. 电脑**未配置或不可达**时，发消息走**本地对话**并渲染回复；
 * 2. 电脑**可达**时，发消息走**遥控投递**并显示投递状态；
 * 3. 从可达变不可达后，**对话仍可用**（降级不丢功能、不丢记录、不弹技术错误）；
 * 4. **空态渲染**：`LIVE_JOBS` 为空、`REGIONS` 无数值时界面不崩、不显示占位数字。
 *
 * 用 `.spec.ts` 而不是 `.spec.tsx`：仓库根 vitest 配置里手机端这一条 include 只收
 * `*.spec.ts`，所以这里用 `createElement` 写元素（`.ts` 不能写 JSX）。
 */
import { act, createElement, type FC, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { PcWindowHttpPort } from '@deepseek-ai/dsh-client-pc-window-bridge'
import { App, type AppProps } from '../src/App.tsx'
import { ChatController, type ChatSnapshot, type StreamChatFn } from '../src/chat.ts'
import type { ChatStream } from '../src/llm.ts'
import { LIVE_JOBS } from '../src/data.ts'
import { MemoryWindowJournalStore, PhoneWindowRuntime } from '../src/window-runtime.ts'
import { installStorage } from './storage.ts'

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
const OFFLINE = { state: 'offline', allowedActions: [] }

/** 本地模式的假服务商：不联网，一次性吐出可断言的回答。 */
const LOCAL_SETTINGS = { providerId: 'deepseek', baseUrl: 'https://local.test/v1', model: 'deepseek-chat' }
const LOCAL_SECRET = 'sk-local-test'
const LOCAL_REPLY = '这是这台手机自己给出的回答。'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 电脑可达的网关：bootstrap/access 在线，submit 返回已接收。 */
function onlineGateway(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/bootstrap')) return jsonResponse({ binding: BINDING, access: ONLINE })
    if (url.includes('/access')) return jsonResponse(ONLINE)
    if (url.includes('/submit')) {
      return jsonResponse({
        receipt: {
          requestId: 'req-1',
          origin: BINDING,
          revision: 1,
          state: 'received',
          reason: 'session-admitted',
          // dispatch 的 received 回执必须带子会话 id，否则连接层按
          // PC_WINDOW_MISSING_CHILD_RECEIPT 拒收——测试的假网关也要守这个契约，
          // 否则测出来的"已接收"在生产里根本走不到。
          childSessionId: 'session-child-1',
        },
      })
    }
    return jsonResponse({ binding: BINDING, fromCursor: null, nextCursor: 'qianshou.pc-window.cursor.v1:1', receipts: [], notReceivedIds: [] })
  }) as typeof fetch
}

/** 电脑存在但在线状态不可用（关机 / 换网络）：bootstrap 认领成功，access 判离线。 */
function unreachableGateway(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/bootstrap')) return jsonResponse({ binding: BINDING, access: OFFLINE })
    if (url.includes('/access')) return jsonResponse(OFFLINE)
    throw new Error(`电脑不可达时不该发出这个请求：${url}`)
  }) as typeof fetch
}

/** 可达之后掉线的网关：submit 直接失败，用来验证「从可达变不可达」。 */
function dropAfterSendGateway(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/bootstrap')) return jsonResponse({ binding: BINDING, access: ONLINE })
    if (url.includes('/access')) return jsonResponse(ONLINE)
    if (url.includes('/submit')) throw new Error('PC_WINDOW_TRANSPORT_FAILED')
    return jsonResponse({ binding: BINDING, fromCursor: null, nextCursor: 'qianshou.pc-window.cursor.v1:1', receipts: [], notReceivedIds: [] })
  }) as typeof fetch
}

interface FakeController {
  readonly controller: ChatController
  /** 每次本地调用累积的可断言痕迹；没走本地模型时保持为空。 */
  readonly calls: readonly string[]
}

/** 注入式假对话控制器：不联网、不打存储，回复内容可断言。 */
function fakeController(): FakeController {
  const calls: string[] = []
  const stream: StreamChatFn = (options, handlers): ChatStream => {
    calls.push(options.messages[options.messages.length - 1]?.content ?? '')
    // 异步交付而不是同步交付：真实 `streamChat` 的 `completed` 也是后到的，
    // 同步回调会让「正在回复」这一帧不被观察到，测出来的时序与生产不一致。
    const completed = Promise.resolve().then(() => {
      handlers.onDelta(LOCAL_REPLY)
      handlers.onDone()
    })
    return { abort: () => {}, completed }
  }
  const controller = new ChatController({
    settings: LOCAL_SETTINGS,
    secret: LOCAL_SECRET,
    sessions: [],
    // 生产用 `streamChat`；这里换成本地假实现，断言的是界面把回复渲染出来，
    // 传输层本身由 llm.spec.ts / integration.spec.ts 用真实 HTTP 覆盖。
    stream,
  })
  return { controller, calls }
}

let container: HTMLDivElement | undefined
let root: { render: (node: ReactElement) => void; unmount: () => void } | null = null

beforeEach(() => {
  // 存储桩方法齐全（含 clear），不再依赖别的测试文件漏在全局上的实现。
  installStorage()
})

afterEach(async () => {
  if (root !== null) await act(async () => { root!.unmount() })
  container?.remove()
  root = null
  container = undefined
  vi.unstubAllGlobals()
})

async function flush(rounds = 4): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

/**
 * 反复冲刷，直到条件成立。
 *
 * 投递结果由界面按 250ms 节拍跟进（`App` 里的投递跟进 effect），固定次数的
 * `flush` 读不到它；这里给真实时间与上限，超时就用当前状态断言失败，
 * 而不是伪造成通过。
 */
async function settle(check: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (check()) return
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)) })
    await flush(2)
  }
}

function byLabel(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  if (found === null) {
    const available = [...document.querySelectorAll('[aria-label]')].map(node => node.getAttribute('aria-label'))
    throw new Error(`找不到「${label}」；当前可用的 aria-label：${JSON.stringify(available)}`)
  }
  return found
}

async function mountApp(controller: ChatController, runtime?: PhoneWindowRuntime): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const mounted = createRoot(container)
  root = mounted
  // 显式写两个分支而不是先拼一个 props 对象：分支能同时覆盖「有运行时」和
  // 「没有运行时」，也让 `exactOptionalPropertyTypes` 下的可选属性保持精确。
  await act(async () => {
    mounted.render(runtime === undefined
      ? createElement(AppElement, { controller })
      : createElement(AppElement, { controller, runtime }))
  })
  await flush(6)
}

async function openRuntime(gateway: typeof fetch): Promise<PhoneWindowRuntime> {
  return PhoneWindowRuntime.open({
    port: new PcWindowHttpPort({ baseUrl: 'http://pc.test', fetch: gateway }),
    store: new MemoryWindowJournalStore(),
    deviceId: 'phone-test',
    sessionId: 'session-primary',
    now: () => 1_700_000_000_000,
    requestId: () => 'req-1' as SessionRequestId,
  })
}

/** 点一下首页的建议卡片，进到对话屏（输入框与发送按钮都在这一屏上）。 */
async function openChatScreen(): Promise<void> {
  const suggest = document.querySelector<HTMLElement>('.suggest')
  if (suggest === null) throw new Error('首页没有建议卡片，无法进入对话屏')
  await act(async () => { suggest.click() })
  await flush()
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
  await flush(8)
}

function body(): string {
  return container?.textContent ?? ''
}

describe('两条能力共存：独立对话 + 遥控器', () => {
  it('电脑不可达时，发消息走这台手机的本地对话并渲染回复', async () => {
    const fake = fakeController()
    const runtime = await openRuntime(unreachableGateway())
    await mountApp(fake.controller, runtime)

    // 电脑存在但判离线：界面不能假称已连接，也不能因此挡住对话入口。
    expect(runtime.snapshot().access).toBe('offline')
    expect(body()).toContain('电脑不可用，这台手机自己回答')

    await openChatScreen()
    await sendText('电脑关机了也要能说话')

    expect(fake.calls).toHaveLength(1)
    expect(body()).toContain('电脑关机了也要能说话')
    expect(body()).toContain(LOCAL_REPLY)
    // 没有派给电脑：发件箱必须还是空的。
    expect(runtime.snapshot().records).toHaveLength(0)
  })

  it('未配置电脑（没有窗口运行时）时，同一个入口照样走本地对话', async () => {
    const fake = fakeController()
    await mountApp(fake.controller)
    await openChatScreen()
    await sendText('这台手机独立可用')

    expect(fake.calls).toHaveLength(1)
    expect(body()).toContain(LOCAL_REPLY)
  })

  it('电脑可达时，发消息走遥控投递并显示投递状态', async () => {
    const fake = fakeController()
    const runtime = await openRuntime(onlineGateway())
    await mountApp(fake.controller, runtime)

    expect(runtime.snapshot().access).toBe('online')
    expect(body()).toContain('这条会派给电脑执行')

    await openChatScreen()
    await sendText('在电脑上继续')

    // 送达回执是异步的：等它从 queued 走到 received，再断言界面文字。
    await settle(() => runtime.snapshot().records[0]?.state === 'received')
    const records = runtime.snapshot().records
    expect(records).toHaveLength(1)
    expect(records[0]?.command.action).toEqual({ type: 'dispatch', text: '在电脑上继续' })
    expect(records[0]?.state).toBe('received')
    expect(body()).toContain('在电脑上继续')
    expect(body()).toContain('电脑已接收')
    // 遥控投递不代表本机也回答了一次：这条没走本地模型。
    expect(fake.calls).toHaveLength(0)
  })

  it('从可达变不可达后，对话仍可用：降级到本地、不丢记录、不弹技术错误', async () => {
    const fake = fakeController()
    const runtime = await openRuntime(dropAfterSendGateway())
    await mountApp(fake.controller, runtime)

    expect(body()).toContain('这条会派给电脑执行')
    await openChatScreen()

    // 第一条：界面以为电脑可达，投递失败 → 给出可读说明，这条改由手机回答，
    // 并且模式自动让回手机。
    await sendText('第一条发给电脑')
    await settle(() => runtime.snapshot().records[0]?.state === 'uncertain')
    expect(runtime.snapshot().records).toHaveLength(1)
    expect(runtime.snapshot().records[0]?.state).toBe('uncertain')
    expect(body()).toContain('电脑暂时不可用，这条改由手机回答')
    expect(body()).not.toContain('PC_WINDOW_TRANSPORT_FAILED')
    expect(body()).toContain('未能确认是否送到电脑')
    // 模式让回手机：这一条之后不再往电脑上继续派，但电脑如果恢复，入口还在
    // （模式条仍提供「改用电脑」），所以这里断言的是「已切回本地」而不是某个具体句子。
    expect(body()).toContain('这台手机回答；也可以派给电脑')

    // 第二条：同一屏、同一输入框继续说话，本地模型必须真的答出来。
    await sendText('第二条留在手机')
    await settle(() => body().includes(LOCAL_REPLY))
    expect(fake.calls).toHaveLength(1)
    expect(body()).toContain('第二条留在手机')
    expect(body()).toContain(LOCAL_REPLY)

    // 降级不清空：第一条的遥控记录还在，本地会话也已落盘。
    expect(runtime.snapshot().records).toHaveLength(1)
    const stored = globalThis.localStorage.getItem('qianshou.mobile.sessions.v1')
    expect(stored).not.toBeNull()
    expect(String(stored)).toContain('第二条留在手机')
  })

  it('空态渲染：LIVE_JOBS 为空、REGIONS 无数字段时，界面不崩也不显示占位数字', async () => {
    const fake = fakeController()
    await mountApp(fake.controller)
    const tasksTab = [...document.querySelectorAll<HTMLElement>('.tab')].find(tab => tab.textContent === '任务')
    if (tasksTab === undefined) throw new Error('底栏没有「任务」')
    await act(async () => { tasksTab.click() })
    await flush()
    // 任务屏现在有一个**自己的**调度入口（原先只能点任务卡进入，没有任务就进不去）。
    const entry = [...document.querySelectorAll<HTMLElement>('.model-card')]
      .find(node => (node.textContent ?? '').includes('算力调度'))
    if (entry === undefined) throw new Error('任务页没有「算力调度」入口')
    await act(async () => { entry.click() })
    await flush()

    expect(document.querySelector('.map-wrap')).not.toBeNull()
    expect(body()).toContain('全球节点实时调度')
    expect(body()).toContain('实时任务数据尚未接入')

    // 编造的数字（子任务 1,200 / 参与节点 856 / 在线节点 128,560 / 12.4s/帧 /
    // 00:08:32 / 整体进度 68%）一个都不许出现在这一屏上。
    expect(body()).not.toMatch(/1,200|856|128,?560|12\.4s|00:08:32|68%/)
    const regions = [...document.querySelectorAll('.region')].map(node => node.textContent ?? '')
    expect(regions).toHaveLength(5)
    for (const region of regions) expect(region).not.toMatch(/[0-9]/)
    expect(LIVE_JOBS).toHaveLength(0)
    expect(body()).toContain('实时任务数据还没有接上，这里暂时是空的。')
  })

  it('模式可手动切到手机：本地对话不因遥控就绪而消失，切换后同一条走本地模型', async () => {
    const fake = fakeController()
    const runtime = await openRuntime(onlineGateway())
    await mountApp(fake.controller, runtime)
    const snapshot: ChatSnapshot = fake.controller.snapshot()
    expect(snapshot.settings.model).toBe('deepseek-chat')
    // 电脑可达 → 模式条是遥控；输入框仍在屏上，说明本地能力没有被替换掉。
    expect(body()).toContain('这条会派给电脑执行')
    await openChatScreen()
    expect(document.querySelector('input')).not.toBeNull()

    // 用户点「改用手机」后，同一条消息走本地模型。
    await act(async () => { byLabel('改用手机').click() })
    await flush()
    expect(body()).toContain('这台手机回答；也可以派给电脑')
    await sendText('这条留在手机上')
    await settle(() => body().includes(LOCAL_REPLY))
    expect(fake.calls).toHaveLength(1)
    expect(body()).toContain(LOCAL_REPLY)
    expect(runtime.snapshot().records).toHaveLength(0)
  })
})
