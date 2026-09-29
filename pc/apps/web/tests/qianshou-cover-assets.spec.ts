import { readFile } from 'node:fs/promises'
import type { Plugin, UserConfig } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs() })

it.each(['qianshou', 'official'])('publishes the actual local category atlas only in %s product output', async (profile) => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', profile)
  vi.resetModules()
  const { default: raw } = await import('../vite.config.ts')
  const config = raw as UserConfig
  const plugin = config.plugins?.find(value => value && typeof value === 'object' && 'name' in value
    && value.name === 'dsh-qianshou-guide-assets') as Plugin
  if (typeof plugin?.generateBundle !== 'function') throw new Error('product static asset emitter is unavailable')
  const emitted: Array<{ type: string; fileName?: string; source: string | Uint8Array }> = []
  await plugin.generateBundle.call({ emitFile: (asset: typeof emitted[number]) => { emitted.push(asset); return 'asset' } } as never,
    {} as never, {}, false)
  const cover = emitted.find(asset => asset.fileName === 'assets/qianshou-skill-category-atlas.png')
  if (profile === 'official') { expect(cover).toBeUndefined(); return }
  expect(cover).toBeDefined()
  const bytes = await readFile(new URL('../../../packages/client/ui-qianshou/src/client/assets/skill-category-atlas-v2.png', import.meta.url))
  expect(cover!.source).toEqual(bytes)
  expect(bytes.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
  expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1536, 1024])
})

it.each(['qianshou', 'official'])('preserves response DOM against automatic translation only for %s', async (profile) => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', profile)
  vi.resetModules()
  const { default: raw } = await import('../vite.config.ts')
  const plugin = raw.plugins?.find(value => value && typeof value === 'object' && 'name' in value
    && value.name === 'dsh-client-document-title') as Plugin
  if (typeof plugin?.transformIndexHtml !== 'function') throw new Error('document projection unavailable')
  const input = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  const output = await plugin.transformIndexHtml(input, {} as never)
  expect(typeof output).toBe('string')
  if (typeof output !== 'string') throw new Error('HTML document expected')
  expect(output).toContain(profile === 'qianshou' ? '<html lang="zh-CN" translate="no">' : '<html lang="en">')
  if (profile === 'official') expect(output).not.toContain('translate="no"')
  expect(output).toContain('<div id="root"></div>')
  expect(output).toContain('<script type="module" src="/src/main.ts"></script>')
})
