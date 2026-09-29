// @vitest-environment jsdom
/**
 * 订阅通道在界面上的接线测试：**启用条件、额度显示、降级提示、错误提示**。
 *
 * 这一份测的是"用户能不能看到、请求到底打到哪"，不是协议解析（那在 `subscription.spec.ts`）：
 * 1. 同源 + 有账号 → 默认走订阅通道：请求打到 `/api/qianshou/ai/chat`，**不带任何密钥**，
 *    模型名是前台名「千手·迅捷」；剩余点数读得到就显示，读不到就说读不到。
 * 2. 降级必须让用户看见：`downgradeNote` 挂在回复下方。
 * 3. 402 / 429 给的是**可行动**的提示（升级档位 / 稍等几秒），不是一句"失败了"。
 * 4. 非同源（配对/遥控形态）→ **一个订阅请求都不发**，照旧走自带密钥；
 *    设置页如实说"订阅通道需要同源部署"。
 * 5. 用户仍可在设置里显式选通道，切回 BYOK 后请求打回用户自己的端点。
 *
 * 用 `.spec.ts` 而不是 `.spec.tsx`：仓库根 vitest 配置里手机端这一条 include 只收
 * `*.spec.ts`，所以这里用 `createElement` 写元素。
 */
import { act, createElement, type FC, type ReactElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionRequestId } from '@deepseek-ai/dsh-api-session-controller/types'
import { PcWindowHttpPort } from '@deepseek-ai/dsh-client-pc-window-bridge'
import { App, type AppProps } from '../src/App.tsx'
import { zh } from '../src/copy.ts'
import { MemoryWindowJournalStore, PhoneWindowRuntime } from '../src/window-runtime.ts'
import { installStorage, type StorageStub } from './storage.ts'

const AppElement: FC<AppProps> = App

const AI_CHAT = '/api/qianshou/ai/chat'
const AI_STATUS = '/api/qianshou/ai/status'
const HOST_STATE = '/api/qianshou/account/state'
const SETTINGS_KEY = 'qianshou.mobile.connection.v1'
const SECRET_KEY = 'qianshou.mobile.secret.v1'
const SUBSCRIPTION_KEY = 'qianshou.mobile.subscription.v1'
const ROUTE_KEY = 'qianshou.mobile.route.v1'
const ACCOUNT_KEY = 'qianshou.mobile.account.profile.v1'
const BYOK_ENDPOINT = 'https://local.test/v1/chat/completions'

const BINDING = {
  accountId: 'local-owner',
  pcId: 'this-pc',
  sessionId: 'session-primary',
  sourceDeviceId: 'phone-test',
}
const OFFLINE = { state: 'offline', allowedActions: [] }

/** 一次被记下来的出网请求。 */
interface Recorded {
  readonly url: string
  readonly method: string
  readonly body: string
}

