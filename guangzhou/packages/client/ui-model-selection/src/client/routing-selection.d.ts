import type { ModelSelection } from '@deepseek-ai/dsh-api-remotes/client';
import type { ModelDirectoryState } from './directory.ts';
/** Enable task routing within the currently selected provider's loaded catalog. */
export declare function automaticSelection(state: ModelDirectoryState): ModelSelection | undefined;
/** A manual model pick locks the route while retaining independently automatic effort. */
export declare function manualModelSelection(current: ModelSelection | null, picked: ModelSelection): ModelSelection;
/** Change effort policy without turning an automatic model route into a manual one. */
export declare function effortSelection(current: ModelSelection, effort: string | undefined, automatic: boolean): ModelSelection;
//# sourceMappingURL=routing-selection.d.ts.map