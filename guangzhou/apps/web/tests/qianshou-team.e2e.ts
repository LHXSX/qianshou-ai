/** Keyless assembled-browser proof of real parallel work, CEO voice and floating controls. */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { textResponse, toolCallResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import {
  acknowledgeReloadConnectionLoss, compareOrRefreshGolden, launchWebScaffold, readPersistedEvents,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, REPO_ROOT, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const PROVIDER = 'qianshou-browser-script'
const MODEL = 'isolated-team-model'
const TOOL = 'read_browser_brief'
const INITIAL = '先确认这份家庭阅读文章的目标。'
const PARALLEL = '请独立整理这份文章的提纲。读者是有孩子的家庭，请围绕选书、共读和长期习惯三个方面组织内容，每一部分给出一条今天就能开始的建议。先读取这次任务提供的家庭阅读简报，核对真实要求再撰写，不要编造调查数字，也不要复用没有出处的故事。最后用一句轻松的话邀请家长和孩子一起试一试，并保留这句结尾要求：把阅读变成每天共享的十分钟。'
const SUPPLEMENT = '补充：读者是有孩子的家庭。'
const VOICE = '语气可以再轻松一点吗？'
const EMPLOYEE_FINAL = '员工提纲已核对：三个家庭阅读建议。'
const CEO_VOICE = '可以，我会把语气写得更轻松。'
const CEO_FINAL = '员工已完成，我审阅后交付这份提纲。'
const NESTED_LABEL = '下级审校 · 团队移出验收'
const NESTED_FINAL = '下级审校已完成。'

/** Wait for an explicit test checkpoint while retaining the real agent abort signal. */
async function checkpoint(gate: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (signal === undefined) throw new Error('browser script requires an owned turn signal')
  signal.throwIfAborted()
  let abort!: () => void
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => { reject(signal.reason instanceof Error ? signal.reason : new Error('browser checkpoint aborted', { cause: signal.reason })) }
    signal.addEventListener('abort', abort, { once: true })
  })
  try { await Promise.race([gate, cancelled]) }
  finally { signal.removeEventListener('abort', abort) }
}

/** Script only model output: the Host still owns tool execution, delivery, logs and projections. */
class TeamBrowserAdapter extends LlmAdapter {
  readonly rootGate = Promise.withResolvers<undefined>()
  readonly nestedGate = Promise.withResolvers<undefined>()
  nestedId: SessionId | undefined
  readonly requests: GenerateOptions[] = []
  rootId: SessionId | undefined
  childId: SessionId | undefined
  private readonly calls = new Map<string, number>()
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    const id = options.sessionId
    if (id === undefined) throw new Error('model request omitted its real session id')
    this.rootId ??= id
    const count = (this.calls.get(id) ?? 0) + 1
    this.calls.set(id, count)
    if (id === this.rootId) {
      if (count === 1) await checkpoint(this.rootGate.promise, options.signal)
      const reply = ['我会先确认目标。', '明白，面向有孩子的家庭。', CEO_VOICE, CEO_FINAL][count - 1]
      if (reply === undefined) throw new Error('unexpected extra CEO model call')
      yield* textResponse(reply)
      return
    }
    if (id === this.nestedId) {
      if (count !== 1) throw new Error('unexpected extra nested employee call')
      await checkpoint(this.nestedGate.promise, options.signal)
      yield* textResponse(NESTED_FINAL)
      return
    }
    if (this.childId !== undefined && this.childId !== id) throw new Error('unexpected extra employee')
    this.childId = id
    if (count === 1) yield* toolCallResponse('browser-brief-check', TOOL, {})
    else if (count === 2) yield* textResponse(EMPLOYEE_FINAL)
    else throw new Error('unexpected extra employee model call')
  }
}

type VoiceHarness = {
  requested: number
  stopped: number
  enabled: boolean
  spoken: string[]
  emit(): void
}

