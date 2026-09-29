/** Keyless browser regression for the real device page, HTTP routes, and locally approved peer. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CompanionPeer } from '../../qianshou-companion/src/peer.ts'
import type { WorkspaceId } from '@deepseek-ai/dsh-host-remote-devices/protocol'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'
import { REPO_ROOT, ZH_BROWSER_LOCALE } from './support.ts'

let scaffold: WebScaffold | undefined
let browser: Browser | undefined
let page: Page | undefined
let peer: CompanionPeer | undefined
const archiveBytes = Buffer.from('PK synthetic companion archive for authenticated download verification')

beforeAll(async () => {
  scaffold = await launchWebScaffold()
  const downloads = join(scaffold.harnessHome, 'qianshou', 'companion-downloads')
  await mkdir(downloads, { recursive: true })
  const filename = 'qianshou-companion-0.1.0-darwin-arm64.zip'
  await writeFile(join(downloads, filename), archiveBytes)
  await writeFile(join(downloads, 'manifest.json'), JSON.stringify({ version: 1, releases: [{
    id: 'darwin-arm64', version: '0.1.0', filename, bytes: archiveBytes.length,
    sha256: createHash('sha256').update(archiveBytes).digest('hex'), validation: 'local-mac-verified',
  }] }))
  browser = await chromium.launch({ headless: true })
}, 90_000)

afterAll(async () => {
  peer?.stop()
  try { await page?.close() }
  finally {
    try { await browser?.close() }
    finally { await scaffold?.close() }
  }
}, 30_000)

/** Quote a fixed test command for the POSIX or PowerShell executor. */
function shellQuote(value: string): string {
  return process.platform === 'win32'
    ? "'" + value.replaceAll("'", "''") + "'"
    : "'" + value.replaceAll("'", "'\\''") + "'"
}

async function missing(path: string): Promise<boolean> {
  try { await stat(path); return false }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true; throw error }
}

