/** Resolve only Shanghai's independently verified opaque media reference. */
const TASK_MEDIA_REFERENCE =
  /^qianshou-media:\/\/task\/([A-Za-z0-9][A-Za-z0-9._-]{0,127})\/([a-f0-9]{64})\.(png|jpe?g|webp|gif|mp4|webm|mov)$/u

export function marketResultMedia(value: string, expectedWorkloadId: string,
  location: Pick<Location, 'protocol' | 'origin' | 'hostname'>):
    { kind: 'image' | 'video'; src: string; filename: string } | null {
  const match = TASK_MEDIA_REFERENCE.exec(value)
  const [, taskId, assetId, extension] = match ?? []
  if (!taskId || !assetId || !extension || taskId !== expectedWorkloadId
    || taskId === '.' || taskId === '..') return null
  const base = location.protocol === 'dsh-app:' && location.hostname === 'app' ? 'dsh-app://app'
    : location.protocol === 'http:' || location.protocol === 'https:' ? location.origin : null
  if (base === null) return null
  const src = `${base}/api/qianshou/result-media?task_id=${encodeURIComponent(taskId)}&asset_id=${assetId}&type=${extension}`
  return { kind: /\.(?:mp4|webm|mov)$/u.test(value) ? 'video' : 'image', src,
    filename: `${assetId}.${extension}` }
}