/** Browser-only doubles replace audio hardware and playback, never session or input actions. */
function installVoiceHarness(): void {
  const state: VoiceHarness = { requested: 0, stopped: 0, enabled: true, spoken: [], emit: () => {} }
  const track = { get enabled() { return state.enabled }, set enabled(value: boolean) { state.enabled = value },
    getSettings: () => ({ echoCancellation: true }),
    stop() { state.stopped += 1 }, addEventListener() {}, removeEventListener() {} }
  const node = () => ({ connect() {}, disconnect() {} })
  const processor = { ...node(), onaudioprocess: null as null | ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void) }
  Object.defineProperty(navigator.mediaDevices, 'getUserMedia', { configurable: true, value: async () => {
    state.requested += 1
    return { getTracks: () => [track], getAudioTracks: () => [track] }
  } })
  Object.defineProperty(window, 'AudioContext', { configurable: true, value: class {
    sampleRate = 16000
    destination = {}
    createMediaStreamSource() { return node() }
    createScriptProcessor() { return processor }
    createGain() { return { ...node(), gain: { value: 1 } } }
    async resume() {}
    async close() {}
  } })
  let speaking = false
  let speechTimer: ReturnType<typeof setTimeout> | undefined
  Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: {
    get speaking() { return speaking }, getVoices: () => [],
    addEventListener() {}, removeEventListener() {},
    cancel() { clearTimeout(speechTimer); speaking = false },
    speak(utterance: SpeechSynthesisUtterance) {
      state.spoken.push(utterance.text); speaking = true
      utterance.onstart?.(new Event('start') as SpeechSynthesisEvent)
      speechTimer = setTimeout(() => { speaking = false; utterance.onend?.(new Event('end') as SpeechSynthesisEvent) }, 100)
    },
  } })
  state.emit = () => {
    for (let i = 0; i < 8; i++) processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(1600).fill(.15) } })
    for (let i = 0; i < 14; i++) processor.onaudioprocess?.({ inputBuffer: { getChannelData: () => new Float32Array(1600) } })
  }
  Object.assign(window, { __qianshouVoiceTest: state })
}

async function voiceState(page: Page): Promise<Omit<VoiceHarness, 'emit'>> {
  return await page.evaluate(() => {
    const { requested, stopped, enabled, spoken } = (window as unknown as { __qianshouVoiceTest: VoiceHarness }).__qianshouVoiceTest
    return { requested, stopped, enabled, spoken }
  })
}

async function utterance(page: Page): Promise<void> {
  await page.evaluate(() => { (window as unknown as { __qianshouVoiceTest: VoiceHarness }).__qianshouVoiceTest.emit() })
}

async function insideViewport(page: Page, selector: string): Promise<boolean> {
  return await page.locator(selector).evaluate((element) => {
    const box = element.getBoundingClientRect()
    return box.left >= 0 && box.top >= 0 && box.right <= innerWidth + 1 && box.bottom <= innerHeight + 1
  })
}

/** Inspect the real Loader-rendered transcript, composer controls and team region. */
async function conversationGeometry(page: Page) {
  return await page.evaluate(() => {
    const find = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector)
      if (element === null) throw new Error(`missing layout owner: ${selector}`)
      return element
    }
    const rect = (element: Element) => {
      const { x, y, right, bottom, width, height } = element.getBoundingClientRect()
      return { x, y, right, bottom, width, height }
    }
    const main = find('[data-conversation-main]')
    const card = find('[data-composer-card]')
    const composer = rect(card)
    const toolbar = find('[data-composer-actions]')
    const controls = [...toolbar.querySelectorAll<HTMLElement>('button, select')]
      .filter(element => element.getBoundingClientRect().width > 0)
      .map((element) => {
        const box = rect(element)
        const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
        return { label: element.getAttribute('aria-label') ?? element.textContent,
          contained: box.x >= composer.x - 1 && box.right <= composer.right + 1
            && box.y >= composer.y && box.bottom <= composer.bottom + 1,
          reachable: hit === element || element.contains(hit) }
      })
    const panel = document.querySelector('[data-team-dock="expanded"]')
    const back = document.querySelector('[aria-label="回到底部"]')
    return { root: rect(main.closest('[data-phase]')!), main: rect(main),
      transcript: rect(find('[data-chat-flow]')), composer, controls,
      panel: panel === null ? null : rect(panel), back: back === null ? null : rect(back),
      horizontalOverflow: document.documentElement.scrollWidth > innerWidth, viewportHeight: innerHeight }
  })
}

