import { afterEach, expect, it, vi } from 'vitest'
import type { Translate } from '../src/client/presentation.ts'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

it.each([
  ['qianshou', '技能中心', 'Skills center'],
  ['official', '插件', 'Plugins'],
] as const)('keeps one product navigation name and the upstream name in %s', async (profile, chinese, english) => {
  vi.stubEnv('DSH_CLIENT_BUILD_PROFILE', profile)
  vi.resetModules()
  const { zh, en } = await import('../src/client/locales.ts')
  expect(zh.panel).toBe(chinese)
  expect(zh.title).toBe(chinese)
  expect(en.panel).toBe(english)
  expect(en.title).toBe(english)
  const { packageText, packageRowText } = await import('../src/client/presentation.ts')
  for (const dictionary of [zh, en]) {
    const values: Readonly<Record<string, string>> = { ...dictionary }
    const t: Translate = (key) => {
      const value = values[key]
      if (value === undefined) throw new Error(`missing real manager locale: ${key}`)
      return value
    }
    expect(packageText({ name: 'dshmarket', displayName: 'raw title', description: 'raw description' }, t)).toEqual({
      title: dictionary.builtinPluginMarketTitle,
      description: dictionary.builtinPluginMarketDescription,
      beta: false,
    })
    expect(packageRowText('dshmarket', 'dsh-market', t)).toBe(dictionary.builtinPluginMarketRow)
    expect(packageRowText('dshmarket', 'author-row', t)).toBe('author-row')
  }
  expect(zh.builtinPluginMarketTitle).toBe(profile === 'qianshou' ? '技能中心' : '插件市场')
  expect(zh.builtinPluginMarketRow).toBe(profile === 'qianshou' ? '技能中心界面' : '插件市场界面')
  expect(en.builtinPluginMarketTitle).toBe(profile === 'qianshou' ? 'Skills center' : 'Plugin market')
  expect(en.builtinPluginMarketRow).toBe(profile === 'qianshou' ? 'Skills center interface' : 'Plugin market interface')
  // Plugin discovery is still a distinct real inventory destination.
  expect(zh.catalogLocal).toBe('本机插件')
  expect(en.catalogLocal).toBe('Local plugins')
})
