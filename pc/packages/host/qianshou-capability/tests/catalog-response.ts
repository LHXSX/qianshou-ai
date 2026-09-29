/** Shanghai GET /api/v8/capabilities response used by decoder and Host tests. */
export const CATALOG_RESPONSE = {
  registry_version: '1.0',
  capabilities: [
    { capability: 'media.transcode', implementations: ['ffmpeg'], legacy_task_types: ['video_compress'] },
    { capability: 'accelerator.gpu', implementations: ['cuda'], legacy_task_types: [] },
    { capability: 'future.capability.added', implementations: ['private-plugin'], legacy_task_types: [] },
  ],
} as const
