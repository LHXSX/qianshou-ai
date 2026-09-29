/** Data-only official skills shipped with the PC. Installation uses the Host's SKILL.md importer. */
export const OFFICIAL_SKILLS = [
  {
    name: 'qianshou-image-brief', title: 'officialImageTitle', summary: 'officialImageSummary', mode: 'image',
    sha256: '0d8a1b1e280e8f1ec0c9ad00e8a636a76204f41a95bd0d4030ef5a4151c85e14',
    content: `---
name: qianshou-image-brief
description: 图像创作：整理出图需求与参考图，准备千手图像生成描述。
metadata:
  displayName: 图像创作
  category: image
---

# Image creation in Qianshou

Turn the owner's description and attached reference images into a clear image-generation request. Preserve the subject, style, composition and intended use. Ask only for missing details that materially change the result; otherwise use sensible defaults and make the editable description visible.

Use the image capability provided by the current Qianshou session when available. Keep attached reference images attached to the request. The client sends generation through its configured media service; the owner does not choose a contributor machine or enter a node IP, port or token.

Installing this skill supplies conversation instructions. It does not install a model, start a local service, authorize compute sharing, or prove that generation is available. Use the real task status and original result, and clearly report an unavailable capability. If a submission outcome is unknown, query its original task instead of resubmitting or generating a replacement.
`,
  },
  {
    name: 'qianshou-video-brief', title: 'officialVideoTitle', summary: 'officialVideoSummary', mode: 'video',
    sha256: '6d612191d6bc12c8c3ea76c601d7ad47b16270def89168310f2f2978bdc5be4f',
    content: `---
name: qianshou-video-brief
description: 视频创作：整理短视频场景、动作、时长与参考首帧，准备千手视频生成描述。
metadata:
  displayName: 视频创作
  category: video
---

# Video creation in Qianshou

Turn the owner's description into a coherent short-video request. Preserve the subject, action, camera movement, requested duration and orientation. Use an attached first frame when supplied; otherwise let the available media workflow prepare it. A first frame does not have to be generated on the Mac when the selected workflow supports it on its own node.

Use the video capability provided by the current Qianshou session when available. Keep media in the client's configured Guangzhou and node exchange. Shanghai handles task metadata and scheduling. The owner does not select a contributor computer or enter API credentials.

Installing this skill supplies conversation instructions. It does not install a model, start a video API, authorize compute sharing or guarantee video generation. Report the actual workflow stage and original video result. An unavailable first-frame or video service must remain a real failure. Query an uncertain original submission instead of starting a second GPU job.
`,
  },
] as const
