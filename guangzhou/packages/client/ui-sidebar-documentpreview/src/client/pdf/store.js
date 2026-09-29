/** Restorable PDF viewing preferences; document objects and canvases remain component-local. */
import { defineStore } from '@deepseek-ai/dsh-client-store';
/** Initial viewing position before a tab reaches another page. */
export const DEFAULT_PDF_VIEW = { page: 1 };
/**
 * Declare the last visible page isolated by tab identity.
 * @returns a store declaration instantiated by the document slot for each Session.
 */
export function createPdfStore() {
    return defineStore({
        init: () => ({ byTab: {} }),
        actions: {
            /** @param draft - view state. @param tabId - owning tab. @param page - selected 1-based page. */
            page: (draft, tabId, page) => {
                draft.byTab[tabId] = { page };
            },
            /** @param draft - view state. @param tabId - closed tab whose preferences are discarded. */
            forget: (draft, tabId) => {
                const remaining = {};
                for (const [id, view] of Object.entries(draft.byTab)) {
                    if (id !== tabId)
                        remaining[id] = view;
                }
                draft.byTab = remaining;
            },
        },
    });
}
//# sourceMappingURL=store.js.map