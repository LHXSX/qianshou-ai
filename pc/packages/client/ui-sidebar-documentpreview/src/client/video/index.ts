/** Builtin video metadata and renderer registration. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '../index.ts'
import type { DocumentPreviewDefinition } from '../document/registry.ts'
import { VideoBody, type VideoBodyInjected } from './VideoBody.tsx'
import { en, zh } from './locales.ts'

/** Shared identity for video metadata and its keyed document body. */
export const VIDEO_BODY_ID = '@deepseek-ai/dsh-client-ui-sidebar-documentpreview/video'

/** File types the Host's authenticated media route can stream to a browser. */
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'ogv'] as const

/**
 * Describe the video renderer without requiring a complete-file byte read.
 * @param title - Localized viewer title.
 * @returns The video viewer registration.
 */
export function videoBodyDefinition(title: () => string): DocumentPreviewDefinition {
  return { id: VIDEO_BODY_ID, extensions: VIDEO_EXTENSIONS, binaryExtensions: VIDEO_EXTENSIONS,
    priority: 'builtin', title, loading: 'renderer', wrap: false }
}

/** @param ctx - Client renderer registry, Session file metadata Remote, and slot registry. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('sidebarVideo', { zh, en }), 'document-video: dictionary')
  const t = ctx.locale.bind('sidebarVideo')
  ctx.effect(() => ctx.documentPreviews.register(videoBodyDefinition(() => t('title'))), 'document-video: metadata')
  ctx.effect(() => ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({
    name: 'sidebar.right.tab.document', key: VIDEO_BODY_ID, locale: 'sidebarVideo',
    inject: (): VideoBodyInjected => ({
      readVideo: (file, signal) => ctx.remote.workspaceFiles.stat(file.sessionId, file.path, signal),
    }),
  }, VideoBody)), 'document-video: body')
}
