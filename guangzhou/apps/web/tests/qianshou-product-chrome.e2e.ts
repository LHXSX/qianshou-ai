/** Forge desktop chrome through the shipped Loader and client bundles; no model requests. */
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { isForgeClientBuild, connectFreshWorkspaceZh, saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

describe.skipIf(!isForgeClientBuild())('Qianshou forge product chrome', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1680, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('shows Qianshou empty home, new chat, catalog models, and Settings About', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-qianshou-product-chrome'))
    expect(await page.getByText('DSH Local Build').count()).toBe(0)
    expect(await page.locator('svg[viewBox="0 0 23.16 17.04"]').count()).toBe(0)
    await page.getByText('千手 AI', { exact: true }).first().waitFor({ timeout: 15_000 })
    await page.getByRole('heading', { name: '你好，我是千手AI' }).waitFor({ timeout: 15_000 })
    await page.getByText('连接全球闲置算力，让复杂的工作变简单').waitFor({ timeout: 10_000 })
    await page.getByRole('button', { name: /智能体协同/ }).waitFor({ timeout: 10_000 })
    await page.getByText('你可以这样问我').waitFor({ timeout: 10_000 })
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd, 'qianshou-chrome')
    await page.getByRole('button', { name: '帮我写一份市场分析' }).click()
    const composer = page.locator('[contenteditable="true"]').first()
    await expect.poll(async () => composer.innerText(), { timeout: 10_000 }).toContain('帮我写一份市场分析')
    expect(tripwire.pageErrors).toEqual([])
    await page.getByRole('button', { name: '新建对话' }).filter({ hasText: '开始一轮新的协作' }).click()
    await page.getByRole('heading', { name: '你好，我是千手AI' }).waitFor({ timeout: 15_000 })
    await page.getByRole('button', { name: '设置', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '设置' })
    await dialog.waitFor({ timeout: 10_000 })
    await dialog.getByRole('button', { name: '模型' }).click()
    await dialog.getByText('填入各提供方的 API 密钥即可使用其模型。').waitFor({ timeout: 10_000 })
    expect(await dialog.innerText()).not.toMatch(/GPT-4o/)
    await dialog.getByRole('button', { name: '关于' }).click()
    await dialog.getByRole('heading', { name: '关于千手' }).waitFor({ timeout: 10_000 })
    await dialog.getByText('基于 DeepSeek Harness 开源项目构建。').waitFor({ timeout: 5_000 })
    await dialog.getByRole('link', { name: '开源技术基础' }).waitFor({ timeout: 5_000 })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'hidden' })
  })
})
