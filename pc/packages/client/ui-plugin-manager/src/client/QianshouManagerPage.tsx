/** Bind the market and the capability stores at the same owner as the existing manager page. */
import { useEffect, useRef } from 'react'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import { PluginManagerPage, type PluginManagerPageProps } from './PluginManagerPage.tsx'
import { CapabilitiesPanel, type CapabilitiesPanelProps } from './CapabilitiesPanel.tsx'
import type { CapabilitiesController, CapabilityVisibility, CapabilityWizardStep } from './capabilities-controller.ts'
import type { CapabilityKey } from './capability-locales.ts'
import type { MarketplaceController } from './marketplace-controller.ts'
import type { MarketplaceKey } from './marketplace-locales.ts'
import type { CommunityController } from './community-controller.ts'
import type { CommunityKey } from './community-locales.ts'
import type { SessionSkillsController } from './session-skills-controller.ts'
import type { SkillImportController } from './skill-import-controller.ts'
import type { LocalSkillsController } from './local-skills-controller.ts'
import type { LocalSkillKey } from './local-skill-locales.ts'
import type { PluginManagerFace } from './manager-store.ts'
import type { LocalPluginCandidatesController } from './local-plugin-candidates-controller.ts'
import type { LocalPluginCandidateKey } from './local-plugin-candidate-locales.ts'
import type { LocalPluginCandidateView } from './local-plugin-candidates-controller.ts'
import type { OrderPublicationController, OrderPublicationReview, OrderSkillPricePreview,
  PublicationLifecycleRequest, SkillOrderReviewInput } from './order-publication-controller.ts'
import type { OrderProductsController } from './order-products-controller.ts'
import type { MarketCapabilitiesController } from './market-capabilities-controller.ts'
import type { MarketplaceNavigation } from './marketplace-navigation.ts'
import type { LoadLocalSkillTrial, RunLocalSkillTrial } from './LocalSkillTrial.tsx'
import type { EnterMarketConversation } from './market-conversation-entry.ts'
import type { VideoWorkflowDraftTransport } from './video-workflow-authoring.ts'
import type { OrdinarySkillsController } from './ordinary-skill-controller.ts'
import type { OrdinarySkillKey } from './ordinary-skill-locales.ts'
import css from './PluginManagerPage.module.css'

