import type { ChatViewSlotProps } from '../contract/slots.ts';
/**
 * Render a stable localized summary; the expanded, scrollable region preserves
 * the complete reasoning text and never moves the reader to new tokens.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.t - conversation locale seat for the running status.
 * @returns the reasoning disclosure.
 */
export declare function ReasoningRow({ text, running, t }: {
    text: string;
    running: boolean;
    t: ChatViewSlotProps['t'];
}): import("react").JSX.Element;
//# sourceMappingURL=ReasoningRow.d.ts.map