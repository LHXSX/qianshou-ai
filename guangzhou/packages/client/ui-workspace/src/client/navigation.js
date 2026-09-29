/** Workspace archive and directory UI capability. */
import { Service } from '@deepseek-ai/cordis';
/** Structured directory failure exposed to directory UI consumers. */
export class DirectoryBrowseError extends Error {
    rpcError;
    name = 'DirectoryBrowseError';
    /** @param rpcError - Host directory business failure. */
    constructor(rpcError) {
        super(`directory browse failed: ${rpcError.code}: ${rpcError.message}`);
        this.rpcError = rpcError;
    }
}
/** Implements Workspace archive and directory UI operations. */
class UiWorkspaceService extends Service {
    directoryPicker;
    workspaces;
    sessions;
    connecting = new Map();
    lifetime = new AbortController();
    /**
     * @param ctx - Client root Context.
     * @param directoryPicker - the directory-picking Remote namespace.
     * @param workspaces - pure Workspace Controller.
     * @param sessions - pure Session Controller.
     */
    constructor(ctx, directoryPicker, workspaces, sessions) {
        super(ctx, 'uiWorkspace');
        this.directoryPicker = directoryPicker;
        this.workspaces = workspaces;
        this.sessions = sessions;
        ctx.effect(() => this.watchNavigation(), 'ui-workspace: Workspace navigation policy');
    }
    async connectWorkspace(workspaceId) {
        const workspace = this.workspaces.list.getSnapshot().items
            .find(item => item.workspaceId === workspaceId);
        if (workspace === undefined) {
            throw new Error(`uiWorkspace.connectWorkspace: unknown workspace ${workspaceId}`);
        }
        const inflight = this.connecting.get(workspaceId);
        if (inflight !== undefined)
            return inflight;
        const archived = this.workspaces.list.getSnapshot().archivedSessionIds;
        const sessions = this.sessions.list.getSnapshot();
        for (const id of sessions.ids) {
            const summary = sessions.byId[id];
            if (summary !== undefined && summary.blank && summary.cwd === workspace.path
                && workspace.sessionIds.includes(summary.id)
                && !archived.includes(summary.id))
                return summary.id;
        }
        const attempt = this.sessions.create({ workspaceId })
            .finally(() => { this.connecting.delete(workspaceId); });
        this.connecting.set(workspaceId, attempt);
        return attempt;
    }
    openSession(sessionId) {
        this.sessions.open(sessionId);
        this.ctx.layout.selectPanel(null);
    }
    async openWorkspace(workspaceId, beforeOpen) {
        const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
        const isCurrent = () => !navigation.aborted;
        const sessionId = await this.connectWorkspace(workspaceId);
        if (!isCurrent())
            return;
        beforeOpen?.(sessionId);
        if (isCurrent())
            this.openSession(sessionId);
    }
    async forkSession(sessionId) {
        const navigation = AbortSignal.any([this.ctx.layout.beginNavigation(), this.lifetime.signal]);
        const childId = await this.sessions.fork({ sessionId, increaseTitle: true });
        if (!navigation.aborted)
            this.openSession(childId);
    }
    startSession(workspaceId) {
        const workspace = this.workspaces.list.getSnapshot();
        const sessions = this.sessions.list.getSnapshot();
        const current = sessions.current;
        const currentWorkspaceId = current === undefined
            ? undefined
            : workspace.items.find(item => item.sessionIds.includes(current))?.workspaceId;
        const recent = workspace.phase === 'ready' && sessions.phase === 'ready'
            ? recentWorkspace(workspace.items, sessions.byId)
            : undefined;
        const target = workspaceId ?? currentWorkspaceId ?? recent;
        if (target === undefined) {
            this.sessions.clear();
            this.ctx.layout.selectPanel(null);
            return;
        }
        void this.openWorkspace(target).catch((reason) => { console.warn('new session failed:', reason); });
    }
    async archiveSession(sessionId) {
        await this.workspaces.archiveSession(sessionId);
    }
    async pickDirectory() {
        const result = await this.directoryPicker.pick();
        if (!result.ok)
            throw new Error(`directory picker failed: ${result.error.message}`);
        return result.value;
    }
    async listDirectory(path, signal) {
        const result = await this.directoryPicker.list(path, signal);
        if (!result.ok)
            throw new DirectoryBrowseError(result.error);
        return result.value;
    }
    async createDirectory(path, name) {
        const result = await this.directoryPicker.createDirectory(path, name);
        if (!result.ok)
            throw new DirectoryBrowseError(result.error);
        return result.value;
    }
    watchNavigation() {
        let initial = 'waiting';
        const reconcile = () => {
            if (this.lifetime.signal.aborted)
                return;
            if (this.clearArchivedCurrent())
                return;
            if (initial !== 'waiting')
                return;
            const workspace = this.workspaces.list.getSnapshot();
            const sessions = this.sessions.list.getSnapshot();
            if (workspace.phase !== 'ready' || sessions.phase !== 'ready')
                return;
            if (sessions.current !== undefined) {
                initial = 'done';
                return;
            }
            const target = recentWorkspace(workspace.items, sessions.byId);
            if (target === undefined) {
                initial = 'done';
                return;
            }
            initial = 'connecting';
            void this.connectWorkspace(target).then((sessionId) => {
                if (this.lifetime.signal.aborted)
                    return;
                if (this.sessions.list.getSnapshot().current === undefined) {
                    this.sessions.open(sessionId);
                }
                initial = 'done';
            }, (reason) => {
                if (this.lifetime.signal.aborted)
                    return;
                initial = 'waiting';
                console.warn('initial workspace selection failed:', reason);
            });
        };
        const disposeWorkspaces = this.workspaces.list.subscribe(reconcile);
        const disposeSessions = this.sessions.list.subscribe(reconcile);
        reconcile();
        return () => {
            this.lifetime.abort();
            disposeSessions();
            disposeWorkspaces();
        };
    }
    /** @returns true when an archived current selection was cleared. */
    clearArchivedCurrent() {
        const current = this.sessions.list.getSnapshot().current;
        if (current === undefined
            || !this.workspaces.list.getSnapshot().archivedSessionIds.includes(current))
            return false;
        this.sessions.clear();
        return true;
    }
}
/** Stable tie-breaking follows Host Workspace order. */
function recentWorkspace(workspaces, sessions) {
    let selected;
    let selectedTime = Number.NEGATIVE_INFINITY;
    for (const workspace of workspaces) {
        let latest = Number.NEGATIVE_INFINITY;
        for (const sessionId of workspace.sessionIds) {
            const session = sessions[sessionId];
            if (session !== undefined)
                latest = Math.max(latest, session.updatedAt);
        }
        if (latest === Number.NEGATIVE_INFINITY)
            latest = Date.parse(workspace.createdAt);
        if (selected === undefined || latest > selectedTime) {
            selected = workspace.workspaceId;
            selectedTime = latest;
        }
    }
    return selected;
}
export { UiWorkspaceService };
//# sourceMappingURL=navigation.js.map