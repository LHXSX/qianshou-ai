import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { preview } from 'vite'

const require = createRequire(import.meta.url)
const { chromium } = require(process.env.QIANSHOU_PLAYWRIGHT_MODULE || 'playwright')
const root = fileURLToPath(new URL('../', import.meta.url))

test('enterprise page links scroll within the hash route and clear the sticky navigation', async () => {
  const server = await preview({
    configFile: false,
    root,
    preview: { host: '127.0.0.1', port: 0 },
  })
  const browser = await chromium.launch({ headless: true })
  try {
    const address = server.httpServer.address()
    assert.ok(address && typeof address !== 'string')
    const base = `http://127.0.0.1:${address.port}/#/beta`
    const links = [
      ['.nav-links a.active', 'apply'],
      ['.nav-actions a.cta-pill', 'apply'],
      ['.hero-cta a.btn-primary', 'apply'],
      ['.hero-cta a.btn-ghost[href="#/beta"]', 'what'],
      ['.footer-links a:last-child', 'apply'],
    ]

    for (const width of [390, 1280]) {
      const page = await browser.newPage({ viewport: { width, height: 844 }, reducedMotion: 'reduce' })
      const pageErrors = []
      page.on('pageerror', error => pageErrors.push(error.message))
      try {
        for (const [selector, target] of links) {
          await page.goto(base, { waitUntil: 'networkidle' })
          await page.locator(selector).click()
          assert.equal(new URL(page.url()).hash, '#/beta', `${width}px ${selector} changed the hash route`)
          assert.equal(await page.locator('form.apply-form').count(), 1)
          const geometry = await page.evaluate(id => {
            const section = document.getElementById(id)
            const nav = document.querySelector('.beta-page .nav-bar')
            return {
              targetTop: section?.getBoundingClientRect().top,
              navHeight: nav?.getBoundingClientRect().height,
              viewport: innerWidth,
              scrollWidth: document.documentElement.scrollWidth,
            }
          }, target)
          assert.ok(geometry.targetTop >= geometry.navHeight + 8,
            `${width}px ${selector} hidden behind sticky nav: ${JSON.stringify(geometry)}`)
          assert.ok(geometry.targetTop <= geometry.navHeight + 32,
            `${width}px ${selector} did not scroll to target: ${JSON.stringify(geometry)}`)
          assert.equal(geometry.scrollWidth, geometry.viewport, `${width}px horizontal overflow`)
        }
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