/** 造一帧网关 SSE。 */
function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`
}

/** 一条成功的订阅回复；默认不降级、扣 0.07 点。 */
function doneFrame(overrides: Record<string, unknown> = {}): string {
  return frame({
    type: 'done',
    model: '千手·迅捷',
    requestedModel: '千手·迅捷',
    chargedSp: 0.07,
    downgraded: false,
    usageSource: 'provider',
    credit: { remainingMonthlySp: 388.5, usedInWindowSp: 0.07 },
    ...overrides,
  })
}

/**
 * 出网替身。
 *
 * 认得出每条路径**分别是什么**（宿主账号面 / 订阅网关 / 用户自己的端点 / 版本探测），
 * 认不出的直接抛错——否则"这个请求不该发出来"这类断言就永远查不出来。
 */
function stubNetwork(options: {
  readonly chatFrames: readonly string[]
  readonly hostState?: 'authenticated' | 'signed-out'
  readonly tier?: { readonly id: string; readonly label: string }
  readonly remainingSp?: number
}): { readonly fetch: typeof fetch; readonly requests: Recorded[] } {
  const requests: Recorded[] = []
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push({ url, method: init?.method ?? 'GET', body: typeof init?.body === 'string' ? init.body : '' })
    const json = (value: unknown, status = 200): Response =>
      new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
    if (url === HOST_STATE) {
      return json({ ok: true, state: options.hostState ?? 'authenticated', account: { id: 7, username: '用户' } })
    }
    if (url === AI_STATUS) {
      return json({
        ok: true,
        tier: options.tier ?? { id: 'plus', label: '高级版' },
        credit: { remainingSp: options.remainingSp ?? 389.93, monthlySp: 990, usedInWindowSp: 0.07, windowLimitSp: 200 },
      })
    }
    if (url === AI_CHAT) {
      return new Response(options.chatFrames.join(''), {
        status: 200,
        headers: { 'content-type': 'text/event-stream; charset=utf-8' },
      })
    }
    if (url === BYOK_ENDPOINT) {
      return new Response(
        `${frame({ choices: [{ delta: { content: '这是你自己密钥的回答。' } }] })}\n\ndata: [DONE]\n\n`,
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      )
    }
    // 版本探测拉的是页面本身；给一段没有入口脚本的 HTML，检查就静默跳过。
    if (url === 'http://localhost:3000/' || url.startsWith('http://localhost')) {
      return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    }
    throw new Error(`测试里没有约定这个请求：${url}`)
  }) as typeof fetch
  return { fetch: fetchImpl, requests }
}

let container: HTMLDivElement | undefined
let root: { render: (node: ReactElement) => void; unmount: () => void } | null = null
let storage: StorageStub | undefined

beforeEach(() => {
  // 存储桩方法齐全（含 clear），不依赖别的测试文件漏在全局上的实现。
  storage = installStorage()
})

afterEach(async () => {
  if (root !== null) await act(async () => { root!.unmount() })
  container?.remove()
  root = null
  container = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

async function flush(rounds = 8): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => { await Promise.resolve() })
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

async function click(node: HTMLElement): Promise<void> {
  await act(async () => { node.click() })
  await flush()
}

/** 电脑不可达的运行时：这一屏照旧留在手机上回答（否则发送会被派去电脑）。 */
async function offlineRuntime(): Promise<PhoneWindowRuntime> {
  const gateway = (async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.includes('/bootstrap')) {
      return new Response(JSON.stringify({ binding: BINDING, access: OFFLINE }), {
        status: 200, headers: { 'content-type': 'application/json' },
      })
    }
    if (url.includes('/access')) {
      return new Response(JSON.stringify(OFFLINE), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    throw new Error(`电脑不可达时不该发出这个请求：${url}`)
  }) as typeof fetch
  return PhoneWindowRuntime.open({
    port: new PcWindowHttpPort({ baseUrl: 'http://pc.test', fetch: gateway }),
    store: new MemoryWindowJournalStore(),
    deviceId: 'phone-test',
    sessionId: 'session-primary',
    now: () => 1_700_000_000_000,
    requestId: () => 'req-1' as SessionRequestId,
  })
}

async function mount(): Promise<void> {
  const runtime = await offlineRuntime()
  container = document.createElement('div')
  document.body.append(container)
  const { createRoot } = await import('react-dom/client')
  ;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const mounted = createRoot(container)
  root = mounted
  await act(async () => { mounted.render(createElement(AppElement, { runtime })) })
  await flush()
}

async function send(text: string): Promise<void> {
  const input = document.querySelector('input')
  if (input === null) throw new Error('找不到输入框')
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, text)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush(2)
  await act(async () => { byLabel(zh.send).click() })
  await flush(10)
}

function body(): string {
  return container?.textContent ?? ''
}

function textOf(selector: string): string {
  return document.querySelector(selector)?.textContent ?? ''
}

/** 本机缓存里已登录的账号：这是"这台设备有账号"的证据（冷启动时用得上）。 */
function seedKnownAccount(): void {
  localStorage.setItem(ACCOUNT_KEY, JSON.stringify({
    id: 7, username: '用户', email: 'u@test', role: 'personal', status: 'active',
    balance: null, created_at: null, last_login_at: null,
  }))
}

/** 用户自己那条通路的配置（自带密钥）。 */
function seedByok(): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({
    providerId: 'deepseek', baseUrl: 'https://local.test/v1', model: 'deepseek-chat',
  }))
  localStorage.setItem(SECRET_KEY, JSON.stringify({ key: 'sk-user-key' }))
}

/** 打开模型选择器再进设置页。 */
async function openSettings(): Promise<void> {
  await click(byLabel(zh.modelPickerTitle))
  await click(document.querySelector('.picker-more') as HTMLElement)
}

/** 往设置页的某个输入框里打字。 */
async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  await act(async () => {
    setter?.call(input, value)
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await flush(2)
}

/** 按文字找一个按钮。 */
function buttonByText(text: string): HTMLElement {
  const found = [...document.querySelectorAll<HTMLElement>('button')].find(node => node.textContent?.trim() === text)
  if (found === undefined) throw new Error(`找不到按钮「${text}」`)
  return found
}

describe('同源 + 有账号：默认走订阅通道', () => {
  beforeEach(() => {
    // 同源部署的那份产物（`vite.config.ts` 的 `base` 决定）。
    vi.stubEnv('BASE_URL', '/mobile/')
    seedKnownAccount()
  })

  it('请求打到同源网关，模型是前台名，且不带任何密钥', async () => {
    const network = stubNetwork({ chatFrames: [frame({ type: 'delta', text: '你好，' }), frame({ type: 'delta', text: '我是千手。' }), doneFrame()] })
    vi.stubGlobal('fetch', network.fetch)
    await mount()
    await send('你好')

    const chat = network.requests.filter(request => request.url === AI_CHAT)
    expect(chat).toHaveLength(1)
    const payload = JSON.parse(chat[0]?.body ?? '{}') as Record<string, unknown>
    expect(payload['model']).toBe('千手·迅捷')
    expect(Object.keys(payload).sort()).toEqual(['messages', 'model'])
    // 用户自己那把密钥一个字都不该出现，也不该有 authorization 头。
    expect(chat[0]?.body ?? '').not.toContain('sk-')
    expect(body()).toContain('我是千手。')
  })

  it('「联网搜索」开关在订阅通道上不改变去向：说清没有搜索，且这一条仍走网关', async () => {
    const network = stubNetwork({ chatFrames: [frame({ type: 'delta', text: '直接回答。' }), doneFrame()] })
    vi.stubGlobal('fetch', network.fetch)
    await mount()
    const chip = [...document.querySelectorAll<HTMLElement>('.chip')].find(node => node.textContent?.trim() === zh.webSearch)
    if (chip === undefined) throw new Error('找不到联网搜索开关')
    await click(chip)
    expect(body()).toContain(zh.searchBarSubscription)

    await send('这条会搜索吗')
    // 请求数量没变、也没有跑到搜索端点：订阅通道不带联网搜索，芯片不会悄悄改去向。
    expect(network.requests.filter(request => request.url === AI_CHAT)).toHaveLength(1)
    expect(network.requests.filter(request => request.url.includes('/messages'))).toHaveLength(0)
  })

  it('额度读得到就显示，并且结算帧里的数字会覆盖它', async () => {
    const network = stubNetwork({
      chatFrames: [frame({ type: 'delta', text: '答' }), doneFrame({ credit: { remainingMonthlySp: 388.5 } })],
      remainingSp: 389.93,
    })
    vi.stubGlobal('fetch', network.fetch)
    await mount()

    expect(textOf('.credit')).toContain('389.93')
    await send('再问一句')
    expect(textOf('.credit')).toContain('388.50')
  })

  it('额度读不到时显示"额度未知"，不编数字', async () => {
    const network = stubNetwork({ chatFrames: [doneFrame()] })
    const withoutStatus = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url === AI_STATUS) {
        return new Response(JSON.stringify({ ok: false, message: '读不到订阅额度：连不上网关。' }), {
          status: 200, headers: { 'content-type': 'application/json' },
        })
      }
      return await network.fetch(input, init)
    }) as typeof fetch
    vi.stubGlobal('fetch', withoutStatus)
    await mount()
    expect(textOf('.credit')).toContain(zh.creditUnknown)
    expect(textOf('.credit')).not.toMatch(/\d/)
  })

  it('降级说明挂在回复下方（不能让用户看不见）', async () => {
    localStorage.setItem(SUBSCRIPTION_KEY, JSON.stringify({ model: '千手·强力' }))
    localStorage.setItem(ROUTE_KEY, JSON.stringify('subscription'))
    const note = '「千手·强力」在普通版里用不了，这次由「千手·迅捷」作答。'
    const network = stubNetwork({
      chatFrames: [
        frame({ type: 'delta', text: '换了个模型答。' }),
        doneFrame({ requestedModel: '千手·强力', downgraded: true, downgradeNote: note }),
      ],
      tier: { id: 'basic', label: '普通版' },
    })
    vi.stubGlobal('fetch', network.fetch)
    await mount()
    await send('用强力模型回答')

    const payload = JSON.parse(network.requests.filter(r => r.url === AI_CHAT)[0]?.body ?? '{}') as { model?: string }
    expect(payload.model).toBe('千手·强力')
    expect(textOf('.downgrade')).toContain(note)
  })

  it('402：给的是"升级档位 / 等下一周期"这种能动手的提示', async () => {
    const network = stubNetwork({
      chatFrames: [frame({ type: 'error', kind: 'no-credit', message: '本月额度用完了。', status: 402 })],
    })
    vi.stubGlobal('fetch', network.fetch)
    await mount()
    await send('你好')
    expect(textOf('.failure')).toContain('升级档位')
  })

  it('429：说清是并发上限，让用户等几秒', async () => {
    const network = stubNetwork({
      chatFrames: [frame({ type: 'error', kind: 'too-many-concurrent', message: '并发太多。', status: 429 })],
    })
    vi.stubGlobal('fetch', network.fetch)
    await mount()
    await send('你好')
    expect(textOf('.failure')).toContain('等几秒')
  })

  it('模型选择器只列当前档位能用的模型，并说明档位', async () => {
    const basic = stubNetwork({ chatFrames: [doneFrame()], tier: { id: 'basic', label: '普通版' } })
    vi.stubGlobal('fetch', basic.fetch)
    await mount()
    await click(byLabel(zh.modelPickerTitle))
    const options = [...document.querySelectorAll('[aria-label]')]
      .map(node => node.getAttribute('aria-label') ?? '')
      .filter(label => label.startsWith(`${zh.modelPickerTitle}: `))
    expect(options).toEqual([`${zh.modelPickerTitle}: 千手·迅捷`])
    expect(textOf('.picker-note')).toContain('普通版')
  })

  it('高级版能看到两个模型', async () => {
    const plus = stubNetwork({ chatFrames: [doneFrame()], tier: { id: 'plus', label: '高级版' } })
    vi.stubGlobal('fetch', plus.fetch)
    await mount()
    await click(byLabel(zh.modelPickerTitle))
    const options = [...document.querySelectorAll('[aria-label]')]
      .map(node => node.getAttribute('aria-label') ?? '')
      .filter(label => label.startsWith(`${zh.modelPickerTitle}: `))
    expect(options).toEqual([
      `${zh.modelPickerTitle}: 千手·迅捷`,
      `${zh.modelPickerTitle}: 千手·强力`,
    ])
  })

  it('订阅档不会覆盖用户自带密钥那份配置（两条通路都留着）', async () => {
    seedByok()
    const network = stubNetwork({ chatFrames: [doneFrame()] })
    vi.stubGlobal('fetch', network.fetch)
    await mount()

    const byok = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>
    expect(byok['baseUrl']).toBe('https://local.test/v1')
    expect(byok['model']).toBe('deepseek-chat')
    expect(localStorage.getItem(SECRET_KEY)).toContain('sk-user-key')
    expect(localStorage.getItem(SUBSCRIPTION_KEY)).toContain('千手·迅捷')
  })

  it('在订阅档下改自带密钥那份配置：存下来了，而这一条仍然走订阅通道', async () => {
    seedByok()
    const network = stubNetwork({ chatFrames: [frame({ type: 'delta', text: '订阅回答' }), doneFrame()] })
    vi.stubGlobal('fetch', network.fetch)
    await mount()
    await openSettings()

    // BYOK 表单永远显示用户自己那份配置（不是 `qianshou://subscription`）。
    const inputs = [...document.querySelectorAll<HTMLInputElement>('.field-block input')]
    expect(inputs[0]?.value).toBe('https://local.test/v1')
    await typeInto(inputs[0] as HTMLInputElement, 'https://other.test/v1')
    await typeInto(inputs[2] as HTMLInputElement, 'my-own-model')
    await click(buttonByText(zh.settingsSave))

    // 改动落进了用户那份记录，密钥没被动过。
    const byok = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}') as Record<string, unknown>
    expect(byok['baseUrl']).toBe('https://other.test/v1')
    expect(byok['model']).toBe('my-own-model')
    expect(localStorage.getItem(SECRET_KEY)).toContain('sk-user-key')

    // 通道仍然是订阅：这一条打到网关，而不是刚填的那个端点。
    await click(byLabel(zh.settingsBack))
    await send('这条还是订阅回答')
    expect(network.requests.filter(request => request.url === AI_CHAT)).toHaveLength(1)
    expect(network.requests.filter(request => request.url.startsWith('https://other.test'))).toHaveLength(0)
  })

  it('显式切回自带密钥后，请求打回用户自己的端点', async () => {    seedByok()
    const network = stubNetwork({ chatFrames: [frame({ type: 'delta', text: '订阅回答' }), doneFrame()] })
    vi.stubGlobal('fetch', network.fetch)
    await mount()
    await openSettings()

    // 设置页如实说明现在走的是订阅通道。
    expect(body()).toContain(zh.routeNowSubscription)
    await click(byLabel(`${zh.routeTitle}: 自带密钥`))
    expect(body()).toContain(zh.routeNowByok)
    await click(byLabel(zh.settingsBack))

    const before = network.requests.filter(request => request.url === AI_CHAT).length
    await send('换成我自己的模型')
    expect(network.requests.filter(request => request.url === BYOK_ENDPOINT)).toHaveLength(1)
    expect(network.requests.filter(request => request.url === AI_CHAT)).toHaveLength(before)
    expect(body()).toContain('这是你自己密钥的回答。')
  })
})

