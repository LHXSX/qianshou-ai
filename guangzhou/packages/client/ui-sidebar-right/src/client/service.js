import { activeDockPaneId, canSplit, dockPaneIds, findTabPane, getPane } from '@deepseek-ai/dsh-client-ui-dockkit';
import { pageAddress } from "./contract/seed.js";
import { TabDomain } from "./tab-domain.js";
/**
 * Create the public controller and the plugin-private store adoption callback.
 * Adoption subscribes without reconciling; the first store commit creates occurrences.
 * @param tabs - registered tab types.
 * @param pin - resource retention for an occurrence's lifetime.
 * @returns the controller and a callback releasing exactly its own adoption.
 */
export function createSidebarRightController(tabs, pin) {
    const adopted = new Map();
    const controller = new SidebarRightController(tabs, pin, adopted);
    return {
        controller,
        adopt(sessionId, store) {
            adopted.get(sessionId)?.unsubscribe();
            const sync = () => {
                const surface = store.getSnapshot().bySession[sessionId];
                if (surface !== undefined)
                    controller.tabDomain.sync(sessionId, surface.layout);
            };
            const adoption = { store, unsubscribe: store.subscribe(sync) };
            adopted.set(sessionId, adoption);
            return () => {
                adoption.unsubscribe();
                if (adopted.get(sessionId) === adoption)
                    adopted.delete(sessionId);
            };
        },
    };
}
/** The scheme every resource address carries; anything else is not a resource this face opens. */
const RESOURCE_SCHEME = 'dsh-resource://';
/** Cross-plugin right-Sidebar face (ctx.sidebarRight). */
export class SidebarRightController {
    tabs;
    adopted;
    binding;
    /**
     * The Tab domain this controller navigates into; synced from each adopted
     * store's commits, read by the seat for each body's owner share.
     */
    tabDomain;
    /**
     * @param tabs - the tab-type registry consulted to claim an address.
     * @param pin - `ctx.resources.pin`, which the Tab domain holds addresses with.
     * @param adopted - plugin-owned session stores used by occurrence actions.
     */
    constructor(tabs, pin, adopted = new Map()) {
        this.tabs = tabs;
        this.adopted = adopted;
        this.tabDomain = new TabDomain(this, pin);
    }
    /**
     * Adopt the mounted seat's binding, replacing any previous one.
     *
     * Called from the seat while it is mounted, and released when it leaves.
     * @param binding - the mounted seat's session, actions, and the store's surfaces.
     * @returns a release callback that clears exactly this binding.
     */
    bind(binding) {
        this.binding = binding;
        return () => {
            // A newer seat may already have taken over; only the binding that is
            // still ours may be cleared.
            if (this.binding === binding)
                this.binding = undefined;
        };
    }
    /**
     * Open a resource: claim it, place it, reveal the column, record the navigation.
     * @param address - a `dsh-resource://<type>/…` address.
     * @param options - placement, the opening type, and navigation parameters.
     */
    openResource(address, options = {}) {
        const { sessionId, actions } = this.require();
        this.placeResource(sessionId, actions, address, options);
    }
    /**
     * Open a page type by kind at the address this package records pages under.
     * @param kind - the page type's kind.
     * @param options - placement and that kind's navigation parameters.
     */
    openTab(kind, options = {}) {
        const { sessionId, actions } = this.require();
        this.placeTab(sessionId, actions, kind, options);
    }
    /**
     * Open a resource in one session, for a tab's own action; nothing happens
     * for a session whose store was never adopted or whose adoption was released.
     * Not part of `ISidebarRight`: the Tab domain's path.
     * @param sessionId - the session the acting tab is in.
     * @param address - a `dsh-resource://<type>/…` address.
     * @param options - placement, the opening type, and navigation parameters.
     */
    openResourceIn(sessionId, address, options = {}) {
        const actions = this.actionsFor(sessionId);
        if (actions !== undefined)
            this.placeResource(sessionId, actions, address, options);
    }
    /**
     * Open a page type in one session, for a tab's own action; nothing happens
     * for a session whose store was never adopted or whose adoption was released.
     * Not part of `ISidebarRight`: the Tab domain's path.
     * @param sessionId - the session the acting tab is in.
     * @param kind - the page type's kind.
     * @param options - placement and that kind's navigation parameters.
     */
    openTabIn(sessionId, kind, options = {}) {
        const actions = this.actionsFor(sessionId);
        if (actions !== undefined)
            this.placeTab(sessionId, actions, kind, options);
    }
    /**
     * Close a tab of one session, preserving the sole docked guide; nothing happens
     * for a session whose store was never adopted or whose adoption was released.
     * Not part of `ISidebarRight`: the Tab domain's path.
     * @param sessionId - the session the tab is in.
     * @param tabId - the tab to close.
     */
    closeIn(sessionId, tabId) {
        const actions = this.actionsFor(sessionId);
        if (actions !== undefined)
            actions.closeTab(sessionId, tabId);
    }
    /** Claim a resource and place it in one session; an address outside the scheme or one no type claims throws. */
    placeResource(sessionId, actions, address, options) {
        if (!address.startsWith(RESOURCE_SCHEME)) {
            throw new Error(`sidebarRight: no registered tab type claims "${address}"`);
        }
        this.place(sessionId, actions, this.tabs.claim(address, options.kind), address, options, options.params);
    }
    /** Place a page type in one session at the address pages are recorded under; an unregistered kind throws. */
    placeTab(sessionId, actions, kind, options) {
        const definition = this.tabs.get(kind);
        if (definition === undefined)
            throw new Error(`sidebarRight: no tab type is registered as "${kind}"`);
        const address = pageAddress(kind);
        this.place(sessionId, actions, { kind, contentId: address, title: definition.title(address) }, address, options, options.params);
    }
    /** The steps both opens share: one store intent, and the navigation record for the tab it settles on. */
    place(sessionId, actions, claim, address, placement, params) {
        actions.openContent(sessionId, {
            kind: claim.kind,
            contentId: claim.contentId,
            title: claim.title,
            ...placement.paneId === undefined ? {} : { paneId: placement.paneId },
            ...placement.replaceTab === undefined ? {} : { replaceTab: placement.replaceTab },
            ...placement.revealIfOpened === undefined ? {} : { revealIfOpened: placement.revealIfOpened },
        }, (tabId) => { this.tabDomain.navigate(sessionId, tabId, { address, params }); });
    }
    /**
     * Close one tab of the mounted session; the sole docked guide remains open.
     * @param tabId - the tab to close.
     */
    close(tabId) {
        const { sessionId, actions } = this.require();
        actions.closeTab(sessionId, tabId);
    }
    /**
     * The active tab of the active pane.
     * @returns the record, or `undefined` with no mounted surface.
     */
    active() {
        const layout = this.mounted()?.layout;
        if (layout === undefined)
            return undefined;
        const { activeTabId } = getPane(layout, layout.activePaneId);
        return Object.values(layout.tabs).find(tab => tab.id === activeTabId);
    }
    /**
     * Whether the column is currently showing its panel.
     * @returns `true` while expanded; `false` while collapsed or with no mounted surface.
     */
    isExpanded() {
        return this.mounted()?.layout.expanded ?? false;
    }
    /** Collapse an expanded column, or expand a collapsed one. */
    toggleExpanded() {
        const { sessionId, actions } = this.require();
        actions.toggleExpanded(sessionId);
    }
    /**
     * Focus a tab and the pane holding it; a missing tab is left alone.
     * @param tabId - the tab to focus.
     */
    focus(tabId) {
        const { sessionId, actions } = this.require();
        if (this.mounted()?.layout.tabs[tabId] === undefined)
            return;
        actions.focusTab(sessionId, tabId);
    }
    /**
     * Split a docked pane to its right when the budget and the room rule allow.
     * @param paneId - the pane to split; defaults to the active docked pane.
     * @returns the new pane's id, or `undefined` when nothing was split.
     */
    split(paneId) {
        const { sessionId, actions, canSplitPane } = this.require();
        const layout = this.mounted()?.layout;
        if (layout === undefined)
            return undefined;
        const target = paneId ?? activeDockPaneId(layout);
        const node = layout.nodes[target];
        if (node === undefined || node.kind !== 'pane' || node.host !== 'dock')
            return undefined;
        if (!canSplit(layout) || dockPaneIds(layout).length >= 2 || !canSplitPane(target))
            return undefined;
        let created;
        actions.splitPane(sessionId, target, (id) => { created = id; });
        return created;
    }
    /**
     * Take a docked tab out into a floating panel; a missing or floating tab is left alone.
     * @param tabId - the tab to float.
     * @param rect - the panel's rectangle; defaults to the cascade from the last panel.
     */
    float(tabId, rect) {
        const { sessionId, actions } = this.require();
        const layout = this.mounted()?.layout;
        if (layout === undefined || layout.tabs[tabId] === undefined)
            return;
        if (findTabPane(layout, tabId).host !== 'dock')
            return;
        actions.floatTab(sessionId, tabId, rect);
    }
    /**
     * Return a floating panel's tab to the active docked pane; a missing or docked pane is left alone.
     * @param paneId - the floating pane.
     */
    dock(paneId) {
        const { sessionId, actions } = this.require();
        const node = this.mounted()?.layout.nodes[paneId];
        if (node === undefined || node.kind !== 'pane' || node.host !== 'float')
            return;
        actions.unfloatPane(sessionId, paneId);
    }
    /**
     * Step the mounted session's surface back one intent.
     *
     * @internal Not part of the product: the sequence is an architectural fact
     * with no user-facing control yet. Kept reachable for tests.
     */
    _undo() {
        const { sessionId, actions } = this.require();
        actions.undo(sessionId);
    }
    /**
     * Step the mounted session's surface forward one intent.
     *
     * @internal See `_undo`.
     */
    _redo() {
        const { sessionId, actions } = this.require();
        actions.redo(sessionId);
    }
    /** The mounted session's surface; `undefined` without a seat or before its first open. */
    mounted() {
        const { binding } = this;
        return binding === undefined ? undefined : binding.surfaces[binding.sessionId];
    }
    /**
     * The store actions a tab's own action on `sessionId` runs through: that
     * session's adopted store. `undefined` — nothing to act on — for a session
     * whose store was never minted or whose adoption was released.
     */
    actionsFor(sessionId) {
        return this.adopted.get(sessionId)?.store.actions;
    }
    require() {
        // Reads answer for the no-session case (there is nothing expanded), but a
        // write has no session to write to. Callers are UI gestures and tool
        // results, both of which belong to a session that is on screen.
        if (this.binding === undefined) {
            throw new Error('sidebarRight: no session surface is mounted');
        }
        return this.binding;
    }
}
//# sourceMappingURL=service.js.map