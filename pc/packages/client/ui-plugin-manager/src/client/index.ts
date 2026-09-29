/**
 * Plugin manager, browser half: the **Plugins** entry of the sidebar and the
 * management page it opens in the main column. The page installs, enables,
 * disables, and removes the bundles of the Host's profile through the
 * `pluginManager` Remote and switches their rows in the profile's user layer.
 * A plugin that carries its own configuration renders it on this page through
 * the slots the page declares (`slot-contract.ts`).
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the root `main` keyed slot the page registers into, declared by
// ui-layout with the panel id brand, and the `sidebar.panellist` list the
// entry registers into, declared by ui-sidebar.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-agent-preset/client'
// Type-only: the ctx.remote Context merge and the forwarded-event key face.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-qianshou-account/client'
import type { InputTriggerServiceContract } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: the forwarded events' own declaration (`$on`'s key face resolves
// through the owning package's client-safe types subpath).
import type {} from '@deepseek-ai/dsh-plugin-manager/types'
import { PluginManagerPage } from './PluginManagerPage.tsx'
import { QianshouCapabilitiesPage, QianshouManagerPage } from './QianshouManagerPage.tsx'
import { MarketplaceController } from './marketplace-controller.ts'
import { MarketplaceNavigation } from './marketplace-navigation.ts'
import { CommunityController } from './community-controller.ts'
import { SessionSkillsController } from './session-skills-controller.ts'
import { SkillImportController } from './skill-import-controller.ts'
import { OrdinarySkillsController } from './ordinary-skill-controller.ts'
import type { OrdinarySkillsRemote } from './ordinary-skill-transport.ts'
import { en as ordinarySkillsEn, zh as ordinarySkillsZh, type OrdinarySkillKey } from './ordinary-skill-locales.ts'
import { SkillActionsRow } from './SkillActionsRow.tsx'
import type { LoadLocalSkillTrial, RunLocalSkillTrial } from './LocalSkillTrial.tsx'
import { LocalSkillsController } from './local-skills-controller.ts'
import { LocalPluginCandidatesController } from './local-plugin-candidates-controller.ts'
import { OrderPublicationController, type OrderPublicationRemote } from './order-publication-controller.ts'
import { OrderProductsController } from './order-products-controller.ts'
import { MarketCapabilitiesController } from './market-capabilities-controller.ts'
import { createMarketMentionSource, videoDraftCapability } from './market-mention-source.ts'
import { createMarketTaskTransport } from './market-task-transport.ts'
import { createVideoAssetPlanPreparer } from './video-asset-plan.ts'
import { createMarketInputPresentationLoader } from './market-legacy-input-presentation.ts'
import { createMarketSelection } from './market-selection.ts'
import { createMarketConversationEntry, type EnterMarketConversation } from './market-conversation-entry.ts'
import { MarketUsageController } from './market-usage.ts'
import { registerConversationMarketCalls } from './conversation-market-entry.ts'
import { registerConversationImageTrials } from './conversation-image-trial.tsx'
import { registerConversationVideoTrials } from './conversation-video-trial.tsx'
import { registerConversationFormalMedia } from './conversation-formal-media.tsx'
import { orderAdapterPlanningPrompt } from './order-adapter-prompt.ts'
import { createVideoWorkflowDraftTransport } from './video-workflow-draft-transport.ts'
import { CapabilitiesController, type CapabilityVisibility, type CapabilityWizardStep } from './capabilities-controller.ts'
import { en as marketEn, zh as marketZh, type MarketplaceKey } from './marketplace-locales.ts'
import { en as localSkillsEn, zh as localSkillsZh, type LocalSkillKey } from './local-skill-locales.ts'
import { en as localCandidatesEn, zh as localCandidatesZh, type LocalPluginCandidateKey } from './local-plugin-candidate-locales.ts'
import { en as communityEn, zh as communityZh, type CommunityKey } from './community-locales.ts'
import { en as capabilityEn, zh as capabilityZh, type CapabilityKey } from './capability-locales.ts'
import { PluginsPanelIcon } from './PluginsPanelIcon.tsx'
import { configLedgerSource } from './config-ledger.ts'
import { PluginManagerController } from './manager-store.ts'
import { en, zh, type PluginManagerLocaleKey } from './locales.ts'
import type {} from './slot-contract.ts'

export type { PluginManagerPageProps } from './PluginManagerPage.tsx'
export type { ConfigLedger, OfficialItem } from './config-ledger.ts'
export type { PluginManagerFace } from './manager-store.ts'
export type { PluginManagerLocaleKey } from './locales.ts'
export type { PluginConfigViewProps } from './slot-contract.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Plugin manager tab copy. */
    'pluginManager': PluginManagerLocaleKey
    'qianshou.market': MarketplaceKey
    'qianshou.localSkills': LocalSkillKey
    'qianshou.ordinarySkills': OrdinarySkillKey
    'qianshou.localPluginCandidates': LocalPluginCandidateKey
    'qianshou.community': CommunityKey
    /** 我的能力 copy: the installed declarations, the publish wizard, and the numbers measured here. */
    'qianshou.capabilities': CapabilityKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'pluginManager'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'plugins' as MainPanelId
