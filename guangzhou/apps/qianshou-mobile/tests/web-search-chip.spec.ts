// @vitest-environment jsdom
/**
 * 「联网搜索」开关的界面验收测试：它必须在**请求层面**产生可观察的差异。
 *
 * 这一份测的是开关本身，不是搜索算法（算法在 `search.spec.ts` / `search-loop.spec.ts`）：
 * 1. 打开开关 + 电脑可达 → 这一条**改走电脑**：手机端一个请求都不发；
 * 2. 打开开关 + 电脑不可达 + DeepSeek → 走**手机自己的搜索循环**：发到 Anthropic
 *    兼容的 `/messages`，服务端把回合交回来时会真的再发一轮，中间状态与来源都上屏；
 * 3. 打开开关 + 电脑不可达 + 非 DeepSeek → **明说不支持**，仍走普通对话，绝不假装搜过；
 * 4. 打开开关但没有密钥 → 明说这次没联网，并给出"去填密钥"的引导。
 *
 * 用 `.spec.ts` 而不是 `.spec.tsx`：仓库根 vitest 配置里手机端这一条 include 只收
 * `*.spec.ts`，所以这里用 `createElement` 写元素。
 */
import { act, createElement, type FC, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { PcWindowHttpPort } from '@deepseek-ai/dsh-client-pc-window-bridge'
import { App, type AppProps } from '../src/App.tsx'
import { ChatController, type StreamChatFn } from '../src/chat.ts'
import type { ChatStream } from '../src/llm.ts'
import { zh } from '../src/copy.ts'
import { MemoryWindowJournalStore, PhoneWindowRuntime } from '../src/window-runtime.ts'
import { installStorage } from './storage.ts'

const AppElement: FC<AppProps> = App

const BINDING = {
  accountId: 'local-owner',
  pcId: 'this-pc',
  sessionId: 'session-primary',
  sourceDeviceId: 'phone-test',
}
const ONLINE = { state: 'online', allowedActions: ['dispatch', 'append', 'cancel'] }
const OFFLINE = { state: 'offline', allowedActions: [] }

const SETTINGS_KEY = 'qianshou.mobile.connection.v1'
const SECRET_KEY = 'qianshou.mobile.secret.v1'

/** 记录一次本机流的调用；用来证明"这条没有走手机"。 */
interface LocalCalls {
  readonly controller: ChatController
  readonly calls: readonly string[]
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

/** 电脑可达的网关（与 dual-mode 用同一套契约）。 */
function onlineGateway(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/bootstrap')) return jsonResponse({ binding: BINDING, access: ONLINE })
    if (url.includes('/access')) return jsonResponse(ONLINE)
    if (url.includes('/submit')) {
      return jsonResponse({
        receipt: {
          requestId: 'req-1', origin: BINDING, revision: 1, state: 'received',
          reason: 'session-admitted', childSessionId: 'session-child-1',
        },
      })
    }
    return jsonResponse({ binding: BINDING, fromCursor: null, nextCursor: 'qianshou.pc-window.cursor.v1:1', receipts: [], notReceivedIds: [] })
  }) as typeof fetch
}

/** 电脑存在但不可达：认领成功、判离线。 */
function offlineGateway(): typeof fetch {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/bootstrap')) return jsonResponse({ binding: BINDING, access: OFFLINE })
    if (url.includes('/access')) return jsonResponse(OFFLINE)
    throw new Error(`电脑不可达时不该发出这个请求：${url}`)
  }) as typeof fetch
}

/** 注入式假对话控制器：不联网、不打存储，但会像真流一样收尾。 */
function fakeController(providerId = 'deepseek'): LocalCalls {
  const calls: string[] = []
  const stream: StreamChatFn = (options, handlers): ChatStream => {
    calls.push(options.messages[options.messages.length - 1]?.content ?? '')
    // 异步交付而不是同步交付：真实 `streamChat` 的收尾也是后到的，同步回调会让
    // "正在回复"这一帧根本不存在，测出来的时序与生产不一致。
    const completed = Promise.resolve().then(() => {
      handlers.onDelta('本机回答')
      handlers.onDone()
    })
    return { abort: () => {}, completed }
  }
  const controller = new ChatController({
    settings: { providerId, baseUrl: 'https://local.test/v1', model: 'deepseek-chat' },
    secret: 'sk-local-test',
    sessions: [],
    stream,
  })
  return { controller, calls }
}

