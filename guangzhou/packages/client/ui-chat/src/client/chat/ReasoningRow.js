import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
/** Assistant reasoning disclosure, independent of Tool-call presentation. */
import { useState } from 'react';
import { DisclosureRow, IconThinkOutline14 } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './ReasoningRow.module.css';
/**
 * Render a stable localized summary; the expanded, scrollable region preserves
 * the complete reasoning text and never moves the reader to new tokens.
 * @param props.text - complete or streaming reasoning text.
 * @param props.running - whether this block is the streaming tail.
 * @param props.t - conversation locale seat for the running status.
 * @returns the reasoning disclosure.
 */
export function ReasoningRow({ text, running, t }) {
    const [expanded, setExpanded] = useState(false);
    return (_jsx("div", { className: css.root, "data-variant": "think", "data-state": running ? 'running' : 'ok', "data-expanded": expanded || undefined, children: _jsx(DisclosureRow, { rowClassName: css.row, leadingClassName: css.leading, titleClassName: css.title, chevronClassName: css.chevron, icon: _jsx(IconThinkOutline14, { size: 14 }), title: t('message.think'), open: expanded, expandable: true, expandOnRowClick: true, onToggle: () => { setExpanded(value => !value); }, collapsedContent: (_jsxs(_Fragment, { children: [_jsx("span", { className: css.separator, "aria-hidden": true }), _jsx("span", { className: css.summary, children: t(running ? 'message.think.running' : 'message.think.settled') })] })), children: _jsx("div", { className: css.thinkBody, role: "region", "aria-label": t('message.think.details'), tabIndex: 0, children: text }) }) }));
}
//# sourceMappingURL=ReasoningRow.js.map