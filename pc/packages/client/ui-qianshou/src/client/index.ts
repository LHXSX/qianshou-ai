/** Qianshou brand contributions; enabled only by the qianshou build profile. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client'
import type {} from '@deepseek-ai/dsh-client-ui-subagent/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-ui-qianshou-account/client'
import type { MarketCapability, SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { SkillSeat } from './SkillSeat.tsx'
export { SkillCover } from './SkillCover.tsx'
import { SkillsController } from './skills-controller.ts'
import { pluginBorrowDraft } from './conversation-plugin-borrow.ts'
import type { ConversationPlugin } from './SkillSeat.tsx'
import type { QianshouMarketSelection } from './qianshou-market-selection.ts'
export type { QianshouMarketSelection } from './qianshou-market-selection.ts'
export type { QianshouMarketplaceNavigation, MarketplacePublicationFocus } from './market-navigation.ts'
import { WorkModeSwitch } from './WorkModeSwitch.tsx'
import { WorkModeController } from './work-mode-controller.ts'
import { HelpIcon, HelpPage } from './help/HelpPage.tsx'
import { SharingController, createSharingInjection } from './help/sharing-controller.ts'
import { createSharingTransport } from './help/sharing-transport.ts'
import { CommunityIcon, CommunityPage } from './community/CommunityPage.tsx'
import { en as communityEn, zh as communityZh, type CommunityKey } from './community/locales.ts'
import type { CommunityRelated } from './community/transport.ts'
import { createCommunityMarketSearch, createCommunityMarketResolver, type CommunityMarketRemote } from './community/related-market.ts'
import { AgentTasks, AgentTaskPanel, type AgentTaskActions } from './AgentTasks.tsx'
import { OrderSelection, OrderSidebar, SealedOrderMain, SealedOrderPanel } from './SealedOrder.tsx'
import { QianshouMark, QianshouName } from './Brand.tsx'
import { en, zh, type QianshouKey } from './locales.ts'
import { NodeStatusController } from './node-status/controller.ts'
import { NodeStatusEntry } from './node-status/NodeStatusEntry.tsx'
import { NodeStatusPanel } from './node-status/NodeStatusPanel.tsx'
import { NodeIntakePage } from './node-status/NodeIntakePage.tsx'
import { createRelayTransport } from './node-status/transport.ts'
import { createIntakeSupplyTransport, type IntakeSupplyRemote } from './node-status/supply-transport.ts'
import { createH3OwnerSetupTransport, type H3OwnerSetupRemote } from './node-status/h3-owner-setup-transport.ts'
import { createH3CanonicalSetupTransport, type H3CanonicalSetupRemote } from './node-status/h3-canonical-setup-transport.ts'
import { en as nodeEn, zh as nodeZh } from './node-status/locales.ts'
import { ComputePlanRow } from './ComputePlanRow.tsx'
import { createComputePlanTransport } from './compute-plan-transport.ts'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    'qianshou-order': { readonly order: { readonly shardId: string; readonly attempt: number } }
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Product identity and the existing cloud account destination. */
    'qianshou.brand': QianshouKey
    /** Authenticated discussion and moderation notices. */
    'qianshou.forum': CommunityKey
  }
}

/** The only services read by this presentation plugin. */
export const inject = ['slots', 'locale', 'theme', ...process.env.DSH_CLIENT_BUILD_PROFILE === 'qianshou' ? ['remote.qianshouPluginCatalog', 'skillCreatorNavigation'] : []]

/** Capability picker waiting configuration for the client plugin. */
export interface Config {
  /** Longest wait for a capability check before leaving the draft unchanged. */
  readonly abilitySelectionTimeoutMs?: number
}

/**
 * Install reversible product branding without modifying session or model state.
 * @param ctx - Client context with slots, locale, and theme services.
 * @param config - Capability selection timeout in milliseconds.
 */