/** Reuses the same manager controller, opening its existing owner capability tab. */
export const CAPABILITIES_PANEL_ID = 'qianshou-capabilities' as MainPanelId

/** Services required by the sidebar registration and the Remote methods; the inventory says whether the Host manages a profile. */
export const inject = ['slots', 'locale', 'remote', 'remote.pluginManager', 'remote.pluginInventory', ...process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou' ? ['layout', 'sessions', 'conversation', 'inputTriggers', 'remote.skills', 'remote.qianshouAccount', 'remote.qianshouPluginCatalog', 'remote.qianshouSkillImport', 'skillCreatorNavigation'] : []]

/**
 * Contribute the Plugins entry to the sidebar with the management page it
 * opens, and keep it current on the Host's change events.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-plugin-manager: dictionaries')
  const qianshou = process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou'
  const videoWorkflowDrafts = qianshou && typeof location !== 'undefined'
    ? createVideoWorkflowDraftTransport(location.href) : undefined
  const readOwner = async (): Promise<number | null> => {
    const response = await ctx.remote.qianshouAccount.state()
    if (!response.ok) return null
    const state = response.value
    if (state.phase !== 'authenticated' || state.account === null) return null
    const id = Number(state.account.id)
    return Number.isSafeInteger(id) && id > 0 ? id : null
  }
  const marketplaceNavigation = qianshou ? new MarketplaceNavigation(() => { ctx.layout.selectPanel(PANEL_ID) }) : null
  const market = qianshou ? new MarketplaceController(ctx) : null
  const community = qianshou ? new CommunityController(ctx) : null
  const sessionSkills = qianshou ? new SessionSkillsController(ctx.remote.skills) : null
  const skillImport = qianshou ? new SkillImportController(ctx) : null
  const ordinarySkills = qianshou ? new OrdinarySkillsController(
    ctx.remote.qianshouPluginCatalog as unknown as OrdinarySkillsRemote, readOwner) : null
  const localSkills = qianshou ? new LocalSkillsController(
    ctx.remote.qianshouSkillImport, ctx.remote.qianshouPluginCatalog, readOwner) : null
  const localPluginCandidates = qianshou ? new LocalPluginCandidatesController(
    ctx.remote.qianshouPluginCatalog) : null
  const orderPublication = qianshou ? new OrderPublicationController({
    account: ctx.remote.qianshouAccount, catalog: ctx.remote.qianshouPluginCatalog, manager: ctx.remote.pluginManager,
  } as unknown as OrderPublicationRemote) : null
  const orderProducts = qianshou ? new OrderProductsController(
    ctx.remote.qianshouPluginCatalog, readOwner) : null
  const marketCapabilities = qianshou ? new MarketCapabilitiesController(
    ctx.remote.qianshouPluginCatalog, readOwner) : null
  const capabilities = qianshou ? new CapabilitiesController(ctx) : null
  let enterMarketConversation: EnterMarketConversation | undefined
  const loadLocalTrial: LoadLocalSkillTrial = async (source, name) => {
    const result = await ctx.remote.qianshouPluginCatalog.readInstalledOrderSkillTrial({ source, name })
    if (!result.ok) throw new Error('local-skill-trial-contract-unavailable')
    return result.value
  }
  const runLocalTrial: RunLocalSkillTrial = async (source, name, inputJson, expectedArtifactDigest) => {
    const result = await ctx.remote.qianshouPluginCatalog.tryInstalledOrderSkill({ source, name, inputJson,
      ...(expectedArtifactDigest === undefined ? {} : { expectedArtifactDigest }) })
    if (!result.ok) throw new Error('local-skill-trial-unavailable')
    return result.value
  }
  if (qianshou) {
    for (const key of ['qianshou_skill_complete', 'qianshou_try_local_skill']) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key, locale: 'qianshou.localSkills',
      inject: () => ({ run: runLocalTrial, load: loadLocalTrial,
        manage: (focus: Parameters<MarketplaceNavigation['openMySkill']>[0]) => marketplaceNavigation?.openMySkill(focus) ?? false }),
    }, SkillActionsRow))
    if (marketplaceNavigation !== null) {
      ctx.provide('qianshouMarketplaceNavigation', marketplaceNavigation)
      ctx.effect(() => () => { marketplaceNavigation.dispose() }, 'ui-plugin-manager: publication navigation lifetime')
    }
    let storage: Storage | null
    try { storage = globalThis.localStorage } catch (_failure) { storage = null } // Browser preferences may be unavailable.
    const usage = new MarketUsageController({ readOwner, storage })
    const catalog = marketCapabilities?.store
    if (catalog === undefined) throw new Error('market-catalog-unavailable')
    const imageTrial = registerConversationImageTrials(ctx)
    const videoTrial = registerConversationVideoTrials(ctx)
    const formalMedia = registerConversationFormalMedia(ctx)
    const callCapability = registerConversationMarketCalls(ctx, { readOwner, usage, catalog,
      prepareVideoAssetPlan: createVideoAssetPlanPreparer(ctx.remote.qianshouPluginCatalog as unknown as
        Parameters<typeof createVideoAssetPlanPreparer>[0]),
      loadInputPresentation: createMarketInputPresentationLoader(
        ctx.remote.qianshouPluginCatalog,
        () => catalog.getSnapshot(), readOwner),
      reloadCatalog: () => {
        if (marketCapabilities === null) throw new Error('market-catalog-unavailable')
        return marketCapabilities.ensureLoaded()
      } })
    let marketSelectionAvailable = true
    ctx.effect(() => () => { marketSelectionAvailable = false }, 'ui-plugin-manager: selector lifetime')
    if (marketCapabilities !== null) {
      const selection = createMarketSelection(marketCapabilities, (sessionId) => {
        if (!marketSelectionAvailable) return undefined
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined) return undefined
        const input = ctx.conversation.input.for(binding.ctx)
        return { scope: binding.ctx, selectProduct: (item, product, goal) =>
          callCapability({ sessionId }, item, goal ?? '', undefined, product), compose: (reference, goal) => {
          const draft = input.state.getSnapshot()
          return input.composeReference(draft.draft.length === 0 && goal !== undefined && goal !== ''
            ? `${reference} ${goal}` : reference, draft.draftRev)
        } }
      })
      ctx.provide('qianshouMarketSelection', selection)
      enterMarketConversation = createMarketConversationEntry({ selection,
        currentSession: () => {
          const main = Object.values(ctx.sessions.list.getSnapshot().byId)
            .filter(session => (session.retainedBy.mainView ?? 0) > 0)
          return main.length === 1 ? main[0]?.id ?? null : null
        },
        subscribe: listener => ctx.sessions.list.subscribe(listener),
        openConversation: () => { ctx.layout.selectPanel(null) },
      })
    }
    if (marketCapabilities !== null) ctx.effect(() => {
      const attachmentLifetime = new AbortController()
      ctx.effect(() => () => { attachmentLifetime.abort() }, 'ui-plugin-manager: composer input import lifetime')
      const transport = createMarketTaskTransport()
      const importComposerFiles = transport.importComposerFiles
      const source = createMarketMentionSource({ capabilities: marketCapabilities, imageTrial, videoTrial, formalMedia,
        callingMode: session => ctx.sessions.list.getSnapshot().byId[session.sessionId]
          ?.projectionValues?.agentPreset === 'qianshou-call',
        callCapability: (session, capability, goal, files, directVideoEntry) =>
          callCapability(session, capability, goal, files, undefined, false, directVideoEntry === true),
        callVideoDraft: (session, goal) => callCapability(session, videoDraftCapability, goal,
          undefined, undefined, true), usage,
        videoTaskTypes: signal => transport.taskTypes(signal),
        prepareAttachments: importComposerFiles === undefined ? undefined
          : (session, attachments) => importComposerFiles(session, attachments, attachmentLifetime.signal) })
      return (ctx.get('inputTriggers') as InputTriggerServiceContract).registerSource(source)
    }, 'ui-plugin-manager: market @ entry')
    ctx.effect(() => ctx.locale.register('qianshou.market', { zh: marketZh, en: marketEn }), 'ui-plugin-manager: market locales')
    ctx.effect(() => ctx.locale.register('qianshou.localSkills', { zh: localSkillsZh, en: localSkillsEn }), 'ui-plugin-manager: local skill locales')
    ctx.effect(() => ctx.locale.register('qianshou.ordinarySkills', { zh: ordinarySkillsZh, en: ordinarySkillsEn }), 'ui-plugin-manager: ordinary skill locales')
    ctx.effect(() => ctx.locale.register('qianshou.localPluginCandidates', { zh: localCandidatesZh, en: localCandidatesEn }), 'ui-plugin-manager: local plugin candidate locales')
    ctx.effect(() => ctx.locale.register('qianshou.community', { zh: communityZh, en: communityEn }), 'ui-plugin-manager: community locales')
    ctx.effect(() => ctx.locale.register('qianshou.capabilities', { zh: capabilityZh, en: capabilityEn }),
      'ui-plugin-manager: capability locales')
    ctx.effect(() => () => { market?.dispose() }, 'ui-plugin-manager: market lifetime')
    ctx.effect(() => () => { community?.dispose() }, 'ui-plugin-manager: community lifetime')
    ctx.effect(() => () => { sessionSkills?.dispose() }, 'ui-plugin-manager: session skill lifetime')
    ctx.effect(() => () => { skillImport?.dispose() }, 'ui-plugin-manager: skill import lifetime')
    ctx.effect(() => () => { ordinarySkills?.dispose() }, 'ui-plugin-manager: ordinary skill lifetime')
    ctx.effect(() => () => { localSkills?.dispose() }, 'ui-plugin-manager: local skill lifetime')
    ctx.effect(() => () => { localPluginCandidates?.dispose() }, 'ui-plugin-manager: local plugin candidate lifetime')
    ctx.effect(() => () => { orderPublication?.dispose() }, 'ui-plugin-manager: order publication lifetime')
    ctx.effect(() => () => { orderProducts?.dispose() }, 'ui-plugin-manager: order products lifetime')
    ctx.effect(() => () => { marketCapabilities?.dispose() }, 'ui-plugin-manager: market capabilities lifetime')
    ctx.effect(() => () => { capabilities?.dispose() }, 'ui-plugin-manager: capability lifetime')
    if (sessionSkills !== null) ctx.effect(() => {
      const selectMain = (): void => {
        const current = Object.values(ctx.sessions.list.getSnapshot().byId)
          .find(session => (session.retainedBy.mainView ?? 0) > 0)?.id ?? null
        void sessionSkills.select(current)
      }
      selectMain()
      const dispose = ctx.sessions.list.subscribe(selectMain)
      return () => { dispose() }
    }, 'ui-plugin-manager: current session skill address')
    if (sessionSkills !== null) ctx.effect(() => {
      const refreshSelected = (): void => { void sessionSkills.reload() }
      const disposers = [
        ctx.remote.$on('agent-preset/selected', refreshSelected),
        ctx.on('connection/reset', refreshSelected),
      ]
      return () => { for (const dispose of disposers) dispose() }
    }, 'ui-plugin-manager: session skill invalidations')
    if (localSkills !== null) ctx.effect(() => {
      const dispose = ctx.remote.$on('skills/change', () => {
        void localSkills.reload()
        void ordinarySkills?.reload()
        void orderPublication?.refreshSkillPublications()
      })
      return () => { dispose() }
    }, 'ui-plugin-manager: local skill invalidations')
    if (orderPublication !== null) ctx.effect(() => {
      const refresh = (): void => {
        void ordinarySkills?.reload()
        void localSkills?.reload()
        void marketCapabilities?.reload()
        void orderProducts?.invalidateIdentityAndReload()
        void orderPublication.refreshSkillPublications()
      }
      const disposers = [ctx.on('connection/reset', refresh), ctx.on('qianshou-account/identity-changed', refresh)]
      return () => { for (const dispose of disposers) dispose() }
    }, 'ui-plugin-manager: publication account refresh')
  }
  const t = ctx.locale.bind(NS)
  const controller = new PluginManagerController(ctx)
  ctx.effect(() => () => { controller.dispose() }, 'ui-plugin-manager: controller')
  // The Host says when what is installed, enabled, or composed changed — from
  // this page, the CLI, or another browser — and streams install output.
  ctx.effect(() => {
    // A page never rendered holds no snapshot to refresh.
    const refresh = (): void => {
      localPluginCandidates?.invalidateInstalledChecks()
      if (controller.getSnapshot().status !== 'idle') void controller.load()
    }
    const disposers = [
      ctx.remote.$on('plugin-manager/changed', refresh),
      ctx.remote.$on('plugin-manager/install-log', (chunk) => { controller.appendLog(chunk) }),
      ctx.remote.$on('plugin-manager/install-state', (progress) => { controller.installProgress(progress) }),
      ctx.on('connection/reset', refresh),
    ]
    return () => { for (const dispose of disposers) dispose() }
  }, 'ui-plugin-manager: host invalidations')

  // The page is a global panel: it belongs to the profile, not to a Session,
  // and the sidebar's entry selects it. What is installed and switched on is
  // the page's own; a plugin's configuration arrives through the slots the
  // page declares here, so the page never names a configurable plugin.
  const configLedger = configLedgerSource(ctx)
  const children = {
    'plugins.item': { kind: 'list', scope: 'root' },
    'plugins.bundle.config': { kind: 'keyed', scope: 'root' },
    'plugins.row.config': { kind: 'keyed', scope: 'root' },
  } as const
  const qianshouInjection = market && community && sessionSkills && skillImport && localSkills && localPluginCandidates
    && orderPublication && orderProducts && marketCapabilities && capabilities && marketplaceNavigation && ordinarySkills ? (() => {
      const face = controller.inject(configLedger)
      return { ...face, hooks: { ...face.hooks, marketplace: market.store, community: community.store,
        sessionSkills: sessionSkills.store, skillImport: skillImport.store, localSkills: localSkills.store,
        ordinarySkills: ordinarySkills.store,
        localPluginCandidates: localPluginCandidates.store,
        orderPublication: orderPublication.store,
        orderProducts: orderProducts.store,
        marketCapabilities: marketCapabilities.store,
        marketplaceNavigation: marketplaceNavigation.store,
        capabilities: capabilities.store },
      consumePublicationsRequest: (id: number) => marketplaceNavigation.consume(id),
      ordinarySkillsReload: () => ordinarySkills.reload(),
      ordinarySkillsRefresh: () => ordinarySkills.refresh(),
      ordinarySkillsEdit: (change: Parameters<OrdinarySkillsController['edit']>[0]) => { ordinarySkills.edit(change) },
      ordinarySkillsSubmit: () => ordinarySkills.submit(),
      ordinarySkillsTranslate: ctx.locale.bind('qianshou.ordinarySkills'),
      marketEnsure: () => { market.ensure() },
      marketReload: () => { void market.reload() },
      marketInspect: (id: string) => { void market.inspect(id) },
      marketInstall: (id: string) => { void market.install(id) },
      marketRecheck: (id: string) => { void market.recheck(id) },
      marketRepair: (id: string) => { void market.repair(id) },
      marketRollback: (id: string) => { void market.rollback(id) },
      marketDismiss: () => { market.dismiss() },
      orderProductsReload: () => { void orderProducts.reload() },
      orderProductsBuyAndActivate: (productId: string) => { void orderProducts.buyAndActivate(productId) },
      marketCapabilitiesReload: () => { void marketCapabilities.reload() },
      enterMarketConversation,
      startSkillCreator: () => ctx.skillCreatorNavigation.startSkill(),
      videoWorkflowDrafts,
      marketTranslate: ctx.locale.bind('qianshou.market'),
      communitySearch: (query: string) => { void community.search(query) },
      communityLoadMore: () => { void community.loadMore() },
      communityTranslate: ctx.locale.bind('qianshou.community'),
      sessionSkillsReload: () => sessionSkills.reload(),
      skillImportInspectFile: (file: File) => { void skillImport.inspectFile(file) },
      skillImportInstall: () => { void skillImport.install() },
      skillImportCheckWrite: () => { void skillImport.checkWrite() },
      skillImportDismiss: () => { skillImport.dismiss() },
      runLocalTrial,
      loadLocalTrial,
      localSkillsEnsure: () => localSkills.ensure(),
      archiveLocalSkill: async (request: Parameters<LocalSkillsController['archive']>[0]) => {
        const archived = await localSkills.archive(request)
        if (archived) await sessionSkills.reload()
        return archived
      },
      refreshLocalArchives: () => localSkills.refreshArchives(),
      restoreLocalSkill: async (request: Parameters<LocalSkillsController['restore']>[0]) => {
        const restored = await localSkills.restore(request)
        if (restored) await sessionSkills.reload()
        return restored
      },
      enableOrderSkill: async (source: 'user-dsh' | 'user-agents', name: string) => {
        await localSkills.enable(source, name)
        await capabilities.reload()
      },
      refreshSkillPublications: () => orderPublication.refreshSkillPublications(),
      managePublicationLifecycle: (request: Parameters<OrderPublicationController['managePublicationLifecycle']>[0]) =>
        orderPublication.managePublicationLifecycle(request),
      localSkillsReload: async () => {
        void orderPublication.refreshSkillPublications()
        await localSkills.reload()
      },
      localSkillsTranslate: ctx.locale.bind('qianshou.localSkills'),
      localPluginCandidatesReload: () => localPluginCandidates.reload(),
      localPluginCandidatesCheckInstalled: (candidate: Parameters<LocalPluginCandidatesController['checkInstalled']>[0]) =>
        localPluginCandidates.checkInstalled(candidate),
      localPluginCandidatesTranslate: ctx.locale.bind('qianshou.localPluginCandidates'),
      publishOrderCandidate: (candidate: Parameters<OrderPublicationController['publishCandidate']>[0]) => orderPublication.publishCandidate(candidate),
      openOrderReview: (candidate: Parameters<OrderPublicationController['openReview']>[0]) => { orderPublication.openReview(candidate) },
      editOrderReview: (change: Parameters<OrderPublicationController['editReview']>[0]) => { orderPublication.editReview(change) },
      saveOrderReview: () => orderPublication.saveReview(),
      closeOrderReview: () => { orderPublication.closeReview() },
      publishOrderSkill: (source: 'user-dsh' | 'user-agents', name: string,
        review: Parameters<OrderPublicationController['publishSkill']>[2]) => orderPublication.publishSkill(source, name, review),
      previewOrderPrice: (source: 'user-dsh' | 'user-agents', name: string) =>
        orderPublication.previewSkillPrice(source, name),
      submitSkillProduct: (source: 'user-dsh' | 'user-agents', name: string, salePriceYuan: string) =>
        orderPublication.submitSkillProduct(source, name, salePriceYuan),
      retryOrderSkillArchive: (source: 'user-dsh' | 'user-agents', name: string) =>
        orderPublication.retrySkillArchive(source, name),
      retryReviewSamples: (source: 'user-dsh' | 'user-agents', name: string) =>
        orderPublication.retryReviewSamples(source, name),
      planOrderAdapter: (source: 'user-dsh' | 'user-agents', name: string) =>
        ctx.skillCreatorNavigation.startSkill(orderAdapterPlanningPrompt(source, name), { autoSubmit: true }),
      reviewLocalCandidate: (candidate: Parameters<PluginManagerController['installLocalCandidate']>[0]) => {
        ctx.layout.selectPanel(PANEL_ID)
        controller.installLocalCandidate(candidate)
      },
      useSessionSkill: (name: string) => {
        const view = sessionSkills.store.getSnapshot()
        if (view.sessionId === null || !view.skills.some(skill => skill.name === name)) return false
        const binding = ctx.sessions.binding(view.sessionId)
        if (binding === undefined) return false
        const input = ctx.conversation.input.for(binding.ctx)
        const state = input.state.getSnapshot()
        if (state.phase !== 'plain') return false
        const prefix = `/${name} `
        if (!state.draft.startsWith(prefix)) input.setDraft(prefix + state.draft.trimStart())
        ctx.layout.selectPanel(null)
        requestAnimationFrame(() => { input.focus() })
        return true
      },
      capabilitiesEnsure: () => { capabilities.ensure() },
      capabilitiesReload: () => { void capabilities.reload() },
      openIntakeSettings: () => { ctx.layout.selectPanel('qianshou-intake' as MainPanelId) },
      capabilitiesOpen: (id: string) => { capabilities.open(id) },
      capabilitiesClose: () => { capabilities.close() },
      capabilitiesSelectStep: (step: CapabilityWizardStep) => { capabilities.selectStep(step) },
      capabilitiesSelectVisibility: (visibility: CapabilityVisibility) => { capabilities.selectVisibility(visibility) },
      capabilitiesConfirmPublic: (next: boolean) => { capabilities.confirmPublic(next) },
      capabilitiesEditInvite: (text: string) => { capabilities.editInvite(text) },
      capabilitiesRunPreflight: (id: string) => { void capabilities.runPreflight(id) },
      capabilitiesSaveDraft: (id: string) => { void capabilities.saveDraft(id) },
      capabilitiesPublish: (id: string) => { void capabilities.publish(id) },
      capabilitiesTranslate: ctx.locale.bind('qianshou.capabilities') }
    }) : null
  ctx.slots.inject('main', () => qianshouInjection === null
    ? ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, children,
      inject: () => controller.inject(configLedger),
    }, PluginManagerPage)
    : ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS, children,
      inject: qianshouInjection,
    }, QianshouManagerPage))
  if (qianshouInjection !== null) ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main', key: CAPABILITIES_PANEL_ID, locale: NS,
    inject: qianshouInjection,
  }, QianshouCapabilitiesPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 0,
    label: () => t('panel'),
    locale: NS,
  }, PluginsPanelIcon))

}
