/** Install fixed, data-only official skills through the existing Host importer. */
import { useEffect, useRef, useState } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketplacePanelProps } from './MarketplacePanel.tsx'
import { SkillImportPanel } from './SkillImportPanel.tsx'
import { OFFICIAL_SKILLS } from './official-skills.ts'
import css from './MarketplaceWorkspace.module.css'

type Props = MarketplacePanelProps & { openInstalled: (name: string) => void }
export function OfficialSkillsMarket({ t, skillImport, localSkills, sessionSkills, openInstalled }: Props) {
  const [selected, setSelected] = useState<string | null>(null)
  const [verifiedId, setVerifiedId] = useState<string | null>(null)
  const submitted = useRef<string | null>(null)
  const refreshed = useRef<string | null>(null)
  const current = OFFICIAL_SKILLS.find(skill => skill.name === selected)
  const importView = skillImport?.view
  useEffect(() => { void localSkills?.ensure() }, [localSkills?.ensure])
  useEffect(() => {
    // Only a click on these fixed shipped bytes may enter the existing write flow.
    if (skillImport === undefined || current === undefined || importView?.status !== 'ready'
      || importView.content !== current.content || importView.inspection?.name !== current.name) return
    const id = importView.inspection.inspectionId
    if (submitted.current === id) return
    submitted.current = id
    skillImport.install()
  }, [current, importView, skillImport])
  useEffect(() => {
    if (current === undefined || importView?.status !== 'written' || importView.inspection?.name !== current.name) return
    const id = importView.inspection.inspectionId
    if (refreshed.current === id) return
    refreshed.current = id
    void Promise.all([localSkills?.reload(), sessionSkills?.reload()]).then(() => { setVerifiedId(id) })
  }, [current, importView, localSkills?.reload, sessionSkills?.reload])
  const busy = importView !== undefined && ['reading', 'inspecting', 'installing', 'verifying', 'unconfirmed'].includes(importView.status)
  return <section className={css.skillsMarket} aria-label={t('officialMarketTitle')}>
    <div><h2>{t('officialMarketTitle')}</h2><p className={css.intro}>{t('officialMarketIntro')}</p></div>
    <div className={css.skillGrid}>{OFFICIAL_SKILLS.map((skill) => {
      const installed = localSkills?.view.skills.some(entry => entry.name === skill.name && entry.source === 'user-dsh' && entry.sha256 === skill.sha256) === true
      return <article className={css.skillCard} key={skill.name}>
        <span className={css.officialBadge}>{t('officialBadge')}</span>
        <div><h3>{t(skill.title)}</h3><p>{t(skill.summary)}</p></div>
        <small className={css.intro}>{t('officialSkillFree')}</small>
        <Button variant="outline" size="sm" disabled={!installed && (busy || skillImport === undefined)} onClick={() => {
          if (installed) { openInstalled(skill.name); return }
          setSelected(skill.name); setVerifiedId(null)
          skillImport?.inspectFile(new File([skill.content], `${skill.name}.md`, { type: 'text/markdown' }))
        }}>{t(installed ? 'officialSkillInstalled' : selected === skill.name && busy ? 'ordinarySkillsAdding' : 'ordinarySkillsAdd')}</Button>
      </article>
    })}</div>
    {skillImport !== undefined && current !== undefined && importView !== undefined && importView.status !== 'idle' &&
      <SkillImportPanel view={importView} t={t} install={skillImport.install} checkWrite={skillImport.checkWrite}
        dismiss={() => { skillImport.dismiss(); setSelected(null) }}
        sessionSkillsView={verifiedId === importView.inspection?.inspectionId ? sessionSkills?.view : undefined} />}
  </section>
}
