import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { preview } from 'vite'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.QIANSHOU_PLAYWRIGHT_MODULE || 'playwright')
const root = fileURLToPath(new URL('../', import.meta.url))

test('phone registration explains enterprise access and links to the real inquiry page', async () => {
  const server = await preview({ configFile: false, root, preview: { host: '127.0.0.1', port: 0 } })
  const browser = await chromium.launch({ headless: true })
  try {
    const address = server.httpServer.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}`
    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } })
      const pageErrors = []
      const postRequests = []
      page.on('pageerror', error => pageErrors.push(error.message))
      page.on('request', request => {
        if (request.method() === 'POST') postRequests.push(request.url())
      })
      try {
        await page.goto(`${base}/#/register`, { waitUntil: 'networkidle' })
        const note = page.locator('.phone-enterprise-note')
        await note.waitFor()
        assert.match(await note.innerText(), /手机号先创建个人账号/)
        assert.match(await note.innerText(), /需审核开通/)
        assert.equal(await page.locator('.register-role').count(), 0)
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width)

        await page.getByRole('tab', { name: '账号密码' }).click()
        await page.locator('.register-role').waitFor()
        assert.match(await page.locator('.register-role').innerText(), /企业用途登记/)
        await page.getByRole('tab', { name: '手机号注册' }).click()
        await note.getByRole('link', { name: '提交合作需求' }).click()
        await page.locator('form.apply-form').waitFor()
        assert.equal(new URL(page.url()).hash, '#/beta')
        assert.deepEqual(postRequests, [])
        assert.deepEqual(pageErrors, [])
      } finally {
        await page.close()
      }
    }
  } finally {
    await browser.close()
    await new Promise((resolve, reject) => server.httpServer.close(error => error ? reject(error) : resolve()))
  }
})
