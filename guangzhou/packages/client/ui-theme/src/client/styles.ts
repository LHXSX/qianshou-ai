import type { Context } from '@deepseek-ai/cordis'
import base from '../styles/base.css?inline'
import cornerShape from '../styles/corner-shape.css?inline'
import designPlatform from '../styles/design-platform.css?inline'
import scrollbar from '../styles/scrollbar.css?inline'
import gradientShadowText from '../styles/gradient-shadow-text.css?inline'
import shiki from '../styles/shiki.css?inline'
import forge from '../styles/forge.css?inline'
import { QIANSHOU_THEMES } from '../qianshou-palettes.ts'

const PLUGIN_ID = '@deepseek-ai/dsh-client-ui-theme'

const STYLES = [
  ['base.css', base],
  ['corner-shape.css', cornerShape],
  ['design-platform.css', designPlatform],
  ['scrollbar.css', scrollbar],
  ['gradient-shadow-text.css', gradientShadowText],
  ['shiki.css', shiki],
] as const

/**
 * Mount the global theme sheets for exactly the owning plugin lifetime.
 * @param ctx - Owning plugin context.
 * @param profile - Public build profile; private skins and interactions mount only in forge.
 */
export function installThemeStyles(ctx: Context, profile = process.env.DSH_CLIENT_BUILD_PROFILE): void {
  if (typeof document === 'undefined') return
  if (profile === 'forge') {
    ctx.effect(() => {
      document.documentElement.dataset.qianshouProduct = ''
      return () => { delete document.documentElement.dataset.qianshouProduct }
    }, 'ui-theme: qianshou product root')
  }
  const previews = QIANSHOU_THEMES.map(theme => `[data-qianshou-preview="${theme.id}"] {${Object.entries(theme.tokens)
    .map(([key, value]) => `${key}:${value};`).join('')}}`).join('\n')
  const sheets = profile === 'forge' ? [...STYLES, ['forge.css', forge] as const, ['qianshou-previews.css', previews] as const] : STYLES
  for (const [name, css] of sheets) {
    ctx.effect(() => {
      const tag = document.createElement('style')
      tag.dataset.plugin = PLUGIN_ID
      tag.dataset.pluginCss = `${PLUGIN_ID}/${name}`
      tag.textContent = css
      document.head.appendChild(tag)
      return () => { tag.remove() }
    }, `ui-theme: ${name} stylesheet`)
  }
}
