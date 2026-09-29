// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ThemeRuntime } from '../src/client/index.ts'
import { installThemeStyles } from '../src/client/styles.ts'
import { QIANSHOU_THEMES } from '../src/qianshou-palettes.ts'
import type { ThemeSettings } from '../src/theme-settings.ts'

function luminance(hex: string): number {
  const values = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return values.reduce((sum, value, i) => sum + value * ([0.2126, 0.7152, 0.0722][i] ?? 0), 0)
}

function contrast(a: string, b: string): number {
  const light = Math.max(luminance(a), luminance(b))
  const dark = Math.min(luminance(a), luminance(b))
  return (light + 0.05) / (dark + 0.05)
}

afterEach(() => { vi.unstubAllGlobals() })

describe('Qianshou skin contract', () => {
  it.each(['light', 'dark'] as const)('persists %s through the host scope and rehydrates a fresh runtime', async (id) => {
    const host = stubSettingsScope<ThemeSettings>()
    const ctx = new Context()
    const theme = new ThemeRuntime(ctx, host.scope, 'forge')
    theme.setTheme(id === 'light' ? 'dark' : 'light')
    theme.setTheme(id)
    expect(host.set).toHaveBeenCalledWith('preference', id)
    expect(theme.getTheme().active.id).toBe(id)
    expect(Object.keys(theme.getTheme().active.tokens).length).toBeGreaterThan(75)
    await ctx.fiber.dispose()
    host.publish({ status: 'ready', value: { preference: id, fontSize: 16 }, revision: 8, writable: true })
    const reconnect = new Context()
    const restored = new ThemeRuntime(reconnect, host.scope, 'forge')
    expect(restored.getTheme()).toMatchObject({ preference: id, fontSize: 16, active: { id } })
    expect(restored.getTheme().active.tokens).toEqual(theme.getTheme().active.tokens)
    await reconnect.fiber.dispose()
  })

  it('resolves retired values from an older running Host to light without exposing them', async () => {
    for (const profile of ['forge', 'generic', 'official']) {
      const host = stubSettingsScope<ThemeSettings>()
      host.publish({
        status: 'ready',
        value: { preference: 'qianshou-dopamine', fontSize: 14 } as unknown as ThemeSettings,
        revision: 1,
        writable: true,
      })
      const ctx = new Context()
      const theme = new ThemeRuntime(ctx, host.scope, profile)
      expect(theme.getTheme()).toMatchObject({ preference: 'light', active: { id: 'light' } })
      expect(theme.getTheme().themes.map(t => t.id)).toEqual(['light', 'dark'])
      expect(host.set).not.toHaveBeenCalled()
      expect(() => { theme.setTheme('qianshou-dopamine') }).toThrow('not registered')
      await ctx.fiber.dispose()
    }
  })

  it('defaults forge system to the light product skin and ignores OS dark', async () => {
    let notify = (): void => {}
    const media = { matches: true, addEventListener: (_: string, cb: () => void) => { notify = cb }, removeEventListener: vi.fn() }
    vi.stubGlobal('matchMedia', () => media)
    const ctx = new Context()
    const theme = new ThemeRuntime(ctx, stubSettingsScope<ThemeSettings>().scope, 'forge')
    expect(theme.getTheme().active.id).toBe('light')
    theme.setTheme('system')
    expect(theme.getTheme().active.id).toBe('light')
    notify()
    expect(theme.getTheme().active.id).toBe('light')
    theme.setTheme('dark')
    expect(theme.getTheme().active.id).toBe('dark')
    await ctx.fiber.dispose()
    expect(media.removeEventListener).toHaveBeenCalledOnce()
  })

  it('gives every skin the same full semantic contract and readable text/control states', () => {
    const names = Object.keys(QIANSHOU_THEMES[0]?.tokens ?? {}).sort()
    for (const theme of QIANSHOU_THEMES) {
      const t = theme.tokens
      expect(Object.keys(t).sort()).toEqual(names)
      const color = (key: string): string => {
        const value = t[key]
        if (value === undefined || !/^#[a-f0-9]{6}$/i.test(value)) throw new Error(`Missing color ${theme.id}/${key}`)
        return value
      }
      const surfaces = [
        '--dsw-alias-bg-base', '--dsw-alias-bg-layer-1', '--dsw-alias-bg-layer-2',
        '--dsw-alias-bg-layer-3', '--dsw-specific-sidebar-fill',
      ]
      for (const surface of surfaces) {
        for (const text of ['--dsw-alias-label-primary', '--dsw-alias-label-secondary', '--dsw-alias-label-tertiary']) {
          expect(contrast(color(text), color(surface)), `${theme.id} ${text} on ${surface}`).toBeGreaterThanOrEqual(4.5)
        }
        expect(contrast(color('--dsw-alias-brand-primary'), color(surface)), `${theme.id} focus on ${surface}`).toBeGreaterThanOrEqual(3)
      }
      for (const state of ['fill', 'hover', 'active']) {
        expect(
          contrast(color(`--dsw-alias-button-primary-${state}`), color('--dsw-alias-label-primary-foreground')),
          `${theme.id} button ${state}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
      for (const state of ['fill', 'hover']) {
        expect(
          contrast(color(`--dsw-alias-button-info-${state}`), color('--dsw-alias-button-info-foreground')),
          `${theme.id} send ${state}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
      for (const state of ['success', 'warn', 'business']) {
        expect(
          contrast(color(`--dsw-alias-state-${state}-primary`), color(`--dsw-alias-state-${state}-tertiary`)),
          `${theme.id} ${state}`,
        ).toBeGreaterThanOrEqual(4.5)
      }
      expect(color('--dsw-alias-bg-base')).not.toBe(color('--dsw-alias-bg-layer-2'))
      expect(color('--dsw-alias-interactive-bg-active')).not.toBe(color('--dsw-alias-interactive-bg-hover'))
    }
  })

  it('mounts palette previews and complete reduced-motion/focus policies only for the private build', async () => {
    const ctx = new Context()
    const fiber = ctx.plugin({ apply(scope) { installThemeStyles(scope, 'forge') } })
    await fiber.await()
    const previews = document.querySelector('[data-plugin-css$="qianshou-previews.css"]')
    for (const theme of QIANSHOU_THEMES) expect(previews?.textContent).toContain(`[data-qianshou-preview="${theme.id}"]`)
    expect(previews?.textContent).not.toContain('qianshou-dopamine')
    expect(document.querySelector('[data-plugin-css$="forge.css"]')).not.toBeNull()
    expect(document.documentElement.dataset.qianshouProduct).toBe('')
    // The Vitest CSS module transform replaces inline imports with empty strings.
    // Parse the actual owner sheet; browser playback verifies computed styling.
    const interaction = readFileSync(resolve(import.meta.dirname, '../src/styles/forge.css'), 'utf8')
    expect(interaction).toContain(':focus-visible')
    expect(interaction).toContain('[aria-disabled="true"]')
    expect(interaction).toMatch(
      /prefers-reduced-motion: reduce[\s\S]*animation-iteration-count: 1[\s\S]*transition-duration: 0ms[\s\S]*scroll-behavior: auto/,
    )
    const cards = readFileSync(resolve(import.meta.dirname, '../src/client/AppearanceRow.module.css'), 'utf8')
    expect(cards).toMatch(/prefers-reduced-motion: reduce.*transform: none; transition: none/)
    await fiber.dispose()
    expect(document.querySelector('[data-plugin-css$="qianshou-previews.css"]')).toBeNull()
    expect(document.documentElement.dataset.qianshouProduct).toBeUndefined()
  })
})