describe('Qianshou device browser workflow', () => {
  it('pairs through the sidebar, submits to the selected workspace, and displays output only after companion approval', async () => {
    if (!scaffold || !browser) throw new Error('Web scaffold did not start')
    const host = scaffold
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE, timezoneId: 'Asia/Shanghai' })
    const ui = page
    const illegalInvocations: string[] = []
    const microphoneRequests: string[] = []
    ui.on('pageerror', (error) => { if (/illegal invocation|illegal receiver/i.test(error.message)) illegalInvocations.push(error.message) })
    ui.on('console', (message) => { if (/illegal invocation|illegal receiver/i.test(message.text())) illegalInvocations.push(message.text()) })
    ui.on('request', (request) => { if (new URL(request.url()).pathname === '/api/forge/voice/transcribe') microphoneRequests.push('transcribe') })
    await ui.goto(host.authenticatedUrl, { waitUntil: 'load' })
    await ui.getByRole('button', { name: '协作设备', exact: true }).click({ timeout: 30_000 })
    await ui.getByRole('heading', { name: '还没有连接协作设备', exact: true }).waitFor()
    await ui.getByRole('heading', { name: '客户端下载与接入指引', exact: true }).waitFor()
    const archiveRoute = '/api/qianshou/companion-downloads/darwin-arm64'
    const unauthenticated = await fetch(new URL(archiveRoute, host.baseUrl))
    expect([401, 403]).toContain(unauthenticated.status)
    const downloadEvent = ui.waitForEvent('download')
    await ui.getByRole('link', { name: '下载到本机', exact: true }).click()
    const download = await downloadEvent
    expect(download.suggestedFilename()).toBe('qianshou-companion-0.1.0-darwin-arm64.zip')
    const downloadedPath = await download.path()
    if (!downloadedPath) throw new Error('Browser did not retain the downloaded archive')
    expect(await readFile(downloadedPath)).toEqual(archiveBytes)
    expect(await ui.getByRole('button', { name: '复制完整接入说明', exact: true }).isDisabled()).toBe(true)
    expect(await ui.getByRole('alert').count()).toBe(0)
    expect(illegalInvocations).toEqual([])

    const voiceStatus = await ui.request.get(new URL('/api/forge/voice/status', host.authenticatedUrl).href)
    expect(voiceStatus.status()).toBe(200)
    const voice: unknown = await voiceStatus.json()
    expect(voice).toMatchObject({ engine: 'whisper.cpp', language: 'zh' })
    expect(voice !== null && typeof voice === 'object' && 'available' in voice && typeof voice.available === 'boolean').toBe(true)

    const pairingResponse = ui.waitForResponse(response => new URL(response.url()).pathname === '/api/qianshou/pairings' && response.request().method() === 'POST')
    await ui.getByRole('button', { name: '配对新设备', exact: true }).click()
    const response = await pairingResponse
    expect(response.status()).toBe(200)
    const pairing = await response.json() as { code: string; wsPath: string }
    expect(pairing.wsPath).toBe('/qianshou-device')
    await ui.getByText('一次性配对码', { exact: true }).waitFor()
    // Keep the ephemeral pairing secret out of assertion diagnostics and console output.
    expect(await ui.locator('strong').evaluateAll((nodes, code) => nodes.some(node => node.textContent === code), pairing.code)).toBe(true)

    const firstWorkspace = join(host.workspaceCwd, 'unused-workspace')
    const chosenWorkspace = join(host.workspaceCwd, 'approved-workspace')
    await mkdir(firstWorkspace); await mkdir(chosenWorkspace)
    const chosenId = 'chosen-browser-workspace' as WorkspaceId
    peer = new CompanionPeer({
      endpoint: new URL(host.authenticatedUrl).origin,
      code: pairing.code,
      hello: { name: '隔离自动化测试设备', platform: process.platform, arch: process.arch, workspaces: [
        { id: 'unused-browser-workspace' as WorkspaceId, name: '未选择目录', path: firstWorkspace },
        { id: chosenId, name: '验收工作区', path: chosenWorkspace },
      ] },
      saveCredential: async () => {},
      saveJobs: async () => {},
      changed: () => {},
    })
    const companion = peer
    companion.connect()
    await expect.poll(() => companion.snapshot().connected, { timeout: 15_000 }).toBe(true)
    await expect.poll(() => ui.getByRole('combobox', { name: '允许的工作区', exact: true }).isEnabled(), { timeout: 10_000 }).toBe(true)
    await ui.getByRole('combobox', { name: '允许的工作区', exact: true }).selectOption(chosenId)
    await ui.getByRole('combobox', { name: '任务类型', exact: true }).selectOption('command')
    const marker = 'qianshou-browser-' + randomUUID()
    const code = `require('node:fs').writeFileSync('browser-proof.txt',${JSON.stringify(marker)});process.stdout.write(${JSON.stringify(marker)})`
    const command = (process.platform === 'win32' ? '& ' : '') + shellQuote(process.execPath) + ' -e ' + shellQuote(code)
    await ui.getByRole('textbox', { name: '命令', exact: true }).fill(command)
    const submittedResponse = ui.waitForResponse(item => new URL(item.url()).pathname === '/api/qianshou/jobs' && item.request().method() === 'POST')
    await ui.getByRole('button', { name: '发送，等待协作端确认', exact: true }).click()
    const submitted = await submittedResponse
    expect(submitted.status()).toBe(200)
    const job = await submitted.json() as { id: string; workspaceId: string }
    expect(job.workspaceId).toBe(chosenId)
    await expect.poll(() => companion.snapshot().jobs.find(item => item.id === job.id)?.status).toBe('awaiting-approval')
    const jobCard = ui.getByRole('article').filter({ hasText: '运行命令 · 隔离自动化测试设备' })
    await jobCard.getByText('等待对方确认', { exact: true }).waitFor()
    expect(await missing(join(chosenWorkspace, 'browser-proof.txt'))).toBe(true)
    expect(await jobCard.locator('pre').count()).toBe(0)

    // This explicit test-side approval substitutes only the companion's local button.
    await companion.approve(job.id)
    await jobCard.getByText('已完成', { exact: true }).waitFor({ timeout: 15_000 })
    expect(await jobCard.locator('pre').first().textContent()).toBe(marker)
    expect(await readFile(join(chosenWorkspace, 'browser-proof.txt'), 'utf8')).toBe(marker)
    expect(await missing(join(firstWorkspace, 'browser-proof.txt'))).toBe(true)
    expect(companion.snapshot().jobs.filter(item => item.id === job.id)).toHaveLength(1)
    expect(await ui.getByRole('alert').count()).toBe(0)
    expect(illegalInvocations).toEqual([])
    expect(microphoneRequests).toEqual([])
    const screenshot = process.env.DSH_DEVICE_E2E_SCREENSHOT ?? join(REPO_ROOT, '.artifacts/qianshou-devices.png')
    await mkdir(dirname(screenshot), { recursive: true })
    await ui.setViewportSize({ width: 1440, height: 1400 })
    await jobCard.scrollIntoViewIfNeeded()
    await ui.screenshot({ path: screenshot, fullPage: true, mask: [ui.getByText(pairing.code, { exact: true })], maskColor: '#d9d5cc' })
  }, 60_000)
})