export function apply(ctx: Context, config: Config = {}): void {
  const abilitySelectionTimeoutMs = config.abilitySelectionTimeoutMs ?? 15000
  if (!Number.isSafeInteger(abilitySelectionTimeoutMs) || abilitySelectionTimeoutMs < 1000 || abilitySelectionTimeoutMs > 60000) {
    throw new Error('abilitySelectionTimeoutMs must be an integer from 1000 to 60000')
  }
  if (process.env.DSH_CLIENT_BUILD_PROFILE !== 'qianshou') return
  ctx.effect(() => ctx.locale.register('qianshou.brand', { zh, en }), 'qianshou: copy')
  ctx.effect(() => ctx.locale.register('qianshou.forum', { zh: communityZh, en: communityEn }), 'qianshou: forum copy')
  ctx.effect(() => ctx.locale.register('qianshou.node', { zh: nodeZh, en: nodeEn }), 'qianshou: node copy')
  const planTransport = createComputePlanTransport()
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview', key: 'compute_plan_draft', locale: 'qianshou.brand',
    inject: () => ({ transport: planTransport }),
  }, ComputePlanRow))
  // One controller for both mount points: the header entry and the dock panel share it,
  // so a reminder raised while the panel is closed is the same one the panel shows.
  const node = new NodeStatusController({ transport: createRelayTransport() })
  const selectedOrder = new OrderSelection()
  const sharing = new SharingController(createSharingTransport())
  ctx.effect(() => { sharing.start(); return () => { sharing.dispose() } }, 'qianshou: sharing lifecycle')
  ctx.effect(() => {
    node.start()
    return () => { node.dispose() }
  }, 'qianshou: node status poll')
  ctx.effect(() => {
    const invalidate = (): void => { node.invalidateIdentity(); sharing.invalidate() }
    const disposers = [ctx.on('qianshou-account/identity-changed', invalidate), ctx.on('connection/reset', invalidate)]
    return () => { for (const dispose of disposers) dispose() }
  }, 'qianshou: node identity invalidation')
  ctx.effect(() => ctx.theme.overrideTokens('qianshou', {
    '--dsw-alias-bg-base': { light: '#f5f6f4', dark: '#111918' },
    '--dsw-alias-bg-layer-1': { light: '#ffffff', dark: '#182220' },
    '--dsw-alias-bg-layer-2': { light: '#f5f7f5', dark: '#202c28' },
    '--dsw-alias-bg-overlay': { light: '#ffffff', dark: '#1b2623' },
    '--dsw-specific-sidebar-fill': { light: '#eef1ed', dark: '#14201c' },
    '--dsw-alias-border-l1': { light: 'rgba(31, 56, 48, 0.08)', dark: 'rgba(224, 240, 232, 0.08)' },
    '--dsw-alias-border-l2': { light: 'rgba(31, 56, 48, 0.14)', dark: 'rgba(224, 240, 232, 0.14)' },
    '--dsw-alias-label-primary': { light: '#202b27', dark: '#edf3ee' },
    '--dsw-alias-label-secondary': { light: '#66736b', dark: '#a7b9ad' },
    '--dsw-alias-interactive-primary': { light: '#147d72', dark: '#69c9b8' },
    '--qianshou-brand-ink': { light: '#ffffff', dark: '#0a302b' },
    '--dsw-alias-state-business-primary': { light: '#147d72', dark: '#69c9b8' },
    '--dsw-alias-button-info-fill': { light: '#147d72', dark: '#238b7e' },
    '--dsw-alias-button-info-hover': { light: '#116a61', dark: '#147d72' },
  }), 'qianshou: accent')
  ctx.inject(['sessions', 'sidebarRight', 'sidebarRightTabs', 'layout', 'remote'], (scope) => {
    const workMode = new WorkModeController(scope.layout)
    const supplyTransport = createIntakeSupplyTransport(
      (scope.remote as unknown as { qianshouPluginCatalog: IntakeSupplyRemote }).qianshouPluginCatalog)
    const h3SetupTransport = createH3OwnerSetupTransport(
      (scope.remote as unknown as { qianshouPluginCatalog: H3OwnerSetupRemote }).qianshouPluginCatalog)
    const h3CanonicalTransport = createH3CanonicalSetupTransport(
      (scope.remote as unknown as { qianshouPluginCatalog: H3CanonicalSetupRemote }).qianshouPluginCatalog)
    scope.slots.inject('sidebar.mode', () => scope.slots.register({
      name: 'sidebar.mode', locale: 'qianshou.brand',
      inject: () => ({
        hooks: { mode: workMode.store },
        selectMode: (mode: 'daily' | 'work', activePanel: MainPanelId | null) => { workMode.select(mode, activePanel) },
        observePanel: (activePanel: MainPanelId | null) => { workMode.observePanel(activePanel) },
      }),
    }, WorkModeSwitch))
    scope.inject(['conversation', 'remote.skills'], (skillScope) => {
      let selectionAvailable = true
      skillScope.effect(() => () => { selectionAvailable = false }, 'qianshou: selector lifetime')
      const skills = new SkillsController(skillScope.remote.skills)
      const pluginRemote = (skillScope.remote as unknown as { qianshouPluginCatalog: {
        conversationPlugins(): Promise<{ ok: true; value: ConversationPlugin[] } | { ok: false; error: { message: string } }>
      } }).qianshouPluginCatalog
      const listPlugins = async (): Promise<readonly ConversationPlugin[]> => {
        const answer = await pluginRemote.conversationPlugins()
        if (!answer.ok) throw new Error(answer.error.message)
        return answer.value
      }
      let marketSelection: QianshouMarketSelection | null = null
      skillScope.inject(['qianshouMarketSelection'], (marketScope) => {
        const selection = marketScope.qianshouMarketSelection
        marketSelection = selection
        marketScope.effect(() => () => { if (marketSelection === selection) marketSelection = null },
          'qianshou: market selection availability')
      })
      const listMarketAbilities = () => marketSelection?.listAbilities?.()
        ?? Promise.reject(new Error('market-selection-unavailable'))
      skillScope.effect(() => () => { skills.dispose() }, 'qianshou: skills controller')
      skillScope.effect(() => skillScope.remote.$on('agent-preset/selected', (sessionId) => { skills.invalidate(sessionId) }),
        'qianshou: skills preset invalidation')
      skillScope.effect(() => skillScope.remote.$on('skills/change', () => { void skills.refreshKnown() }),
        'qianshou: skills file refresh')
      skillScope.effect(() => skillScope.on('connection/reset', () => { skills.invalidate() }), 'qianshou: skills connection invalidation')
      skillScope.slots.inject('conversation.input.left', () => skillScope.slots.register({
        name: 'conversation.input.left', id: 'qianshou-skills', order: 10,
        locale: 'qianshou.brand', inject: (sessionId: SessionId) => ({
          hooks: { skills: skills.storeFor(sessionId) },
          load: () => skills.load(sessionId),
          reload: () => skills.reload(sessionId),
          listPlugins,
          listMarketAbilities,
          coverAtlasUrl: '/assets/qianshou-skill-category-atlas.png',
          abilitySelectionTimeoutMs,
          selectMarketAbility: (taskType: string, expected?: Readonly<MarketCapability>, signal?: AbortSignal) =>
            (signal === undefined
              ? expected === undefined ? marketSelection?.refreshAndSelect(sessionId, taskType)
                : marketSelection?.refreshAndSelect(sessionId, taskType, expected)
              : marketSelection?.refreshAndSelect(sessionId, taskType, expected, signal)) ?? Promise.resolve(false),
          requestPlugin: async (id: string, signal?: AbortSignal) => {
            const canCompose = () => selectionAvailable && signal?.aborted !== true
            if (!canCompose()) return false
            // Refresh before composing; a stale menu entry must not borrow a disabled package.
            const original = skillScope.sessions.binding(sessionId)
            if (original === undefined) return false
            const plugin = (await listPlugins()).find(item => item.id === id)
            if (plugin === undefined || !canCompose()) return false
            const binding = skillScope.sessions.binding(sessionId)
            if (binding === undefined || binding.ctx !== original.ctx) return false
            const input = skillScope.conversation.input.for(binding.ctx)
            return input.composeReference(pluginBorrowDraft(plugin, '').trimEnd(), input.state.getSnapshot().draftRev)
          },
          selectSkill: (name: string) => {
            if (!selectionAvailable) return false
            if (!skills.storeFor(sessionId).getSnapshot().skills.some(skill => skill.name === name)) return false
            const binding = skillScope.sessions.binding(sessionId)
            if (binding === undefined) return false
            const input = skillScope.conversation.input.for(binding.ctx)
            return input.composeReference(`/${name}`, input.state.getSnapshot().draftRev)
          },
          composeCallEntry: (entry: 'image' | 'video') => {
            if (!selectionAvailable) return false
            const binding = skillScope.sessions.binding(sessionId)
            if (binding === undefined) return false
            const input = skillScope.conversation.input.for(binding.ctx)
            return input.composeReference(entry === 'image' ? '@出图' : '@出视频',
              input.state.getSnapshot().draftRev)
          },
        }),
      }, SkillSeat))
    })
    const tabId = '@deepseek-ai/dsh-client-ui-qianshou/tasks'
    scope.effect(() => scope.sidebarRightTabs.register({
      id: tabId, kind: 'qianshou-tasks', priority: 'builtin',
      title: () => scope.locale.bind('qianshou.brand')('tasks'),
    }), 'qianshou: task tab')
    const actions: AgentTaskActions = {
      dispatch: async (parent, text) => {
        const binding = scope.sessions.binding(parent)
        if (binding === undefined) throw new Error('CEO session is unavailable')
        const result = await binding.session.prompt([{ type: 'text', text }], 'queue')
        if (!result.ok) throw new Error(result.error.code)
      },
      openTasks: (session, automatic = false) => {
        if (automatic && scope.sidebarRight.isExpanded()) return
        const existing = scope.sidebarRight.openTabs.getSnapshot()
          .find(tab => tab.sessionId === session && tab.kind === 'qianshou-tasks')
        if (existing === undefined) scope.sidebarRight.openTab('qianshou-tasks')
        else {
          scope.sidebarRight.focus(existing.tabId)
          if (!scope.sidebarRight.isExpanded()) scope.sidebarRight.toggleExpanded()
        }
      },
      openChanges: (address) => { scope.sidebarRight.openResource(address, { kind: 'changes-review', preferNewPane: true }) },
      collapseTasks: () => { if (scope.sidebarRight.isExpanded()) scope.sidebarRight.toggleExpanded() },
      observe: (parent, open) => { scope.sessions.setSubagentCatalogOpen(parent, open) },
      refresh: (parent) => { void scope.sessions.refreshSubagents(parent) },
      openAside: (address) => {
        const query = new URLSearchParams({ parent: address.parentSessionId, mode: address.mode })
        scope.sidebarRight.openResource(`dsh-resource://subagentchat/session/${encodeURIComponent(address.childSessionId)}?${query}`, {
          kind: 'subagentchat', preferNewPane: true,
        })
      },
    }
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: tabId,
      locale: 'qianshou.brand', inject: () => actions,
    }, AgentTaskPanel))
    scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({
      name: 'conversation.session.header.actions', id: 'qianshou-agent-tasks', order: 15,
      locale: 'qianshou.brand', inject: () => actions,
    }, AgentTasks))
    // The owner needs a permanent, session-independent route to intake. Keep the
    // existing dock panel for diagnostics, but route the header and left row to
    // the same live controller in the main column.
    const nodeTabId = '@deepseek-ai/dsh-client-ui-qianshou/node'
    const nodePanelId = 'qianshou-intake' as MainPanelId
    const helpPanelId = 'qianshou-help' as MainPanelId
    const communityPanelId = 'qianshou-community' as MainPanelId
    scope.slots.inject('main', () => scope.slots.register({
      name: 'main', key: helpPanelId, locale: 'qianshou.brand',
      inject: () => createSharingInjection(sharing,
        () => { scope.layout.selectPanel(helpPanelId) },
        () => { scope.layout.selectPanel('plugins' as MainPanelId) },
        () => { document.querySelector<HTMLButtonElement>('[data-qianshou-account-entry]')?.click() }),
    }, HelpPage))
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({
      name: 'sidebar.panellist', id: helpPanelId, order: 10,
      locale: 'qianshou.brand', label: () => scope.locale.bind('qianshou.brand')('helpTitle'),
    }, HelpIcon))
    const communityMarket = scope.remote.qianshouPluginCatalog as unknown as CommunityMarketRemote
    const searchRelated = createCommunityMarketSearch(communityMarket)
    const resolveRelated = createCommunityMarketResolver(communityMarket)
    const openRelated = async (related: CommunityRelated): Promise<void> => {
      let taskType: string | undefined
      if (related.kind === 'skill') {
        try {
          const answer = await communityMarket.orderAdapterCapabilities()
          if (answer.ok) {
            const exact = answer.value.capabilities.find(item => item.taskType === related.id)
            const aliases = answer.value.capabilities.filter(item => item.capabilityId === related.id)
            taskType = exact?.taskType ?? (aliases.length === 1 ? aliases[0]?.taskType : undefined)
          }
        } catch { /* Older local-skill links keep their existing market search. */ }
      }
      try { sessionStorage.setItem('qianshou:market-focus', JSON.stringify(taskType === undefined
        ? { kind: related.kind, id: related.id } : { kind: 'capability', taskType })) }
      catch { /* The live event still opens the market when session storage is unavailable. */ }
      scope.layout.selectPanel('plugins' as MainPanelId)
      window.dispatchEvent(new CustomEvent('qianshou:open-market-item', {
        detail: taskType !== undefined ? { taskType }
          : related.kind === 'product' ? { productId: related.id } : { skillId: related.id },
      }))
    }
    scope.slots.inject('main', () => scope.slots.register({
      name: 'main', key: communityPanelId, locale: 'qianshou.forum',
      inject: () => ({
        accountId: async (): Promise<string | null> => {
          const account = (scope.remote as unknown as {
            qianshouAccount?: { state(): Promise<{ ok: boolean; value?: { account: { id: string } | null } }> }
          }).qianshouAccount
          if (account === undefined) return null
          try {
            const answer = await account.state()
            return answer.ok ? answer.value?.account?.id ?? null : null
          } catch { return null }
        },
        openAccount: () => { document.querySelector<HTMLButtonElement>('[data-qianshou-account-entry]')?.click() },
        openRelated,
        searchRelated,
        resolveRelated,
      }),
    }, CommunityPage))
    scope.slots.inject('sidebar.panellist', () => scope.slots.register({
      name: 'sidebar.panellist', id: communityPanelId, order: 11,
      locale: 'qianshou.forum', label: () => scope.locale.bind('qianshou.forum')('nav'),
    }, CommunityIcon))
    scope.slots.inject('main', () => scope.slots.register({
      name: 'main', key: nodePanelId,
      locale: 'qianshou.node',
      inject: () => ({
        controller: node,
        supplyTransport,
        h3SetupTransport,
        h3CanonicalTransport,
        onOpenSharing: () => { scope.layout.selectPanel(helpPanelId) },
        planOrderAdapter: (prompt: string) => (scope as unknown as {
          skillCreatorNavigation: { startSkill(starterPrompt?: string): Promise<boolean> }
        }).skillCreatorNavigation.startSkill(prompt),
      }),
    }, NodeIntakePage))
    scope.effect(() => scope.sidebarRightTabs.register({
      id: nodeTabId, kind: 'qianshou-node', priority: 'builtin',
      title: () => scope.locale.bind('qianshou.node')('title'),
    }), 'qianshou: node tab')
    const openNode = (): void => { scope.layout.selectPanel(helpPanelId) }
    const openCommunity = (): void => { scope.layout.selectPanel(communityPanelId) }
    scope.effect(() => {
      window.addEventListener('qianshou:open-community', openCommunity)
      return () => { window.removeEventListener('qianshou:open-community', openCommunity) }
    }, 'qianshou: skill submissions to forum')
    scope.effect(() => {
      window.addEventListener('qianshou:open-intake', openNode)
      return () => { window.removeEventListener('qianshou:open-intake', openNode) }
    }, 'qianshou: account income to intake')
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: nodeTabId,
      locale: 'qianshou.node', inject: () => ({ controller: node }),
    }, NodeStatusPanel))
    scope.slots.inject('conversation.session.header.actions', () => scope.slots.register({
      name: 'conversation.session.header.actions', id: 'qianshou-node-status', order: 14,
      locale: 'qianshou.node', inject: () => ({ controller: node, open: openNode }),
    }, NodeStatusEntry))

    // Accepted work is observed in a separate, read-only dock tab. The ordinary
    // node diagnostics tab has owner commands, so it cannot serve as a sealed box.
    const orderTabId = '@deepseek-ai/dsh-client-ui-qianshou/order'
    const orderPanelId = 'qianshou-order-watch' as MainPanelId
    scope.slots.inject('main', () => scope.slots.register({
      name: 'main', key: orderPanelId, locale: 'qianshou.node',
      inject: () => ({ controller: node, selection: selectedOrder }),
    }, SealedOrderMain))
    scope.effect(() => scope.sidebarRightTabs.register({
      id: orderTabId, kind: 'qianshou-order', priority: 'builtin',
      title: () => scope.locale.bind('qianshou.node')('orderBoxTitle'),
    }), 'qianshou: sealed order tab')
    scope.slots.inject('sidebar.right.pane.tab', () => scope.slots.register({
      name: 'sidebar.right.pane.tab', key: orderTabId,
      locale: 'qianshou.node', inject: () => ({ controller: node }),
    }, SealedOrderPanel))
    scope.slots.inject('sidebar.orders', () => scope.slots.register({
      name: 'sidebar.orders', locale: 'qianshou.node',
      inject: () => ({
        controller: node,
        openOrder: (order: { readonly shardId: string; readonly attempt: number }) => {
          selectedOrder.select(order)
          try {
            scope.sidebarRight.openTab('qianshou-order', { params: { order } })
          } catch (error) {
            if (!(error instanceof Error) || !error.message.includes('no session surface is mounted')) throw error
            scope.layout.selectPanel(orderPanelId)
          }
        },
      }),
    }, OrderSidebar))
  })
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.register({ name: 'sidebar.brand.mark' }, QianshouMark))
  ctx.slots.inject('sidebar.brand.name', () =>
    ctx.slots.register({ name: 'sidebar.brand.name', locale: 'qianshou.brand' }, QianshouName))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark' }, QianshouMark))
}
