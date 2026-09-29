/**
 * 模型与API — the provider catalog this deployment actually loaded.
 *
 * `ctx.modelDirectories` resolves the current session's directory, whose store
 * carries the host's model catalog (every provider that answered, plus the ones
 * that failed) and the session's effective route. The page prints exactly that:
 * no quota figure, no price, and no third-party product names beyond what the
 * user's own providers published.
 */
import {
  ActionButton, BoundaryNote, SectionCard, StepList, type DestinationPageProps,
} from './page-chrome.tsx'
import css from './DestinationPage.module.css'

/** Provider catalog, current route, and configuration pointers. */
export function ModelsPage({ state, t, body, openPanel }: DestinationPageProps & {
  openPanel?: ((panel: string | null) => () => void) | undefined
}) {
  const { models } = state
  const route = models.route
  return <>
    <SectionCard
      heading="dest.models.providers.title"
      count={models.providers.length === 0 ? undefined : t('dest.models.providers.count', { count: String(models.providers.length) })}
      t={t}
    >
      {models.providers.length === 0
        ? <p className={css.empty}>{t('dest.models.empty')}</p>
        : <ul className={css.providers}>
          {models.providers.map(provider => (
            <li key={provider.id} className={css.providerRow}>
              <div className={css.providerHead}>
                <strong>{provider.name}</strong>
                <span className={css.providerId}>{provider.id}</span>
                <span className={css.count}>{t('dest.models.modelCount', { count: String(provider.models.length) })}</span>
              </div>
              {provider.models.length > 0 && <ul className={css.modelList}>
                {provider.models.map(model => (
                  <li key={model.id}>
                    <span>{model.name}</span>
                    {model.name === model.id ? null : <code>{model.id}</code>}
                  </li>
                ))}
              </ul>}
            </li>
          ))}
        </ul>}
      {models.failures.length > 0 && <div className={css.failures} role="status">
        <strong>{t('dest.models.failures', { count: String(models.failures.length) })}</strong>
        <ul>{models.failures.map(failure => (
          <li key={failure.id}><span>{failure.name}</span><em>{failure.message}</em></li>
        ))}</ul>
      </div>}
    </SectionCard>

    <SectionCard heading="dest.models.current" t={t}>
      {route === null
        ? <p className={css.empty}>{t('dest.models.noSession')}</p>
        : <>
          <p className={css.route}>{t('dest.models.currentValue', { provider: route.provider, model: route.model })}</p>
          {route.effort !== null && <p className={css.hint}>{t('dest.models.reasoning', { effort: route.effort })}</p>}
          <p className={css.hint}>
            {t(models.routed === null ? 'dest.models.routePending'
              : models.routed ? 'dest.models.routeAvailable' : 'dest.models.routeUnavailable')}
          </p>
        </>}
      {openPanel !== undefined && <div className={css.cardFoot}>
        <ActionButton glyph="back" panel={null} onClick={openPanel(null)}>{t('shell.back')}</ActionButton>
      </div>}
    </SectionCard>

    <SectionCard heading="dest.models.setup.title" t={t}>
      <StepList t={t} steps={{ source: 'dest.models.setup.items' }} />
    </SectionCard>
    <BoundaryNote lead={t(body)} note={t('dest.models.notice')} />
  </>
}
