import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './Brand.module.css'

/**
 * Render the user-supplied Qianshou emblem at the host's requested size.
 * @param props - Host size and optional presentation class.
 * @returns A decorative image with no provider branding.
 */
export function QianshouMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <img src="/brand/qianshou-mark.png" width={size} height={size} alt="" aria-hidden="true"
    draggable={false} className={`${css.mark} ${className ?? ''}`} data-qianshou-brand="mark" />
}

/**
 * Render localized product identity beside the independently slotted mark.
 * @param props - Locale binding supplied by the renderer.
 * @returns Product name and short description.
 */
export function QianshouName({ t }: PropsLocale<'qianshou.brand'>) {
  return <span className={css.name} data-qianshou-brand="name">
    <strong>{t('name')}</strong><span>{t('subtitle')}</span>
  </span>
}

/**
 * Link to the existing cloud account without claiming an authenticated session.
 * @param props - Sidebar display mode and localized copy.
 * @returns A keyboard-accessible external account link.
 */
export function CloudLink({ wide, t }: PropsRuntime<'sidebar.footer.action'> & PropsLocale<'qianshou.brand'>) {
  return <a className={css.cloud} href="https://app.qianshousuanli.com" target="_blank"
    rel="noopener noreferrer" title={t('cloudHint')} aria-label={t('cloudHint')}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.6" aria-hidden="true"><path d="M7 18H6a4 4 0 0 1-.8-7.9A7 7 0 0 1 19 9a4.5 4.5 0 0 1 0 9h-2M12 12v9m-3-6 3-3 3 3" /></svg>
    {wide && <span>{t('cloud')}</span>}
  </a>
}
