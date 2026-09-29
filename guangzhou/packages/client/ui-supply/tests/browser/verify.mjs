/**
 * Narrow-viewport evidence for the supply workspace, in real Chrome.
 *
 * jsdom has no layout, so `tests/narrow.client.spec.ts` can only pin the CSS
 * declarations. This script renders the real page (real stylesheet, real
 * markup) through the repo's Vite dev server and measures the rendered box at
 * phone, tablet and desktop widths: the document must never scroll sideways,
 * and no element's right edge may pass the viewport.
 *
 * Run from the repository root:  node packages/client/ui-supply/tests/browser/verify.mjs
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { createServer } from '../../../../../apps/web/node_modules/vite/dist/node/index.js'
import { chromium } from '../../../../../apps/web/node_modules/playwright/index.mjs'

const web = resolve('apps/web/node_modules')
const output = resolve('.artifacts/ui-supply-narrow')
await mkdir(output, { recursive: true })
const server = await createServer({
  configFile: false,
  root: process.cwd(),
  // This package has no installed node_modules yet, so the harness aliases the
  // few runtime specifiers to their real sources in the repository. Everything
  // else the page imports is the page's own source.
  resolve: {
    alias: [
      { find: /^react$/, replacement: resolve(web, 'react/index.js') },
      { find: /^react\/jsx-runtime$/, replacement: resolve(web, 'react/jsx-runtime.js') },
      { find: /^react-dom\/client$/, replacement: resolve(web, 'react-dom/client.js') },
      { find: '@deepseek-ai/dsh-client-ui-primitives', replacement: resolve('packages/client/ui-supply/tests/browser/primitives.mjs') },
    ],
  },
  server: { host: '127.0.0.1', port: 0 },
})
await server.listen()
const address = server.httpServer.address()
const browser = await chromium.launch({ channel: 'chrome', headless: true })
const evidence = { observedAt: new Date().toISOString(), realChrome: true, realBrowserLayout: true, measurements: [], errors: [] }
try {
  const viewports = [
    { name: 'phone-320', width: 320, height: 640 },
    { name: 'phone-390', width: 390, height: 844 },
    { name: 'tablet-768', width: 768, height: 1024 },
    { name: 'desktop-1280', width: 1280, height: 900 },
  ]
  for (const viewport of viewports) {
    const page = await browser.newPage({ viewport: { width: viewport.width, height: viewport.height } })
    page.on('pageerror', error => evidence.errors.push(`${viewport.name}: ${error.message}`))
    await page.goto(`http://127.0.0.1:${address.port}/packages/client/ui-supply/tests/browser/index.html`)
    await page.waitForSelector('main')
    // React commits the tree asynchronously; wait for the fact rows themselves.
    await page.waitForFunction(() => document.querySelector('[data-fact="voice"] dd') !== null)
    const measured = await page.evaluate(() => {
      const overflowing = [...document.querySelectorAll('main *')]
        .map(element => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0 && rect.right > window.innerWidth + 1)
        .map(({ element, rect }) => ({ tag: element.tagName, className: String(element.className).slice(0, 80), right: Math.round(rect.right) }))
      return {
        innerWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        documentClientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        overflowing,
        harness: globalThis.__supplyFacts(),
      }
    })
    evidence.measurements.push({ viewport: viewport.name, ...measured })
    assert.equal(measured.overflowing.length, 0, `${viewport.name}: elements past the viewport: ${JSON.stringify(measured.overflowing)}`)
    assert.ok(measured.documentScrollWidth <= measured.documentClientWidth + 1,
      `${viewport.name}: document scrolls sideways (${measured.documentScrollWidth} > ${measured.documentClientWidth})`)
    assert.ok(measured.bodyScrollWidth <= measured.documentClientWidth + 1,
      `${viewport.name}: body scrolls sideways (${measured.bodyScrollWidth} > ${measured.documentClientWidth})`)
    if (viewport.name === 'phone-320') {
      assert.equal(measured.harness.voiceFact, measured.harness.unknownVoiceText, 'unreported voice activity must render as unknown')
      assert.deepEqual(measured.harness.reasons, ['HOST_ACTIVITY_UNKNOWN', 'FOREGROUND_PRIORITY', 'USER_ACTIVE', 'SOME_UNRECORDED_HOST_REASON_WITH_A_LONG_CODE'])
      assert.equal(measured.harness.settlementText, '结算尚未接入')
      assert.equal(measured.harness.unknownVramText, true)
      assert.ok(measured.harness.rendered >= 6, 'every labelled surface must be mounted')
    }
    await page.close()
  }
  assert.deepEqual(evidence.errors, [])
  evidence.passed = true
  await writeFile(resolve(output, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
  console.log(JSON.stringify({ passed: true, viewports: evidence.measurements.map(m => `${m.viewport}:${m.documentScrollWidth}/${m.documentClientWidth}`) }, null, 2))
} finally {
  await browser.close()
  await server.close()
}
