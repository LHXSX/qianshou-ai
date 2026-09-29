/**
 * Project the dictionary into the kit's label contract.
 *
 * Called during render, so a language change reaches the kit with the next one —
 * the kit caches no copy to invalidate.
 * @param t - namespace-bound translate.
 * @returns every string the kit renders.
 */
export function dockLabels(t) {
    return {
        emptyPane: t('dock.emptyPane'),
        splitPane: t('dock.splitPane'),
        splitPaneDisabled: t('dock.splitPaneDisabled'),
        splitPaneNarrow: t('dock.splitPaneNarrow'),
        closeTab: t('dock.closeTab'),
        addTab: t('dock.addTab'),
        dockFloat: t('dock.dockFloat'),
        closeFloat: t('dock.closeFloat'),
        dropZone: {
            center: t('dock.drop.center'),
            left: t('dock.drop.left'),
            right: t('dock.drop.right'),
            top: t('dock.drop.top'),
            bottom: t('dock.drop.bottom'),
        },
    };
}
//# sourceMappingURL=labels.js.map