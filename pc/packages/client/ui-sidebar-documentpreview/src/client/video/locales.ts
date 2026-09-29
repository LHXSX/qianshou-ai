/** Locale-owned video preview labels. */
export const zh = {
  title: '视频',
  loading: '正在打开视频…',
  failed: '无法播放这个视频，请检查文件或使用系统播放器打开。',
  preview: '视频预览：{name}',
} satisfies Record<string, string>

/** Video preview dictionary keys. */
export type VideoPreviewKey = keyof typeof zh

/** English dictionary with the same keys as the Chinese dictionary. */
export const en = {
  title: 'Video',
  loading: 'Opening video…',
  failed: 'This video could not be played. Check the file or open it in your system player.',
  preview: 'Video preview: {name}',
} satisfies Record<VideoPreviewKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Video viewer selection, progress, and playback failure. */
    sidebarVideo: VideoPreviewKey
  }
}
