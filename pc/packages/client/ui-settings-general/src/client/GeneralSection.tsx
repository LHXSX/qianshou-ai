/** The General section: one column rendering feature-owned item contributions. */
import type { PropsLocale, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './SettingsRoot.module.css'
import { DesktopDeviceControls } from './DesktopDeviceControls.tsx'

/** Full component props: section owner share plus item render share. */
export type GeneralSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsRenderSlots<'settings.general.item'> & PropsLocale<'settings'>

/**
 * Render the General section content column.
 * @param props - composed slot props (contract/slots.ts).
 * @returns the section element tree.
 */
export function GeneralSection({ renderSlot, t }: GeneralSectionComponentProps) {
  return (
    <div className={css.generalSection} data-settings-general>
      <header className={css.generalHeading}>
        <h2>{t('general.nav')}</h2>
        <p>{t('general.intro')}</p>
      </header>
      <DesktopDeviceControls t={t} />
      <div className={css.generalRows}>
        {renderSlot('settings.general.item', {})}
      </div>
    </div>
  )
}
