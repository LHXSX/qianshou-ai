import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { en } from './locales.ts'
import css from './AboutSection.module.css'

/** About page for the forge build: product identity plus a low-traffic attribution line. */
export function AboutSection({ t }: PropsRuntime<'settings.section'> & { t: (key: keyof typeof en) => string }) {
  return (
    <div className={css.page} data-qianshou-about="">
      <h1 className={css.title}>{t('aboutTitle')}</h1>
      <p className={css.release}>{t('welcomeRelease')}</p>
      <p className={css.attribution}>
        {t('aboutAttribution')}
        {' '}
        <a href="https://github.com/deepseek-ai/deepseek-harness" target="_blank" rel="noopener noreferrer">{t('welcomeSource')}</a>
      </p>
    </div>
  )
}
