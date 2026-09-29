import { jsx as _jsx } from "react/jsx-runtime";
import { memo, useCallback, useMemo } from 'react';
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives';
import { isSettledTool } from "../contract/chat-nodes.js";
import { TURN_PROCESS_INDEPENDENT_KINDS } from "../contract/turn-process.js";
import { storedTurnProcessEntry } from "../stores.js";
import { useSearchableHidden } from "./searchable-hidden.js";
import css from './ChatView.module.css';
function turnDataOf(node) {
    const location = node?.location;
    return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.data : undefined;
}
function turnOf(node) {
    const location = node?.location;
    return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined;
}
function hasToolFailure(call) {
    return (isSettledTool(call) && call.isError) || call.subCalls.some(hasToolFailure);
}
/** Subscribe, apply Turn-process visibility, and dispatch one stable Context key. */
export const ChatNodeSeat = memo(function ChatNodeSeat({ nodeKey, useChatNode, useChatNodeProcess, historyIncomplete, compactTranscript, focusedTranscript, cwd, openFile, openSkill, inspectCall, forkAt, loadImage, renderMessageImages, fileMentions, useStore, actions, renderSlot, t, }) {
    const node = useChatNode(nodeKey);
    const routedNode = node;
    const turn = turnOf(routedNode);
    const processPresentation = useChatNodeProcess(nodeKey);
    const processSpec = processPresentation?.spec;
    const storedEntry = useStore(state => processSpec === undefined
        ? undefined
        : storedTurnProcessEntry(state, processSpec.turn));
    // Active disclosure belongs to the Turn, rather than each streamed Step.
    const liveProcess = focusedTranscript && processPresentation?.turnClosed === false;
    const generation = liveProcess ? -1 : processSpec?.answerStep;
    const processEntry = generation != null
        && storedEntry?.answerStep === generation
        ? storedEntry
        : undefined;
    const processOpen = processEntry !== undefined;
    const setOpen = useCallback((open) => {
        if (processSpec !== undefined && generation != null) {
            actions.setTurnProcessOpen(processSpec.turn, generation, open);
        }
    }, [actions, processSpec, generation]);
    const processWindowReady = processSpec !== undefined
        && processPresentation !== undefined
        && compactTranscript
        && (liveProcess || processSpec.answerAnchorSeq !== null)
        && processPresentation.turn === processSpec.turn
        && (liveProcess || processPresentation.turnClosed)
        && !historyIncomplete;
    const liveReply = liveProcess && routedNode?.kind === 'assistant-step'
        && routedNode.data.step === processPresentation.latestReplyStep;
    const visibleFailure = focusedTranscript && routedNode?.kind === 'tool-call'
        && hasToolFailure(routedNode.data.root);
    const processMember = routedNode !== undefined
        && processWindowReady
        && !liveReply && !visibleFailure
        && !TURN_PROCESS_INDEPENDENT_KINDS.has(routedNode.kind)
        && routedNode.anchorSeq >= processSpec.processStartSeq
        && (liveProcess || (processSpec.answerAnchorSeq !== null && routedNode.anchorSeq < processSpec.answerAnchorSeq));
    const processAnswer = routedNode !== undefined
        && processWindowReady
        && routedNode.kind === 'assistant-step'
        && (liveReply || routedNode.data.step === processSpec.answerStep);
    const ownsDisclosure = routedNode?.kind === 'turn-process' || processAnswer;
    const foldable = processWindowReady
        && (processMember || (ownsDisclosure
            && (processPresentation.hasExternalProcess || processSpec.inlineReasoning)));
    const turnProcess = useMemo(() => processSpec === undefined
        ? undefined
        : {
            spec: processSpec,
            foldable,
            open: processOpen,
            setOpen,
        }, [
        foldable, processOpen, processSpec, setOpen,
    ]);
    const controllerInactive = routedNode?.kind === 'turn-process'
        && !foldable;
    const compactAnswer = processAnswer
        && foldable
        && processPresentation.compactAnswer
        && !processOpen;
    const processHidden = controllerInactive || (foldable && processMember && !processOpen);
    const revealProcess = useCallback(() => {
        if (processMember)
            setOpen(true);
    }, [processMember, setOpen]);
    const wrapperRef = useSearchableHidden(processHidden, revealProcess);
    const owner = useMemo(() => node === undefined
        ? null
        : {
            cwd,
            openFile,
            openSkill,
            inspectCall,
            forkAt,
            loadImage,
            renderMessageImages,
            fileMentions,
            turnProcess,
        }, [
        node, cwd, openFile, openSkill, inspectCall, forkAt,
        loadImage, renderMessageImages, fileMentions, turnProcess,
    ]);
    if (routedNode === undefined || owner === null)
        return null;
    const turnData = turnDataOf(routedNode);
    // Runtime dispatch owns the correlation: every Node's discriminant is the
    // keyed-slot entry passed alongside that same Node. TypeScript does not
    // distribute an object containing a union into a union of objects itself.
    const routedOwner = { ...owner, node: routedNode };
    return (_jsx("div", { ref: wrapperRef, className: css.flowItem, "data-chat-anchor-key": routedNode.key, "data-chat-flow-key": routedNode.key, "data-chat-flow-kind": routedNode.kind, "data-chat-turn": turn, "data-turn-process-member": processMember || undefined, "data-turn-process-hidden": processHidden || undefined, "data-turn-process-answer": compactAnswer || undefined, children: renderSlot('conversation.chat.node', routedOwner, {
            entryKey: routedNode.kind,
            hookContext: turnData,
            fallback: (_jsx(JsonBlock, { label: t('message.unknownSurface', { type: routedNode.kind }), payload: routedNode.data, truncatedLabel: total => t('json.truncated', { total }) })),
        }) }));
});
//# sourceMappingURL=ChatNodeSeat.js.map