import type { ReactNode } from 'react';
import type { DockIntents, DockLabels, TabRenderer } from '../contract/adapter.ts';
import type { LayoutState, TabId } from '../contract/types.ts';
/** The layout whose `floats` this layer draws. */
export interface FloatLayerProps {
    readonly state: LayoutState;
    readonly intents: DockIntents;
    readonly labels: DockLabels;
    readonly renderTab: TabRenderer;
    /** Whether a floating tab offers its close control; defaults to true. Called per tab on every render. */
    readonly canCloseTab?: (tabId: TabId) => boolean;
    /** The panel header's title content; omit to show the record's `title` text (see `DockSurfaceProps`). */
    readonly renderTabTitle?: TabRenderer;
}
/** Every floating panel, in z order. */
export declare function FloatLayer({ state, intents, labels, renderTab, renderTabTitle, canCloseTab }: FloatLayerProps): ReactNode;
//# sourceMappingURL=FloatLayer.d.ts.map