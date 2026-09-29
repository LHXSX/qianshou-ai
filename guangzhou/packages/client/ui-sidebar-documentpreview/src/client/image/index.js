import { ImageBody } from "./ImageBody.js";
import { en, zh } from "./locales.js";
/** Image implementation identity, shared by metadata and the keyed slot. */
export const IMAGE_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/image';
/** File suffixes rendered by the builtin image body. */
export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'svg'];
/**
 * Describe the builtin image renderer independently from its keyed body slot.
 * @param title - locale-owned implementation name.
 * @returns metadata for complete image files.
 */
export function imageBodyDefinition(title) {
    return {
        id: IMAGE_BODY_ID,
        extensions: IMAGE_EXTENSIONS,
        priority: 'builtin',
        title,
        loading: 'bytes-complete',
        wrap: false,
    };
}
/**
 * Register the image dictionary, metadata, and body with reversible effects.
 * @param ctx - owning plugin context.
 */
export function apply(ctx) {
    const t = ctx.locale.bind('sidebarImage');
    ctx.effect(() => ctx.locale.register('sidebarImage', { zh, en }), 'document-image: dictionaries');
    ctx.effect(() => ctx.documentPreviews.register(imageBodyDefinition(() => t('title'))), 'document-image: metadata');
    ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({ name: 'sidebar.right.tab.document', key: IMAGE_BODY_ID, locale: 'sidebarImage' }, ImageBody)), 'document-image: body');
}
//# sourceMappingURL=index.js.map