/** Local H3 setup copy keeps technical configuration behind file choices. */
export const h3OwnerZh = {
  h3SetupTitle: '接入本机 H3',
  h3SetupIntro: '把这台电脑的视频生成能力接入千手。先完成本机测试，再创建技能。',
  h3SetupOpen: '配置视频能力',
  h3SetupClose: '收起配置',
  h3SetupUnavailable: '此版本尚未提供本机接入向导，请更新客户端后再试。',
  h3SetupLoading: '正在读取本机配置…',
  h3SetupFiles: '选择已有的模型、工作流和首帧',
  h3SetupFilesHint: '目前支持固定的 H3 工作流。选择文件即可，无需编写 JSON。',
  h3SetupFirstFrame: '视频首帧（PNG）',
  h3SetupWorkflow: 'H3 工作流文件',
  h3SetupModel: 'H3 模型文件',
  h3SetupOutputFolder: '视频输出文件夹',
  h3SetupOutputFolderHint: '选择本机 H3 服务保存生成视频的目录。',
  h3SetupChooseFolder: '选择文件夹',
  h3SetupChoose: '选择文件',
  h3SetupNoFile: '尚未选择',
  h3SetupEnvironment: '运行环境',
  h3SetupEnvironmentHint: '选择这台电脑已有的运行程序；尚未安装时，请先安装受支持的 H3 软件包。',
  h3SetupPython: 'Python 程序',
  h3SetupFfmpeg: '视频编码程序（FFmpeg）',
  h3SetupFfprobe: '视频检查程序（FFprobe）',
  h3SetupAdapter: '本机 H3 服务地址',
  h3SetupInspect: '检查环境',
  h3SetupChecking: '正在检查…',
  h3SetupInspected: '文件检查通过，可以保存配置。',
  h3SetupAdapterOffline: '文件已检查，本机 H3 服务尚未连接。保存后请启动服务，再进行测试。',
  h3SetupSave: '保存配置',
  h3SetupSaved: '配置已保存，接下来生成一段测试视频。',
  h3SetupTrial: '生成本机测试视频',
  h3SetupTrialHint: '使用本机 GPU 生成五秒视频，可能需要几分钟。此步骤不发布技能、不收取平台费用。',
  h3SetupPrompt: '描述测试视频',
  h3SetupDefaultPrompt: '镜头缓慢推进，画面自然流畅',
  h3SetupRun: '开始本机测试',
  h3SetupPending: '本机正在生成测试视频或确认结果，请保持程序运行。',
  h3SetupUnknown: '当前运行环境中的测试结果尚未确认，请核对本机服务。不会自动再生成一次。',
  h3SetupFailed: '本机测试未通过。请重新检查并保存配置后，再开始测试。',
  h3SetupVerified: '本机视频测试通过，可以创建技能。平台审核与接单验证将在发布时进行。',
  h3SetupRefresh: '查看测试状态',
  h3SetupSkillName: '技能中文名称',
  h3SetupSkillDefault: 'H3 视频生成',
  h3SetupDescription: '告诉别人这个技能能做什么',
  h3SetupDescriptionDefault: '根据中文描述和固定首帧，生成五秒视频。',
  h3SetupCreate: '创建视频技能',
  h3SetupCreated: '技能已保存到本机。可以在技能中心查看，或进入发布管理提交审核。',
  h3SetupLogin: '请先登录这台电脑上的千手账号，再配置视频能力。',
  h3SetupChanged: '账号或本机配置已变化，请重新检查后再操作。',
  h3SetupExternal: '这台电脑正在使用外部配置。请先由安装程序迁移到客户端管理，再使用此向导。',
  h3SetupUnsupported: '这套软件包或工作流尚未受支持，请先安装已核验的适配器。',
  h3SetupPickerUnavailable: '当前窗口无法选择本机文件，请在这台电脑的千手桌面客户端中配置。',
  h3SetupInputError: '请完整选择正确的模型、工作流、首帧和运行程序，再检查环境。',
  h3SetupFailedRequest: '操作尚未确认完成，请查看本机状态后再操作。',
  h3SetupBusy: '这台电脑正在处理其他任务，完成后再配置或测试。',
  h3SetupUnsettled: '这台电脑还有一次视频测试尚未确认完成。请先核对测试状态，不会重复生成。',
  h3SetupRecordNeedsCheck: '本机测试记录无法确认，请保留现有记录并联系支持处理。',
  h3SetupWorking: '正在处理…',
} as const

