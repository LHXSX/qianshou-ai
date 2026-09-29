/** Copy for a local Comfy trial receipt. It cannot imply installation or order readiness. */
export const zh = {
  title: '本机 ComfyUI 样例', iconGlyph: '图', digestLabel: 'SHA-256',
  running: '正在核对条件、等待机主授权并生成一张 PNG…',
  completed: '样例已生成并通过本机校验', private: '本机私有',
  errorDenied: '机主没有批准，本次未提交。', errorPreflight: '本机节点或模型选项与已保存的图不匹配，未提交。',
  errorBusy: '已有试跑尚未核清，该端口暂不能再次提交。',
  errorUnknown: '运行状态不确定，请先核对本次作业，暂勿重试。',
  errorOutput: '生成结果无法验证为受支持的单张 PNG。', errorGeneral: '本机试跑未完成，请查看错误详情。',
  previewLoading: '正在载入本机图片…', previewFailed: '图片预览暂不可用，试跑回执仍保留。',
  sampleAlt: '本机生成的 PNG 样例', boundary: '只用于这台电脑的私有试跑；尚不能安装、出售或接单。', inspect: '查看详情',
} satisfies Record<string, string>

export type TrialKey = keyof typeof zh

export const en: Record<TrialKey, string> = {
  title: 'Local ComfyUI sample', iconGlyph: 'I', digestLabel: 'SHA-256',
  running: 'Checking this device, awaiting owner approval and generating one PNG…',
  completed: 'Sample generated and verified locally', private: 'Private on this device',
  errorDenied: 'The owner did not approve; nothing was submitted.', errorPreflight: 'Local nodes or model options do not match the saved graph; nothing was submitted.',
  errorBusy: 'An earlier trial is unresolved. This port is temporarily blocked.',
  errorUnknown: 'The run state is uncertain. Reconcile this job before trying again.',
  errorOutput: 'The result could not be verified as one supported PNG.', errorGeneral: 'The local trial did not finish. Inspect the error details.',
  previewLoading: 'Loading the local image…', previewFailed: 'Preview is unavailable; the trial receipt remains.',
  sampleAlt: 'PNG sample generated on this computer', boundary: 'Private trial on this device only; not installable, saleable or available for orders.', inspect: 'Inspect details',
}
