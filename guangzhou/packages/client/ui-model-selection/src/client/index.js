import { IconDataOutline16 } from '@deepseek-ai/dsh-client-ui-primitives';
import { ModelDirectoryResolver } from "./service.js";
import { ModelSelect } from "./ModelSelect.js";
import { automaticSelection, manualModelSelection } from "./routing-selection.js";
import { en, zh } from "./locales.js";
export { ModelDirectory } from "./directory.js";
export { ModelDirectoryResolver } from "./service.js";
/** One selectable row's id: an opaque row key (resolved by lookup, never parsed). */
function rowId(providerId, modelId) {
    return `${providerId}/${modelId}`;
}
const BUILTIN_DESCRIPTION_KEYS = {
    'deepseek-official/deepseek-flash': 'option.deepseekFlash.description',
    'deepseek-official/deepseek-v4-flash-vision-exp': 'option.deepseekV4Flash.description',
    'deepseek-official/deepseek-v4-flash': 'option.deepseekV4Flash.description',
    'deepseek-official/deepseek-v4-pro': 'option.deepseekV4Pro.description',
};
function descriptionOf(providerId, model, t) {
    const key = BUILTIN_DESCRIPTION_KEYS[rowId(providerId, model.id)];
    return key !== undefined && model.description === en[key] ? t(key) : model.description;
}
/** Flatten the directory into popup rows; failure rows are listed for visibility but never selectable. */
function optionsOf(directory, t) {
    const rows = [];
    if (automaticSelection(directory) !== undefined) {
        rows.push({
            id: 'auto-routing',
            label: t('auto.label'),
            detail: t('auto.description'),
            ...directory.current?.routing?.model === 'auto' && directory.current.routing.effort === 'auto'
                ? { active: true } : {},
        });
    }
    for (const group of directory.groups) {
        for (const model of group.models) {
            const description = descriptionOf(group.id, model, t);
            rows.push({
                id: rowId(group.id, model.id),
                label: model.name,
                detail: description !== undefined ? `${group.name} · ${description}` : group.name,
                ...(directory.current !== null
                    && directory.current.routing?.model !== 'auto'
                    && directory.current.provider === group.id
                    && directory.current.model === model.id
                    ? { active: true } : {}),
            });
        }
    }
    for (const failure of directory.failures) {
        rows.push({
            id: `failure/${failure.id}`,
            label: failure.name,
            detail: t('option.loadError', { message: failure.message }),
        });
    }
    return rows;
}
/**
 * Resolve a picked row back to its model selection by matching against the loaded
 * groups (the same data the rows were built from — ids stay opaque).
 * @param state - the session's directory snapshot.
 * @param id - the picked row id.
 * @returns the row's model selection, or undefined for failure rows / stale ids.
 */
function selectionOf(state, id) {
    if (id === 'auto-routing')
        return automaticSelection(state);
    for (const group of state.groups) {
        for (const model of group.models) {
            if (rowId(group.id, model.id) !== id)
                continue;
            const sameRoute = state.current?.provider === group.id && state.current.model === model.id;
            const reasoningEffort = sameRoute
                ? state.current?.reasoningEffort ?? model.reasoning?.defaultEffort
                : model.reasoning?.defaultEffort;
            return manualModelSelection(state.current, {
                provider: group.id,
                model: model.id,
                ...reasoningEffort === undefined ? {} : { reasoningEffort },
            });
        }
    }
    return undefined;
}
/** Dictionary namespace owned by this plugin. */
const NS = 'model';
/** Required services: the contribution registry, the seat's slot registry, locale, and the service's own faces. */
export const inject = ['commandUi', 'locale', 'sessions', 'slots', 'remote', 'remote.session'];
/**
 * Client plugin body: mount ModelDirectoryResolver, register the `model` dictionaries,
 * then register the /model popup contribution and the composer model seat
 * over the service.
 * @param ctx - client root context.
 */
export function apply(ctx) {
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-model-selection: dictionaries');
    // Non-slot faces (the command description, the popup option builder) read
    // through the bound translate; the seat component reads the standard seat.
    const t = ctx.locale.bind(NS);
    // The composer-block reason is this plugin's own copy, read at raise time so
    // a locale change reaches the next publish.
    ctx.plugin(ModelDirectoryResolver, { blockReason: () => t('blocked.composer') });
    // Entry 1: the /model popupSelect over the shared directory.
    ctx.inject(['commandUi', 'modelDirectories'], (scope) => {
        const command = scope.get('commandUi');
        const models = scope.modelDirectories;
        const sessions = scope.sessions;
        scope.effect(() => command.register({
            name: 'model',
            label: () => t('command.label'),
            description: () => t('command.description'),
            icon: IconDataOutline16,
            available: session => sessions.subagentAddress(session.sessionId) === undefined,
            ui: {
                kind: 'popupSelect',
                options: async (session) => {
                    if (sessions.subagentAddress(session.sessionId) !== undefined) {
                        throw new Error('model selection is unavailable for addressed subagent sessions');
                    }
                    return optionsOf(await models.directoryFor(session.sessionId).load(), t);
                },
                onSelect: async (option, session) => {
                    if (sessions.subagentAddress(session.sessionId) !== undefined) {
                        throw new Error('model selection is unavailable for addressed subagent sessions');
                    }
                    const directory = models.directoryFor(session.sessionId);
                    const selection = selectionOf(directory.store.getSnapshot(), option.id);
                    if (selection === undefined) {
                        throw new Error('this provider\'s catalog failed to load — pick a model from a loaded group');
                    }
                    await directory.select(selection);
                },
            },
        }), 'ui-model-selection: /model contribution');
    });
    // Entry 2: the composer's named model seat over the SAME directory.
    ctx.inject(['slots', 'modelDirectories'], (scope) => {
        const models = scope.modelDirectories;
        const sessions = scope.sessions;
        scope.slots.inject('conversation.input.model', () => scope.slots.register({
            name: 'conversation.input.model',
            locale: NS,
            inject: (sessionId) => {
                const directory = models.directoryFor(sessionId);
                const available = sessions.subagentAddress(sessionId) === undefined;
                return {
                    available,
                    directory: directory.store,
                    load: () => {
                        if (available)
                            directory.load().catch(() => { });
                    },
                    select: (selection) => available
                        ? directory.select(selection).then(() => true, () => false)
                        : Promise.resolve(false),
                };
            },
        }, ModelSelect));
    });
}
//# sourceMappingURL=index.js.map