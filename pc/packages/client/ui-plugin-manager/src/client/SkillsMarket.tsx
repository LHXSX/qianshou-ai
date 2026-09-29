/** Legacy installable adapters remain separate from ordinary SKILL.md publication. */
import { useEffect, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import { SessionSkillsPanel } from './SessionSkillsPanel.tsx'
import type { MarketplacePanelProps } from './MarketplacePanel.tsx'
import css from './MarketplaceWorkspace.module.css'

export function SkillsMarket({ view, t, ensure, reload, install, sessionSkills, localSkills }: MarketplacePanelProps) {
  const [query, setQuery] = useState('')
  useEffect(ensure, [ensure])
  const normalized = query.trim().toLocaleLowerCase()
  const available = view.listings.filter(row => row.installable)
  const shown = available.filter(row => normalized === '' || [row.title, row.summary].some(text => text.toLocaleLowerCase().includes(normalized)))
  return <section className={css.skillsMarket} aria-label={t('ordinarySkillsTitle')}>
    <header className={css.header}><div><h2>{t('ordinarySkillsTitle')}</h2><p className={css.intro}>{t('ordinarySkillsIntro')}</p></div>
      <Button variant="outline" size="sm" disabled={view.loading} onClick={reload}>{t('maintenanceRefresh')}</Button></header>
    <label className={css.search}><span>{t('searchLabel')}</span><input type="search" value={query}
      placeholder={t('ordinarySkillsSearch')} onChange={(event) => { setQuery(event.currentTarget.value) }} /></label>
    {view.loading ? <p role="status">{t('ordinarySkillsLoading')}</p> : null}
    {view.error !== null ? <p role="status">{t('ordinarySkillsUnavailable')}</p> : null}
    {!view.loading && view.error === null && available.length === 0 ? <p>{t('ordinarySkillsEmpty')}</p> : null}
    <div className={css.skillGrid}>{shown.map((row) => {
      const installed = view.installedRecords.some(saved => saved.id === row.id
        && saved.version === row.version && saved.capabilityId === row.capabilityId)
      const busy = view.busyId === row.id || view.workingId === row.id
      return <article key={row.id} className={css.skillCard}>
        <div><h3>{row.title}</h3><p>{row.summary}</p></div>
        <Button size="sm" variant="outline" disabled={installed || view.busyId !== null || view.workingId !== null}
          onClick={() => { install(row.id) }}>{t(busy ? 'ordinarySkillsAdding' : installed ? 'ordinarySkillsAdded' : 'ordinarySkillsAdd')}</Button>
      </article>
    })}</div>
    {view.report?.verdict === 'failed' ? <details><summary>{t('ordinarySkillsCheckFailed')}</summary>
      <p>{t('ordinarySkillsCheckHint')}</p>{view.report.steps.filter(step => step.state === 'failed').map(step =>
        <p key={step.id}>{step.reason}</p>)}</details> : null}
    {sessionSkills !== undefined ? <SessionSkillsPanel view={sessionSkills.view} reload={() => { void sessionSkills.reload() }}
      useSkill={sessionSkills.useSkill} localT={localSkills?.t} labels={{
        title: t('ordinarySkillsReady'), scope: t('ordinarySkillsReadyScope'), searchLabel: t('searchLabel'),
        searchPlaceholder: t('ordinarySkillsSearch'), refresh: t('skillsRefresh'), loading: t('skillsLoading'),
        unavailable: t('skillsUnavailable'), noSession: t('skillsNoSession'), empty: t('skillsEmpty'), noMatches: t('skillsNoMatches'),
        count: t('skillsCount'), userOnly: t('skillsUserOnly'), useSkill: t('skillsUse'), useUnavailable: t('skillsUseUnavailable'), details: t('skillsDetails'),
      }} /> : null}
  </section>
}
