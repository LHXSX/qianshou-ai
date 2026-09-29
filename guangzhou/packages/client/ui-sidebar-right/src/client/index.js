import { GuideBody } from "./tabs/guide/GuideBody.js";
import { GuideTitle } from "./tabs/guide/GuideTitle.js";
import { ExpandButton } from "./shell/ExpandButton.js";
import { RightbarSeat } from "./shell/SidebarRight.js";
import { RightbarRoot } from "./shell/RightbarRoot.js";
import { createSidebarRightController } from "./service.js";
import { SidebarRightTabRegistry } from "./tab-registry.js";
import { createSidebarRightStore } from "./stores.js";
import { en, zh } from "./locales.js";
import { GUIDE_ID, guideDefinition } from "./tabs/guide/definition.js";
import { guideTabInfoFactory, tabInfoFactory } from "./tab-info.js";
import { defaultSeed } from "./contract/seed.js";
/** This package's copy namespace. */
const NS = 'sidebarRight';
/** Required browser services: the slot registry, the frame's panel actions, copy, and the resource model. */
export const inject = ['slots', 'layout', 'locale', 'resources'];
/**
 * Client plugin body: provide the registry and the navigation face, register the
 * panel seat and the rail seat over one store with their extension children, and
 * register the guide type through the same public two-stage path any other type
 * uses.
 * @param ctx - client root context carrying the slot registry, the frame's face, and copy.
 */
export function apply(ctx) {
    // The registry and the face it backs are built here, at apply's top level,
    // and never inside an effect. A registry other packages register into cannot
    // have an effect-internal scope as its host: `register()` adds an effect to
    // this fiber, and doing that from another plugin's apply while the effect is
    // still the active scope stalls browser boot with no error at all. The
    // template this follows (ui-conversation's definition registry) is built at
    // its own apply top level for the same reason.
    const t = ctx.locale.bind(NS);
    const tabs = new SidebarRightTabRegistry(ctx);
    const { controller, adopt } = createSidebarRightController(tabs, (address, signal) => { ctx.resources.pin(address, signal); });
    const disposeRegistry = ctx.reflect.provide('sidebarRightTabs', tabs);
    const disposeService = ctx.reflect.provide('sidebarRight', controller);
    // Registered first, so it tears down last: the faces outlive every seat and
    // type that reaches for them. provide()'s disposer settles asynchronously;
    // teardown is synchronous fire-and-forget, matching ui-layout's root entry.
    // Unloading aborts every tab occurrence, which releases every pin.
    ctx.effect(() => () => {
        controller.tabDomain.dispose();
        void disposeService();
        void disposeRegistry();
    }, 'ui-sidebar-right: service faces');
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-sidebar-right: dictionaries');
    ctx.effect(() => {
        const handle = createSidebarRightStore(() => defaultSeed(tabs));
        // The runtime mints one instance of this handle per session (the scope key
        // is the session id) and caches it per key. Each is adopted as it is minted,
        // so a tab's own action reaches its session's store while another session
        // is on screen, and that store's commits sync the Tab domain themselves.
        const adoptions = [];
        const store = {
            ...handle,
            create: (scopeKey) => {
                const instance = handle.create(scopeKey);
                if (scopeKey !== undefined)
                    adoptions.push(adopt(scopeKey, instance));
                return instance;
            },
        };
        const layout = ctx.layout;
        const injected = {
            syncPresentation({ shown, track, fullscreen }) {
                if (shown)
                    layout.openRightbar(track, fullscreen);
                else
                    layout.closeRightbar();
            },
            bindService: binding => controller.bind(binding),
            openTab: (kind, options) => { controller.openTab(kind, options); },
            hooks: { tabTypes: { subscribe: listener => tabs.subscribe(listener), getSnapshot: () => tabs.entries() } },
        };
        const disposeTypes = [tabs.register(guideDefinition(t))];
        const disposeSeat = ctx.slots.inject('rightbar', function* () {
            yield ctx.slots.register({
                name: 'rightbar',
                children: { 'rightbar.session': { kind: 'single', scope: 'session' } },
            }, RightbarRoot);
            yield ctx.slots.register({
                name: 'rightbar.session',
                locale: NS,
                children: {
                    'sidebar.right.pane.tab': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: tabInfoFactory } } },
                    'sidebar.right.pane.tab.title': { kind: 'keyed', scope: 'session', inject: { hooks: { tabInfo: tabInfoFactory } } },
                    'sidebar.right.tab.menu.item': { kind: 'list', scope: 'session' },
                },
                store,
                inject: (sessionId) => ({
                    ...injected,
                    keyedHooks: { tabNavigation: key => controller.tabDomain.occurrence(sessionId, { id: key }).navigation },
                    occurrence: tab => controller.tabDomain.occurrence(sessionId, tab),
                }),
            }, RightbarSeat);
        });
        // The expand button shares the panel's store: it only needs to know whether
        // the panel is expanded, and to ask for it to be. The header's corner seat
        // is its own place, past the utilities, so showing and hiding it moves
        // nothing else in the row.
        const disposeExpand = ctx.slots.inject('conversation.session.header.corner', () => ctx.slots.register({
            name: 'conversation.session.header.corner',
            locale: NS,
            store,
        }, ExpandButton));
        // Stage two for the guide: it declares the chain child it hosts and reads
        // the registry's entry boxes, which an ordinary type has no reason to do.
        const guideInjected = {
            hooks: { guideEntries: { subscribe: listener => tabs.subscribe(listener), getSnapshot: () => tabs.guide() } },
        };
        const disposeGuide = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: GUIDE_ID,
            children: {
                'sidebar.right.tab.guide': {
                    kind: 'chain', scope: 'session', inject: { hooks: { tabInfo: guideTabInfoFactory } },
                },
            },
            inject: () => guideInjected,
        }, GuideBody));
        const disposeGuideTitle = ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: GUIDE_ID }, GuideTitle));
        return () => {
            disposeGuideTitle();
            disposeGuide();
            disposeExpand();
            disposeSeat();
            for (const dispose of disposeTypes.reverse())
                dispose();
            for (const release of adoptions)
                release();
        };
    }, 'ui-sidebar-right: seats and shipped tab type');
}
//# sourceMappingURL=index.js.map