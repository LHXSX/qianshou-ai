import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** Lazily loaded, fully rigged character; no microphone or task ownership. */
import { useEffect, useRef, useState } from 'react';
import css from './VRMCompanion.module.css';
/**
 * Render an interactive full-body model using the existing speech playback observations.
 * @param props - UI-owned activity, approved local model and localized loading messages.
 * @returns A transparent WebGL canvas with an explicit loading/error state.
 */
export function VRMCompanion({ frame, speaking, modelUrl, t }) {
    const mount = useRef(null);
    const live = useRef({ frame, speaking });
    live.current = { frame, speaking };
    const [generation, setGeneration] = useState(0);
    const [state, setState] = useState('loading');
    useEffect(() => {
        const container = mount.current;
        if (!container)
            return;
        let disposed = false;
        const isDisposed = () => disposed;
        let runtime;
        const controller = new AbortController();
        setState('loading');
        void import("./vrm-companion-runtime.js").then(async ({ createCompanionRuntime }) => {
            if (disposed)
                return;
            runtime = await createCompanionRuntime(container, {
                modelUrl, signal: controller.signal, readState: () => live.current,
                onError: () => { if (!disposed)
                    setState('error'); },
            });
            if (isDisposed())
                runtime.dispose();
            else
                setState('ready');
        }).catch(() => { if (!disposed)
            setState('error'); });
        return () => { disposed = true; controller.abort(); runtime?.dispose(); };
    }, [modelUrl, generation]);
    return _jsxs("div", { className: css.host, "data-vrm-character": state, children: [_jsx("div", { className: css.canvas, ref: mount, role: "img", "aria-label": t('voice.characterDescription') }), state !== 'ready' && _jsxs("div", { className: css.notice, role: "status", children: [_jsx("span", { children: t(state === 'loading' ? 'voice.characterLoading' : 'voice.characterFailed') }), state === 'error' && _jsx("button", { type: "button", onClick: () => { setGeneration(value => value + 1); }, children: t('voice.characterRetry') })] })] });
}
//# sourceMappingURL=VRMCompanion.js.map