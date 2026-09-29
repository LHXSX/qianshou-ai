/** Host registration for the browser theme preference and pre-plugin palette. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { bootThemeInjection } from './boot-theme.ts'
import {
  DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, THEME_SETTINGS_NAMESPACE, ThemeSettingsSchema,
  type ThemePreference, type ThemeSettings,
} from './theme-settings.ts'

export {
  DEFAULT_FONT_SIZE, DEFAULT_PREFERENCE, FONT_SIZE_FIELD, FONT_SIZE_MAX, FONT_SIZE_MIN,
  THEME_PREFERENCE_FIELD, THEME_PREFERENCES, THEME_SETTINGS_NAMESPACE,
  type ThemePreference, type ThemeSettings,
} from './theme-settings.ts'

const THEME_NAMESPACE = THEME_SETTINGS_NAMESPACE

/** Read the registered theme section or the schema defaults without a settings provider. */
function readSection(ctx: Context): { preference: ThemePreference; fontSize: number } {
  const fallback = { preference: DEFAULT_PREFERENCE, fontSize: DEFAULT_FONT_SIZE }
  const settings = ctx.get('settings')
  if (settings === undefined) return fallback
  const section = settings.get(THEME_NAMESPACE) as ThemeSettings | undefined
  if (section === undefined) return fallback
  return section
}

/**
 * Register the durable theme section when the optional settings service is
 * composed, and answer every index injection collection with the current
 * theme bootstrap row.
 * @param ctx - Host context that may acquire the settings service.
 */
export function apply(ctx: Context): void {
  ctx.inject(['settings'], async (settingsCtx) => {
    const settings = settingsCtx.settings
    settings.register(THEME_NAMESPACE, ThemeSettingsSchema)
    if (!settings.writable) return
    const stored = settings.describe().find(row => row.ns === THEME_NAMESPACE)
    if (stored === undefined || (stored.user as { preference?: unknown } | undefined)?.preference !== 'qianshou-dopamine') return
    try {
      // A revision fence prevents this one-field migration overwriting a
      // concurrent appearance choice. Other namespaces and fields stay intact.
      await settings.update(THEME_NAMESPACE, { preference: 'light' }, stored.revision)
    } catch {
      // Read compatibility already supplies a valid light palette if the
      // document is temporarily unwritable or another writer won the race.
      settingsCtx.logger.warn('The retired theme could not be saved as light; its compatible light palette remains available.')
    }
  })
  ctx.on('webserver/index-inject', (table) => {
    const section = readSection(ctx)
    table.push(bootThemeInjection(section.preference, section.fontSize))
  })
}
