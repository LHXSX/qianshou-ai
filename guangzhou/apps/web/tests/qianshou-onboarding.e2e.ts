/** Forge onboarding through the actual shipped Loader and client bundles; no model requests. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFile, mkdir } from 'node:fs/promises'
import { chromium } from 'playwright'
import { describe, expect, it } from 'vitest'
import { captureStableAria, compareOrRefreshGolden, launchWebScaffold, webSnapshotMode } from './scaffold.ts'
import { isForgeClientBuild } from './support.ts'

const expected = fileURLToPath(new URL('./expected/qianshou-onboarding', import.meta.url))
const evidence = fileURLToPath(new URL('../../../.artifacts/qianshou-onboarding', import.meta.url))

describe.skipIf(!isForgeClientBuild())('Qianshou first-run welcome', () => {
  it.each(['zh', 'en'] as const)('shows the company website in %s without accepting for the user', async (locale) => {
    const scaffold = await launchWebScaffold({ deepSeekMissingCredential: true, welcomeNoticePending: true })
    const browser = await chromium.launch()
    try {
      const page = await browser.newPage({ locale: locale === 'zh' ? 'zh-CN' : 'en-US', viewport: locale === 'zh' ? { width: 390, height: 844 } : { width: 1440, height: 960 } })
      await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      const title = locale === 'zh' ? '欢迎使用千手智能体' : 'Welcome to Qianshou Agent'
      const dialog = page.getByRole('dialog', { name: title })
      await dialog.waitFor({ timeout: 30_000 })
      expect(await dialog.textContent()).toContain('0.2.1')
      expect(await dialog.textContent()).not.toMatch(/DSH 插件生态|Harness 开发者|Harness developers|Harness 0\.1/)
      expect(await dialog.getByRole('link').evaluateAll(links => links.map(link => link.getAttribute('href')))).toEqual(['https://qianshousuanli.com'])
      await compareOrRefreshGolden(join(expected, `${locale}.expected.md`), await captureStableAria(page, '[role="dialog"]', scaffold.workspaceCwd), webSnapshotMode())
      const action = dialog.getByRole('button', { name: locale === 'zh' ? '开始使用' : 'Get started' })
      await action.scrollIntoViewIfNeeded()
      const box = await action.boundingBox()
      expect(box).not.toBeNull()
      expect(box!.y + box!.height).toBeLessThanOrEqual(page.viewportSize()!.height)
      await mkdir(evidence, { recursive: true })
      await page.screenshot({ path: join(evidence, `${locale}-welcome.png`) })
      await page.reload({ waitUntil: 'load' })
      await dialog.waitFor({ timeout: 30_000 })
      const settings = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8').catch(() => '')
      expect(settings).not.toContain('welcomeNoticeVersion: 2026-08-13.1')
      // Only this isolated fixture clicks; the user's actual application is untouched.
      await dialog.getByRole('button', { name: locale === 'zh' ? '开始使用' : 'Get started' }).click()
      const credentials = page.getByRole('dialog', { name: locale === 'zh' ? '接入你的模型接口' : 'Connect your model provider' })
      await credentials.waitFor({ timeout: 15_000 })
      expect(await credentials.textContent()).toContain(locale === 'zh' ? '自己的 DeepSeek API 密钥' : 'your own DeepSeek API key')
      await credentials.getByRole('button', { name: locale === 'zh' ? '稍后配置' : 'Configure later' }).click()
      const saved = await readFile(join(scaffold.harnessHome, 'settings.yaml'), 'utf8')
      expect(saved).toContain('welcomeNoticeVersion: 2026-08-13.1')
      await page.reload({ waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      expect(await page.getByRole('dialog', { name: title }).count()).toBe(0)
    } finally {
      await browser.close()
      await scaffold.close()
    }
  })
})
