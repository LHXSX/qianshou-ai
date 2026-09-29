import { type CompanionMotionInput } from './companion-motion.ts';
interface RuntimeOptions {
    readonly modelUrl: string;
    readonly signal: AbortSignal;
    readonly readState: () => {
        readonly frame: Omit<CompanionMotionInput, 'elapsed'>;
        readonly speaking: boolean;
    };
    readonly onError: () => void;
}
/** A character owns only its local rendering resources. */
export interface CompanionRuntime {
    dispose(): void;
}
/**
 * Load an approved bundled model and animate its actual skeleton and expression morphs.
 * @param container - Transparent character slot; input controls are owned by its parent.
 * @param options - Local asset, cancellation and read-only activity/speech state.
 * @returns Resource cleanup, including the GPU context, model and observer listeners.
 */
export declare function createCompanionRuntime(container: HTMLElement, options: RuntimeOptions): Promise<CompanionRuntime>;
export {};
//# sourceMappingURL=vrm-companion-runtime.d.ts.map