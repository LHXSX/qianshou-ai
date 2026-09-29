import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
/**
 * ModelSelect: the composer's named model seat (`conversation.input.model`).
 * Two-level selection per figma 496:26454's MenuDropdown: the root menu is
 * the Model / Effort row pair (label + current value + a right chevron),
 * each drilling into its own list — the provider-grouped model list over
 * the shared directory, and the effort levels. The trigger (313:14108's
 * ToggleButton) shows both: model name + effort in the caption tone.
 * Data and submission ride the SAME per-session ModelDirectory as the
 * /model popup; exact-model reasoning metadata and the selected effort come
 * from the Host rather than a client-owned vocabulary. A rejected selection
 * announces through the shared transient Toast anchored to the composer
 * card; the in-menu strip with Retry remains the catalog-load surface.
 */
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, } from 'react';
import { createPortal } from 'react-dom';
import clsx from 'clsx';
import { IconCheckOutline16, IconChevronDownOutline14, IconChevronRightOutline14, IconDataOutline16, IconWarningOutline16, Toast, } from '@deepseek-ai/dsh-client-ui-primitives';
import { automaticSelection, effortSelection, manualModelSelection } from "./routing-selection.js";
import css from './ModelSelect.module.css';
/** Unplaced portal card: hidden but laid out at a fixed origin so offsetWidth/offsetHeight are real (Menu primitive's measure pass). */
const MEASURE_STYLE = { visibility: 'hidden', left: 0, top: 0 };
/**
 * Render the composer model seat.
 * @param props - owner share (locked) + injected face (shared directory
 * store/verbs) + the standard locale seat.
 * @returns the trigger and, while open, the two-level menu.
 */
