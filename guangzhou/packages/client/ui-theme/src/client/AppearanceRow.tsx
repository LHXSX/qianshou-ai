/**
 * Appearance preference row registered into the General section item slot
 * (figma 501:30012 'Frame 2117131228'): title + three preference cubes.
 * Registered by this package — the theme feature owns its own settings
 * surface. Selection follows the persisted preference, never the resolved
 * active theme.
 */
import clsx from 'clsx'
import {
  IconDarkOutline16, IconFollowsystemOutline16, IconLightOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type { ThemePreference } from '../theme-settings.ts'
import type { ThemeKey } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createAppearanceRowStore } from './settings-store.ts'
import css from './AppearanceRow.module.css'

/** Injected business face: the preference write (t rides the standard locale seat). */
export interface AppearanceRowInjected {
  /** Switch the theme preference. */
  setTheme: (id: ThemePreference) => void
  /** Whether this build exposes Qianshou's black and white skins. */
  qianshou?: boolean
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type AppearanceRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createAppearanceRowStore>>
  & PropsLocale<'settings.theme'> & AppearanceRowInjected

/** Cube order and icons (figma 501:30015-30017: Light, Dark, System). */
const CUBES: readonly { id: ThemePreference; labelKey: ThemeKey; Icon: typeof IconLightOutline16 }[] = [
  { id: 'light', labelKey: 'appearance.light', Icon: IconLightOutline16 },
  { id: 'dark', labelKey: 'appearance.dark', Icon: IconDarkOutline16 },
  { id: 'system', labelKey: 'appearance.system', Icon: IconFollowsystemOutline16 },
]

const SKINS: readonly { id: ThemePreference; labelKey: ThemeKey; descriptionKey: ThemeKey }[] = [
  { id: 'dark', labelKey: 'appearance.obsidian', descriptionKey: 'appearance.obsidianDetail' },
  { id: 'light', labelKey: 'appearance.cloud', descriptionKey: 'appearance.cloudDetail' },
]

/**
 * Render the Appearance row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function AppearanceRow({ t, setTheme, useStore, qianshou = false }: AppearanceRowComponentProps) {
  const preference = useStore(s => s.preference)
  if (qianshou) return (
    <div className={css.group}>
      <div className={css.heading}>
        <div className={css.title}>{t('appearance.title')}</div>
        <span className={css.subtitle}>{t('appearance.skinDetail')}</span>
      </div>
      <div className={css.skinGrid}>
        {SKINS.map(({ id, labelKey, descriptionKey }) => (
          <button key={id} type="button" className={clsx(css.skin, preference === id && css.skinSelected)}
            aria-pressed={preference === id} onClick={() => { setTheme(id) }}>
            <span aria-hidden="true" className={css.preview} data-qianshou-preview={id}>
              <span className={css.previewSidebar}><i /><i /><i /></span>
              <span className={css.previewWorkspace}>
                <span className={css.previewLine} /><span className={css.previewBubbles}><i /><i /><i /></span>
                <span className={css.previewInput}><i /></span>
              </span>
            </span>
            <span className={css.skinLabel}>{t(labelKey)}<span className={css.check} aria-hidden="true">{preference === id ? '✓' : ''}</span></span>
            <span className={css.skinDescription}>{t(descriptionKey)}</span>
          </button>
        ))}
      </div>
      <button type="button" className={clsx(css.systemChoice, preference === 'system' && css.skinSelected)}
        aria-pressed={preference === 'system'} onClick={() => { setTheme('system') }}>
        <IconFollowsystemOutline16 /><span>{t('appearance.system')}</span>
        <span className={css.systemHint}>{t('appearance.systemDetail')}</span>
      </button>
    </div>
  )
  return (
    <div className={css.group}>
      <div className={css.title}>{t('appearance.title')}</div>
      <div className={css.cubeRow}>
        {CUBES.map(({ id, labelKey, Icon }) => (
          <button
            key={id}
            type="button"
            className={clsx(css.themeCube, preference === id && css.selected)}
            aria-pressed={preference === id}
            onClick={() => { setTheme(id) }}
          >
            <Icon />
            {t(labelKey)}
          </button>
        ))}
      </div>
    </div>
  )
}
