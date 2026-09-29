import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots';
import type { CompanionMotionInput } from './companion-motion.ts';
interface VRMCompanionProps extends PropsLocale<'chat'> {
    readonly frame: Omit<CompanionMotionInput, 'elapsed'>;
    readonly speaking: boolean;
    readonly modelUrl: string;
}
/**
 * Render an interactive full-body model using the existing speech playback observations.
 * @param props - UI-owned activity, approved local model and localized loading messages.
 * @returns A transparent WebGL canvas with an explicit loading/error state.
 */
export declare function VRMCompanion({ frame, speaking, modelUrl, t }: VRMCompanionProps): import("react").JSX.Element;
export {};
//# sourceMappingURL=VRMCompanion.d.ts.map