/** 一个可以逐段推送的 SSE 响应：中间状态只有在真的能分段时才观察得到。 */
function streamingResponse(): {
  readonly response: Response
  readonly push: (text: string) => void
  readonly close: () => void
} {
  const encoder = new TextEncoder()
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined
  const stream = new ReadableStream<Uint8Array>({ start(next) { controller = next } })
  return {
    response: new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    push: (text) => { controller?.enqueue(encoder.encode(text)) },
    close: () => { controller?.close() },
  }
}

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 第一轮：服务端发起搜索并把这个回合交回客户端。 */
const PAUSE_WITH_TOOL = [
  frame({ type: 'content_block_start', index: 0, content_block: { type: 'server_tool_use', id: 'srv-1', name: 'web_search' } }),
  frame({ type: 'message_delta', delta: { stop_reason: 'pause_turn' } }),
  frame({ type: 'message_stop' }),
].join('')

/** 第二轮前半：搜索结果到手。 */
const RESULTS = frame({
  type: 'content_block_start',
  index: 0,
  content_block: {
    type: 'web_search_tool_result',
    tool_use_id: 'srv-1',
    content: [
      { type: 'web_search_result', url: 'https://news.test/a', title: '甲报道' },
      { type: 'web_search_result', url: 'https://news.test/b', title: '乙报道' },
    ],
  },
})

/** 第二轮后半：最终回答。 */
const ANSWERING = [
  frame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
  frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '联网查到：' } }),
  frame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '今天有两条新消息。' } }),
  frame({ type: 'message_delta', delta: { stop_reason: 'end_turn' } }),
  frame({ type: 'message_stop' }),
].join('')

/** 普通对话（OpenAI 兼容）的一条流式回复。 */
function completionsSse(): string {
  return [
    frame({ choices: [{ delta: { content: '这是普通回答。' } }] }),
    'data: [DONE]\n\n',
  ].join('')
}

/** 记录了全部出网请求的 fetch 假实现。 */
interface RecordedRequest {
  readonly url: string
  readonly body: string
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

async function flush(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve() })
  }
}

