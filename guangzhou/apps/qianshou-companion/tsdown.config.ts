import { defineConfig } from 'tsdown'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { buildUpdater } from '../qianshou-updater/build.mjs'

export default defineConfig({
  entry: ['src/main.ts', 'src/peer.ts', 'src/executor.ts'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024',
  fixedExtension: false, dts: false, clean: false,
  deps: {
    neverBundle: ['electron'],
    alwaysBundle: ['ws', /^@deepseek-ai\/dsh-host-remote-devices(?:\/.*)?$/],
    onlyBundle: ['ws', /^@deepseek-ai\/dsh-host-remote-devices(?:\/.*)?$/],
  },
  hooks: { 'build:done': async () => {
    await mkdir('lib', { recursive: true })
    for (const file of ['index.html', 'renderer.js', 'style.css', 'preload.cjs']) await copyFile(`src/${file}`, `lib/${file}`)
    try {
      const previous = JSON.parse(await readFile('lib/updater/BUILD_MANIFEST.json', 'utf8'))
      if (previous.source !== 'apps/qianshou-updater' || previous.runtime !== 'bundled-node22') throw new Error('Unknown updater build output; preserve it before rebuilding')
      await rm('lib/updater', { recursive: true })
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await buildUpdater('lib/updater')
  } },
})