/** The optional market and 我的能力 page belong to the Qianshou profile only. */
export interface QianshouFace extends PluginManagerFace {
  hooks: PluginManagerFace['hooks'] & { marketplace: MarketplaceController['store']
    community: CommunityController['store']
    sessionSkills: SessionSkillsController['store']
    skillImport: SkillImportController['store']
    localSkills: LocalSkillsController['store']
    localPluginCandidates: LocalPluginCandidatesController['store']
    orderPublication: OrderPublicationController['store']
    orderProducts: OrderProductsController['store']
    marketCapabilities: MarketCapabilitiesController['store']
    marketplaceNavigation: MarketplaceNavigation['store']
    ordinarySkills: OrdinarySkillsController['store']
    capabilities: CapabilitiesController['store'] }
  marketEnsure: () => void
  marketReload: () => void
  marketInspect: (id: string) => void
  marketInstall: (id: string) => void
  marketRecheck: (id: string) => void
  marketRepair: (id: string) => void
  marketRollback: (id: string) => void
  marketDismiss: () => void
  ordinarySkillsReload: () => Promise<void>
  ordinarySkillsRefresh: () => Promise<void>
  ordinarySkillsEdit: (change: Parameters<OrdinarySkillsController['edit']>[0]) => void
  ordinarySkillsSubmit: () => Promise<void>
  ordinarySkillsTranslate: (key: OrdinarySkillKey) => string
  orderProductsReload: () => void
  orderProductsBuyAndActivate: (productId: string) => void
  marketCapabilitiesReload: () => void
  enterMarketConversation?: EnterMarketConversation | undefined
  consumePublicationsRequest: (id: number) => boolean
  startSkillCreator: () => Promise<boolean>
  videoWorkflowDrafts?: VideoWorkflowDraftTransport | undefined
  marketTranslate: (key: MarketplaceKey) => string
  communitySearch: (query: string) => void
  communityLoadMore: () => void
  communityTranslate: (key: CommunityKey) => string
  sessionSkillsReload: () => Promise<void>
  skillImportInspectFile: (file: File) => void
  skillImportInstall: () => void
  skillImportCheckWrite: () => void
  skillImportDismiss: () => void
  runLocalTrial: RunLocalSkillTrial
  loadLocalTrial?: LoadLocalSkillTrial | undefined
  localSkillsEnsure: () => Promise<void>
  refreshSkillPublications: () => Promise<void>
  managePublicationLifecycle?: ((request: PublicationLifecycleRequest) => Promise<boolean>) | undefined
  localSkillsReload: () => Promise<void>
  archiveLocalSkill: NonNullable<import('./LocalSkillsPanel.tsx').LocalSkillsPanelProps['archiveLocalSkill']>
  refreshLocalArchives?: (() => Promise<void>) | undefined
  restoreLocalSkill?: import('./LocalSkillsPanel.tsx').LocalSkillsPanelProps['restoreLocalSkill']
  enableOrderSkill: (source: 'user-dsh' | 'user-agents', name: string) => Promise<void>
  localSkillsTranslate: (key: LocalSkillKey) => string
  localPluginCandidatesReload: () => Promise<void>
  localPluginCandidatesCheckInstalled: (candidate: LocalPluginCandidateView) => Promise<void>
  localPluginCandidatesTranslate: (key: LocalPluginCandidateKey) => string
  reviewLocalCandidate: (candidate: LocalPluginCandidateView) => void
  publishOrderCandidate: (candidate: LocalPluginCandidateView) => Promise<void>
  openOrderReview: (candidate: LocalPluginCandidateView) => void
  editOrderReview: (change: Partial<Pick<OrderPublicationReview,
    'name' | 'purpose' | 'category' | 'configuration' | 'saleMode' | 'salePriceYuan'>>) => void
  saveOrderReview: () => Promise<void>
  closeOrderReview: () => void
  publishOrderSkill: (source: 'user-dsh' | 'user-agents', name: string, review: SkillOrderReviewInput) => Promise<void>
  previewOrderPrice: (source: 'user-dsh' | 'user-agents', name: string) => Promise<OrderSkillPricePreview>
  submitSkillProduct: (source: 'user-dsh' | 'user-agents', name: string, salePriceYuan: string) => Promise<boolean>
  retryOrderSkillArchive: (source: 'user-dsh' | 'user-agents', name: string) => Promise<void>
  retryReviewSamples: (source: 'user-dsh' | 'user-agents', name: string) => Promise<void>
  planOrderAdapter: (source: 'user-dsh' | 'user-agents', name: string) => Promise<boolean>
  useSessionSkill: (name: string) => boolean
  capabilitiesEnsure: () => void
  capabilitiesReload: () => void
  openIntakeSettings: () => void
  capabilitiesOpen: (id: string) => void
  capabilitiesClose: () => void
  capabilitiesSelectStep: (step: CapabilityWizardStep) => void
  capabilitiesSelectVisibility: (visibility: CapabilityVisibility) => void
  capabilitiesConfirmPublic: (next: boolean) => void
  capabilitiesEditInvite: (text: string) => void
  capabilitiesRunPreflight: (id: string) => void
  capabilitiesSaveDraft: (id: string) => void
  capabilitiesPublish: (id: string) => void
  capabilitiesTranslate: (key: CapabilityKey, params?: Record<string, string>) => string
}

/**
 * Connect owner actions without embedding a second installation workflow.
 * @param props - Manager, discovery, and capability injected faces.
 * @returns Existing manager with the live market and 我的能力 pages.
 */
function capabilityFace(props: InjectFace<QianshouFace>): CapabilitiesPanelProps {
  const capabilities = props.useCapabilities(value => value)
  const localSkills = props.useLocalSkills(value => value)
  const sessionSkills = props.useSessionSkills(value => value)
  const candidates = props.useLocalPluginCandidates(value => value)
  const pluginManager = props.usePluginManager(value => value)
  const publication = props.useOrderPublication(value => value)
  return {
    view: capabilities, t: props.capabilitiesTranslate, marketT: props.marketTranslate,
    ensure: props.capabilitiesEnsure, reload: props.capabilitiesReload,
    openIntakeSettings: props.openIntakeSettings, open: props.capabilitiesOpen,
    close: props.capabilitiesClose, selectStep: props.capabilitiesSelectStep,
    selectVisibility: props.capabilitiesSelectVisibility, confirmPublic: props.capabilitiesConfirmPublic,
    editInvite: props.capabilitiesEditInvite, runPreflight: props.capabilitiesRunPreflight,
    saveDraft: props.capabilitiesSaveDraft, publish: props.capabilitiesPublish,
    localSkills: { view: localSkills, session: sessionSkills, t: props.localSkillsTranslate,
      ensure: props.localSkillsEnsure, refreshPublications: props.refreshSkillPublications,
      managePublicationLifecycle: props.managePublicationLifecycle,
      reload: props.localSkillsReload, archiveLocalSkill: props.archiveLocalSkill,
      refreshLocalArchives: props.refreshLocalArchives, restoreLocalSkill: props.restoreLocalSkill,
      useSkill: props.useSessionSkill, runLocalTrial: props.runLocalTrial, loadLocalTrial: props.loadLocalTrial,
      publication, publishOrderSkill: props.publishOrderSkill,
      previewOrderPrice: props.previewOrderPrice,
      submitSkillProduct: props.submitSkillProduct,
      retryOrderSkillArchive: props.retryOrderSkillArchive, planOrderAdapter: props.planOrderAdapter,
      retryReviewSamples: props.retryReviewSamples,
      openIntake: props.openIntakeSettings, enableOrderSkill: props.enableOrderSkill,
      compact: true },
    localPluginCandidates: { view: candidates, installed: pluginManager.packages,
      t: props.localPluginCandidatesTranslate, reload: props.localPluginCandidatesReload,
      reviewInstall: props.reviewLocalCandidate,
      checkInstalled: props.localPluginCandidatesCheckInstalled, publication,
      publishOrderCandidate: props.publishOrderCandidate, openOrderReview: props.openOrderReview,
      editOrderReview: props.editOrderReview, saveOrderReview: props.saveOrderReview,
      closeOrderReview: props.closeOrderReview, openIntake: props.openIntakeSettings },
  }
}

