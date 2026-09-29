import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import { memo } from 'react';
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './TurnProcessNodeView.module.css';
/** Turn-level process disclosure controller. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({ node, turnProcess, t, }) {
    if (turnProcess === undefined)
        throw new Error('turn-process node requires Turn process owner state');
    if (!turnProcess.foldable)
        return null;
    const open = turnProcess.open;
    const running = (node.location.kind === 'turn' || node.location.kind === 'step')
        && node.location.turn.status === 'open';
    const labels = [];
    if (node.data.toolCallCount > 0) {
        labels.push(t(node.data.toolCallCount === 1
            ? 'message.turnProcess.toolCalls.one'
            : 'message.turnProcess.toolCalls.other', { count: node.data.toolCallCount }));
    }
    if (node.data.messageCount > 0) {
        labels.push(t(node.data.messageCount === 1
            ? 'message.turnProcess.messages.one'
            : 'message.turnProcess.messages.other', { count: node.data.messageCount }));
    }
    if (node.data.subagentCount > 0) {
        labels.push(t(node.data.subagentCount === 1
            ? 'message.turnProcess.subagents.one'
            : 'message.turnProcess.subagents.other', { count: node.data.subagentCount }));
    }
    const label = labels.length === 0
        ? t('message.turnProcess.thoughtForAWhile')
        : labels.join(t('message.turnProcess.separator'));
    return (_jsxs("button", { type: "button", className: css.root, "data-open": open || undefined, "data-running": running || undefined, "data-turn-process": node.data.turn, "data-turn-process-messages": node.data.messageCount, "data-turn-process-tool-calls": node.data.toolCallCount, "data-turn-process-subagents": node.data.subagentCount, "aria-expanded": open, "aria-label": running ? `${t('message.turnProcess.running')} · ${label}` : label, onClick: (event) => {
            event.currentTarget.focus();
            turnProcess.setOpen(!open);
        }, children: [_jsx("span", { className: css.indicator, "aria-hidden": "true" }), _jsxs("span", { className: css.copy, "aria-hidden": "true", children: [_jsx("strong", { children: t(running ? 'message.turnProcess.running' : 'message.turnProcess.done') }), _jsx("span", { className: css.label, children: label })] }), _jsx("span", { className: css.action, "aria-hidden": "true", children: t(open ? 'message.turnProcess.collapse' : 'message.turnProcess.expand') }), _jsx(IconChevronDownOutline14, { className: css.chevron })] }));
});
//# sourceMappingURL=TurnProcessNodeView.js.map