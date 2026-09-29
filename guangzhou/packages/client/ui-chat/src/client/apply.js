import { fileAddressFor } from '@deepseek-ai/dsh-util-workspace-path';
import { EMPTY_CHAT_SNAPSHOT } from "./contract/snapshot.js";
import { ApprovalCommand } from "./chat/ApprovalCommand.js";
import { ChatView } from "./chat/ChatView.js";
import { registerChatNodeRenderers } from "./chat/register-node-renderers.js";
import { StatsPills } from "./chat/StatsPills.js";
import { registerConversationNodes } from "./conversation-nodes/register.js";
import { en, NS, zh } from "./locale.js";
import { TranscriptViewRow } from "./settings/TranscriptViewRow.js";
import { createChatStore } from "./stores.js";
import { TranscriptViewPolicy } from "./transcript-view.js";
import { CHAT_SETTINGS_NAMESPACE } from "../chat-settings.js";
import { useTurnDataValue } from "./chat/use-turn-data.js";
import { VoiceConversation } from "./chat/voice/VoiceConversation.js";
import { voiceStatus, transcribeVoice } from "./chat/voice/api.js";
const CHAT_NODE_INJECT = {
    hooks: {
        turnData: (_standard, data) => function useTurnData(key) {
            return useTurnDataValue(data, key);
        },
    },
};
/** Services required by the Chat target and its presentation registrations. */
export const inject = [
    'slots', 'sessions', 'uiSession', 'uiConversation', 'locale',
    'settingsScope', 'remote', 'remote.session', 'sidebarRight',
];
/**
 * Mount all Chat-owned contributions.
 * @param ctx - Client root context.
 */
export function apply(ctx) {
    const chatSources = new WeakMap();
    const chatSource = (binding) => {
        let source = chatSources.get(binding);
        if (source === undefined) {
            const target = ctx.uiConversation.binding(binding).target('chat');
            source = {
                getSnapshot: () => target.getSnapshot() ?? EMPTY_CHAT_SNAPSHOT,
                subscribe: listener => target.subscribe(listener),
            };
            chatSources.set(binding, source);
        }
        return source;
    };
    registerConversationNodes(ctx);
    registerChatNodeRenderers(ctx);
    ctx.uiSession.provide({
        hooks: ['chat'],
        resolve: binding => ({ hooks: { chat: chatSource(binding) } }),
    });
    ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-chat: dictionaries');
    const t = ctx.locale.bind(NS);
    const chatStore = createChatStore();
    const chatScrollPositions = new Map();
    const transcriptView = new TranscriptViewPolicy(ctx.settingsScope.bind({ namespace: CHAT_SETTINGS_NAMESPACE }));
    ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'transcript-view',
        order: 12,
        locale: NS,
        inject: () => ({
            hooks: { transcriptView: transcriptView.mode },
            setTranscriptView: (mode) => { transcriptView.setMode(mode); },
        }),
    }, TranscriptViewRow));
    ctx.slots.inject('conversation.view', () => {
        const disposeView = ctx.slots.register({
            name: 'conversation.view',
            id: 'chat',
            order: 0,
            label: () => t('view.chat'),
            locale: NS,
            children: {
                'conversation.chat.node': { kind: 'keyed', scope: 'session', inject: CHAT_NODE_INJECT },
                'conversation.message.images': { kind: 'single', scope: 'session' },
            },
            store: chatStore,
            inject: (sessionId) => {
                const binding = ctx.sessions.binding(sessionId);
                if (binding === undefined)
                    throw new Error(`ui-chat: unknown session "${sessionId}"`);
                const session = binding.session;
                const chat = chatSource(binding);
                return {
                    hooks: { transcriptView: transcriptView.mode },
                    keyedHooks: {
                        chatNode: key => chat.getSnapshot().nodes.source(key),
                        chatNodeProcess: key => chat.getSnapshot().nodes.processSource(key),
                    },
                    fileMentions: (owner) => ctx.get('chatFileMentions')?.forClosing(owner, sessionId),
                    // Files open in the right Sidebar, not in a desktop application: the
                    // content stays in the product, beside the conversation that produced
                    // it. A relative path, or an absolute one inside the session's
                    // workspace, is addressed under this session's scope,
                    // `dsh-resource://file/session/<id>/<path>`; an absolute path
                    // elsewhere keeps its absolute spelling in the same Session's address.
                    // Which tab type claims the
                    // address is the Sidebar's decision, not this call site's.
                    // A line travels as a navigation parameter, not as part of the
                    // address: the file is one piece of content whether it is opened at
                    // its top or at line 400, so the same tab is revealed and told where
                    // to land.
                    openFile: async (path, options) => {
                        const cwd = ctx.sessions.list.getSnapshot().byId[sessionId]?.cwd;
                        const url = fileAddressFor(sessionId, cwd, path);
                        if (options?.line === undefined)
                            ctx.sidebarRight.openResource(url);
                        else
                            ctx.sidebarRight.openResource(url, { params: { line: options.line } });
                        await Promise.resolve();
                    },
                    openSkill: (name) => {
                        const scope = ctx.sessions.scope(sessionId);
                        if (scope === undefined)
                            return;
                        ctx.get('inputTriggers')?.sessionOf(scope).openReference('skill', { ref: `/${name}` });
                    },
                    loadOlder: () => { void session.loadOlder(); },
                    loadThrough: seq => session.loadThrough(seq),
                    loadImage: Object.assign((attachment) => ctx.uiConversation.imageUrl(sessionId, attachment), { peek: (attachment) => ctx.uiConversation.peekImageUrl(sessionId, attachment) }),
                    chatScroll: {
                        save: (position) => {
                            if (position === null)
                                chatScrollPositions.delete(sessionId);
                            else
                                chatScrollPositions.set(sessionId, position);
                        },
                        read: () => chatScrollPositions.get(sessionId) ?? null,
                    },
                    forkAt: (seq) => {
                        ctx.sessions.fork({ sessionId, atSeq: seq, increaseTitle: true })
                            .then((childId) => { ctx.sessions.open(childId); })
                            .catch(() => {
                            // Fork or child-title failure leaves the source view unchanged.
                        });
                    },
                };
            },
        }, ChatView);
        return disposeView;
    });
    ctx.slots.inject('conversation.session.header.utilities', () => ctx.slots.register({
        name: 'conversation.session.header.utilities', id: 'stats', order: 0, locale: NS,
    }, StatsPills));
    // Transcript-only hosts do not mount the composer input service.
    ctx.inject(['conversation'], voiceCtx => voiceCtx.slots.inject('conversation.composer.dock', () => voiceCtx.slots.register({
        name: 'conversation.composer.dock', id: 'voice', order: -10, locale: NS,
        inject: (sessionId) => ({
            status: voiceStatus,
            transcribe: transcribeVoice,
            stopAgent: () => {
                const scope = ctx.sessions.scope(sessionId);
                if (scope !== undefined)
                    void scope.conversation.cancel().catch(() => { });
            },
            hooks: { voiceBlock: voiceCtx.conversation.blocks.storeFor(sessionId) },
        }),
    }, VoiceConversation)));
    ctx.slots.inject('conversation.approval.detail', () => ctx.slots.register({ name: 'conversation.approval.detail' }, ApprovalCommand));
}
//# sourceMappingURL=apply.js.map