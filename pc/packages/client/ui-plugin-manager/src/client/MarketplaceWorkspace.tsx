/** Official skill installation and the owner's installed skills. */
import { useEffect, useState, type ReactNode } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarketplacePanelProps } from './MarketplacePanel.tsx'
import { OrdinarySkillCatalog } from './OrdinarySkillPublication.tsx'
import { LocalSkillsPanel, type LocalSkillsPanelProps } from './LocalSkillsPanel.tsx'
import { OfficialSkillsMarket } from './OfficialSkillsMarket.tsx'
import css from './MarketplaceWorkspace.module.css'

type Props = MarketplacePanelProps & {
  localSkills: LocalSkillsPanelProps
  marketCapabilities: NonNullable<MarketplacePanelProps['marketCapabilities']>
  renderMaintenance: (open: () => void) => ReactNode
}

export function MarketplaceWorkspace(props: Props) {
  const { t, localSkills } = props
  const [tab, setTab] = useState<'market' | 'mine'>('market')
  const [focusSource, setFocusSource] = useState<'user-dsh' | 'user-agents' | undefined>()
  const [focusName, setFocusName] = useState<string | undefined>()
  const request = props.publicationsNavigation?.request
  const consume = props.publicationsNavigation?.consume
  useEffect(() => {
    if (request == null || consume?.(request.id) !== true) return
    // Old publication links still resolve to the corresponding local skill.
    if (request.focus !== null) {
      setTab('mine'); setFocusName(request.focus.name); setFocusSource(request.focus.source)
      void localSkills.reload()
    } else setTab('market')
  }, [request, consume, localSkills.reload])
  useEffect(() => {
    const browse = (): void => { setTab('market'); setFocusName(undefined); setFocusSource(undefined) }
    window.addEventListener('qianshou:open-market-item', browse)
    return () => { window.removeEventListener('qianshou:open-market-item', browse) }
  }, [])
  return <section className={css.workspace} data-qianshou-plugin-market>
    <header className={css.header}>
      <div className={css.tabs} role="tablist" aria-label={t('title')}>
        {(['market', 'mine'] as const).map(next => <button key={next} type="button" role="tab"
          aria-selected={tab === next} onClick={() => {
            setTab(next); setFocusName(undefined); setFocusSource(undefined)
            if (next === 'mine') void localSkills.reload()
          }}>{t(next === 'market' ? 'workspaceMarket' : 'workspaceMine')}</button>)}
      </div>
    </header>
    {tab === 'market' && <>
      <OfficialSkillsMarket {...props} openInstalled={(name) => {
        setFocusName(name); setFocusSource('user-dsh'); setTab('mine'); void localSkills.reload()
      }} />
      {props.ordinarySkills !== undefined && props.ordinarySkills.view.catalog.some(skill => skill.publisherKind === 'official')
        && <OrdinarySkillCatalog {...props.ordinarySkills} officialOnly />}
      <div className={css.forumNotice}>
        <div><strong>{t('developerForumTitle')}</strong><p>{t('developerForumIntro')}</p></div>
        <Button variant="outline" size="sm" onClick={() => {
          window.dispatchEvent(new CustomEvent('qianshou:open-community'))
        }}>{t('developerForumOpen')}</Button>
      </div>
    </>}
    {tab === 'mine' && <LocalSkillsPanel {...localSkills} consumptionOnly focusName={focusName} focusSource={focusSource} />}
  </section>
}
