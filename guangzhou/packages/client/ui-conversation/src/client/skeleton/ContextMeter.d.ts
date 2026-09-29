/** Session context-occupancy meter: a header ring fed by the
 * `contextPressure` projection, with a click-open panel of the heuristic
 * `contextBreakdown` composition (system prompt, tools, conversation).
 * Renders nothing until a provider reports both pressure and a route
 * capacity. */
import type { UseProjection } from '@deepseek-ai/dsh-api-session-controller/client';
import type { ComposerBarProps } from '../contract/slots.ts';
export interface ContextMeterProps {
    useProjection: UseProjection;
    /** The owning bar's locale seat, passed down as a plain prop. */
    t: ComposerBarProps['t'];
    placement?: 'above' | 'below';
}
/** Header placement retains the same context projection and detail disclosure. */
export declare function HeaderContextMeter(props: ContextMeterProps): import("react").JSX.Element;
export declare function ContextMeter({ useProjection, t, placement }: ContextMeterProps): import("react").JSX.Element | null;
//# sourceMappingURL=ContextMeter.d.ts.map