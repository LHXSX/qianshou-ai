import { documentFileBytes } from "./rpc.js";
/**
 * Bind the preview's face to one paged read and one complete-byte read.
 * @param read - the bound `workspaceFiles.read` call.
 * @param readAll - ordinary complete-byte Remote read.
 * @returns the Slot `inject` factory: bound actions in, face out. The slot's session id is unused because the address carries its own.
 */
export function textFace(read, readAll) {
    return (_sessionId, actions) => {
        const tabs = new Map();
        // Reached with a live signal only: the record's end forgets the tab's
        // bucket and this bookkeeping in one listener, however often its body mounts.
        const readsOf = (tabId, signal) => {
            const held = tabs.get(tabId);
            if (held !== undefined)
                return held;
            const created = { generation: 0, version: undefined, mode: 'text-pages' };
            tabs.set(tabId, created);
            signal.addEventListener('abort', () => {
                tabs.delete(tabId);
                actions.forget(tabId);
            }, { once: true });
            return created;
        };
        const modeOf = (tabId, signal, mode) => {
            const reads = readsOf(tabId, signal);
            if (reads.mode !== mode) {
                reads.mode = mode;
                reads.generation++;
                reads.version = undefined;
                actions.reset(tabId);
            }
            return reads;
        };
        const loadPage = (tabId, file, offset, signal, observedVersion) => {
            if (signal.aborted)
                return;
            const reads = modeOf(tabId, signal, 'text-pages');
            const { generation } = reads;
            actions.loading(tabId, 'text-pages', observedVersion);
            void read(file.sessionId, file.path, offset, signal).then((result) => {
                if (signal.aborted || reads.generation !== generation)
                    return;
                if (!result.ok) {
                    actions.failed(tabId, result.error);
                    return;
                }
                // Pages of two versions never meet: a newer file past the first line
                // restarts the walk from line 1, where the store adopts the new version.
                if (offset !== 1 && reads.version !== undefined && result.value.version !== reads.version) {
                    restart(tabId, file, signal, observedVersion);
                    return;
                }
                reads.version = result.value.version;
                actions.page(tabId, result.value);
            });
        };
        const loadAll = (tabId, file, signal, observedVersion) => {
            if (signal.aborted)
                return;
            const reads = modeOf(tabId, signal, 'bytes-complete');
            const { generation } = reads;
            actions.loading(tabId, 'bytes-complete', observedVersion);
            void readAll(file, signal).then((result) => {
                if (signal.aborted || reads.generation !== generation)
                    return;
                if (!result.ok) {
                    actions.failed(tabId, result.error);
                    return;
                }
                let file;
                try {
                    file = documentFileBytes(result.value);
                }
                catch (error) {
                    actions.failed(tabId, Object.assign(new Error('document file byte response has malformed base64 data', { cause: error }), { name: 'RemoteError', isDSHRemoteError: true, code: 'gateway/internal', details: {} }));
                    return;
                }
                reads.version = file.version;
                actions.complete(tabId, file);
            });
        };
        const restart = (tabId, file, signal, observedVersion, mode = 'text-pages') => {
            if (signal.aborted)
                return;
            const reads = readsOf(tabId, signal);
            reads.generation += 1;
            reads.version = undefined;
            actions.reset(tabId);
            if (mode === 'text-pages')
                loadPage(tabId, file, 1, signal, observedVersion);
            else
                loadAll(tabId, file, signal, observedVersion);
        };
        return {
            loadPage, reloadPages: restart, loadAll,
            reloadAll: (tabId, file, signal, observedVersion) => { restart(tabId, file, signal, observedVersion, 'bytes-complete'); },
        };
    };
}
//# sourceMappingURL=face.js.map