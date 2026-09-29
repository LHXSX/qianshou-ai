import { jsx as _jsx, Fragment as _Fragment, jsxs as _jsxs } from "react/jsx-runtime";
import { useEffect, useRef, useState } from 'react';
import { speakReply, spokenText } from "./speech.js";
import { loadPlaybackSpeaker } from "./voice-catalog.js";
import css from '../MessageIconActions.module.css';
/** Read a completed assistant answer on demand; navigation always ends playback. */
export function ReadAloud({ text, t }) {
    const [speaking, setSpeaking] = useState(false);
    const [failed, setFailed] = useState(false);
    const cancel = useRef(null);
    useEffect(() => () => { cancel.current?.(); }, [text]);
    if (!('speechSynthesis' in window) || typeof SpeechSynthesisUtterance === 'undefined' || spokenText(text) === '')
        return null;
    const label = failed ? t('voice.speechFailed') : t(speaking ? 'voice.stopReading' : 'voice.read');
    return _jsx("button", { type: "button", className: css.action, "aria-label": label, title: label, "aria-pressed": speaking, onClick: () => {
            if (speaking) {
                cancel.current?.();
                setSpeaking(false);
                return;
            }
            setFailed(false);
            setSpeaking(true);
            cancel.current = speakReply(text, t('voice.language'), () => { setSpeaking(false); }, () => { setSpeaking(false); setFailed(true); }, loadPlaybackSpeaker(), () => { setSpeaking(false); });
        }, children: _jsx("svg", { width: "16", height: "16", viewBox: "0 0 20 20", fill: "none", stroke: "currentColor", strokeWidth: "1.4", "aria-hidden": "true", children: speaking ? _jsx("rect", { x: "5", y: "5", width: "10", height: "10", rx: "2", fill: "currentColor" }) : _jsxs(_Fragment, { children: [_jsx("path", { d: "M9 4 5 7H2v6h3l4 3V4Z" }), _jsx("path", { d: "M12 7c2 1.5 2 4.5 0 6m3-9c4 3 4 9 0 12" })] }) }) });
}
//# sourceMappingURL=ReadAloud.js.map