function byLabel(label: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[aria-label="${label}"]`)
  if (found === null) throw new Error(`找不到「${label}」`)
  return found
}

/** 按显示文字找输入框上方的功能开关。 */
function chip(label: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('.chip')].find(node => node.textContent?.trim() === label)
  if (found === undefined) throw new Error(`找不到开关「${label}」`)
  return found
}

async function click(node: HTMLElement): Promise<void> {
  await act(async () => { node.click() })
  await flush()
}

async function mount(props: AppProps): Promise<void> {
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const mounted = createRoot(container)
  root = mounted
  await act(async () => { mounted.render(createElement(AppElement, { ...props })) })
  await flush()
}

/** 点建议卡片进对话屏：输入框与发送按钮都在那一屏上。 */
async function openChatScreen(): Promise<void> {
  const suggest = document.querySelector<HTMLElement>('.suggest')
  if (suggest === null) throw new Error('首页没有建议卡片')
  await click(suggest)
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

async function sendText(value: string): Promise<void> {
  const input = document.querySelector('input')
  if (input === null) throw new Error('找不到输入框')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush(2)
  await act(async () => { byLabel('发送').click() })
  await flush(4)
}

function body(): string {
  return container?.textContent ?? ''
}

function statusLine(): string {
  return document.querySelector('.status-line')?.textContent ?? ''
}

/** 预置「这台手机自己的模型」配置，等价于用户已在设置页填好。 */
function seedConnection(providerId: string, withKey: boolean): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    providerId, baseUrl: 'https://local.test/v1', model: 'deepseek-chat',
  }))
  if (withKey) localStorage.setItem(SECRET_KEY, JSON.stringify({ key: 'sk-user-key' }))
}

/** 装一个只在手机侧出网的 fetch：Anthropic 端与 OpenAI 端各记一笔。 */
function phoneOnlyFetch(plan: { messages: () => Response; completions: () => Response }): {
  readonly fetchImpl: typeof fetch
  readonly requests: readonly RecordedRequest[]
} {
  const requests: RecordedRequest[] = []
  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    requests.push({ url, body: typeof init?.body === 'string' ? init.body : '' })
    if (url.endsWith('/messages')) return plan.messages()
    if (url.endsWith('/chat/completions')) return plan.completions()
    throw new Error(`没预料到的请求：${url}`)
  }) as unknown as typeof fetch
  return { fetchImpl, requests }
}

describe('开关打开 + 电脑可达：这一条改走电脑，手机端一个请求都不发', () => {
  it('同一条输入，开关关时走手机、开关开时走电脑', async () => {
    const fake = fakeController()
    const runtime = await openRuntime(onlineGateway())
    await mount({ controller: fake.controller, runtime })
    await openChatScreen()
    // 用户显式选了"这台手机回答"：没有开关时，这条就该留在手机上。
    await click(byLabel(zh.modeUseLocal))

    await sendText('第一条：没有联网搜索')
    expect(fake.calls).toHaveLength(1)
    expect(runtime.snapshot().records).toHaveLength(0)

    await click(chip(zh.webSearch))
    // 开关一打开，界面立刻说清楚这条会怎么走——不是发出去之后才知道。
    expect(body()).toContain(zh.searchBarRemote)

    await sendText('第二条：打开联网搜索')
    // 请求层面真的不同：这一条进了电脑的发件箱，手机端的流一次都没有被调用。
    expect(runtime.snapshot().records).toHaveLength(1)
    expect(runtime.snapshot().records[0]?.command.action).toEqual({ type: 'dispatch', text: '第二条：打开联网搜索' })
    expect(fake.calls).toHaveLength(1)
  })

  it('开关关着时界面不留去向说明，也不影响原有的模式条行为', async () => {
    const fake = fakeController()
    const runtime = await openRuntime(onlineGateway())
    await mount({ controller: fake.controller, runtime })
    await openChatScreen()
    expect(document.querySelector('.search-note')).toBeNull()
    // 默认遥控：电脑可达且用户没改成手机，这条照旧派给电脑。
    await sendText('默认派给电脑')
    expect(runtime.snapshot().records).toHaveLength(1)
    expect(fake.calls).toHaveLength(0)
  })
})

describe('开关打开 + 电脑不可达 + DeepSeek：走手机自己的搜索循环', () => {
  it('发到 Anthropic 兼容的 /messages，服务端交回时会真的再发一轮，状态与来源都上屏', async () => {
    seedConnection('deepseek', true)
    const runtime = await openRuntime(offlineGateway())
    const roundOne = streamingResponse()
    const roundTwo = streamingResponse()
    let round = 0
    const { fetchImpl, requests } = phoneOnlyFetch({
      messages: () => {
        round += 1
        return round === 1 ? roundOne.response : roundTwo.response
      },
      completions: () => new Response(completionsSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    vi.stubGlobal('fetch', fetchImpl)

    await mount({ runtime })
    await openChatScreen()
    await click(chip(zh.webSearch))
    expect(body()).toContain(zh.searchBarPhone)

    await sendText('今天有什么新闻？')
    // 第一轮已经发出，还没结果：状态行说的是"正在搜索"，不是笼统的"正在回复"。
    expect(requests.map(request => request.url)).toEqual(['https://local.test/anthropic/v1/messages'])
    expect(statusLine()).toBe(zh.searchSearching)

    // 服务端把回合交回来：循环必须**再发一轮**，并把第一轮的助手内容原样带回。
    roundOne.push(PAUSE_WITH_TOOL)
    roundOne.close()
    await flush(8)
    expect(requests).toHaveLength(2)
    const secondBody = JSON.parse(requests[1]?.body ?? '{}') as { messages?: { role: string; content: unknown }[] }
    expect(secondBody.messages?.filter(message => message.role === 'assistant')).toEqual([
      { role: 'assistant', content: [{ type: 'server_tool_use', id: 'srv-1', name: 'web_search' }] },
    ])
    expect(statusLine()).toBe(zh.searchSearching)

    // 搜索结果到手：换到"正在整理"，并把**真实**来源条数显示出来。
    roundTwo.push(RESULTS)
    await flush(8)
    expect(statusLine()).toBe(zh.searchReading)
    expect(body()).toContain(zh.searchSources.replace('{n}', '2'))
    expect(body()).toContain('news.test')

    roundTwo.push(ANSWERING)
    await flush(8)
    expect(body()).toContain('联网查到：今天有两条新消息。')

    roundTwo.close()
    await flush(8)
    // 收尾干净：状态回到"就绪"，发送按钮回来，来源仍然留在屏幕上可核对。
    expect(statusLine()).toBe(zh.idle)
    expect(byLabel(zh.send)).toBeTruthy()
    expect(body()).toContain(zh.searchSources.replace('{n}', '2'))
    // 走的是搜索循环，不是普通对话：整场没有一条 /chat/completions。
    expect(requests.every(request => request.url.endsWith('/messages'))).toBe(true)
  })

  it('同一个配置下关掉开关：走普通对话，一个 /messages 都不发', async () => {
    seedConnection('deepseek', true)
    const runtime = await openRuntime(offlineGateway())
    const { fetchImpl, requests } = phoneOnlyFetch({
      messages: () => { throw new Error('开关关着时不该发搜索请求') },
      completions: () => new Response(completionsSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    vi.stubGlobal('fetch', fetchImpl)

    await mount({ runtime })
    await openChatScreen()
    await sendText('没有联网搜索的普通问题')

    expect(requests.map(request => request.url)).toEqual(['https://local.test/v1/chat/completions'])
    expect(body()).toContain('这是普通回答。')
    expect(document.querySelector('.search-sources')).toBeNull()
    expect(statusLine()).toBe(zh.idle)
  })
})

describe('开关打开但手机也搜不了：明说，而不是静默失败', () => {
  it('非 DeepSeek 服务商：说明这次不联网，仍按普通对话回答', async () => {
    seedConnection('custom', true)
    const runtime = await openRuntime(offlineGateway())
    const { fetchImpl, requests } = phoneOnlyFetch({
      messages: () => { throw new Error('不支持的服务商不该发出搜索请求') },
      completions: () => new Response(completionsSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    vi.stubGlobal('fetch', fetchImpl)

    await mount({ runtime })
    await openChatScreen()
    await click(chip(zh.webSearch))

    // 明确说明：当前服务商不支持手机端联网搜索，这条可能不含最新信息。
    expect(body()).toContain(zh.searchBarUnsupported)
    expect(document.querySelector('.search-note')?.className).not.toContain('on')

    await sendText('自定义网关也能问问题')
    expect(requests.map(request => request.url)).toEqual(['https://local.test/v1/chat/completions'])
    expect(body()).toContain('这是普通回答。')
    // 没搜过就不许出现来源那一行。
    expect(document.querySelector('.search-sources')).toBeNull()
    expect(body()).not.toContain(zh.searchSources.replace('{n}', '0'))
  })

  it('DeepSeek 但没有密钥：说明这次没联网，并给出"去填密钥"的引导', async () => {
    seedConnection('deepseek', false)
    const runtime = await openRuntime(offlineGateway())
    const { fetchImpl, requests } = phoneOnlyFetch({
      messages: () => { throw new Error('没有密钥时不该发出搜索请求') },
      completions: () => new Response(completionsSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } }),
    })
    vi.stubGlobal('fetch', fetchImpl)

    await mount({ runtime })
    await openChatScreen()
    await click(chip(zh.webSearch))
    expect(body()).toContain(zh.searchBarOffline)

    await sendText('缺密钥时的问题')
    expect(requests).toHaveLength(0)
    expect(body()).toContain('还没有填密钥')
    expect(document.querySelector('.failure')).not.toBeNull()
  })
})
