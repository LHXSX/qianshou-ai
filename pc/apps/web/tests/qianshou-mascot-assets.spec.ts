import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { Plugin } from 'vite'
import { afterEach, expect, it, vi } from 'vitest'

afterEach(() => { vi.unstubAllEnvs() })

it.each(['qianshou', 'official'])('emits every waiting mascot at the CSS URL in %s output', async (profile) => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', profile)
  vi.resetModules()
  const { default: raw } = await import('../vite.config.ts')
  const plugin = raw.plugins?.find(value => value && typeof value === 'object' && 'name' in value
    && value.name === 'dsh-qianshou-guide-assets') as Plugin
  if (typeof plugin?.generateBundle !== 'function') throw new Error('static mascot emitter unavailable')
  const emitted: Array<{ type: string; fileName?: string; source: string | Uint8Array }> = []
  await plugin.generateBundle.call({ emitFile: (asset: typeof emitted[number]) => { emitted.push(asset); return 'asset' } } as never,
    {} as never, {}, false)
  const css = await readFile(new URL('../../../packages/client/ui-chat/src/client/chat/RunningQianshouCat.module.css', import.meta.url), 'utf8')
  for (const [file, sha256] of [
    ['qianshou-white-cat-running-e3e16221.png', 'e3e16221de0a94a0f9548b147de5970ad851d8d04802efd0f324c5dd81f528d8'],
    ['qianshou-helper-chase-90b1e1f7.png', '90b1e1f74242897a41d3a4fb06e8d306b2d615aebbab79ed665b37ee55230303'],
    ['qianshou-bichon-chase-54533ea4.png', '54533ea4141adf15933210f4f4337cfadec2972fbaa5025847b811b802bf9b29'],
  ]) {
    const bytes = await readFile(new URL(`../../../packages/client/ui-qianshou/src/client/assets/${file}`, import.meta.url))
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(sha256)
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([1774, 887])
    expect(bytes[25]).toBe(6) // RGBA atlas, including transparency.
    expect(css).toContain(`url('/assets/${file}')`)
    expect(emitted.find(asset => asset.fileName === `assets/${file}`)?.source).toEqual(bytes)
  }
}, 30_000)
