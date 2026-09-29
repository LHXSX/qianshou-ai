import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { MessageIconActions } from "./MessageIconActions.js";
import { UserStyleBubble } from "./MessageItem.js";
import css from './ParallelDispatchNodeView.module.css';
/**
 * Show a durable independent-task submission without impersonating a CEO reply.
 * @param props - Accepted receipt, attachment presentation and explicit child navigation.
 * @returns the original message when recorded, followed by its dispatch receipt.
 */
export function ParallelDispatchNodeView({ node, renderMessageImages, openFile, openSkill, openChild, t, }) {
    const { receipt, time } = node.data;
    const { message } = receipt;
    return _jsxs("section", { className: css.root, "data-parallel-dispatch": receipt.requestId, children: [message !== undefined && _jsx(UserStyleBubble, { content: message.content, renderMessageImages: renderMessageImages, references: { openFile, openSkill }, t: t, actions: text => _jsx(MessageIconActions, { text: text, time: time, clock: "start", t: t }) }), _jsxs("div", { className: css.receipt, children: [_jsx("span", { className: css.mark, "aria-hidden": "true", children: "\u2197" }), _jsxs("div", { className: css.copy, children: [_jsx("span", { className: css.title, children: t('parallel.dispatched') }), message === undefined && _jsxs("p", { className: css.legacy, children: [_jsx("span", { children: t('parallel.legacySummary') }), receipt.label] })] }), _jsx("button", { className: css.open, type: "button", onClick: () => {
                            openChild({ parentSessionId: receipt.parentSessionId, childSessionId: receipt.childSessionId, mode: receipt.mode });
                        }, children: t('parallel.openRecord') })] })] });
}
//# sourceMappingURL=ParallelDispatchNodeView.js.map