/** English labels mirror the Chinese setup dictionary. */
export const h3OwnerEn: Record<keyof typeof h3OwnerZh, string> = {
  h3SetupTitle: 'Connect this PC’s H3',
  h3SetupIntro: 'Connect this PC’s video generation. Test locally before creating a skill.',
  h3SetupOpen: 'Configure video generation', h3SetupClose: 'Collapse setup',
  h3SetupUnavailable: 'This version does not provide local setup. Update the client first.',
  h3SetupLoading: 'Reading local configuration…',
  h3SetupFiles: 'Choose an existing model, workflow and first frame',
  h3SetupFilesHint: 'The supported H3 workflow is fixed. Select files; no JSON editing is required.',
  h3SetupFirstFrame: 'First frame (PNG)', h3SetupWorkflow: 'H3 workflow file', h3SetupModel: 'H3 model file',
  h3SetupOutputFolder: 'Video output folder', h3SetupOutputFolderHint: 'Choose where this PC’s H3 service saves generated videos.',
  h3SetupChooseFolder: 'Choose folder',
  h3SetupChoose: 'Choose file', h3SetupNoFile: 'Not selected', h3SetupEnvironment: 'Runtime environment',
  h3SetupEnvironmentHint: 'Choose the programs installed on this PC. Install a supported H3 bundle if needed.',
  h3SetupPython: 'Python program', h3SetupFfmpeg: 'Video encoder (FFmpeg)', h3SetupFfprobe: 'Video inspector (FFprobe)',
  h3SetupAdapter: 'Local H3 service address', h3SetupInspect: 'Check environment', h3SetupChecking: 'Checking…',
  h3SetupInspected: 'Files checked. You can save the configuration.',
  h3SetupAdapterOffline: 'Files checked. Start the local H3 service before running a trial.',
  h3SetupSave: 'Save configuration', h3SetupSaved: 'Configuration saved. Generate a local test video next.',
  h3SetupTrial: 'Generate a local test video',
  h3SetupTrialHint: 'The local GPU generates five seconds of video and may take several minutes. This does not publish a skill or incur platform charges.',
  h3SetupPrompt: 'Describe the test video', h3SetupDefaultPrompt: 'Slow camera push, natural and smooth motion',
  h3SetupRun: 'Start local test', h3SetupPending: 'This PC is generating or confirming the test video. Keep the program running.',
  h3SetupUnknown: 'A test result in this runtime environment is not confirmed. Check the local service. No generation is retried automatically.',
  h3SetupFailed: 'The local test failed. Check and save the configuration before starting another test.',
  h3SetupVerified: 'Local video verified. You can create a skill; publication has separate platform review and device checks.',
  h3SetupRefresh: 'Check test status', h3SetupSkillName: 'Skill display name', h3SetupSkillDefault: 'H3 video generation',
  h3SetupDescription: 'Describe what this skill does', h3SetupDescriptionDefault: 'Generate a five-second video from a prompt and a fixed first frame.',
  h3SetupCreate: 'Create video skill', h3SetupCreated: 'Saved locally. Find it in the skill center or submit it through publication management.',
  h3SetupLogin: 'Sign in to this PC’s Qianshou account first.',
  h3SetupChanged: 'The account or local configuration changed. Check again before continuing.',
  h3SetupExternal: 'This PC uses external configuration. Migrate it with the installer before using this wizard.',
  h3SetupUnsupported: 'This bundle or workflow is not supported. Install a verified adapter first.',
  h3SetupPickerUnavailable: 'Open this PC’s Qianshou desktop client to choose local files.',
  h3SetupInputError: 'Select the correct model, workflow, frame and runtime programs before checking.',
  h3SetupFailedRequest: 'This operation is not confirmed. Check the local state before continuing.',
  h3SetupBusy: 'This PC is handling another task. Configure or test after it finishes.',
  h3SetupUnsettled: 'A video test on this PC is not confirmed complete. Check its status; no generation is repeated.',
  h3SetupRecordNeedsCheck: 'The local test record cannot be verified. Keep it and contact support.',
  h3SetupWorking: 'Working…',
}

/**
 * Select a localized semantic failure without displaying private machine paths.
 * @param error Host or file-picker failure.
 * @returns A key in the setup dictionary.
 */
export function h3OwnerErrorCopy(error: unknown): keyof typeof h3OwnerZh {
  const message = error instanceof Error ? error.message : ''
  if (/TRIAL_GUARD_INVALID/u.test(message)) return 'h3SetupRecordNeedsCheck'
  if (/SELF_TEST_(?:PENDING|UNKNOWN|UNSETTLED)/u.test(message)) return 'h3SetupUnsettled'
  if (/H3_SETUP_BUSY/u.test(message)) return 'h3SetupBusy'
  if (/EXTERNAL_CONFIG/u.test(message)) return 'h3SetupExternal'
  if (/UNSUPPORTED|CANONICAL/u.test(message)) return 'h3SetupUnsupported'
  if (/LOGIN|AUTHENTICAT|ACCOUNT_REQUIRED|OWNER_REQUIRED/u.test(message)) return 'h3SetupLogin'
  if (/CHANGED|REVISION|EXPIRED|STALE|SCOPE|CONTEXT/u.test(message)) return 'h3SetupChanged'
  if (/PICKER_UNAVAILABLE/u.test(message)) return 'h3SetupPickerUnavailable'
  if (/SELECTION|INVALID_PATH|FILE_|WORKFLOW|MODEL|FRAME|PYTHON|FFMPEG|FFPROBE/u.test(message)) return 'h3SetupInputError'
  return 'h3SetupFailedRequest'
}
