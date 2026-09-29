import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
import clsx from 'clsx';
import { IconLoadingOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './LoadingIndicator.module.css';
/** @param props - localized status label and optional placement style. @returns an animated, accessible loading status. */
export function LoadingIndicator({ label, className }) {
    return _jsxs("span", { className: clsx(css.loading, className), role: "status", "data-document-loading": true, children: [_jsx("span", { className: css.icon, "aria-hidden": "true", children: _jsx(IconLoadingOutline16, {}) }), _jsx("span", { children: label })] });
}
//# sourceMappingURL=LoadingIndicator.js.map