describe('非同源（配对 / 遥控形态）：一个订阅请求都不发', () => {
  it('发消息照旧走自带密钥，订阅网关一次都没被调用', async () => {
    seedByok()
    const network = stubNetwork({ chatFrames: [frame({ type: 'delta', text: '订阅回答' }), doneFrame()] })
    vi.stubGlobal('fetch', network.fetch)
    await mount()
    await send('你好')

    expect(network.requests.filter(request => request.url === AI_CHAT)).toHaveLength(0)
    expect(network.requests.filter(request => request.url === AI_STATUS)).toHaveLength(0)
    expect(network.requests.filter(request => request.url === BYOK_ENDPOINT)).toHaveLength(1)
    expect(body()).toContain('这是你自己密钥的回答。')
    // 非同源时连"读额度"的请求都不该发，顶栏也不该出现订阅额度。
    expect(document.querySelector('.credit')).toBeNull()
  })

  it('设置页如实说"订阅通道需要同源部署"，并且仍走自带密钥', async () => {
    seedByok()
    const network = stubNetwork({ chatFrames: [doneFrame()] })
    vi.stubGlobal('fetch', network.fetch)
    await mount()
    await openSettings()
    expect(body()).toContain('同源部署')
    expect(body()).toContain(zh.routeNowByok)

    // 即使显式选了订阅档：仍然走 BYOK，并且给的是红色说明。
    await click(byLabel(`${zh.routeTitle}: 订阅通道`))
    expect(textOf('.route-blocked')).toContain('同源部署')
    expect(body()).toContain(zh.routeNowByok)
    await click(byLabel(zh.settingsBack))
    await send('这条还是我自己的密钥')
    expect(network.requests.filter(request => request.url === AI_CHAT)).toHaveLength(0)
    expect(network.requests.filter(request => request.url === BYOK_ENDPOINT)).toHaveLength(1)
  })
})

describe('同源但没有账号：不启用订阅通道', () => {
  it('保持 BYOK，并说明订阅通道需要登录', async () => {
    vi.stubEnv('BASE_URL', '/mobile/')
    seedByok()
    const network = stubNetwork({ chatFrames: [doneFrame()], hostState: 'signed-out' })
    vi.stubGlobal('fetch', network.fetch)
    await mount()
    await send('你好')

    expect(network.requests.filter(request => request.url === AI_CHAT)).toHaveLength(0)
    expect(network.requests.filter(request => request.url === BYOK_ENDPOINT)).toHaveLength(1)

    await click(byLabel(zh.modelPickerTitle))
    await click(document.querySelector('.picker-more') as HTMLElement)
    await click(byLabel(`${zh.routeTitle}: 订阅通道`))
    expect(textOf('.route-blocked')).toContain('登录')
  })
})
