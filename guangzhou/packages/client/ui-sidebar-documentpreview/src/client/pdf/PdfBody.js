import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** PDF page presentation; binary content and tab information come from the document owner. */
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@deepseek-ai/dsh-client-ui-primitives';
import { LoadingIndicator } from "../LoadingIndicator.js";
import { DEFAULT_PDF_VIEW } from "./store.js";
import { renderPdfPage } from "./document.js";
import { openPdf } from "./runtime.js";
import { PdfWorkerFailure } from "./errors.js";
import css from './PdfBody.module.css';
/**
 * Present a PDF with tab-local viewing preferences and component-owned rendering resources.
 * @param props - complete bytes and framework-owned tab/store/locale seats.
 * @returns the PDF reader.
 */
export function PdfBody(props) {
    const { tab } = props.useTabInfo();
    const view = props.useStore(state => state.byTab[tab.id] ?? DEFAULT_PDF_VIEW);
    const data = props.content.kind === 'bytes' ? props.content.data : undefined;
    const [load, setLoad] = useState();
    const [attempt, setAttempt] = useState(0);
    const { retainTab, actions, t } = props;
    const pageVisible = useCallback((page) => {
        actions.page(tab.id, page);
    }, [actions, tab.id]);
    useEffect(() => { retainTab(tab.id, tab.signal); }, [retainTab, tab.id, tab.signal]);
    useEffect(() => {
        if (data === undefined || tab.signal.aborted)
            return;
        const lifetime = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, tab.signal]);
        setLoad(undefined);
        const session = openPdf(data, signal, (error) => {
            if (!signal.aborted)
                setLoad({ kind: 'failed', data, error });
        });
        void session.document.then((document) => { if (!signal.aborted)
            setLoad({ kind: 'loaded', data, document }); }, (error) => { if (!signal.aborted)
            setLoad({ kind: 'failed', data, error }); });
        return () => {
            lifetime.abort();
            void session.dispose();
        };
    }, [data, tab.signal, attempt]);
    if (data === undefined)
        return _jsx("p", { className: css.status, role: "alert", children: t('unsupported') });
    if (load?.data !== data)
        return _jsx(LoadingIndicator, { className: css.status, label: t('loading') });
    if (load.kind === 'failed') {
        return _jsxs("div", { className: css.status, role: "alert", children: [_jsx("span", { children: failureText(load.error, t) }), _jsx(Button, { size: "sm", onClick: () => { setAttempt(value => value + 1); }, children: t('retry') })] });
    }
    return _jsx("section", { className: css.body, "data-pdf-preview": true, children: Array.from({ length: load.document.numPages }, (_, index) => (_jsx(PdfPage, { document: load.document, page: index + 1, requested: index === 0 || view.page === index + 1, onVisible: pageVisible, signal: tab.signal, t: t }, index))) });
}
function PdfPage({ document, page, requested: initiallyRequested, onVisible, signal, t }) {
    const host = useRef(null);
    const canvas = useRef(null);
    const [requested, setRequested] = useState(initiallyRequested);
    const [state, setState] = useState('loading');
    const [failure, setFailure] = useState();
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
        const node = host.current;
        if (typeof IntersectionObserver === 'undefined') {
            setRequested(true);
            return;
        }
        let disposed = false;
        const observer = new IntersectionObserver((entries) => {
            if (disposed || !entries.some(entry => entry.isIntersecting))
                return;
            setRequested(true);
            onVisible(page);
            observer.disconnect();
        }, { rootMargin: '100% 0px' });
        observer.observe(node);
        return () => {
            disposed = true;
            observer.disconnect();
        };
    }, [page, onVisible]);
    useEffect(() => {
        if (!requested)
            return;
        // The canvas is unconditional; this effect runs after its ref is committed.
        const node = canvas.current;
        const lifetime = new AbortController();
        const renderSignal = AbortSignal.any([lifetime.signal, signal]);
        setState('loading');
        setFailure(undefined);
        void renderPdfPage(document, page, node, renderSignal, window.devicePixelRatio).then(() => { if (!renderSignal.aborted)
            setState('ready'); }, (error) => { if (!renderSignal.aborted)
            setFailure({ error }); });
        return () => { lifetime.abort(); };
    }, [document, page, requested, signal, attempt]);
    return _jsxs("div", { ref: host, className: css.page, "data-pdf-page": page, children: [failure === undefined && state !== 'ready' && _jsx("div", { className: css.placeholder, children: requested && _jsx(LoadingIndicator, { className: css.status, label: t('rendering') }) }), failure !== undefined && _jsxs("div", { className: css.status, role: "alert", children: [_jsx("span", { children: failureText(failure.error, t) }), _jsx(Button, { size: "sm", onClick: () => { setAttempt(value => value + 1); }, children: t('retry') })] }), _jsx("canvas", { ref: canvas, className: css.canvas, role: "img", "aria-label": t('pageImage', { page }), hidden: state !== 'ready' || failure !== undefined })] });
}
function failureText(error, t) {
    if (error instanceof PdfWorkerFailure)
        return t('workerFailed');
    if (error instanceof Error && error.name === 'PasswordException')
        return t('password');
    return t('failed', { message: error instanceof Error ? error.message : String(error) });
}
//# sourceMappingURL=PdfBody.js.map