/** A real Loader and browser retain an unsent draft while authenticated update preparation refuses admission. */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-settings'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { textResponse } from '../../../packages/core/agent-loop/tests/mock-adapter.ts'
import { compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { connectFreshWorkspaceZh, REPO_ROOT, ZH_BROWSER_LOCALE } from './support.ts'

class UpdateBrowserAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  override async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield* textResponse(this.requests.length === 1 ? '初始任务已完成。' : '更新取消后任务正常完成。')
  }
}

describe.skipIf(webSnapshotMode() === 'record')('Qianshou bounded update preparation', () => {
  it('authenticates, blocks a real prompt without losing its draft or writing history, then restores delivery on cancel', async () => {
    const scaffold = await launchWebScaffold({ toolsMode: 'native' })
    const browser = await chromium.launch()
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: ZH_BROWSER_LOCALE, reducedMotion: 'reduce', colorScheme: 'dark' })
    const adapter = new UpdateBrowserAdapter()
    const artifacts = join(REPO_ROOT, '.artifacts/qianshou-update-readiness')
    await mkdir(artifacts, { recursive: true })
    let leaseId: string | undefined
    const api = (suffix: string, body?: object) => scaffold.hostFetch(`/api/qianshou/update-${suffix}`, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    })
    try {
      scaffold.ctx.effect(() => scaffold.ctx.llm.registerAdapter(['update-browser-script'], adapter), 'update acceptance model script')
      await scaffold.ctx.agentDefaultModel.saveSelection({ provider: 'update-browser-script', model: 'keyless' })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
      const input = page.locator('[data-composer-input][contenteditable="true"]').first()
      await input.fill('确认本地测试任务。')
      await input.press('Enter')
      await page.getByText('初始任务已完成。', { exact: true }).waitFor()
      await expect.poll(async () => (await (await api('readiness')).json() as { ready: boolean }).ready).toBe(true)
      const unauthorized = await fetch(new URL('/api/qianshou/update-prepare', scaffold.baseUrl), {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      })
      expect(unauthorized.status).toBe(401)
      const prepared = await api('prepare', {})
      expect(prepared.status).toBe(201)
      const lease = await prepared.json() as { leaseId: string; expiresAt: number }
      leaseId = lease.leaseId
      const root = scaffold.ctx.agents.get(adapter.requests[0]!.sessionId!)!
      const before = root.session.snapshotEvents()
      const draft = '这条输入要保留，取消更新后再执行。'
      await input.fill(draft)
      expect(await input.innerText()).toBe(draft)
      await input.press('Enter')
      const refusal = page.getByText('正在准备更新，请稍后重试；本次输入未提交。 (update/preparing)', { exact: true })
      await refusal.waitFor()
      await compareOrRefreshGolden(join(REPO_ROOT, 'apps/web/tests/expected/qianshou-update-refusal.expected.md'), await refusal.ariaSnapshot(), webSnapshotMode())
      expect(await input.innerText()).toBe(draft)
      expect(adapter.requests).toHaveLength(1)
      expect(root.session.snapshotEvents()).toEqual(before)
      expect(root.inbox.nextTurn).toEqual([])
      expect((await api('commit', { leaseId })).status).toBe(200)
      const holding: unknown = await (await api('readiness')).json()
      await page.screenshot({ path: join(artifacts, '01-refused-draft-preserved.png'), fullPage: true })
      expect(await (await api('cancel', { leaseId })).json()).toEqual({ released: true })
      leaseId = undefined
      await input.press('Enter')
      await page.getByText('更新取消后任务正常完成。', { exact: true }).waitFor()
      expect(adapter.requests).toHaveLength(2)
      expect(await input.innerText()).toBe('')
      expect(root.session.snapshotEvents().filter(event => event.type === 'user/message' && event.data.source.kind === 'user')).toHaveLength(2)
      await scaffold.ctx.sessions.flush(root.session)
      await page.screenshot({ path: join(artifacts, '02-resumed-delivery.png'), fullPage: true })
      await writeFile(join(artifacts, 'result.json'), JSON.stringify({ cookieRequired: unauthorized.status === 401, holding, preservedDraft: draft, modelCalls: adapter.requests.length, acceptedMessages: 2 }, null, 2))
    } finally {
      if (leaseId !== undefined) await api('cancel', { leaseId })
      await browser.close()
      await scaffold.close()
    }
  })
})