export function ModelSelect({ locked, available, directory, load, select, t }) {
    const state = useSyncExternalStore(fn => directory.subscribe(fn), () => directory.getSnapshot());
    const [open, setOpen] = useState(false);
    const [pane, setPane] = useState('root');
    // The in-menu error strip serves catalog loads (its Retry re-runs the
    // load); a rejected SELECTION announces through the transient toast
    // instead, so the strip renders only while the latest failure-capable
    // action was a load.
    const lastActionRef = useRef('load');
    const [toast, setToast] = useState(null);
    const toastSeq = useRef(0);
    const rootRef = useRef(null);
    const triggerRef = useRef(null);
    const menuRef = useRef(null);
    const [menuPos, setMenuPos] = useState(null);
    const itemRefs = useRef([]);
    const id = useId();
    const choices = useMemo(() => state.groups.flatMap(group => group.models.map(model => ({
        group,
        model,
        selection: {
            provider: group.id,
            model: model.id,
            ...model.reasoning?.defaultEffort === undefined
                ? {}
                : { reasoningEffort: model.reasoning.defaultEffort },
        },
    }))), [state.groups]);
    const selectedIndex = state.current === null
        ? -1
        : choices.findIndex(c => c.selection.provider === state.current?.provider && c.selection.model === state.current.model);
    const currentChoice = choices[selectedIndex];
    const modelAutomatic = state.current?.routing?.model === 'auto';
    const effortAutomatic = state.current?.routing?.effort === 'auto';
    const autoSelection = automaticSelection(state);
    const reasoning = currentChoice?.model.reasoning;
    const effectiveEffort = state.current?.reasoningEffort ?? reasoning?.defaultEffort;
    const effortLabel = effortAutomatic
        ? t('auto.label')
        : reasoning === undefined
            ? undefined
            : effectiveEffort === undefined
                ? t('effort.providerDefault')
                : reasoning.efforts.find(level => level.id === effectiveEffort)?.name ?? effectiveEffort;
    const effortChoices = useMemo(() => reasoning === undefined
        ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
        : [
            ...reasoning.defaultEffort === undefined
                ? [{ key: 'provider-default', effort: undefined, label: t('effort.providerDefault') }]
                : [],
            ...reasoning.efforts.map((effort) => ({
                key: `effort:${effort.id}`,
                effort: effort.id,
                label: effort.name,
            })),
        ], [reasoning, t]);
    const busy = state.status === 'selecting';
    const reload = () => {
        lastActionRef.current = 'load';
        load();
    };
    useEffect(() => {
        if (!open)
            return;
        const closeOutside = (event) => {
            // The portaled card is outside the trigger subtree; check both.
            if (rootRef.current?.contains(event.target) === true)
                return;
            if (menuRef.current?.contains(event.target) === true)
                return;
            setOpen(false);
        };
        document.addEventListener('mousedown', closeOutside);
        return () => { document.removeEventListener('mousedown', closeOutside); };
    }, [open]);
    // Portaled placement (the Menu primitive's portal rules: fixed from the
    // anchor rect, measured before paint, clamped inside the viewport): above
    // the trigger, right edges aligned. Depends on pane and directory state
    // because pane switches and async catalog loads resize the card.
    /* jscpd:ignore-start -- deliberate mirror of ui-primitives useAnchoredPosition:
       that hook only places from the anchor's LEFT edge, while this card aligns
       right edges (x = rect.right - width), so the measure-and-clamp plumbing repeats. */
    useLayoutEffect(() => {
        if (!open) {
            setMenuPos(null);
            return;
        }
        const place = () => {
            /* v8 ignore next 2 -- the trigger ref is attached whenever the menu is open. */
            const rect = triggerRef.current?.getBoundingClientRect();
            if (rect === undefined)
                return;
            const MARGIN = 12;
            const lw = menuRef.current?.offsetWidth ?? 0;
            const lh = menuRef.current?.offsetHeight ?? 0;
            let x = rect.right - lw;
            let y = rect.top - 8 - lh;
            if (lw > 0)
                x = Math.min(Math.max(x, MARGIN), window.innerWidth - lw - MARGIN);
            if (lh > 0)
                y = Math.min(Math.max(y, MARGIN), window.innerHeight - lh - MARGIN);
            setMenuPos({ left: x, top: y });
        };
        // First run measures the hidden pre-render (same commit as `open`), so
        // the card lands placed before anything paints.
        place();
        window.addEventListener('scroll', place, true);
        window.addEventListener('resize', place);
        return () => {
            window.removeEventListener('scroll', place, true);
            window.removeEventListener('resize', place);
        };
    }, [open, pane, state]);
    /* jscpd:ignore-end */
    if (!available)
        return null;
    const show = () => {
        setPane('root');
        setOpen(true);
        reload();
    };
    const close = (restoreFocus = false) => {
        setOpen(false);
        setPane('root');
        if (restoreFocus)
            queueMicrotask(() => { triggerRef.current?.focus(); });
    };
    const moveFocus = (offset) => {
        const items = itemRefs.current.filter(item => item !== null);
        if (items.length === 0)
            return;
        const active = items.findIndex(item => item === document.activeElement);
        const next = (Math.max(active, 0) + offset + items.length) % items.length;
        items[next]?.focus();
    };
    const onRootKeyDown = (event) => {
        if (event.key === 'Escape' && open) {
            event.preventDefault();
            // Escape backs out of a drilled pane first, then closes.
            if (pane !== 'root')
                setPane('root');
            else
                close(true);
            return;
        }
        if (!open)
            return;
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            moveFocus(event.key === 'ArrowDown' ? 1 : -1);
        }
    };
    const onBlur = (event) => {
        if (event.relatedTarget instanceof Node && (rootRef.current?.contains(event.relatedTarget) === true
            || menuRef.current?.contains(event.relatedTarget) === true))
            return;
        close();
    };
    const settleSelection = (accepted) => {
        if (accepted) {
            if (rootRef.current !== null)
                close(true);
            return;
        }
        const message = directory.getSnapshot().error;
        if (message !== null) {
            toastSeq.current += 1;
            setToast({ seq: toastSeq.current, text: t('error.action', { message }) });
        }
    };
    const choose = (selection) => {
        if (!modelAutomatic && state.current?.provider === selection.provider && state.current.model === selection.model) {
            close(true);
            return;
        }
        lastActionRef.current = 'select';
        void select(manualModelSelection(state.current, selection)).then(settleSelection);
    };
    const chooseAutomatic = () => {
        if (autoSelection === undefined)
            return;
        lastActionRef.current = 'select';
        void select(autoSelection).then(settleSelection);
    };
    const chooseEffort = (effort, automatic = false) => {
        if (state.current === null)
            return;
        if ((automatic && effortAutomatic) || (!automatic && !effortAutomatic && effectiveEffort === effort)) {
            close(true);
            return;
        }
        const selection = effortSelection(state.current, effort, automatic);
        lastActionRef.current = 'select';
        void select(selection).then(settleSelection);
    };
    const waiting = state.current === null && state.status === 'loading';
    const modelLabel = modelAutomatic ? t('auto.label') : waiting
        ? t('trigger.loading')
        : currentChoice?.model.name
            ?? (state.current === null ? t('trigger.fallback') : `${state.current.provider}/${state.current.model}`);
    const triggerLabel = effortLabel === undefined ? modelLabel : `${modelLabel} · ${effortLabel}`;
    const triggerAria = waiting
        ? t('trigger.loading')
        : state.current === null
            ? t('trigger.selectAria')
            : effortLabel === undefined
                ? t('trigger.aria', { model: modelLabel })
                : t('trigger.ariaEffort', { model: modelLabel, effort: effortLabel });
    itemRefs.current = [];
    let itemIndex = 0;
    const itemRef = () => {
        const at = itemIndex++;
        return (node) => { itemRefs.current[at] = node; };
    };
    return (_jsxs("div", { ref: rootRef, className: css.root, onKeyDown: onRootKeyDown, onBlur: onBlur, children: [_jsxs("button", { ref: triggerRef, type: "button", className: css.trigger, "aria-label": triggerAria, "aria-haspopup": "menu", "aria-expanded": open, "aria-controls": open ? `${id}-menu` : undefined, title: triggerLabel, disabled: locked, onClick: () => {
                    if (open) {
                        close();
                    }
                    else {
                        show();
                    }
                }, children: [_jsx(IconDataOutline16, { className: css.triggerIcon, size: 16 }), _jsx("span", { className: css.triggerLabel, children: modelLabel }), effortLabel !== undefined && !(modelAutomatic && effortAutomatic) && _jsx("span", { className: css.triggerEffort, children: effortLabel }), _jsx(IconChevronDownOutline14, { className: clsx(css.chevron, open && css.chevronOpen) })] }), open && createPortal(_jsxs("div", { ref: menuRef, id: `${id}-menu`, className: css.menu, style: menuPos ?? MEASURE_STYLE, role: "menu", "aria-label": t('menu.aria'), "aria-busy": state.status === 'loading' || busy, children: [pane === 'root' && (_jsxs(_Fragment, { children: [_jsxs("button", { ref: itemRef(), type: "button", role: "menuitemradio", "aria-checked": modelAutomatic && effortAutomatic, className: css.option, disabled: busy || autoSelection === undefined, onClick: chooseAutomatic, children: [_jsxs("span", { className: css.optionCopy, children: [_jsx("span", { className: css.modelName, children: t('auto.label') }), _jsx("span", { className: css.optionDescription, children: t('auto.description') })] }), _jsx("span", { className: css.check, children: modelAutomatic && effortAutomatic ? _jsx(IconCheckOutline16, {}) : null })] }), _jsxs("button", { ref: itemRef(), type: "button", role: "menuitem", className: css.cell, onClick: () => { setPane('model'); }, children: [_jsx("span", { className: css.cellLabel, children: t('menu.model') }), _jsx("span", { className: css.cellValue, children: modelLabel }), _jsx(IconChevronRightOutline14, { className: css.cellChevron })] }), (reasoning !== undefined || modelAutomatic || effortAutomatic) && (_jsxs("button", { ref: itemRef(), type: "button", role: "menuitem", className: css.cell, onClick: () => { setPane('effort'); }, children: [_jsx("span", { className: css.cellLabel, children: t('menu.effort') }), _jsx("span", { className: css.cellValue, children: effortLabel }), _jsx(IconChevronRightOutline14, { className: css.cellChevron })] })), (modelAutomatic || effortAutomatic) && (_jsxs("div", { className: css.autoScope, children: [t('auto.scope', { provider: currentChoice?.group.name ?? state.current?.provider ?? '' }), state.lastUsed !== null && _jsx("span", { className: css.lastUsed, children: t('auto.lastUsed', {
                                            model: state.lastUsed.model,
                                            effort: state.lastUsed.reasoningEffort ?? t('auto.noEffort'),
                                        }) }), state.autoDecision != null && _jsx("span", { className: css.lastUsed, children: state.autoDecision.reason })] }))] })), pane === 'model' && (_jsxs(_Fragment, { children: [state.status === 'loading' && (_jsx("div", { className: css.status, children: t('status.loading') })), state.error !== null && lastActionRef.current === 'load' && (_jsxs("div", { className: css.error, children: [_jsx("span", { children: t('error.action', { message: state.error }) }), _jsx("button", { type: "button", className: css.retry, onClick: reload, children: t('retry') })] })), state.failures.map(failure => (_jsxs("div", { className: css.warning, children: [_jsx("span", { children: t('warning.groupLoad', { name: failure.name, message: failure.message }) }), _jsx("button", { type: "button", className: css.retry, onClick: reload, children: t('retry') })] }, failure.id))), _jsx("div", { className: clsx(css.groups, 'scrollable'), children: state.groups.map((group) => {
                                    const headingId = `${id}-${group.id}`;
                                    return (_jsxs("section", { role: "group", "aria-labelledby": headingId, className: css.group, children: [_jsx("div", { className: css.groupTitle, id: headingId, children: group.name }), group.models.map((model) => {
                                                const selected = !modelAutomatic && state.current?.provider === group.id && state.current.model === model.id;
                                                return (_jsxs("button", { ref: itemRef(), type: "button", role: "menuitemradio", "aria-checked": selected, className: clsx(css.option, selected && css.selected), title: model.name, disabled: busy, onClick: () => { choose({ provider: group.id, model: model.id }); }, children: [_jsx("span", { className: css.optionCopy, children: _jsx("span", { className: css.modelName, children: model.name }) }), _jsx("span", { className: css.check, children: selected ? _jsx(IconCheckOutline16, {}) : null })] }, model.id));
                                            })] }, group.id));
                                }) }), state.status === 'ready' && choices.length === 0 && (_jsx("div", { className: css.empty, children: t('empty.models') }))] })), pane === 'effort' && (_jsxs(_Fragment, { children: [_jsxs("button", { ref: itemRef(), type: "button", role: "menuitemradio", "aria-checked": effortAutomatic, className: css.option, disabled: busy, onClick: () => { chooseEffort(undefined, true); }, children: [_jsx("span", { className: css.optionCopy, children: _jsx("span", { className: css.modelName, children: t('auto.effort') }) }), _jsx("span", { className: css.check, children: effortAutomatic ? _jsx(IconCheckOutline16, {}) : null })] }), state.error !== null && lastActionRef.current === 'load' && (_jsxs("div", { className: css.error, children: [_jsx("span", { children: t('error.action', { message: state.error }) }), _jsx("button", { type: "button", className: css.retry, onClick: reload, children: t('action.reload') })] })), effortChoices.length === 0
                                ? _jsx("div", { className: css.empty, children: t('empty.efforts') })
                                : effortChoices.map(level => (_jsxs("button", { ref: itemRef(), type: "button", role: "menuitemradio", "aria-checked": !effortAutomatic && effectiveEffort === level.effort, className: clsx(css.option, !effortAutomatic && effectiveEffort === level.effort && css.selected), disabled: busy, onClick: () => { chooseEffort(level.effort); }, children: [_jsx("span", { className: css.optionCopy, children: _jsx("span", { className: css.modelName, children: level.label }) }), _jsx("span", { className: css.check, children: !effortAutomatic && effectiveEffort === level.effort ? _jsx(IconCheckOutline16, {}) : null })] }, level.key)))] }))] }), document.body), toast !== null && (_jsx(Toast, { text: toast.text, icon: _jsx(IconWarningOutline16, {}), anchor: rootRef.current?.closest('[data-composer-card]') ?? null, onDone: () => { setToast(null); } }, toast.seq))] }));
}
//# sourceMappingURL=ModelSelect.js.map