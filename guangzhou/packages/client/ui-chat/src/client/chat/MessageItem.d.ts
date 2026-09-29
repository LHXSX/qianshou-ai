import type { ReactNode } from 'react';
import type { PendingSubmission } from '@deepseek-ai/dsh-api-session-controller/client';
import type { MessageImageSource } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { ChatNodeOwnerProps, ChatNodeViewProps, ChatViewSlotProps } from '../contract/slots.ts';
import type { UserMessageNode } from '../contract/snapshot.ts';
type UserFile = Extract<UserMessageNode['content'][number], {
    type: 'file';
}>;
type PresentedAttachment = {
    readonly type: 'image';
    readonly image: MessageImageSource;
} | {
    readonly type: 'file';
    readonly file: UserFile['attachment'];
};
/**
 * Render human-authored content and durable attachments in a right-aligned bubble.
 * @param props - Content, image presentation, optional actions and localized labels.
 * @returns the common human-message presentation.
 */
export declare function UserStyleBubble({ content, renderMessageImages, actions, pending, echo, referenceLabels, skillNames, previewAttachments, references, t, }: {
    content: readonly unknown[];
    renderMessageImages: ChatNodeOwnerProps['renderMessageImages'];
    /** Optional IconActions (or similar) below the bubble; receives the joined text. */
    actions?: (text: string) => ReactNode;
    /** Whether this is the Host-authoritative pre-admission steering projection. */
    pending?: boolean;
    /** Whether this is a local submission echo (invisible marker; the echo renders exactly like its durable replacement). */
    echo?: boolean;
    /** Exact session mention labels associated by the adjacent recall node. */
    referenceLabels?: readonly string[];
    /** Skill names the step's `skill-invocation` injections loaded for this message. */
    skillNames?: readonly string[];
    /** Local submission-echo attachments replacing the content-derived attachment sequence. */
    previewAttachments?: readonly PresentedAttachment[];
    references?: Pick<ChatNodeOwnerProps, 'openFile' | 'openSkill'>;
    t: ChatViewSlotProps['t'];
}): ReactNode;
/**
 * Render one Host-authoritative pending steering item with the same visual
 * language as its eventual durable transcript node.
 * @param props - Pending message content and conversation translator.
 * @returns the pending steering bubble.
 */
export declare function PendingSteeringBubble({ content, renderMessageImages, t }: {
    content: readonly unknown[];
    renderMessageImages: ChatNodeOwnerProps['renderMessageImages'];
    t: ChatViewSlotProps['t'];
}): ReactNode;
/**
 * Render one local transcript or steering submission echo with the same
 * visual language and surface marker as the Host occurrence that replaces
 * it: draft text plus object-URL previews, visible from the submit click
 * until the durable `user/message` or steering occurrence renders.
 * @param props - the session snapshot's pending submission and render seats.
 * @returns the echoed user bubble.
 */
export declare function PendingSubmissionBubble({ submission, renderMessageImages, t }: {
    submission: PendingSubmission;
    renderMessageImages: ChatNodeOwnerProps['renderMessageImages'];
    t: ChatViewSlotProps['t'];
}): ReactNode;
/** User and admitted-steering keyed Chat renderer. */
export declare const UserMessageNodeView: import("react").MemoExoticComponent<({ node, renderMessageImages, openFile, openSkill, t, }: ChatNodeViewProps<"user" | "steering">) => import("react").JSX.Element>;
/** Injected-context keyed Chat renderer. */
export declare const ContextMessageNodeView: import("react").MemoExoticComponent<({ node, t }: ChatNodeViewProps<"context">) => import("react").JSX.Element>;
/** Automatic compaction keyed Chat renderer. */
export declare const CompactionNodeView: import("react").MemoExoticComponent<({ node, t }: ChatNodeViewProps<"compaction">) => import("react").JSX.Element>;
/** Correlated retry-chain keyed Chat renderer. */
export declare const RetryNodeView: import("react").MemoExoticComponent<({ node, t }: ChatNodeViewProps<"model-retry">) => import("react").JSX.Element>;
/** Terminal turn-error keyed Chat renderer. */
export declare const TurnErrorNodeView: import("react").MemoExoticComponent<({ node, t }: ChatNodeViewProps<"turn-error">) => import("react").JSX.Element>;
/** Max-tokens turn-end notice keyed Chat renderer. */
export declare const TurnMaxTokensNodeView: import("react").MemoExoticComponent<({ t }: ChatNodeViewProps<"turn-max-tokens">) => import("react").JSX.Element>;
/** Explicit unknown-surface keyed Chat renderer. */
export declare const UnknownNodeView: import("react").MemoExoticComponent<({ node, t }: ChatNodeViewProps<"unknown">) => import("react").JSX.Element>;
export {};
//# sourceMappingURL=MessageItem.d.ts.map