/** Real shipped composition acceptance for the isolated Qianshou build. */
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MockAdapter } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-session-projection-cache'
import type {} from '@deepseek-ai/dsh-client-connection'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspaceZh } from './support.ts'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import { snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'

const expected = fileURLToPath(new URL('./expected/qianshou-brand/first-run.expected.md', import.meta.url))
// This product suite requires matching built artifacts. Default upstream builds
// retain their own onboarding, so the ordinary upstream lane skips this suite.
describe.skipIf(process.env.DSH_CLIENT_BUILD_PROFILE !== 'qianshou')('Qianshou shipped browser composition', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let consoleState: ReturnType<typeof watchConsole>
  beforeAll(async () => {
    scaffold = await launchWebScaffold({ welcomeNoticePending: true, deepSeekMissingCredential: true, agentPresets: { default: 'qianshou-ceo', roots: [{ path: fileURLToPath(new URL('../../../qianshou/presets', import.meta.url)), trust: 'system' }] } })
    browser = await chromium.launch(process.env.QIANSHOU_TEST_BROWSER === 'chrome' ? { channel: 'chrome' } : {})
    page = await browser.newPage({ locale: 'zh-CN', viewport: { width: 1440, height: 960 }, colorScheme: 'light' })
    consoleState = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  })
  afterAll(async () => { await browser?.close(); await scaffold?.close() })

  it('shows product-owned welcome and does not ask for a vendor account', async () => {
    await page.getByText('欢迎使用千手', { exact: true }).waitFor()
    // Roster arrival is independent of the welcome dialog.
    await page.getByRole('button', { name: 'CEO 模式', exact: true }).waitFor()
    expect(await page.title()).toBe('千手 PC · 开发版')
    await compareOrRefreshGolden(expected, await captureStableAria(page, 'body', scaffold.workspaceCwd), webSnapshotMode())
    await page.getByRole('button', { name: '继续', exact: true }).click()
    await page.getByText('欢迎使用千手', { exact: true }).waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: 'CEO 模式', exact: true }).waitFor()
    expect(await page.locator('body').innerText()).not.toContain('DeepSeek')
    expect(await page.locator('[data-qianshou-brand="mark"]').count()).toBe(2)
    expect(consoleState.pageErrors).toEqual([])
  })

  it('mounts the shipped creator and inspects an owner-provided workflow without exposing values', async () => {
    const handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('qianshou-plugin-workflow-inspection'),
      meta: { cwd: scaffold.workspaceCwd },
      setup: agentCtx => scaffold.ctx.agentPresets.mount(agentCtx, 'qianshou-plugin-creator').then(() => undefined),
    })
    try {
      const names = scaffold.ctx.tools.schemas(handle.agent).map(tool => tool.name)
      expect(names).toContain('plugin_draft_inspect_comfy_workflow')
      expect(names).toContain('plugin_draft_probe_local_comfy')
      expect(names).toContain('plugin_draft_preflight_comfy_workflow')
      expect(names).not.toContain('compute_submit')
      const result = await scaffold.ctx.tools.execute({ agent: handle.agent, signal: new AbortController().signal,
        callId: ToolCallId('qianshou-comfy-inspection'), name: 'plugin_draft_inspect_comfy_workflow', arguments: {
          workflow: { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'owner private prompt' } },
            '2': { class_type: 'SaveImage', inputs: { images: ['1', 0] } } },
        } })
      const content = result.content.find(block => block.type === 'text')
      expect(result.isError).not.toBe(true)
      expect(content?.type === 'text' ? JSON.parse(content.text) : null).toMatchObject({
        nodeCount: 2, textFields: [{ nodeId: '1', field: 'text' }], installable: false,
      })
      expect(JSON.stringify(result)).not.toContain('owner private prompt')
    } finally {
      await handle.dispose()
    }
  })

  it('opens the CEO task window over a real workspace and an empty child catalog', async () => {
    // The welcome case keeps credentials absent. Workspace interaction uses a
    // local route whose empty script rejects any unintended inference call.
    const adapter = new MockAdapter([])
    scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['qianshou-browser-fixture'], adapter))
    await scaffold.ctx.settings.update('agent-default-model', { provider: 'qianshou-browser-fixture', model: 'fixture-model' })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'ceo-workspace')
    await page.getByRole('button', { name: 'CEO 模式', exact: true }).waitFor()
    await page.getByRole('button', { name: '子代理任务', exact: true }).click()
    await page.getByText('CEO 尚未派发子代理任务', { exact: true }).waitFor()
    const inputBounds = await page.locator('[data-composer-input][contenteditable="true"]').first().boundingBox()
    const panelBounds = await page.locator('[data-qianshou-task-panel]').boundingBox()
    expect(inputBounds).not.toBeNull()
    expect(panelBounds).not.toBeNull()
    expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(panelBounds!.x + 1)
    const taskExpected = fileURLToPath(new URL('./expected/qianshou-brand/tasks.expected.md', import.meta.url))
    await compareOrRefreshGolden(taskExpected, await captureStableAria(page, '[data-qianshou-task-panel]', scaffold.workspaceCwd), webSnapshotMode())
    await page.getByRole('button', { name: '派发设置', exact: true }).click()
    const form = page.locator('[data-qianshou-delegation-form]')
    await form.getByLabel('运行方式', { exact: true }).selectOption('continuable')
    await form.getByLabel('专业角色', { exact: true }).selectOption('custom')
    await form.getByLabel('角色名称与特长', { exact: true }).fill('协议验证专员')
    expect(await form.getByLabel('运行方式', { exact: true }).inputValue()).toBe('continuable')
    expect(await form.getByRole('button', { name: '交给 CEO 派发' }).isDisabled()).toBe(true)
    await page.getByRole('button', { name: '任务列表', exact: true }).click()
    await page.getByRole('button', { name: '关闭任务窗口', exact: true }).click()
    await page.getByRole('button', { name: '打开右侧边栏', exact: true }).waitFor()
    await page.waitForFunction(width => document.querySelector('[class*="centerCol"]')!.getBoundingClientRect().width > width,
      inputBounds!.width)
    expect(consoleState.pageErrors).toEqual([])
    expect(adapter.requests).toEqual([])
  })

  it('loads a persisted specialist task and opens its real child conversation in the side panel', async () => {
    // Author a labelled fixture through Host persistence, then exercise the shipped
    // catalog and resource navigation. This is UI integration, not live inference.
    const parent = scaffold.ctx.agents.roots().find(agent =>
      agent.session.header.cwd === join(scaffold.workspaceCwd, 'ceo-workspace'))
    if (parent === undefined) throw new Error('CEO workspace has no parent agent')
    const at = Date.now()
    const header: SessionHeader = {
      version: SESSION_FORMAT_VERSION, id: SessionId('qianshou-specialist-fixture'),
      createdAt: at, isSeeded: false, cwd: join(scaffold.workspaceCwd, 'ceo-workspace'),
      parentSession: parent.id, origin: 'subagent', delegationDepth: 1,
    }
    const events = [
      { type: 'turn/start', seq: 0, time: at, data: { turn: 1 } },
      { type: 'user/message', seq: 1, time: at + 1, surfaceOp: 'append', data: {
        id: '00000000-0000-4000-9000-000000000201', role: 'user',
        content: [{ type: 'text', text: '测试样本：检查工作台布局并提供验收清单。' }], source: { kind: 'user' },
      } },
      { type: 'subagent/descriptor', seq: 2, time: at + 2, data: snapshotSubagentDescriptor({
        mode: 'continuable', provider: 'spawn', label: '界面专家 · 工作台布局（测试样本）',
      }) },
      { type: 'turn/end', seq: 3, time: at + 3, data: { turn: 1, reason: { kind: 'completed' } } },
    ] as SessionEvent[]
    const handle = await scaffold.ctx.sessionPersistence.create(header)
    await handle.append(events)
    await handle.close()
    scaffold.ctx.sessionProjectionCache.coldSnapshot(header, SessionLogOffset(0), events)
    await expect.poll(() => scaffold.ctx.sessionProjectionCache.cachedSnapshot(header, SessionLogOffset(0))).toBeDefined()
    await page.getByRole('button', { name: '子代理任务', exact: true }).click()
    const dialog = page.getByRole('region', { name: '子代理任务' })
    const child = dialog.getByRole('button', { name: /界面专家/ })
    await child.waitFor()
    expect(await child.innerText()).toContain('工作台布局')
    expect(await child.innerText()).toContain('运行模式： 可继续会话')
    await child.click()
    await page.locator('[data-chat-flow-kind="user"]').getByText('测试样本：检查工作台布局并提供验收清单。', { exact: true }).waitFor()
    expect(await page.locator('[data-qianshou-tasks]').count()).toBe(1)
    expect(consoleState.pageErrors).toEqual([])
  })

  it('follows system appearance and preserves readable brand tokens', async () => {
    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--qianshou-brand-ink').trim() === '#0a302b')
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--qianshou-brand-ink').trim() === '#ffffff')
    expect(consoleState.pageErrors).toEqual([])
  })
})