export function QianshouManagerPage(props: PluginManagerPageProps & InjectFace<QianshouFace>) {
  const market = props.useMarketplace(value => value)
  const community = props.useCommunity(value => value)
  const sessionSkills = props.useSessionSkills(value => value)
  const skillImport = props.useSkillImport(value => value)
  const localSkills = props.useLocalSkills(value => value)
  const publication = props.useOrderPublication(value => value)
  const orderProducts = props.useOrderProducts(value => value)
  const marketCapabilities = props.useMarketCapabilities(value => value)
  const marketplaceNavigation = props.useMarketplaceNavigation(value => value)
  const ordinarySkills = props.useOrdinarySkills(value => value)
  return <PluginManagerPage
    {...props}
    singleMarketplace
    market={{
      view: market, t: props.marketTranslate, ensure: props.marketEnsure, reload: props.marketReload,
      inspect: props.marketInspect, install: props.marketInstall, recheck: props.marketRecheck, repair: props.marketRepair,
      rollback: props.marketRollback, dismiss: props.marketDismiss,
      orderProducts: { view: orderProducts, reload: props.orderProductsReload,
        buyAndActivate: props.orderProductsBuyAndActivate, enterConversation: props.enterMarketConversation },
      marketCapabilities: { view: marketCapabilities, reload: props.marketCapabilitiesReload,
        enterConversation: props.enterMarketConversation },
      publicationsNavigation: { request: marketplaceNavigation.request, consume: props.consumePublicationsRequest },
      ordinarySkills: { view: ordinarySkills, reload: props.ordinarySkillsReload,
        refresh: props.ordinarySkillsRefresh, edit: props.ordinarySkillsEdit,
        submit: props.ordinarySkillsSubmit, t: props.ordinarySkillsTranslate },
      startSkillCreator: props.startSkillCreator,
      videoWorkflowDrafts: props.videoWorkflowDrafts,
      sessionSkills: { view: sessionSkills, reload: props.sessionSkillsReload, useSkill: props.useSessionSkill },
      skillImport: { view: skillImport, inspectFile: props.skillImportInspectFile,
        install: props.skillImportInstall, checkWrite: props.skillImportCheckWrite,
        dismiss: props.skillImportDismiss },
      localSkills: { view: localSkills, session: sessionSkills, t: props.localSkillsTranslate,
        ensure: props.localSkillsEnsure, refreshPublications: props.refreshSkillPublications,
        managePublicationLifecycle: props.managePublicationLifecycle,
        reload: props.localSkillsReload, archiveLocalSkill: props.archiveLocalSkill,
        refreshLocalArchives: props.refreshLocalArchives, restoreLocalSkill: props.restoreLocalSkill,
        useSkill: props.useSessionSkill, runLocalTrial: props.runLocalTrial, loadLocalTrial: props.loadLocalTrial,
        publication, publishOrderSkill: props.publishOrderSkill,
        previewOrderPrice: props.previewOrderPrice,
        submitSkillProduct: props.submitSkillProduct,
        retryOrderSkillArchive: props.retryOrderSkillArchive, planOrderAdapter: props.planOrderAdapter,
        retryReviewSamples: props.retryReviewSamples,
        openIntake: props.openIntakeSettings, enableOrderSkill: props.enableOrderSkill },
      community: { view: community, t: props.communityTranslate,
        search: props.communitySearch, loadMore: props.communityLoadMore,
        reviewPackage: (spec: string) => { props.openInstall(); props.editInstallSpec(spec) } },
    }}
    capabilities={capabilityFace(props)}
  />
}

/** Direct route from the device's intake page to the existing owner policy tab. */
export function QianshouCapabilitiesPage(props: InjectFace<QianshouFace>) {
  const ensured = useRef(false)
  useEffect(() => {
    if (ensured.current) return
    ensured.current = true
    // The intake page may have changed the saved policy while this page was away.
    props.capabilitiesReload()
    props.ensure()
  }, [props.capabilitiesReload])
  return <main className={css.page} data-qianshou-capabilities-route>
    <CapabilitiesPanel {...capabilityFace(props)} />
  </main>
}