describe.skipIf(webSnapshotMode() === 'record')('Qianshou team and voice browser workflow', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tracing = false
  let tripwire: ReturnType<typeof watchConsole>
  const adapter = new TeamBrowserAdapter()
  const toolGate = Promise.withResolvers<undefined>()
  const events: Array<{ sessionId: string; event: SessionEvent }> = []
  let toolEntered = false
  let briefRead: string | undefined
  let transcriptions = 0
  const screenshots = process.env.DSH_TEAM_E2E_SCREENSHOTS ?? join(REPO_ROOT, '.artifacts/qianshou-team')

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ toolsMode: 'native' })
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter([PROVIDER], adapter), 'Qianshou browser model script')
    await scaffold.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: MODEL })
    await writeFile(join(scaffold.workspaceCwd, 'browser-brief.txt'), '家庭读者；三条可执行建议。')
    scaffold.ctx.effect(() => scaffold.ctx.tools.register(defineContentToolFixture({
      name: TOOL, description: 'Read the isolated browser acceptance brief.', parameters: {},
      async execute(_args, context) {
        toolEntered = true
        await checkpoint(toolGate.promise, context.signal)
        briefRead = await readFile(join(scaffold.workspaceCwd, 'browser-brief.txt'), 'utf8')
        return [{ type: 'text', text: briefRead }]
      },
    })), 'Qianshou browser read-only checkpoint tool')
    scaffold.ctx.on('session/event', (session, event) => { events.push({ sessionId: session.id, event }) })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE, reducedMotion: 'reduce', colorScheme: 'dark' })
    await mkdir(screenshots, { recursive: true })
    await page.context().tracing.start({ screenshots: true, snapshots: true, sources: true })
    tracing = true
    await page.addInitScript(installVoiceHarness)
    await page.route('**/api/forge/voice/status', route => route.fulfill({ json: { available: true, engine: 'whisper.cpp', language: 'zh' } }))
    await page.route('**/api/forge/voice/tts/status', route => route.fulfill({ json: { available: false } }))
    await page.route('**/api/forge/voice/transcribe', async (route) => {
      const wav = route.request().postDataBuffer()
      expect(wav?.subarray(0, 4).toString()).toBe('RIFF')
      expect(wav?.readUInt32LE(24)).toBe(16000)
      expect(wav?.readUInt16LE(22)).toBe(1)
      transcriptions += 1
      await route.fulfill({ json: { text: VOICE } })
    })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  }, 90_000)

  afterAll(async () => {
    adapter.rootGate.resolve(undefined); adapter.nestedGate.resolve(undefined); toolGate.resolve(undefined)
    try {
      if (tracing) await page.context().tracing.stop({ path: join(screenshots, 'trace.zip') })
    }
    finally {
      try { await browser?.close() }
      finally { await scaffold?.close() }
    }
  })

  it('retains one full parallel request across reload while the CEO and employee keep working, with contextual CEO-only voice', async () => {
    onTestFailed(async () => {
      await saveFailureShot(page, 'qianshou-team')
      await writeFile(join(screenshots, 'failure-state.json'), JSON.stringify({
        voice: await voiceState(page), transcriptions,
        requests: adapter.requests.map(request => request.sessionId),
        recentEvents: events.slice(-20).map(({ sessionId, event }) => ({ sessionId, type: event.type, seq: event.seq })),
      }, null, 2))
    })
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    const delivery = page.getByRole('combobox', { name: '任务投递方式', exact: true })
    await input.fill(INITIAL); await input.press('Enter')
    await expect.poll(() => adapter.rootId).toBeDefined()
    const owner = scaffold.ctx.agents.get(adapter.rootId!)
    if (owner === undefined) throw new Error('CEO did not enter a real model turn')
    const rootRequest = adapter.requests.find(request => request.sessionId === adapter.rootId)
    if (rootRequest?.signal === undefined) throw new Error('CEO model turn omitted its owned abort signal')
    expect(owner.status).toBe('running')
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const settings = page.getByRole('dialog', { name: '设置', exact: true })
    await settings.getByRole('button', { name: '紧凑', exact: true }).click()
    await page.getByRole('menuitem', { name: '专注', exact: true }).click()
    await settings.getByRole('button', { name: '专注', exact: true }).waitFor()
    await expect.poll(async () => readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8'))
      .toMatch(/ui-chat:\n\s+transcriptView: focused/)
    await page.keyboard.press('Escape')
    await delivery.selectOption('parallel')
    await input.fill(PARALLEL)
    await page.getByRole('button', { name: '派出独立任务', exact: true }).click()
    await expect.poll(() => toolEntered, { timeout: 15_000 }).toBe(true)
    expect(owner.status).toBe('running')
    const dock = page.locator('[data-team-dock="expanded"]')
    await dock.waitFor({ timeout: 15_000 })
    await dock.getByText('正在调用工具', { exact: true }).waitFor()
    await dock.getByText(TOOL, { exact: true }).waitFor()
    await dock.getByText(`${PROVIDER} / ${MODEL}`, { exact: true }).waitFor()
    const dispatches = events.filter(({ sessionId, event }) => sessionId === adapter.rootId && event.type === 'parallel/dispatched')
    expect(dispatches).toHaveLength(1)
    const dispatch = dispatches[0]?.event
    if (dispatch?.type !== 'parallel/dispatched') throw new Error('parallel admission omitted its parent receipt')
    expect(dispatch.data).toMatchObject({
      parentSessionId: adapter.rootId, childSessionId: adapter.childId,
      message: { id: dispatch.data.messageId, content: [{ type: 'text', text: PARALLEL }], source: { kind: 'user' } },
    })
    expect(events.some(({ sessionId, event }) => sessionId === adapter.childId && event.type === 'tool/call' && event.data.name === TOOL)).toBe(true)
    // Create a real nested employee through the Host, leaving model output scripted.
    const employee = scaffold.ctx.agents.get(adapter.childId!)
    if (employee === undefined) throw new Error('running employee is not resident')
    adapter.nestedId = randomUUID() as SessionId
    await scaffold.ctx.subagents.startContinuable({
      provider: 'fork', childId: adapter.nestedId, label: NESTED_LABEL,
      signal: new AbortController().signal,
      request: { parent: employee, prompt: [{ type: 'text', text: '只审校本次隔离验收的提纲。' }], maxDepth: 3,
        agentOptions: { provider: PROVIDER, model: MODEL } },
    })
    await expect.poll(() => scaffold.ctx.agents.get(adapter.nestedId!)?.status).toBe('running')
    const catalogTrigger = page.getByRole('banner').getByRole('button', { name: /个子代理/ })
    await catalogTrigger.click()
    const teamTree = page.getByRole('tree', { name: '协作团队任务', exact: true })
    const removeEmployee = teamTree.getByRole('button', { name: `将 ${dispatch.data.label} 移出团队`, exact: true })
    await expect.poll(() => removeEmployee.isDisabled()).toBe(true)
    await expect.poll(() => removeEmployee.getAttribute('title')).toContain('仍在运行或排队')
    await page.screenshot({ path: join(screenshots, '05-team-removal-busy-descendant.png'), fullPage: true })
    await page.keyboard.press('Escape')

    const transcript = page.locator('[data-chat-flow]')
    const dispatchedInput = transcript.locator('[data-parallel-dispatch]')
    await expect.poll(() => dispatchedInput.count(), { timeout: 15_000 }).toBe(1)
    expect(await dispatchedInput.getAttribute('data-parallel-dispatch')).toBe(dispatch.data.requestId)
    await dispatchedInput.getByText(PARALLEL, { exact: true }).waitFor()
    await dispatchedInput.getByText('独立任务已派出', { exact: true }).waitFor()
    await expect.poll(() => transcript.getByText(PARALLEL, { exact: true }).count()).toBe(1)
    await transcript.getByText(INITIAL, { exact: true }).waitFor()
    await expect.poll(() => input.textContent()).toBe('')
    const wideGeometry = await conversationGeometry(page)
    expect(wideGeometry.transcript.x).toBeCloseTo(wideGeometry.composer.x, 0)
    expect(wideGeometry.transcript.x - wideGeometry.root.x).toBe(32)
    expect(wideGeometry.composer.right).toBeLessThanOrEqual(wideGeometry.panel!.x)
    expect(wideGeometry.main.right).toBeLessThanOrEqual(wideGeometry.panel!.x)
    expect(wideGeometry.controls.every(control => control.contained && control.reachable)).toBe(true)
    expect(wideGeometry.horizontalOverflow).toBe(false)
    await page.screenshot({ path: join(screenshots, '01-desktop-active-team.png'), fullPage: true })

    await page.setViewportSize({ width: 390, height: 640 })
    await expect.poll(async () => {
      const geometry = await conversationGeometry(page)
      return geometry.transcript.x - geometry.root.x
    }).toBe(16)
    const narrowGeometry = await conversationGeometry(page)
    expect(narrowGeometry.transcript.x).toBeCloseTo(narrowGeometry.composer.x, 0)
    expect(narrowGeometry.panel!.bottom).toBeLessThanOrEqual(narrowGeometry.main.y)
    expect(narrowGeometry.composer.bottom).toBeLessThanOrEqual(narrowGeometry.viewportHeight)
    expect(narrowGeometry.controls.every(control => control.contained && control.reachable)).toBe(true)
    expect(narrowGeometry.horizontalOverflow).toBe(false)
    await page.locator('[data-conversation-scroll]').evaluate((element) => { element.scrollTop = 0 })
    const backToBottom = page.getByRole('button', { name: '回到底部', exact: true })
    await backToBottom.waitFor()
    const scrolledGeometry = await conversationGeometry(page)
    expect(scrolledGeometry.back!.right).toBeCloseTo(scrolledGeometry.transcript.right, 0)
    expect(scrolledGeometry.back!.bottom).toBeLessThan(scrolledGeometry.composer.y)
    await page.screenshot({ path: join(screenshots, '01a-narrow-real-toolbar.png'), fullPage: true })
    await backToBottom.click()
    await backToBottom.waitFor({ state: 'hidden' })
    await dock.getByRole('button', { name: '收起为状态条', exact: true }).click()
    const collapsedGeometry = await conversationGeometry(page)
    expect(collapsedGeometry.main.width).toBe(collapsedGeometry.root.width)
    expect(collapsedGeometry.transcript.x).toBeCloseTo(collapsedGeometry.composer.x, 0)
    await page.locator('[data-team-dock="collapsed"]').click()
    await page.setViewportSize({ width: 1440, height: 1000 })
    await dock.getByText(TOOL, { exact: true }).waitFor()
    await writeFile(join(screenshots, 'layout-geometry.json'), JSON.stringify({
      wide: wideGeometry, narrow: narrowGeometry, scrolled: scrolledGeometry, collapsed: collapsedGeometry,
    }, null, 2))

    // Reload the real view with both turn checkpoints still held. Reopening
    // the parent must neither re-dispatch this request nor abort either worker.
    const warningStart = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await input.waitFor({ timeout: 30_000 })
    await dispatchedInput.getByText(PARALLEL, { exact: true }).waitFor({ timeout: 15_000 })
    acknowledgeReloadConnectionLoss(tripwire, warningStart)
    expect(await dispatchedInput.count()).toBe(1)
    expect(await dispatchedInput.getAttribute('data-parallel-dispatch')).toBe(dispatch.data.requestId)
    expect(await transcript.getByText(PARALLEL, { exact: true }).count()).toBe(1)
    await transcript.getByText(INITIAL, { exact: true }).waitFor()
    expect(scaffold.ctx.agents.get(adapter.rootId!)).toBe(owner)
    expect(owner.status).toBe('running')
    expect(rootRequest.signal.aborted).toBe(false)
    expect(scaffold.ctx.agents.get(adapter.childId!)?.status).toBe('running')
    expect(adapter.requests.filter(request => request.sessionId === adapter.rootId)).toHaveLength(1)
    expect(adapter.requests.filter(request => request.sessionId === adapter.childId)).toHaveLength(1)
    expect(events.filter(({ sessionId, event }) => sessionId === adapter.rootId && event.type === 'parallel/dispatched')).toHaveLength(1)
    await dock.getByText(TOOL, { exact: true }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    await settings.getByRole('button', { name: '专注', exact: true }).waitFor({ timeout: 10_000 })
    await page.keyboard.press('Escape')
    expect(await dispatchedInput.getByText(PARALLEL, { exact: true }).isVisible()).toBe(true)
    await page.screenshot({ path: join(screenshots, '01b-desktop-reloaded-dispatch.png'), fullPage: true })

    await dock.getByRole('button', { name: '收起为状态条', exact: true }).click()
    const rail = page.locator('[data-team-dock="collapsed"]')
    await rail.waitFor()
    expect(await rail.getAttribute('aria-label')).toContain('1 人执行中，共 1 项任务')
    expect(await catalogTrigger.textContent()).toContain('2 个子代理')
    await delivery.selectOption('current')
    await input.fill(SUPPLEMENT); await input.press('Meta+Enter')
    adapter.rootGate.resolve(undefined)
    await page.getByText('明白，面向有孩子的家庭。', { exact: true }).waitFor({ timeout: 15_000 })
    expect(scaffold.ctx.agents.get(adapter.childId!)?.status).toBe('running')
    const humanMessages = events.filter(item => item.event.type === 'user/message' && item.event.data.source.kind === 'user')
    expect(humanMessages.filter(item => JSON.stringify(item.event.data).includes(SUPPLEMENT)).map(item => item.sessionId))
      .toEqual([adapter.rootId])
    expect(humanMessages.filter(item => JSON.stringify(item.event.data).includes(PARALLEL)).map(item => item.sessionId))
      .not.toContain(adapter.rootId)

    // Hardware is touched only after the user's explicit start action.
    expect((await voiceState(page)).requested).toBe(0)
    const voiceEntry = page.locator('[data-composer-voice] [data-composer-voice-entry]')
    await voiceEntry.waitFor()
    expect(await voiceEntry.getByRole('button', { name: '开始语音对话', exact: true }).getAttribute('aria-description')).toBe('语音管家')
    await page.getByRole('button', { name: '开始语音对话', exact: true }).click()
    const pet = page.getByRole('complementary', { name: '千手互动角色', exact: true })
    await pet.getByText('正在聆听', { exact: true }).waitFor()
    await pet.locator('[data-vrm-character="ready"]').waitFor({ timeout: 15_000 })
    expect((await voiceState(page)).requested).toBe(1)
    await page.screenshot({ path: join(screenshots, '02a-desktop-character-compact.png'), fullPage: true })
    await pet.getByRole('button', { name: '更多语音控制', exact: true }).click()
    await pet.getByRole('button', { name: '暂停麦克风', exact: true }).click()
    expect((await voiceState(page)).enabled).toBe(false)
    await utterance(page)
    expect(transcriptions).toBe(0)
    await pet.getByRole('button', { name: '继续聆听', exact: true }).click()
    await pet.getByText('正在聆听', { exact: true }).waitFor()
    await utterance(page)
    await expect.poll(() => transcriptions, { timeout: 15_000 }).toBe(1)
    await transcript.getByText(CEO_VOICE, { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(async () => (await voiceState(page)).spoken, { timeout: 15_000 }).toContain(CEO_VOICE)
    await pet.getByText('正在聆听', { exact: true }).waitFor()
    expect(transcriptions).toBe(1)
    expect(events.filter(item => item.event.type === 'user/message' && item.event.data.source.kind === 'user'
      && JSON.stringify(item.event.data.content).includes(VOICE)).map(item => item.sessionId)).toEqual([adapter.rootId])
    expect(scaffold.ctx.agents.get(adapter.childId!)?.status).toBe('running')

    const handle = pet.getByRole('button', { name: '移动角色', exact: true })
    const before = await pet.boundingBox()
    await handle.focus(); await handle.press('Shift+ArrowLeft')
    expect((await pet.boundingBox())!.x).toBeLessThan(before!.x)
    await pet.getByRole('button', { name: '收起语音控制', exact: true }).click()
    expect(await pet.getByRole('button', { name: '更多语音控制', exact: true }).getAttribute('aria-expanded')).toBe('false')
    expect((await voiceState(page)).enabled).toBe(true)
    await pet.getByRole('button', { name: '更多语音控制', exact: true }).click()
    await page.screenshot({ path: join(screenshots, '02-desktop-voice-companion.png'), fullPage: true })
    await page.setViewportSize({ width: 420, height: 860 })
    await expect.poll(() => insideViewport(page, '[data-character-stage]')).toBe(true)
    expect(await insideViewport(page, '[data-team-dock="collapsed"]')).toBe(true)
    await page.screenshot({ path: join(screenshots, '03-narrow-voice-companion.png'), fullPage: true })
    await pet.getByRole('button', { name: '收起语音控制', exact: true }).click()
    await page.screenshot({ path: join(screenshots, '03a-narrow-character-compact.png'), fullPage: true })

    adapter.nestedGate.resolve(undefined)
    await expect.poll(() => scaffold.ctx.agents.get(adapter.nestedId!)?.status === 'running').toBe(false)
    toolGate.resolve(undefined)
    await expect.poll(() => rail.getAttribute('data-unread'), { timeout: 15_000 }).toBe('true')
    await rail.click()
    await dock.getByText('本轮完成 · 待命', { exact: true }).first().waitFor()
    await dock.getByText(EMPLOYEE_FINAL, { exact: true }).waitFor()
    await expect.poll(async () => (await voiceState(page)).spoken, { timeout: 15_000 }).toContain(CEO_FINAL)
    const spoken = (await voiceState(page)).spoken
    expect(spoken).toEqual([CEO_VOICE, CEO_FINAL])
    expect(spoken).not.toContain(EMPLOYEE_FINAL)
    expect(events.some(item => item.sessionId === adapter.rootId && item.event.type === 'user/message'
      && item.event.data.source.kind === 'subagent-settled')).toBe(true)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.screenshot({ path: join(screenshots, '04-desktop-team-complete.png'), fullPage: true })
    await pet.getByRole('button', { name: '结束语音', exact: true }).click()
    await pet.waitFor({ state: 'detached' })
    expect((await voiceState(page)).stopped).toBe(1)
    const employeeRequests = adapter.requests.filter(request => request.sessionId === adapter.childId)
    expect(employeeRequests).toHaveLength(2)
    expect(briefRead).toBe('家庭读者；三条可执行建议。')
    const toolEvidence = employeeRequests[1]?.messages.flatMap(message => message.content)
      .find(block => block.type === 'tool-result' && block.toolCallId === 'browser-brief-check')
    expect(toolEvidence).toMatchObject({
      type: 'tool-result', content: [{ type: 'text', text: '家庭读者；三条可执行建议。' }],
    })
    expect(events.filter(({ sessionId, event }) => sessionId === adapter.childId && event.type === 'user/message'
      && event.data.source.kind === 'user' && JSON.stringify(event.data.content).includes(PARALLEL))).toHaveLength(1)
    await scaffold.ctx.sessions.flush(owner.session)
    const persisted = await readPersistedEvents(scaffold, owner.id)
    const storedDispatches = persisted.filter(event => event.type === 'parallel/dispatched')
    expect(storedDispatches).toHaveLength(1)
    expect(storedDispatches[0]).toMatchObject({
      type: 'parallel/dispatched',
      data: { requestId: dispatch.data.requestId, message: { content: [{ type: 'text', text: PARALLEL }] } },
    })
    expect(await transcript.getByText(PARALLEL, { exact: true }).count()).toBe(1)
    expect(await transcript.getByText(CEO_FINAL, { exact: true }).isVisible()).toBe(true)

    await catalogTrigger.click()
    await expect.poll(() => removeEmployee.isEnabled()).toBe(true)
    await removeEmployee.click()
    const confirmation = page.getByRole('dialog', { name: `将“${dispatch.data.label}”移出团队？`, exact: true })
    await confirmation.getByText('此任务及全部下级任务将一起移出协作团队，刷新后也不会重新出现。', { exact: true }).waitFor()
    await expect.poll(() => confirmation.getByRole('button', { name: '确认移出团队', exact: true }).isEnabled()).toBe(true)
    await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/qianshou-team-removal.expected.md'),
      await confirmation.ariaSnapshot(), webSnapshotMode())
    await confirmation.getByRole('button', { name: '取消', exact: true }).last().click()
    expect((await scaffold.ctx.subagents.listChildren(owner.id, new AbortController().signal)).some(entry => entry.id === adapter.childId)).toBe(true)
    await catalogTrigger.click()
    await teamTree.getByRole('button', { name: `展开 ${dispatch.data.label} 的下级子代理`, exact: true }).click()
    await teamTree.getByRole('treeitem', { name: new RegExp(NESTED_LABEL) }).waitFor()
    await removeEmployee.click()
    await page.screenshot({ path: join(screenshots, '06-team-removal-confirm.png'), fullPage: true })
    await confirmation.getByRole('button', { name: '确认移出团队', exact: true }).click()
    await confirmation.waitFor({ state: 'detached' })
    await expect.poll(async () => (await scaffold.ctx.subagents.listChildren(owner.id, new AbortController().signal)).length).toBe(0)
    await expect.poll(() => catalogTrigger.count()).toBe(0)
    await expect.poll(() => page.locator('[data-team-dock]').count()).toBe(0)
    await scaffold.ctx.sessions.flush(owner.session)
    const retiredEvents = await readPersistedEvents(scaffold, owner.id)
    expect(retiredEvents.some(event => event.type === 'subagent/retired')).toBe(true)
    const retainedEmployee = await readPersistedEvents(scaffold, adapter.childId!)
    const retainedNested = await readPersistedEvents(scaffold, adapter.nestedId)
    expect(retainedEmployee.some(event => event.type === 'assistant/message')).toBe(true)
    expect(retainedNested.some(event => event.type === 'assistant/message')).toBe(true)
    const retirementReloadWarnings = tripwire.warnings.length
    await page.reload({ waitUntil: 'load' })
    await transcript.getByText(CEO_FINAL, { exact: true }).waitFor({ timeout: 15_000 })
    acknowledgeReloadConnectionLoss(tripwire, retirementReloadWarnings)
    expect(await catalogTrigger.count()).toBe(0)
    expect(await page.locator('[data-team-dock]').count()).toBe(0)
    expect(await transcript.getByText(PARALLEL, { exact: true }).count()).toBe(1)
    await page.screenshot({ path: join(screenshots, '07-team-removal-persisted.png'), fullPage: true })
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 90_000)
})
