import type { ReactNode } from 'react';
import type { LayoutState, PaneNode } from '../contract/types.ts';
import type { PaneCallbacks } from './render.ts';
/** A pane and the live layout it reads its tabs from. */
export interface TabPanelProps {
    readonly state: LayoutState;
    readonly pane: PaneNode;
    readonly callbacks: PaneCallbacks;
}
/** The pane's tab strip, split control, and body. */
export declare function TabPanel({ state, pane, callbacks }: TabPanelProps): ReactNode;
//# sourceMappingURL=TabPanel.d.ts.map