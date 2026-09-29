import { jsx as _jsx } from "react/jsx-runtime";
/** Complete HTML rendered in a script-enabled opaque iframe, without parent application access. */
import { useEffect, useMemo, useState } from 'react';
import { LoadingIndicator } from "../LoadingIndicator.js";
import { createHtmlDocument } from "./bootstrap.js";
import { packHtml } from "./pack.js";
import { createReadHtmlRelative } from "./read-relative.js";
import css from './HtmlBody.module.css';
/** One mounted file owns its root Blob; replacing content also replaces the browsing context. */
function HtmlFrame({ data, readRelative, t }) {
    const [frame, setFrame] = useState();
    useEffect(() => {
        const controller = new AbortController();
        let url;
        void (async () => {
            try {
                const bundle = await packHtml(data, readRelative, controller.signal);
                controller.signal.throwIfAborted();
                const html = createHtmlDocument(bundle);
                url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
                setFrame({ data, readRelative, url });
            }
            catch {
                if (!controller.signal.aborted)
                    setFrame({ data, readRelative, url: undefined });
            }
        })();
        return () => {
            controller.abort();
            if (url !== undefined)
                URL.revokeObjectURL(url);
        };
    }, [data, readRelative]);
    if (frame?.data !== data || frame.readRelative !== readRelative) {
        return _jsx(LoadingIndicator, { className: css.status, label: t('loading') });
    }
    if (frame.url === undefined)
        return _jsx("p", { className: css.status, role: "alert", children: t('failed') });
    return _jsx("iframe", { className: css.frame, src: frame.url, sandbox: "allow-scripts", title: t('frame'), "data-html-preview": true }, frame.url);
}
/**
 * Render complete HTML with the standard file and tab hooks.
 * @param props - document bytes, hooks, related-file reader and locale.
 * @returns an isolated HTML document, or nothing for text delivery.
 */
export function HtmlBody({ content, resourceAddress, readRelated, useTabInfo, t }) {
    const { tab } = useTabInfo();
    const readRelative = useMemo(() => createReadHtmlRelative(readRelated, resourceAddress, tab.signal), [readRelated, resourceAddress, tab.signal]);
    if (content.kind !== 'bytes')
        return null;
    return _jsx(HtmlFrame, { data: content.data, readRelative: readRelative, t: t }, resourceAddress);
}
//# sourceMappingURL=HtmlBody.js.map