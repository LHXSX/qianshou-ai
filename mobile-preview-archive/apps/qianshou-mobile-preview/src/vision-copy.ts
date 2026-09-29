/** Locale-owned notices for original-image understanding; provider diagnostics never become UI copy. */
export const visionCopy = {
  chooseOperation: '想了解图片里的内容，还是修改这张图片？',
  chooseImage: '请先上传要识别的图片。',
  count: '一次最多识别 4 张图片，请减少图片后再试。',
  fileSize: '单张图片不能超过 8 MiB，请选择较小的原图。',
  totalSize: '图片总大小不能超过 16 MiB，请减少图片后再试。',
  invalid: '这张图片暂时无法读取。请使用 PNG、JPEG、WebP 或 GIF 原图。',
  unavailable: '当前会话暂不支持识图，请稍后再试。',
  changed: '会话已切换，请在当前会话重新选择图片。',
  cancelled: '已取消读取图片。',
  retry: '图片暂未提交成功，请稍后检查当前会话。',
} as const
