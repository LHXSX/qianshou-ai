import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))

test('updater privacy copy keeps DeepSeek Harness only in the footer', async () => {
  const html = await readFile(path.join(dir, '../window.html'), 'utf8')
  const js = await readFile(path.join(dir, '../renderer.js'), 'utf8')
  assert.match(html, /基于 DeepSeek Harness 开源项目构建/)
  assert.match(js, /Built on the open-source DeepSeek Harness project/)
  assert.match(js, /基于 DeepSeek Harness 开源项目构建/)
})
