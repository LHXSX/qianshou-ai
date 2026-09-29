import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import css from './ForgeBrand.module.css'

/** Six soft arms surround one coordinating center at sidebar and hero sizes. */
export function ForgeBrandMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <svg
    width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false"
    className={className === undefined ? css.mark : `${css.mark} ${className}`} data-qianshou-brand="mark"
  >
    <rect x="1" y="1" width="30" height="30" rx="9" fill="currentColor" />
    <g className={css.ink}>
      <circle cx="16" cy="16" r="2.45" fill="currentColor" />
      <g stroke="currentColor" strokeWidth="2.5" fill="none" strokeLinecap="round">
        {[0, 60, 120, 180, 240, 300].map(angle => <path
          key={angle}
          d="M16 11.7C16 9.3 19.7 10.3 19.7 7.7"
          transform={`rotate(${String(angle)} 16 16)`}
        />)}
      </g>
    </g>
  </svg>
}

/** Localized private product identity, separate from provider/model identity. */
export function ForgeBrandName({ t }: PropsLocale<'forge.brand'>) {
  return <span className={css.name} data-qianshou-brand="name"><strong>{t('name')}</strong><span>{t('subtitle')}</span></span>
}
