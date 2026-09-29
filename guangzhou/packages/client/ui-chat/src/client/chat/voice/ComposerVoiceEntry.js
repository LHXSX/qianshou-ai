import { jsx as _jsx, jsxs as _jsxs } from "react/jsx-runtime";
/** Compact composer entry; microphone and task ownership stay in VoiceConversation. */
import { useState } from 'react';
import { Button, IconChevronDownOutline14, IconEditOutline16, Menu } from '@deepseek-ai/dsh-client-ui-primitives';
import css from './ComposerVoiceEntry.module.css';
/**
 * Present a microphone action and an optional menu inside the resident composer.
 * @param props - current delivery choice and controller-owned actions.
 * @returns compact controls that open no microphone until a start action.
 */
export function ComposerVoiceEntry({ t, delivery, isSubagent, onStartConversation, onStartDictation, onDeliveryChange, }) {
    const [optionsOpen, setOptionsOpen] = useState(false);
    const select = (id) => {
        setOptionsOpen(false);
        if (id === 'dictate')
            onStartDictation();
        else if (id === 'manager' || id === 'parallel' || id === 'current')
            onDeliveryChange(id);
    };
    return _jsxs("div", { className: css.root, "data-composer-voice-entry": true, children: [_jsx(Button, { size: "sm", className: css.microphone, "aria-label": t('voice.start'), "aria-description": t(`voice.${delivery}`), title: t('voice.start'), onClick: onStartConversation, children: _jsxs("svg", { width: "18", height: "18", viewBox: "0 0 20 20", fill: "none", "aria-hidden": "true", children: [_jsx("rect", { x: "7", y: "2", width: "6", height: "10", rx: "3", stroke: "currentColor", strokeWidth: "1.6" }), _jsx("path", { d: "M4.5 9.5a5.5 5.5 0 0 0 11 0M10 15v3M7 18h6", stroke: "currentColor", strokeWidth: "1.6", strokeLinecap: "round" })] }) }), _jsx(Menu, { open: optionsOpen, onClose: () => { setOptionsOpen(false); }, onSelect: select, selectedId: delivery, side: "top", align: "end", compact: true, dense: true, portal: true, autoFocus: true, anchor: _jsx(Button, { size: "sm", className: css.options, "aria-label": t('voice.delivery'), title: t('voice.delivery'), "aria-haspopup": "menu", "aria-expanded": optionsOpen, onClick: () => { setOptionsOpen(value => !value); }, children: _jsx(IconChevronDownOutline14, { size: 11 }) }), items: [
                    { type: 'label', id: 'delivery-heading', text: t('voice.delivery') },
                    { id: 'manager', label: t('voice.manager'), disabled: isSubagent },
                    { id: 'parallel', label: t('voice.parallel'), disabled: isSubagent },
                    { id: 'current', label: t('voice.current') },
                    { type: 'separator', id: 'dictation-separator' },
                    { id: 'dictate', label: t('voice.dictate'), icon: _jsx(IconEditOutline16, { size: 15 }) },
                ] })] });
}
//# sourceMappingURL=ComposerVoiceEntry.js.map