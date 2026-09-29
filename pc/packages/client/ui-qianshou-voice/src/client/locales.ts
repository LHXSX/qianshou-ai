/** Product-owned voice copy, including every status and accessibility label. */
export const en = {
  hold: 'Hold to talk', release: 'Release to transcribe', mode: 'Voice release action',
  insertMode: 'Release to insert text', sendMode: 'Release to send (queue when busy)',
  cancel: 'Cancel', discard: 'Discard', insertPending: 'Add to draft',
  read: 'Read aloud', stopReading: 'Stop reading', speechLoading: 'Loading system voices',
  speechUnavailable: 'No local system voice for this language', speechStarting: 'Starting narration',
  speechFailed: 'Narration failed. Try again', language: 'en-US',
  idle: '', checking: 'Checking local speech recognition…', permission: 'Waiting for microphone permission…',
  recording: 'Recording. Release to finish; slide up or press Escape to cancel.', cancelling: 'Release to discard this recording',
  recognizing: 'Recognizing speech…', submitting: 'Waiting for the input result…', inserted: 'Text added to the draft',
  accepted: 'Message accepted by this conversation', review: 'Command text added to the draft. Review before sending.',
  conflict: 'The draft changed. Review the recognized text before adding it.', blocked: 'This conversation cannot accept voice input now.',
  nonempty: 'Sending on release requires an empty draft with no attachments. Select transcription to keep your draft.',
  empty: 'No speech was recognized. Hold and try again.', failed: 'Voice input failed. Your draft was preserved.',
  unavailable: 'Local speech recognition is not configured or its files are unavailable.', busy: 'Speech recognition is busy. Try again shortly.',
  denied: 'Microphone access was denied. Allow it in your system or browser settings.', lost: 'The microphone disconnected. Recording was cancelled.',
  short: 'The recording was too short. Hold while speaking.', limit: 'Recording limit reached. Recognizing the captured speech…',
  timeout: 'Speech recognition timed out. Try a shorter recording.',
} as const

/** Keys shared by translated dictionaries and voice state. */
export type VoiceKey = keyof typeof en

/** Chinese product and accessible copy. */
export const zh: Record<VoiceKey, string> = {
  hold: '按住说话', release: '松开完成录音', mode: '语音松开后的操作',
  insertMode: '松开转文字', sendMode: '松开发送（忙时排队）',
  cancel: '取消', discard: '丢弃', insertPending: '加入草稿',
  read: '朗读', stopReading: '停止朗读', speechLoading: '正在加载系统声音',
  speechUnavailable: '没有可用的本地系统声音', speechStarting: '正在启动朗读',
  speechFailed: '朗读失败，点击重试', language: 'zh-CN',
  idle: '', checking: '正在检查本地语音识别…', permission: '正在等待麦克风权限…',
  recording: '正在录音。松开完成，上滑或按 Esc 取消。', cancelling: '松开将丢弃这段录音',
  recognizing: '正在识别语音…', submitting: '正在等待输入结果…', inserted: '文字已加入草稿',
  accepted: '当前会话已接收消息', review: '命令文字已加入草稿，请检查后手动发送。',
  conflict: '草稿已变化，请检查识别文字后再加入。', blocked: '当前会话暂时不能接收语音输入。',
  nonempty: '松开发送需要空草稿且没有附件。请选择转文字以保留现有内容。',
  empty: '没有识别到语音，请按住后重新说话。', failed: '语音输入失败，原有草稿已保留。',
  unavailable: '本地语音识别尚未配置或资源不可用。', busy: '语音识别正在忙，请稍后重试。',
  denied: '麦克风权限被拒绝，请在系统或浏览器设置中允许。', lost: '麦克风已断开，录音已取消。',
  short: '录音太短，请按住按钮说话。', limit: '录音已达上限，正在识别已录内容…',
  timeout: '语音识别超时，请缩短录音后重试。',
}
