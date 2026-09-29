// @vitest-environment jsdom
/** Runs the actual entry, account client and mobile controller with test-only HTTP and IDB ports. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { materializeMobileFrame } from '../src/dom-painter.ts'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import type { MobileAgentSessionPort } from '../src/window/mobile-workspace-types.ts'
import { planImageIntent, readyImagePlan, inventImageSubject } from '@deepseek-ai/dsh-client-compute-trigger'
import { readDeviceId } from '../src/device-id.ts'

vi.mock('@deepseek-ai/dsh-client-pc-window-bridge', async importOriginal => ({
  ...await importOriginal<object>(),
  IndexedDbWindowJournalStore: {
    open: async () => ({ load: async () => null, save: async () => {}, remove: async () => {}, close: () => {} }),
  },
}))
/** Browser speech engine is the only replacement; the real voice controller stays mounted by main. */
class SpeechEngine {
  static instances: SpeechEngine[] = []
  lang = ''; continuous = false; interimResults = false; maxAlternatives = 1; processLocally = false
  onstart: (() => void) | null = null
  onend: (() => void) | null = null
  onerror: ((event: { error: string }) => void) | null = null
  onresult: ((event: { results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null = null
  start = vi.fn(); stop = vi.fn(); abort = vi.fn()
  constructor() { SpeechEngine.instances.push(this) }
}
function speechResult(engine: SpeechEngine, text: string, final = true): void {
  engine.onresult?.({ results: [{ isFinal: final, 0: { transcript: text } }] })
}
async function startDictation(): Promise<SpeechEngine> {
  const starts = SpeechEngine.instances.reduce((count, engine) => count + engine.start.mock.calls.length, 0)
  const hold = document.querySelector<HTMLButtonElement>('[data-testid="mobile-voice-hold"]')
  if (!hold || hold.hidden) document.querySelector<HTMLButtonElement>('[data-testid="mobile-voice"]')!.click()
  document.querySelector<HTMLButtonElement>('[data-testid="mobile-voice-hold"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
  expect(document.querySelector('.voice-dialog')).toBeNull()
  expect(document.body.textContent).not.toContain('选择语音识别方式')
  await vi.waitFor(() => {
    const now = SpeechEngine.instances.reduce((count, engine) => count + engine.start.mock.calls.length, 0)
    expect(now).toBe(starts + 1)
  })
  const engine = SpeechEngine.instances.at(-1)
  if (!engine) throw new Error('MISSING_SPEECH_ENGINE')
  engine.onstart?.(); return engine
}
const me = { id: '42', username: 'preview-test', email: '', role: 'user', status: 'active', balance: null, created_at: null, last_login_at: null }
const requests: { path: string; body: unknown }[] = []
let workers: unknown = []
let failDirectory = false
let verifiedAccount: typeof me | null = me
function byText(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(button => button.textContent === text)
  if (!found) throw new Error(`Missing button: ${text}`)
  return found
}
function field(label: string): HTMLInputElement { return document.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)! }
function submit(): void { document.querySelector('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })) }
async function boot(): Promise<void> {
  await import('../src/main.ts')
  await vi.waitFor(() => { expect(document.querySelector('textarea')).not.toBeNull() })
  await vi.waitFor(() => { expect(document.querySelector('.sidebar-account')?.textContent).toContain('登录') })
}
async function loginReady(status?: string): Promise<void> {
  await boot(); byText('登录').click()
  field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit()
  await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
  field('动态验证码').value = '123456'; submit()
  await vi.waitFor(() => { expect(sidebarAccount().textContent).toContain(me.username) })
  if (status) await vi.waitFor(() => { expect(document.body.textContent).toContain(status) })
}
function sendText(text: string): void {
  const editor = document.querySelector('textarea')!
  editor.value = text; editor.dispatchEvent(new Event('input'))
  document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click()
}
function sidebarAccount(): HTMLButtonElement {
  const found = document.querySelector<HTMLButtonElement>('.sidebar-account')
  if (!found) throw new Error('Missing sidebar account')
  return found
}
function intentFixture(body: unknown): Record<string, unknown> {
  const payload = body !== null && typeof body === 'object' ? body as Record<string, unknown> : {}
  const text = typeof payload.text === 'string' ? payload.text : ''
  const previous = payload.previous !== null && typeof payload.previous === 'object'
    ? payload.previous as { originalText?: string; stage?: string }
    : undefined
  if (previous?.stage === 'clarify' && typeof previous.originalText === 'string') {
    const plan = planImageIntent(previous.originalText)
    if (plan !== null) {
      const ready = readyImagePlan(plan, text)
      return { ok: true, route: 'image', stage: 'generate', capability: 'image.generate', prompt: ready.prompt, model: '千手·绘画' }
    }
  }
  const plan = planImageIntent(text)
  if (plan === null) return { ok: true, route: 'chat' }
  if (plan.stage === 'clarify') {
    return { ok: true, route: 'image', stage: 'clarify', capability: 'image.generate', originalText: text, question: plan.question }
  }
  return { ok: true, route: 'image', stage: 'generate', capability: 'image.generate', prompt: readyImagePlan(plan).prompt, model: '千手·绘画' }
}
function fixtureWorkers(onlineCount: number, total: number): unknown[] {
  const seen = new Date().toISOString()
  return Array.from({ length: total }, (_, index) => ({
    id: `pc-${String(index)}`,
    owner_id: me.id,
    name: `电脑 ${String(index + 1)}`,
    status: index < onlineCount ? 'online' : 'offline',
    last_seen: seen,
    os: 'darwin',
    hostname: `host-${String(index)}`,
    window_origin: null,
  }))
}
beforeEach(() => {
  SpeechEngine.instances = []; vi.stubGlobal('SpeechRecognition', SpeechEngine)
  vi.resetModules(); requests.length = 0; workers = []; failDirectory = false; verifiedAccount = me; delete window.qianshouMobileHost
  document.body.innerHTML = '<div id="app"></div>'; localStorage.clear()
  vi.stubGlobal('__MOBILE_AGENT_HTTP__', false)
  vi.stubGlobal('__ACCOUNT_ORIGIN__', 'https://qianshousuanli.com')
  vi.stubGlobal('indexedDB', {})
  window.matchMedia = vi.fn().mockReturnValue({ matches: true, addEventListener() {}, removeEventListener() {} })
  HTMLDialogElement.prototype.showModal = function () { this.open = true }
  HTMLDialogElement.prototype.close = function () { this.open = false }
  window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const path = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw)
    const body = init?.body
    if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('TEST_EXPECTS_JSON_BODY')
    requests.push({ path, body: body ? JSON.parse(body) : null })
    let payload: unknown
    if (path.endsWith('/auth/login')) payload = { ok: true, two_factor_required: true, challenge_token: 'test-challenge' }
    else if (path.endsWith('/auth/login/totp')) payload = { ok: true, access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 3600, account: me }
    else if (path.endsWith('/auth/me')) payload = { ok: true, account: verifiedAccount }
    else if (path.endsWith('/workers')) {
      if (failDirectory) throw new Error('test-offline')
      payload = { ok: true, workers }
    } else if (path.endsWith('/auth/logout')) payload = { ok: true }
    else if (path.endsWith('/api/qianshou/ai/intent')) payload = intentFixture(body ? JSON.parse(body) : null)
    else throw new Error(`Unexpected endpoint ${path}`)
    return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } })
  })
})
afterEach(() => { window.dispatchEvent(new Event('pagehide')); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('mobile browser face', () => {
  it('deletes a selected session with a pending admission without blocking the replacement conversation', async () => {
    let count = 0
    let finishFirst: (() => void) | undefined
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId(`delete-pending-${++count}`) }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      archive: vi.fn(async () => {}),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => {
        if (binding.sessionId === 'delete-pending-1') await new Promise<void>((resolve) => { finishFirst = resolve })
        return { binding, requestId: request.requestId, state: 'received' }
      }),
    }
    window.qianshouMobileHost = { agent }
    await loginReady()
    sendText('第一条消息')
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(1) })
    document.querySelector<HTMLButtonElement>('[data-testid="mobile-delete-0"]')!.click()
    document.querySelector<HTMLButtonElement>('[data-testid="mobile-delete-confirm"]')!.click()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-history-row-0"]')).toBeNull() })
    sendText('新会话继续')
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(2) })
    expect(vi.mocked(agent.submit).mock.calls[1]![0].sessionId).toBe('delete-pending-2')
    finishFirst?.()
    await vi.waitFor(() => { expect(document.querySelector('textarea')!.value).toBe('') })
    sendText('第三条')
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(3) })
    expect(vi.mocked(agent.submit).mock.calls[2]![0].sessionId).toBe('delete-pending-2')
  })

  it('contains a navigation paint error during deletion and still sends and recovers the sidebar', async () => {
    const directory = await import('../src/pc-directory-view.ts')
    const paintDirectory = vi.spyOn(directory, 'decoratePcDirectory')
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    let count = 0
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId(`paint-delete-${++count}`) }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      archive: vi.fn(async () => {}),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' })),
    }
    window.qianshouMobileHost = { agent }
    await loginReady()
    paintDirectory.mockImplementationOnce(() => { throw new Error('private render detail') })
    document.querySelector<HTMLButtonElement>('[data-testid="mobile-delete-0"]')!.click()
    expect(document.querySelector('[data-testid="mobile-view-notice"]')!.textContent).toContain('聊天可以继续')
    sendText('聊天不应被侧栏阻塞')
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-delete-confirm"]')).not.toBeNull() })
    document.querySelector<HTMLButtonElement>('[data-testid="mobile-delete-confirm"]')!.click()
    await vi.waitFor(() => { expect(agent.archive).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-view-notice"]')!.textContent).toBe('') })
    expect(log).toHaveBeenCalledWith('MOBILE_VIEW_UPDATE_FAILED:navigation')
    expect(log.mock.calls.flat().join(' ')).not.toContain('private render detail')
  })

  it('keeps the composer draft after a cross-tab missing session and opens a new session on the next send', async () => {
    let count = 0; let missing = false
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId(`missing-browser-${++count}`) }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => {
        if (missing) throw new Error('MOBILE_AGENT_SESSION_NOT_FOUND')
        return { binding, requestId: request.requestId, state: 'received' }
      }),
    }
    window.qianshouMobileHost = { agent }
    await loginReady()
    missing = true
    sendText('保留这段草稿')
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(1) })
    expect(document.querySelector('textarea')!.value).toBe('保留这段草稿')
    expect(vi.mocked(agent.submit).mock.calls[0]?.[0].sessionId).toBe('missing-browser-1')
    sendText('下一次发送')
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(2) })
    expect(vi.mocked(agent.submit).mock.calls[1]?.[0].sessionId).toBe('missing-browser-2')
  })

  it('settles unavailable video locally and admits the next text message once', async () => {
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('video-recovery') }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await loginReady()
    sendText('给我制作一段小狗奔跑的视频')
    await vi.waitFor(() => { expect(document.body.textContent).toContain('视频生成暂未接入') })
    expect(agent.submit).not.toHaveBeenCalled()
    expect(requests.some(row => row.path.includes('/ai/images/'))).toBe(false)
    await vi.waitFor(() => { expect(document.querySelector('textarea')!.value).toBe('') })
    sendText('你好，解释一下月相')
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(1) })
    expect(vi.mocked(agent.submit).mock.calls[0]![1].text).toBe('你好，解释一下月相')
    await vi.waitFor(() => { expect(document.querySelector('textarea')!.value).toBe('') })
  })

  it.each(['send', 'edit', 'cancel', 'session'] as const)('holds dictated text briefly and honors %s before optional auto-send', async (action) => {
    let count = 0
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId(`voice-auto-${++count}`) }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    localStorage.setItem('qianshou.mobile.voice-auto-send', 'true')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    await loginReady()
    const engine = await startDictation()
    vi.useFakeTimers()
    speechResult(engine, '解释月相'); engine.onend?.()
    expect(document.querySelector('textarea')!.value).toBe('解释月相')
    expect(agent.submit).not.toHaveBeenCalled()
    if (action === 'edit') {
      const input = document.querySelector('textarea')!
      input.value = '解释月相，三句话'; input.dispatchEvent(new Event('input'))
    } else if (action === 'cancel') document.querySelector<HTMLButtonElement>('.voice-cancel')!.click()
    else if (action === 'session') { byText('新建智能体会话').click(); await vi.advanceTimersByTimeAsync(0) }
    await vi.advanceTimersByTimeAsync(1600)
    expect(agent.submit).toHaveBeenCalledTimes(action === 'send' ? 1 : 0)
    if (action === 'send') expect(vi.mocked(agent.submit).mock.calls[0]![1].text).toBe('解释月相')
  })

  it('clears image lightbox and unsent attachments when the account logs out', async () => {
    const accountFetch = window.fetch
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).includes('/ai/images/generations')
      ? Response.json({ data: [{ b64_json: 'QQ==' }] })
      : accountFetch(input, init))
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('logout-images') }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await loginReady()
    sendText('画一只猫')
    await vi.waitFor(() => { expect(document.querySelector('.generated-image')).not.toBeNull() })
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image"]')!
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [new File(['image'], 'private.png', { type: 'image/png' })] })
    fileInput.dispatchEvent(new Event('change'))
    expect(document.querySelector('.composer-attachment')).not.toBeNull()
    document.querySelector<HTMLButtonElement>('[data-testid^="generated-image-open-"]')!.click()
    const lightbox = document.querySelector<HTMLDialogElement>('[data-testid="image-lightbox"]')!
    expect(lightbox.open).toBe(true)
    expect(lightbox.querySelector('img')).not.toBeNull()
    sidebarAccount().click(); byText('退出登录').click()
    await vi.waitFor(() => { expect(sidebarAccount().textContent).toBe('登录') })
    expect(lightbox.open).toBe(false)
    expect(lightbox.querySelector('img')).toBeNull()
    expect(document.querySelector('.composer-attachment')).toBeNull()
  })

  it('cancels only the current image request and rejects a late image response', async () => {
    let imageSignal: AbortSignal | undefined
    let release!: (response: Response) => void
    const gate = new Promise<Response>((resolve) => { release = resolve })
    const accountFetch = window.fetch
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      if ((typeof input === 'string' ? input : input instanceof URL ? input.href : input.url).includes('/ai/images/generations')) {
        imageSignal = init?.signal ?? undefined
        return gate
      }
      return accountFetch(input, init)
    })
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('cancel-image-only') }),
      inspect: async binding => ({ binding, status: 'running', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
      cancel: vi.fn(async () => {}),
    }
    window.qianshouMobileHost = { agent }
    await loginReady('正在回复…')
    sendText('画一只猫')
    await vi.waitFor(() => { expect(imageSignal).toBeDefined() })
    sendText('取消出图')
    await vi.waitFor(() => { expect(imageSignal?.aborted).toBe(true) })
    expect(agent.cancel).not.toHaveBeenCalled()
    expect(agent.submit).not.toHaveBeenCalled()
    expect(document.body.textContent).toContain('已停止等待这张图片')
    const response = Response.json({ data: [{ b64_json: 'QQ==' }] })
    const decoded = vi.spyOn(response, 'json')
    release(response)
    await vi.waitFor(() => { expect(decoded).toHaveBeenCalledTimes(1) })
    expect(document.querySelector('.generated-image')).toBeNull()
    expect(agent.cancel).not.toHaveBeenCalled()
  })

  it.each(['取消', '你好'])('releases image clarification and resumes ordinary conversation: %s', async (reply) => {
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('clarification-release') }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await loginReady()
    sendText('给我出图')
    await vi.waitFor(() => { expect(document.querySelector('.image-intent-card')).not.toBeNull() })
    sendText(reply)
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(1) })
    expect(vi.mocked(agent.submit).mock.calls[0]![1].text).toBe(reply)
    await vi.waitFor(() => { expect(document.querySelector('textarea')!.value).toBe('') })
    sendText('雨夜城市')
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(2) })
    expect(requests.filter(row => row.path.includes('/ai/images/generations'))).toHaveLength(0)
    expect(requests.filter(row => row.path.includes('/ai/intent'))).toHaveLength(0)
  })

  it('retains the image subject question after an acknowledgement', async () => {
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('clarification-ack') }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await loginReady()
    sendText('给我出图')
    await vi.waitFor(() => { expect(document.querySelector('.image-intent-card')).not.toBeNull() })
    sendText('好的')
    await vi.waitFor(() => { expect(document.querySelector('textarea')!.value).toBe('') })
    expect(document.body.textContent).toContain('想画什么')
    expect(agent.submit).not.toHaveBeenCalled()
    expect(requests.filter(row => row.path.includes('/ai/images/generations'))).toHaveLength(0)
  })

  it('does not move an image clarification into a newly opened Session', async () => {
    let count = 0
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId(`isolated-clarification-${++count}`) }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await loginReady()
    sendText('给我出图')
    await vi.waitFor(() => { expect(document.querySelector('.image-intent-card')).not.toBeNull() })
    byText('新建智能体会话').click()
    await vi.waitFor(() => { expect(count).toBe(2) })
    await vi.waitFor(() => { expect(document.querySelector('.image-intent-card')).toBeNull() })
    sendText('雨夜城市')
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(1) })
    expect(vi.mocked(agent.submit).mock.calls[0]![0].sessionId).toBe('isolated-clarification-2')
    expect(requests.filter(row => row.path.includes('/ai/images/generations'))).toHaveLength(0)
    await vi.waitFor(() => { expect(document.querySelector('textarea')!.value).toBe('') })
    document.querySelector<HTMLButtonElement>('[data-testid="mobile-conversation-0"]')!.click()
    await vi.waitFor(() => { expect(document.querySelector('.image-intent-card')).not.toBeNull() })
    sendText('取消')
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(2) })
    expect(vi.mocked(agent.submit).mock.calls[1]![0].sessionId).toBe('isolated-clarification-1')
  })

  it('materializes escaped user text and forwards input and tap callbacks', () => {
    const change = vi.fn(); const tap = vi.fn()
    const tree = materializeMobileFrame({ code: 'test', tree: { type: 'view', testId: 'root', children: [
      { type: 'text', testId: 'text', text: '<img src=x onerror=alert(1)>' },
      { type: 'input', testId: 'input', value: 'draft', input: change },
      { type: 'view', testId: 'send', tap },
    ] } })
    expect(tree.querySelector('img')).toBeNull()
    const textarea = tree.querySelector('textarea')!; textarea.value = 'original request'; textarea.dispatchEvent(new Event('input'))
    tree.querySelector('button')!.click()
    expect(change).toHaveBeenCalledWith('original request'); expect(tap).toHaveBeenCalledTimes(1)
  })
  it('keeps one non-secret device identity across reloads and refuses corrupted storage', () => {
    const uuid = vi.fn(() => '01234567-89ab-4cde-89ab-0123456789ab')
    expect(readDeviceId(localStorage, uuid)).toBe(readDeviceId(localStorage, uuid))
    expect(uuid).toHaveBeenCalledTimes(1)
    expect([...Object.keys(localStorage)]).toEqual(['qianshou.mobile-preview.device-id.v1'])
    localStorage.setItem('qianshou.mobile-preview.device-id.v1', 'foreign')
    expect(() => readDeviceId(localStorage, uuid)).toThrow('PREVIEW_DEVICE_ID_INVALID')
  })
  it('draws a hairline plus and a compact speaker-wave voice entry, not a heavy plus or note', async () => {
    await boot()
    const add = document.querySelector('.composer-add')!
    expect(add.getAttribute('aria-label')).toBe('上传图片')
    expect(add.querySelector('svg.composer-icon-plus')).not.toBeNull()
    expect(add.querySelector('svg.composer-icon-plus path')?.getAttribute('d')).toContain('M12 7.25')
    const mic = document.querySelector('[data-testid="mobile-voice"]')!
    expect(mic.querySelector('svg.composer-icon-mic')).not.toBeNull()
    expect(mic.querySelector('path')?.getAttribute('d')).toContain('M4.8 10.1')
    expect(mic.querySelectorAll('path')).toHaveLength(2)
    expect(mic.textContent).not.toContain('按住说话')
    expect(document.querySelector('[data-testid="mobile-voice-hold"]')?.textContent).toBe('按住说话')
    expect(`${add.innerHTML}${mic.innerHTML}`).not.toMatch(/[♩♪♫♬◉]/)
  })
  it('toggles voice on the composer mic and never opens a picker dialog', async () => {
    await boot()
    document.querySelector<HTMLButtonElement>('[data-testid="mobile-voice-hold"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    expect(document.querySelector('.voice-dialog')).toBeNull()
    expect(document.body.textContent).not.toContain('选择语音识别方式')
    expect(document.body.textContent).not.toContain('同意并开始')
    expect(document.querySelector('[data-testid="mobile-voice-stop"]')).toBeNull()
    expect(document.querySelector('.composer .voice-status')).toBeNull()
    expect(document.querySelector('[data-testid="mobile-voice-hold"]')).not.toBeNull()
    expect(getComputedStyle(document.querySelector('.composer')!).flexWrap).toBe('nowrap')
  })
  it('switches composer modes without starting speech and restores the text draft', async () => {
    await boot()
    const editor = document.querySelector('textarea')!
    editor.value = '保留这段草稿'; editor.dispatchEvent(new Event('input'))
    const mic = document.querySelector<HTMLButtonElement>('[data-testid="mobile-voice"]')!
    const starts = SpeechEngine.instances.reduce((count, engine) => count + engine.start.mock.calls.length, 0)
    mic.click()
    expect(editor.hidden).toBe(true)
    expect(document.querySelector<HTMLButtonElement>('[data-testid="mobile-voice-hold"]')?.hidden).toBe(false)
    expect(SpeechEngine.instances.reduce((count, engine) => count + engine.start.mock.calls.length, 0)).toBe(starts)
    document.querySelector<HTMLButtonElement>('[data-testid="mobile-keyboard-mode"]')!.click()
    expect(editor.hidden).toBe(false)
    expect(editor.value).toBe('保留这段草稿')
    expect(document.activeElement).toBe(editor)
  })
  it('shows an honest signed-out page, prepares input without requests, and returns drawer focus', async () => {
    await boot()
    expect(document.querySelector<HTMLElement>('.mobile-shell')?.hidden).toBe(true)
    expect(document.querySelector('.header .account-button')).toBeNull()
    expect(sidebarAccount().textContent).toBe('登录')
    expect(document.querySelector('.sidebar-settings')?.getAttribute('aria-label')).toBe('账号设置')
    expect(document.querySelector('.sidebar-settings svg')).not.toBeNull()
    expect(document.body.textContent).toContain('登录后查看你的电脑')
    expect(document.body.textContent).not.toContain('无远程主机')
    byText('创作一张图片').click()
    expect(document.querySelector('textarea')!.value).toBe('给我出一张图')
    expect(document.querySelector<HTMLElement>('.draft')!.hidden).toBe(true)
    expect(document.querySelector('.image-confirm')).toBeNull()
    expect(document.querySelector('.image-intent-card')).toBeNull()
    expect(requests).toEqual([])
    const menu = document.querySelector<HTMLButtonElement>('[aria-label="打开侧边栏"]')!
    menu.click(); expect(document.querySelector('.mobile-shell')!.classList.contains('drawer-open')).toBe(true)
    const pcToggle = document.querySelector<HTMLButtonElement>('.pc-toggle')!
    expect(pcToggle.textContent).toContain('我的电脑')
    expect(pcToggle.textContent).toContain('0/0 在线')
    expect(pcToggle.querySelector('.pc-status-dot')).not.toBeNull()
    expect(pcToggle.querySelector('.pc-status-dot-online')).toBeNull()
    expect(document.querySelector('.pc-contents')!.hasAttribute('hidden')).toBe(true)
    pcToggle.click(); expect(document.querySelector('.pc-contents')!.hasAttribute('hidden')).toBe(false)
    document.querySelector<HTMLButtonElement>('.sidebar-top .icon-button')!.click()
    expect(document.activeElement).toBe(menu)
    document.querySelector('textarea')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    expect(document.querySelector<HTMLElement>('section.account-dialog')!.hidden).toBe(false)
    expect(requests).toEqual([])
    expect(document.querySelector('textarea')!.value).toBe('给我出一张图')
  })
  it('performs actual shared-client 2FA, verifies identity, distinguishes empty and failed directory, and clears account on logout', async () => {
    await boot(); byText('登录').click()
    field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit(); submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    expect(requests.filter(row => row.path.endsWith('/auth/login'))).toHaveLength(1)
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.body.textContent).toContain('无远程主机') })
    expect(document.body.textContent).toContain('移动端智能体服务尚未连接')
    expect(requests.map(row => row.path)).toEqual(['/account-api/api/v8/auth/login', '/account-api/api/v8/auth/login/totp', '/account-api/api/v8/auth/me', '/account-api/api/v8/workers'])
    expect(requests[1]!.body).toEqual({ challenge_token: 'test-challenge', code: '123456', trust_device: false, remember_me: false })
    expect(document.body.textContent).not.toContain('test-access')
    expect(JSON.stringify(localStorage)).not.toMatch(/test-(access|refresh|password)/)
    const editor = document.querySelector('textarea')!
    editor.value = '正在输入中文'; editor.dispatchEvent(new Event('input')); editor.focus(); editor.setSelectionRange(2, 4)
    editor.dispatchEvent(new CompositionEvent('compositionstart', { data: 'zhong' }))
    failDirectory = true; byText('刷新').click()
    await vi.waitFor(() => { expect(document.body.textContent).toContain('电脑列表查询失败，请重试') })
    expect(document.body.textContent).not.toContain('无远程主机')
    expect(document.querySelector('textarea')).toBe(editor)
    expect(editor.isConnected).toBe(true); expect(editor.value).toBe('正在输入中文')
    expect([editor.selectionStart, editor.selectionEnd]).toEqual([2, 4])
    editor.dispatchEvent(new CompositionEvent('compositionend', { data: '中' }))
    expect(sidebarAccount().textContent).toContain('preview-test')
    expect(sidebarAccount().textContent).toContain('ID 42')
    sidebarAccount().click(); byText('退出登录').click()
    await vi.waitFor(() => { expect(document.body.textContent).toContain('账号登录') })
    expect(document.querySelector<HTMLElement>('.mobile-shell')?.hidden).toBe(true)
    expect(document.body.textContent).not.toContain('preview-test')
  })
  it('opens the account PC through the relay, reads its transcript, sends, and reconciles the result', async () => {
    workers = fixtureWorkers(1, 1)
    let binding: { accountId: string; pcId: string; sessionId: string; sourceDeviceId: string } | null = null
    const relayActions: string[] = []
    const turns: { id: string; role: 'user' | 'assistant'; text: string; at: number }[] = [
      { id: 'pc-assistant-1', role: 'assistant', text: '来自 Mac 的历史回复', at: 1 },
    ]
    const accountFetch = window.fetch
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw)
      if (!path.startsWith('/api/qianshou/mobile-pc/v1/')) return accountFetch(input, init)
      const action = path.split('/').at(-1)
      const outer = JSON.parse(String(init?.body)) as { workerId: string; payload: Record<string, unknown> }
      relayActions.push(action ?? '')
      expect(outer.workerId).toBe('pc-0')
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-access')
      if (action === 'bootstrap') {
        binding = { accountId: '42', pcId: 'pc-0', sessionId: 'mac-session', sourceDeviceId: String(outer.payload.deviceId) }
        return Response.json({ binding, access: { state: 'online', allowedActions: ['dispatch', 'append', 'cancel'] } })
      }
      if (binding === null) throw new Error('BOOTSTRAP_REQUIRED')
      if (action === 'access') return Response.json({ state: 'online', allowedActions: ['dispatch', 'append', 'cancel'] })
      if (action === 'transcript') return Response.json({ binding, status: 'idle', turns })
      if (action === 'sync') return Response.json({ binding, fromCursor: outer.payload.cursor ?? null, nextCursor: 'qianshou.pc-window.cursor.v1:0', receipts: [], notReceivedIds: [] })
      if (action === 'submit') {
        const command = (outer.payload.command ?? {}) as { requestId?: string; origin?: unknown; action?: { text?: string } }
        turns.push({ id: `pc-user-${String(turns.length)}`, role: 'user', text: command.action?.text ?? '', at: 2 })
        turns.push({ id: `pc-assistant-${String(turns.length)}`, role: 'assistant', text: 'Mac 已执行并返回结果', at: 3 })
        return Response.json({ receipt: { origin: binding, requestId: command.requestId, revision: 1, state: 'received', reason: 'session-admitted', childSessionId: binding.sessionId }, outcome: 'executed', mayResend: false })
      }
      throw new Error(`Unexpected relay action ${action}`)
    })
    await boot(); byText('登录').click()
    field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-pc-pc-0"]')).not.toBeNull() })
    document.querySelector<HTMLButtonElement>('[data-testid="mobile-pc-pc-0"]')!.click()
    await vi.waitFor(() => { expect(document.body.textContent).toContain('来自 Mac 的历史回复') })
    const drawer = document.querySelector<HTMLElement>('.sidebar')
    expect(document.querySelector('[data-testid="mobile-session-strip"]')).toBeNull()
    expect(document.querySelector('main.conversation [data-testid="mobile-new-agent"]')).toBeNull()
    expect(drawer?.querySelector('[data-testid="mobile-sessions-title"]')?.textContent).toBe('手机会话')
    expect(drawer?.querySelector('[data-testid="mobile-new-agent"]')?.textContent).toBe('新建智能体会话')
    expect(drawer?.querySelector('[data-testid="mobile-pc-session-0"]')?.textContent).toBe('电脑 1')
    expect(document.querySelector('.mobile-shell')!.classList.contains('drawer-open')).toBe(false)
    const editor = document.querySelector('textarea')!
    editor.value = '继续处理这个任务'; editor.dispatchEvent(new Event('input'))
    document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click()
    await vi.waitFor(() => { expect(document.body.textContent).toContain('Mac 已执行并返回结果') })
    expect(relayActions).toEqual(
      expect.arrayContaining(['bootstrap', 'access', 'transcript', 'submit']),
    )
  })
  it('uses the configured Agent Session, retains the editor through refresh and sends original text once', async () => {
    let session = 0
    let release!: () => void
    const admitted = new Promise<void>((yes) => { release = yes })
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId(`test-session-${++session}`) }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => { await admitted; return { binding, requestId: request.requestId, state: 'received' as const } }),
    }
    window.qianshouMobileHost = { agent }
    await boot(); byText('登录').click()
    field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-status"]')?.textContent).toBe('') })
    const editor = document.querySelector('textarea')!
    const text = '请用三句话解释月相，不要表格'
    editor.value = text; editor.dispatchEvent(new Event('input'))
    editor.dispatchEvent(new CompositionEvent('compositionstart'))
    byText('刷新').click()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-status"]')?.textContent).toBe('') })
    expect(document.querySelector('textarea')).toBe(editor); expect(editor.value).toBe(text)
    editor.dispatchEvent(new CompositionEvent('compositionend'))
    const send = document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!
    send.click(); send.click()
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(1) })
    expect(vi.mocked(agent.submit).mock.calls[0]![1].text).toBe(text)
    expect(editor.value).toBe(text)
    release()
    await vi.waitFor(() => { expect(editor.value).toBe('') })
    expect(document.body.textContent).not.toContain('已接收')
    expect(document.querySelector('[data-testid="mobile-admissions"]')!.textContent).toBe('')
    byText('新建智能体会话').click()
    await vi.waitFor(() => { expect(session).toBe(2) })
    expect(document.querySelectorAll('[data-testid^="mobile-conversation-"]').length).toBeGreaterThanOrEqual(2)
    expect(document.querySelector('[data-testid="mobile-admissions"]')!.textContent).toBe('')
  })
  it('does not publish an account when the server cannot verify its identity', async () => {
    verifiedAccount = null
    await boot(); byText('登录').click()
    field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.querySelector('.form-error')!.textContent).toContain('登录未完成') })
    expect(requests.some(row => row.path.endsWith('/workers'))).toBe(false)
    expect(sidebarAccount().textContent).toBe('登录')
  })

  it('uses the configured HTTP Agent adapter for restored sessions, tool progress and cancellation', async () => {
    vi.stubGlobal('__MOBILE_AGENT_HTTP__', true)
    const accountFetch = window.fetch
    const binding = { accountId: '42', sessionId: 'server-session' }
    let running = true
    const agentCalls: { action: string; body: unknown; bearer: string | null }[] = []
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      const path = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (!path.startsWith('/api/qianshou/mobile-agent/v1/')) return accountFetch(input, init)
      const action = path.split('/').at(-1)!
      if (typeof init?.body !== 'string') throw new Error('EXPECTED_JSON_REQUEST')
      const body: unknown = JSON.parse(init.body)
      agentCalls.push({ action, body, bearer: new Headers(init?.headers).get('authorization') })
      if (action === 'list') return Response.json({ ok: true, bindings: [binding] })
      if (action === 'inspect') return Response.json({ ok: true, transcript: { binding, status: running ? 'running' : 'idle', turns: [{ id: 'assistant', role: 'assistant', text: '已恢复真实会话投影', at: 1 }], activity: [{ id: 'tool', kind: 'tool', at: 1, name: 'tenant_echo', state: running ? 'running' : 'cancelled' }] } })
      if (action === 'cancel') { running = false; return Response.json({ ok: true, binding, state: 'cancellation-requested' }) }
      throw new Error('Unexpected Agent endpoint')
    })
    await boot(); byText('登录').click(); field('用户名或邮箱').value = 'preview'; field('密码').value = 'local'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.body.textContent).toContain('已恢复真实会话投影') })
    expect(document.body.textContent).toContain('tenant_echo · 正在执行工具')
    expect(agentCalls.map(call => call.action)).not.toContain('open')
    byText('停止当前任务').click()
    await vi.waitFor(() => { expect(document.body.textContent).toContain('tenant_echo · 已取消') })
    expect(agentCalls.filter(call => call.action === 'cancel')).toEqual([{ action: 'cancel', body: { binding }, bearer: 'Bearer test-access' }])
    expect(document.cookie).not.toContain('test-access')
    expect(window.location.href).not.toContain('test-access')
  })

  it('requires explicit speech consent, merges the final transcript into the retained editor and never auto-sends', async () => {
    await boot()
    const editor = document.querySelector('textarea')!
    Object.defineProperty(editor, 'scrollHeight', { configurable: true, value: 94 })
    editor.value = '已输入'; editor.dispatchEvent(new Event('input'))
    expect(editor.style.height).toBe('94px')
    const engine = await startDictation()
    const hold = document.querySelector<HTMLButtonElement>('[data-testid="mobile-voice-hold"]')!
    expect(hold.textContent).toBe('正在聆听…')
    expect(hold.getAttribute('aria-label')).toBe('结束语音输入')
    speechResult(engine, '半句话', false)
    expect(editor.value).toBe('已输入')
    editor.value = '用户补充'; editor.dispatchEvent(new Event('input'))
    expect(document.querySelector('[data-testid="mobile-voice-hold"]')?.getAttribute('aria-pressed')).toBe('true')
    document.querySelector<HTMLButtonElement>('[data-testid="mobile-voice-hold"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 0 }))
    expect(engine.stop).toHaveBeenCalledTimes(1)
    speechResult(engine, '完整的语音'); engine.onend?.()
    expect(editor.value).toBe('用户补充 完整的语音')
    expect(editor.style.height).toBe('94px')
    expect(document.querySelector('textarea')).toBe(editor)
    expect(requests).toEqual([])
    expect(document.body.textContent).toContain('文字已放入输入框')
  })

  it('cancels speech when the page is hidden and refuses queued results after returning', async () => {
    await boot(); const engine = await startDictation()
    const result = engine.onresult; const end = engine.onend
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(engine.abort).toHaveBeenCalledTimes(1)
    result?.({ results: [{ isFinal: true, 0: { transcript: '迟到的私人语音' } }] }); end?.()
    expect(document.querySelector('textarea')!.value).toBe('')
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' })
    document.dispatchEvent(new Event('visibilitychange'))
    expect(document.body.textContent).not.toContain('迟到的私人语音')
  })

  it('cancels a recording on conversation and account changes without inserting old speech in a new draft', async () => {
    let count = 0
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId(`voice-session-${++count}`) }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await boot(); byText('登录').click(); field('用户名或邮箱').value = 'preview'; field('密码').value = 'local'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() }); field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(count).toBe(1) })
    const first = await startDictation(); const result = first.onresult; const end = first.onend
    byText('新建智能体会话').click()
    await vi.waitFor(() => { expect(count).toBe(2); expect(first.abort).toHaveBeenCalledTimes(1) })
    result?.({ results: [{ isFinal: true, 0: { transcript: '旧会话语音' } }] }); end?.()
    expect(document.querySelector('textarea')!.value).toBe('')
    const second = await startDictation()
    sidebarAccount().click()
    expect(second.abort).toHaveBeenCalledTimes(1)
    byText('退出登录').click()
    expect(agent.submit).not.toHaveBeenCalled()
    expect(document.querySelector('textarea')!.value).toBe('')
  })

  it('classifies a specified image locally then POSTs generations once, with a wait card', async () => {
    workers = fixtureWorkers(1, 20)
    let releaseGenerate: ((response: Response) => void) | undefined
    const generateGate = new Promise<Response>((resolve) => { releaseGenerate = resolve })
    const accountFetch = window.fetch
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw)
      if (path.endsWith('/api/qianshou/ai/images/generations')) {
        const body = init?.body
        if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('TEST_EXPECTS_JSON_BODY')
        requests.push({ path, body: body ? JSON.parse(body) : null })
        return generateGate
      }
      return accountFetch(input, init)
    })
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('image-session') }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await boot(); byText('登录').click()
    field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-status"]')?.textContent).toBe('') })
    await vi.waitFor(() => { expect(document.querySelector('.pc-toggle')!.textContent).toContain('1/20 在线') })
    expect(document.querySelector('.pc-status-dot-online')).not.toBeNull()
    expect(document.querySelector('.pc-contents')!.hasAttribute('hidden')).toBe(true)
    const editor = document.querySelector('textarea')!
    const prompt = '生成一张雨夜赛博城市海报，16:9，不要文字'
    editor.value = prompt; editor.dispatchEvent(new Event('input'))
    expect(document.querySelector<HTMLElement>('.draft')!.hidden).toBe(true)
    expect(document.querySelector('.image-confirm')).toBeNull()
    expect(document.querySelector('.image-intent-card')).toBeNull()
    expect(requests.filter(row => row.path.includes('/ai/images/generations'))).toHaveLength(0)
    document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid^="image-wait-card-"]')).not.toBeNull() })
    expect(document.querySelector('[data-testid^="image-wait-progress-"]')).not.toBeNull()
    expect(document.querySelector('[data-testid^="image-wait-progress-"]')?.getAttribute('role')).toBe('progressbar')
    expect(document.body.textContent).toContain('正在出图，请稍等')
    expect(document.querySelector<HTMLElement>('.draft')!.hidden).toBe(true)
    expect(document.querySelector('.pending-image-user')?.textContent).toContain(prompt)
    expect(editor.value).toBe('')
    expect(agent.submit).not.toHaveBeenCalled()
    expect(requests.filter(row => row.path.includes('/ai/intent'))).toHaveLength(0)
    expect(requests.filter(row => row.path.includes('/ai/images/generations'))).toHaveLength(1)
    releaseGenerate?.(Response.json({ data: [{ b64_json: 'QQ==' }], qianshou: { mime_type: 'image/jpeg' } }))
    await vi.waitFor(() => { expect(document.querySelector('.generated-image')).not.toBeNull() })
    expect(agent.submit).not.toHaveBeenCalled()
  })

  it('keeps normal conversation responsive while the image request is running', async () => {
    workers = fixtureWorkers(1, 20)
    let releaseGenerate: ((response: Response) => void) | undefined
    const generateGate = new Promise<Response>((resolve) => { releaseGenerate = resolve })
    const accountFetch = window.fetch
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw)
      if (path.endsWith('/api/qianshou/ai/images/generations')) {
        const body = init?.body
        if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('TEST_EXPECTS_JSON_BODY')
        requests.push({ path, body: body ? JSON.parse(body) : null })
        return generateGate
      }
      return accountFetch(input, init)
    })
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('kitten-session') }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await boot(); byText('登录').click()
    field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-status"]')?.textContent).toBe('') })
    const editor = document.querySelector('textarea')!
    const send = (): void => { document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click() }
    editor.value = '出小猫图'; editor.dispatchEvent(new Event('input'))
    send()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid^="image-wait-card-"]')).not.toBeNull() })
    expect(document.querySelector('[data-testid^="image-wait-progress-"]')).not.toBeNull()
    expect(document.body.textContent).toContain('正在出图，请稍等')
    expect(document.body.textContent).not.toContain('还想补充什么')
    expect(document.body.textContent).not.toContain('<svg')
    expect(document.querySelector('.image-intent-card')).toBeNull()
    editor.value = '你好'; editor.dispatchEvent(new Event('input'))
    send()
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(1) })
    expect(vi.mocked(agent.submit).mock.calls[0]![1].text).toBe('你好')
    expect(requests.filter(row => row.path.includes('/ai/images/generations'))).toHaveLength(1)
    releaseGenerate?.(Response.json({ data: [{ b64_json: 'QQ==' }], qianshou: { mime_type: 'image/jpeg' } }))
    await vi.waitFor(() => { expect(document.querySelector('.generated-image')).not.toBeNull() })
    expect(agent.submit).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('本轮响应未完成')
  })

  it('sends a follow-up after 给我出个图 to the image gateway, not the Agent Session', async () => {
    workers = fixtureWorkers(1, 20)
    const accountFetch = window.fetch
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw)
      if (path.endsWith('/api/qianshou/ai/images/generations')) {
        const body = init?.body
        if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('TEST_EXPECTS_JSON_BODY')
        requests.push({ path, body: body ? JSON.parse(body) : null })
        return Response.json({ data: [{ b64_json: 'QQ==' }], qianshou: { mime_type: 'image/jpeg' } })
      }
      return accountFetch(input, init)
    })
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('image-follow-session') }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await boot(); byText('登录').click()
    field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-status"]')?.textContent).toBe('') })
    const editor = document.querySelector('textarea')!
    const send = (): void => { document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click() }
    editor.value = '给我出个图'; editor.dispatchEvent(new Event('input'))
    send()
    await vi.waitFor(() => { expect(document.querySelector('.image-intent-card')).not.toBeNull() })
    expect(document.body.textContent).toContain('想画什么')
    expect(document.querySelector('.image-confirm')).toBeNull()
    expect(agent.submit).not.toHaveBeenCalled()
    editor.value = '雨夜赛博城市'; editor.dispatchEvent(new Event('input'))
    send()
    await vi.waitFor(() => { expect(document.querySelector('.generated-image')).not.toBeNull() })
    expect(requests.filter(row => row.path.includes('/ai/intent'))).toHaveLength(0)
    expect(requests.filter(row => row.path.includes('/ai/images/generations'))).toHaveLength(1)
    expect((requests.find(row => row.path.includes('/ai/images/generations'))?.body as { prompt?: string }).prompt).toContain('雨夜赛博城市')
    expect(agent.submit).not.toHaveBeenCalled()

    // A normal acknowledgement must not clear the completed image anchor. A
    // later bare redraw should still return to the image gateway instead of
    // becoming an Agent turn that says image generation is unavailable.
    editor.value = '真好看'; editor.dispatchEvent(new Event('input'))
    send()
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(1) })
    editor.value = '还想再要一张'; editor.dispatchEvent(new Event('input'))
    send()
    await vi.waitFor(() => { expect(requests.filter(row => row.path.includes('/ai/images/generations'))).toHaveLength(2) })
    const redraw = requests.filter(row => row.path.includes('/ai/images/generations'))[1]?.body as { prompt?: string }
    expect(redraw.prompt).toContain('雨夜赛博城市')
    expect(agent.submit).toHaveBeenCalledTimes(1)
    expect(document.body.textContent).not.toContain('正在处理这轮消息')
  })

  it('keeps the composer text field usable after a real image file is attached', async () => {
    await boot()
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image"]')
    expect(fileInput).not.toBeNull()
    const file = new File([new Uint8Array([1, 2, 3])], 'cat.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [file] })
    fileInput!.dispatchEvent(new Event('change'))
    await vi.waitFor(() => { expect(document.querySelector('.composer-attachment')).not.toBeNull() })
    const editor = document.querySelector('textarea')!
    expect(editor.disabled).toBe(false)
    editor.value = '改成夜景'
    editor.dispatchEvent(new Event('input'))
    expect(editor.value).toBe('改成夜景')
  })

  it('turns 随便 into a concrete gateway prompt, then POSTs generations once', async () => {
    workers = fixtureWorkers(1, 20)
    const accountFetch = window.fetch
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw)
      if (path.endsWith('/api/qianshou/ai/images/generations')) {
        const body = init?.body
        if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('TEST_EXPECTS_JSON_BODY')
        requests.push({ path, body: body ? JSON.parse(body) : null })
        return Response.json({ data: [{ b64_json: 'QQ==' }], qianshou: { mime_type: 'image/jpeg' } })
      }
      return accountFetch(input, init)
    })
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('image-freeform-session') }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await boot(); byText('登录').click()
    field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-status"]')?.textContent).toBe('') })
    const editor = document.querySelector('textarea')!
    const send = (): void => { document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click() }
    editor.value = '给我出图'; editor.dispatchEvent(new Event('input'))
    send()
    await vi.waitFor(() => { expect(document.querySelector('.image-intent-card')).not.toBeNull() })
    editor.value = '随便'; editor.dispatchEvent(new Event('input'))
    send()
    await vi.waitFor(() => { expect(document.querySelector('.generated-image')).not.toBeNull() })
    const generation = requests.find(row => row.path.includes('/ai/images/generations'))?.body as { prompt?: string }
    expect(generation.prompt).toBe(inventImageSubject())
    expect(generation.prompt).not.toContain('随便')
    expect(agent.submit).not.toHaveBeenCalled()
  })

  it('does not depend on a deployed intent HTTP route before image admission', async () => {
    workers = fixtureWorkers(1, 20)
    const accountFetch = window.fetch
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw)
      if (path.endsWith('/api/qianshou/ai/intent')) {
        const body = init?.body
        if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('TEST_EXPECTS_JSON_BODY')
        requests.push({ path, body: body ? JSON.parse(body) : null })
        return new Response(null, { status: 404 })
      }
      if (path.endsWith('/api/qianshou/ai/images/generations')) {
        const body = init?.body
        if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('TEST_EXPECTS_JSON_BODY')
        requests.push({ path, body: body ? JSON.parse(body) : null })
        return Response.json({ data: [{ b64_json: 'QQ==' }], qianshou: { mime_type: 'image/jpeg' } })
      }
      return accountFetch(input, init)
    })
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('image-fallback-session') }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await boot(); byText('登录').click()
    field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-status"]')?.textContent).toBe('') })
    const editor = document.querySelector('textarea')!
    editor.value = '生成一张雨夜赛博城市海报，16:9，不要文字'
    editor.dispatchEvent(new Event('input'))
    document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click()
    await vi.waitFor(() => { expect(document.querySelector('.generated-image')).not.toBeNull() })
    expect(requests.filter(row => row.path.includes('/ai/intent'))).toHaveLength(0)
    expect(requests.filter(row => row.path.includes('/ai/images/generations'))).toHaveLength(1)
    expect(agent.submit).not.toHaveBeenCalled()
  })

  it('keeps 出个小狗图 on the wait card with a progress bar, and hides leftover Agent turn failure', async () => {
    workers = fixtureWorkers(1, 20)
    const accountFetch = window.fetch
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw)
      if (path.endsWith('/api/qianshou/ai/images/generations')) {
        const body = init?.body
        if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('TEST_EXPECTS_JSON_BODY')
        requests.push({ path, body: body ? JSON.parse(body) : null })
        return Response.json({ ok: false, code: 'AUTH_REQUIRED' }, { status: 401 })
      }
      return accountFetch(input, init)
    })
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('puppy-session') }),
      inspect: async binding => ({
        binding, status: 'idle', turns: [],
        activity: [{ id: 'stale-turn', kind: 'turn', name: 'agent-turn', state: 'failed' }],
      }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await boot(); byText('登录').click()
    field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-status"]')?.textContent).toBe('') })
    const editor = document.querySelector('textarea')!
    editor.value = '出个小狗图'; editor.dispatchEvent(new Event('input'))
    document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click()
    await vi.waitFor(() => { expect(document.body.textContent).toContain('出图通道没有认到这次登录，图还没交到号池。') })
    expect(document.querySelector('[data-testid^="image-wait-progress-"]')).not.toBeNull()
    expect(document.querySelector('.image-wait-card-failed')).not.toBeNull()
    expect(document.body.textContent).not.toContain('本轮响应未完成')
    expect(document.body.textContent).not.toContain('出图没有完成，请稍后重试')
    expect(agent.submit).not.toHaveBeenCalled()
    expect(requests.filter(row => row.path.includes('/ai/images/generations'))).toHaveLength(1)
  })

  it('lifts a finished picture with later chat instead of pinning it under the newest turn', async () => {
    workers = fixtureWorkers(1, 20)
    let later = false
    const laterAt = Date.now() + 60_000
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('lift-session') }),
      inspect: async binding => ({
        binding,
        status: 'idle',
        turns: later
          ? [
            { id: 'later-user', role: 'user' as const, text: '下一句', at: laterAt },
            { id: 'later-assistant', role: 'assistant' as const, text: '**收到**\n\n表格如下：\n\n| 项 | 值 |\n| --- | --- |\n| 图 | 已生成 |', at: laterAt + 1 },
          ]
          : [],
      }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => {
        later = true
        return { binding, requestId: request.requestId, state: 'received' as const }
      }),
    }
    window.qianshouMobileHost = { agent }
    const accountFetch = window.fetch
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw)
      if (path.endsWith('/api/qianshou/ai/images/generations')) {
        const body = init?.body
        if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('TEST_EXPECTS_JSON_BODY')
        requests.push({ path, body: body ? JSON.parse(body) : null })
        return Response.json({ data: [{ b64_json: 'QQ==' }], qianshou: { mime_type: 'image/jpeg' } })
      }
      return accountFetch(input, init)
    })
    await boot(); byText('登录').click()
    field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-status"]')?.textContent).toBe('') })
    const editor = document.querySelector('textarea')!
    const send = (): void => { document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click() }
    editor.value = '生成一张雨夜赛博城市海报，16:9，不要文字'
    editor.dispatchEvent(new Event('input'))
    send()
    await vi.waitFor(() => { expect(document.querySelector('.generated-image')).not.toBeNull() })
    editor.value = '下一句'; editor.dispatchEvent(new Event('input')); send()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-turn-later-assistant"]')).not.toBeNull() })
    const order = [...document.querySelector('[data-testid="mobile-transcript"]')!.children]
      .map(node => (node as HTMLElement).dataset.testid)
    const imageIndex = order.findIndex(id => id?.startsWith('generated-image-'))
    const laterIndex = order.indexOf('mobile-turn-later-assistant')
    expect(imageIndex).toBeGreaterThanOrEqual(0)
    expect(laterIndex).toBeGreaterThan(imageIndex)
    expect(document.querySelector('.message-markdown strong')?.textContent).toBe('收到')
    expect(document.querySelector('.message-table th')?.textContent).toBe('项')
  })

  it('sends 你好 through the Agent Session even after a leftover failed turn', async () => {
    workers = fixtureWorkers(1, 20)
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('hello-session') }),
      inspect: async binding => ({
        binding, status: 'idle', turns: [],
        activity: [{ id: 'stale-turn', kind: 'turn', name: 'agent-turn', state: 'failed' }],
      }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    const accountFetch = window.fetch
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw)
      if (path.endsWith('/api/qianshou/ai/images/generations')) {
        const body = init?.body
        if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('TEST_EXPECTS_JSON_BODY')
        requests.push({ path, body: body ? JSON.parse(body) : null })
        return Response.json({ data: [{ b64_json: 'QQ==' }], qianshou: { mime_type: 'image/jpeg' } })
      }
      return accountFetch(input, init)
    })
    await boot(); byText('登录').click()
    field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-status"]')?.textContent).toBe('') })
    expect(document.body.textContent).toContain('这次回复没能完成。')
    expect(document.body.textContent).not.toContain('本轮响应未完成')
    const editor = document.querySelector('textarea')!
    const send = (): void => { document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click() }
    editor.value = '生成一张雨夜赛博城市海报，16:9，不要文字'
    editor.dispatchEvent(new Event('input')); send()
    await vi.waitFor(() => { expect(document.querySelector('.generated-image')).not.toBeNull() })
    editor.value = '你好'; editor.dispatchEvent(new Event('input')); send()
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalled() })
    expect(vi.mocked(agent.submit).mock.calls[0]![1].text).toBe('你好')
    expect(requests.filter(row => row.path.includes('/ai/images/generations'))).toHaveLength(1)
  })

  it('redraws from 不满意 inside two turns, and opens the picture for download', async () => {
    workers = fixtureWorkers(1, 20)
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('redo-session') }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    const accountFetch = window.fetch
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw)
      if (path.endsWith('/api/qianshou/ai/images/generations')) {
        const body = init?.body
        if (body !== undefined && body !== null && typeof body !== 'string') throw new Error('TEST_EXPECTS_JSON_BODY')
        requests.push({ path, body: body ? JSON.parse(body) : null })
        return Response.json({ data: [{ b64_json: 'QQ==' }], qianshou: { mime_type: 'image/jpeg' } })
      }
      return accountFetch(input, init)
    })
    await boot(); byText('登录').click()
    field('用户名或邮箱').value = 'preview-test'; field('密码').value = 'test-password'; submit()
    await vi.waitFor(() => { expect(field('动态验证码')).not.toBeNull() })
    field('动态验证码').value = '123456'; submit()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="mobile-status"]')?.textContent).toBe('') })
    const editor = document.querySelector('textarea')!
    const send = (): void => { document.querySelector<HTMLButtonElement>('[aria-label="发送消息"]')!.click() }
    editor.value = '生成一张雨夜赛博城市海报，16:9，不要文字'
    editor.dispatchEvent(new Event('input')); send()
    await vi.waitFor(() => { expect(document.querySelector('.generated-image')).not.toBeNull() })
    document.querySelector<HTMLButtonElement>('[data-testid^="generated-image-open-"]')!.click()
    await vi.waitFor(() => { expect(document.querySelector('[data-testid="image-lightbox"]')?.hasAttribute('open') || (document.querySelector('[data-testid="image-lightbox"]') as HTMLDialogElement).open).toBeTruthy() })
    expect(document.body.textContent).toContain('下载')
    expect(document.body.textContent).toContain('重新出')
    document.querySelector<HTMLDialogElement>('[data-testid="image-lightbox"]')?.close()
    editor.value = '不满意'; editor.dispatchEvent(new Event('input')); send()
    await vi.waitFor(() => {
      expect(requests.filter(row => row.path.includes('/ai/images/generations')).length).toBe(2)
    })
    expect(agent.submit).not.toHaveBeenCalled()
  })

  it('keeps attachment and latest-result edit sources isolated and routes edits separately from generations', async () => {
    workers = fixtureWorkers(1, 1)
    const imageCalls: { path: string; body: Record<string, unknown> }[] = []
    const accountFetch = window.fetch
    window.fetch = vi.fn<typeof window.fetch>(async (input, init) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const path = raw.startsWith('http') ? new URL(raw).pathname : (raw.split('?')[0] ?? raw)
      if (path.endsWith('/api/qianshou/ai/images/generations') || path.endsWith('/api/qianshou/ai/images/edits')) {
        if (typeof init?.body !== 'string') throw new Error('TEST_EXPECTS_JSON_BODY')
        const body = JSON.parse(init.body) as Record<string, unknown>
        imageCalls.push({ path, body })
        return Response.json({ data: [{ b64_json: 'Qg==' }], qianshou: { mime_type: 'image/png' } })
      }
      return accountFetch(input, init)
    })
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId('edit-isolation') }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await loginReady()
    const fileInput = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image"]')!
    const original = new File([new Uint8Array([137, 80, 78, 71])], 'original.png', { type: 'image/png' })
    Object.defineProperty(fileInput, 'files', { configurable: true, value: [original] })
    fileInput.dispatchEvent(new Event('change'))
    expect(document.querySelector('.composer-attachment')).not.toBeNull()

    sendText('修改图片')
    await vi.waitFor(() => { expect(document.body.textContent).toContain('想修改哪里？') })
    expect(imageCalls).toHaveLength(0)
    sendText('背景改蓝')
    await vi.waitFor(() => { expect(imageCalls).toHaveLength(1) })
    expect(imageCalls[0]!.path).toContain('/ai/images/edits')
    expect(imageCalls[0]!.body).toMatchObject({ model: '千手·绘画', n: 1, response_format: 'b64_json' })
    expect(String(imageCalls[0]!.body.prompt)).toContain('背景改蓝')
    expect(String(imageCalls[0]!.body.image)).toMatch(/^data:image\/png;base64,/)
    expect(String(imageCalls[0]!.body.image)).not.toContain('original.png')
    await vi.waitFor(() => { expect(document.querySelector('.generated-image')).not.toBeNull() })

    document.querySelector<HTMLButtonElement>('[data-testid^="generated-image-open-"]')!.click()
    byText('重新出').click()
    await vi.waitFor(() => { expect(imageCalls).toHaveLength(2) })
    expect(imageCalls[1]!.path).toContain('/ai/images/edits')
    expect(imageCalls[1]!.body.image).toBe(imageCalls[0]!.body.image)

    sendText('真好看')
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(1) })
    await vi.waitFor(() => { expect(document.querySelector('textarea')!.value).toBe('') })
    expect(imageCalls).toHaveLength(2)

    sendText('再亮一点')
    await vi.waitFor(() => { expect(imageCalls).toHaveLength(3) })
    expect(imageCalls[2]!.path).toContain('/ai/images/edits')
    expect(imageCalls[2]!.body.image).toBe('data:image/png;base64,Qg==')

    sendText('还想要一个小狗的')
    await vi.waitFor(() => { expect(imageCalls).toHaveLength(4) })
    expect(imageCalls[3]!.path).toContain('/ai/images/generations')
    expect(imageCalls[3]!.body).not.toHaveProperty('image')
    expect(String(imageCalls[3]!.body.prompt)).toContain('还想要一个小狗的')
    expect(agent.submit).toHaveBeenCalledTimes(1)
  })

  it('clears an unsent original on Session switch and cannot edit the old Session source', async () => {
    let count = 0
    const agent: MobileAgentSessionPort = {
      open: async accountId => ({ accountId, sessionId: SessionId(`isolated-original-${++count}`) }),
      inspect: async binding => ({ binding, status: 'idle', turns: [] }),
      submit: vi.fn<MobileAgentSessionPort['submit']>(async (binding, request) => ({ binding, requestId: request.requestId, state: 'received' as const })),
    }
    window.qianshouMobileHost = { agent }
    await loginReady()
    const input = document.querySelector<HTMLInputElement>('input[type="file"][accept*="image"]')!
    Object.defineProperty(input, 'files', { configurable: true, value: [new File(['original'], 'private.png', { type: 'image/png' })] })
    input.dispatchEvent(new Event('change'))
    expect(document.querySelector('.composer-attachment')).not.toBeNull()
    sendText('取消修图')
    await vi.waitFor(() => { expect(document.querySelector('.composer-attachment')).toBeNull() })
    expect(agent.submit).not.toHaveBeenCalled()
    expect(requests.filter(row => row.path.includes('/ai/images/'))).toHaveLength(0)
    input.dispatchEvent(new Event('change'))
    expect(document.querySelector('.composer-attachment')).not.toBeNull()
    byText('新建智能体会话').click()
    await vi.waitFor(() => { expect(count).toBe(2) })
    await vi.waitFor(() => { expect(document.querySelector('.composer-attachment')).toBeNull() })
    sendText('修改这张图片，背景改蓝')
    await vi.waitFor(() => { expect(document.body.textContent).toContain('请先上传要修改的原图') })
    expect(requests.filter(row => row.path.includes('/ai/images/'))).toHaveLength(0)
    sendText('取消')
    await vi.waitFor(() => { expect(agent.submit).toHaveBeenCalledTimes(1) })
    expect(requests.filter(row => row.path.includes('/ai/images/'))).toHaveLength(0)
  })
})
