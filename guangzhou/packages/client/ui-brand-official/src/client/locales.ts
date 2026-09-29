/** Chinese branding used by the private workbench build. */
export const zh = {
  name: '千手 AI',
  subtitle: '一群AI，为你而来',
  'nav.chat': '对话',
  'dest.agents.title': '智能体广场',
  'dest.agents.body': '员工与子智能体在设置 → 员工中配置。这里不展示虚构的智能体市场。',
  'dest.workflows.title': '工作流',
  'dest.workflows.body': '工作流编排尚未接入。从对话发出的任务仍在当前会话中执行。',
  'dest.files.title': '文件与数据',
  'dest.files.body': '在对话里用 @ 引用工作区文件。不展示虚构的资料库规模。',
  'dest.models.title': '模型与API',
  'dest.models.body': '在设置 → 模型 接入你自己的接口。千手不出售第三方模型额度。',
  'rail.identity': '千手 AI',
  'rail.models': '选择模型',
  'rail.modelsMore': '更多模型',
  'rail.modelsEmpty': '还没有可选模型。到设置 → 模型 接入你的接口。',
  'rail.modelsHint': '列表来自当前会话已配置的目录，不是第三方产品名。',
  'rail.tools': '快捷工具',
  'rail.toolSearch': '联网搜索',
  'rail.toolThink': '深度思考',
  'rail.toolFile': '文件',
  'rail.toolImage': '图像',
  'rail.toolMore': '更多工具',
  'rail.tasks': '任务动态',
  'rail.tasksAll': '查看全部',
  'rail.tasksEmpty': '还没有进行中的任务。从对话发出的工作会显示在这里。',
  'shell.nav': '快捷跳转',
  'shell.back': '回到对话',
  'shell.openTasks': '任务中心',
  'shell.openAgents': '智能体广场',
  'shell.openWorkflows': '工作流',
  'shell.openFiles': '文件与数据',
  'shell.openModels': '模型与API',
  'shell.reading': '正在读取…',
  'shell.unavailable': '未接入',
  'shell.scopeGlobal': '全局面板',
  'shell.scopeSession': '跟随当前会话',
  'dest.agents.position': '一支常驻的 AI 团队替你推进项目：你只说出目标，CEO 负责拆解、派工、验收与交付。',
  'dest.agents.status.title': '当前团队',
  'dest.agents.status.subagents': '{count} 名员工已上线',
  'dest.agents.status.empty': '这一秒没有员工在工作。',
  'dest.agents.count': '{count} 名员工已上线',
  'dest.agents.categorySubagent': '子智能体',
  'dest.agents.categoryOneShot': '一次性子智能体',
  'dest.agents.stateRunning': '进行中',
  'dest.agents.stateInactive': '已暂停',
  'dest.agents.open': '打开这个会话',
  'dest.agents.detail': '详情',
  'dest.agents.where': '怎么让员工开工',
  'dest.agents.where.items': '直接对话|你只描述目标、受众与验收标准，不需要先建团队。'
    + '\n同一条消息里派工|独立的工作会同时启动，不再串行等待。'
    + '\n内部协作|员工之间用内部消息对齐细节，你只看最终交付。'
    + '\n随时干预|说停就停，改需求时把完整修订发给同一个员工。',
  'dest.agents.members': '团队配置',
  'dest.agents.members.count': '最多 {count} 个员工名额',
  'dest.agents.members.items': '维护员工名册|员工名字、职责与默认路由都在 设置 → 插件 → 员工设置（qianshou-employees）里维护。'
    + '\n指定接口|员工设置可为单个员工固定服务商与模型；密钥留在服务商设置里。'
    + '\n可查可改|员工的职责与接口绑定在设置里可查可改，随时能停用。',
  'dest.agents.now.title': '现在就能直接用',
  'dest.agents.now.items': '在对话里点名员工|按职责派活，例如让「工程师」改一处代码。'
    + '\n沿用同一个员工|相同职责的后续工作发给同一个会话，上下文不会断。'
    + '\n查员工清单|对话里随时列出可派工的子智能体及其职责与接口绑定。'
    + '\n先试点再铺开|先让一个员工跑通，再复制成整支团队。',
  'dest.agents.notice': '这一页只显示真实存在的会话与子智能体，不列出未接入的市场目录。',
  'dest.workflows.position': '把一次工作拆成可复用的步骤，交给员工并行推进，进程与结果都可回看。',
  'dest.workflows.jobs.title': '后台进程',
  'dest.workflows.jobs.count': '{count} 个后台进程',
  'dest.workflows.jobs.empty': '这一秒没有后台进程在跑。',
  'dest.workflows.jobRunning': '运行中',
  'dest.workflows.jobStopping': '正在停止',
  'dest.workflows.jobCompleted': '已完成',
  'dest.workflows.jobKilled': '已停止',
  'dest.workflows.jobFailed': '失败',
  'dest.workflows.kindScript': '并行脚本',
  'dest.workflows.kindLoop': '迭代循环',
  'dest.workflows.forms.title': '四种可用的编排形态',
  'dest.workflows.forms.items': '并行脚本|一次派出多个员工，收齐结果后再汇总。'
    + '\n迭代循环|同一个目标反复打磨，直到达到验收标准。'
    + '\n后台进程|长任务交给后台，对话继续往下走。'
    + '\n可回看的节点|每次运行都留在会话里，随时打开原始记录。',
  'dest.workflows.run.title': '从哪里发起',
  'dest.workflows.run.items': '说清目标|在对话里说明目标与验收标准。'
    + '\n要求并行|明确要求并行推进，或直接说「按工作流做」。'
    + '\n看进度|运行中的进程显示在会话顶部的任务列表与会话内的运行节点里。'
    + '\n中断不丢结果|已完成的步骤会保留在会话历史中。',
  'dest.workflows.notice': '独立的可视化编排编辑器尚未接入，工作流现在通过对话与后台进程运行。',
  'dest.files.position': '工作区就是你的资料库：对话、命令行与文件面板读的是同一份真实文件。',
  'dest.files.read.title': '三种读取方式',
  'dest.files.read.items': '在对话里引用|输入 @ 选择工作区文件或目录，路径会写进你的消息。'
    + '\n直接拖进对话|附件随消息一起发送，而不是复制粘贴内容。'
    + '\n文件面板|在会话右侧的「文件」页签浏览工作区目录。',
  'dest.files.panel': '打开文件面板',
  'dest.files.panelNoSession': '先打开一个会话，文件面板会跟随该会话的工作区。',
  'dest.files.scope.title': '范围与边界',
  'dest.files.scope.items': '跟随工作区|@ 只在当前会话的工作区里检索，不碰工作区之外的路径。'
    + '\n真实目录|文件面板列出的是真实目录内容，因此空文件夹就是空的。'
    + '\n不做索引|这一页不统计文件数量与体积，也不维护全局索引。',
  'dest.files.notice': '这里没有「已上传多少文件」这类数字：读取入口在会话里，本页不复制一份可能过期的清单。',
  'dest.models.position': '接入你自己的模型接口，按会话或按员工分配路由。',
  'dest.models.providers.title': '可用服务商',
  'dest.models.providers.count': '{count} 个服务商',
  'dest.models.modelCount': '{count} 个模型',
  'dest.models.empty': '还没有读到任何服务商，接入接口后这里会出现真实目录。',
  'dest.models.current': '当前会话的默认选择',
  'dest.models.currentValue': '{provider} / {model}',
  'dest.models.reasoning': '推理强度 {effort}',
  'dest.models.routeAvailable': '当前路由可用。',
  'dest.models.routeUnavailable': '当前路由没有对应的适配器，发送前请先改选模型。',
  'dest.models.routePending': '路由状态尚未读到，第一次请求会给出结果。',
  'dest.models.failures': '{count} 个服务商读取失败',
  'dest.models.setup.title': '在哪里配置',
  'dest.models.setup.items': '模型|设置 → 模型：填写服务商地址、模型 id 与 API 密钥。'
    + '\n模型路由|设置 → 模型路由：设定默认路由与绑定顺序。'
    + '\n按员工分配|设置 → 插件 → 员工设置：为单个员工指定服务商与模型。'
    + '\n会话内切换|对话右侧的「选择模型」即时切换当前会话使用的模型。',
  'dest.models.notice': '模型由你自带的密钥调用，费用由对应服务商结算；本应用不附带共享额度，也不转售第三方额度。',
  'dest.models.noSession': '还没有打开会话，读不到模型目录。先回到对话，这里就会列出真实模型。',
} as const
/** Complete set of private workbench brand dictionary keys. */
export type ForgeBrandKey = keyof typeof zh
/** English branding with the same keys as the Chinese dictionary. */
export const en: Record<ForgeBrandKey, string> = {
  name: 'Qianshou AI',
  subtitle: 'A team of AI, here for you',
  'nav.chat': 'Chat',
  'dest.agents.title': 'Agent plaza',
  'dest.agents.body': 'Configure employees and subagents in Settings → Employees. This page does not invent a marketplace catalog.',
  'dest.workflows.title': 'Workflows',
  'dest.workflows.body': 'Workflow orchestration is not connected yet. Tasks you send still run in the current conversation.',
  'dest.files.title': 'Files and data',
  'dest.files.body': 'Reference workspace files with @ in the conversation. This page does not invent a library inventory.',
  'dest.models.title': 'Models and API',
  'dest.models.body': 'Connect your own providers in Settings → Models. Qianshou does not sell third-party model quota.',
  'rail.identity': 'Qianshou AI',
  'rail.models': 'Choose a model',
  'rail.modelsMore': 'More models',
  'rail.modelsEmpty': 'No models yet. Connect your provider in Settings → Models.',
  'rail.modelsHint': 'This list is the current session catalog, not third-party product names.',
  'rail.tools': 'Quick tools',
  'rail.toolSearch': 'Web search',
  'rail.toolThink': 'Deep thinking',
  'rail.toolFile': 'Files',
  'rail.toolImage': 'Images',
  'rail.toolMore': 'More tools',
  'rail.tasks': 'Task activity',
  'rail.tasksAll': 'View all',
  'rail.tasksEmpty': 'No running tasks yet. Work you send from chat appears here.',
  'shell.nav': 'Jump to',
  'shell.back': 'Back to chat',
  'shell.openTasks': 'Task center',
  'shell.openAgents': 'Agent plaza',
  'shell.openWorkflows': 'Workflows',
  'shell.openFiles': 'Files and data',
  'shell.openModels': 'Models and API',
  'shell.reading': 'Reading…',
  'shell.unavailable': 'Not connected',
  'shell.scopeGlobal': 'Global panel',
  'shell.scopeSession': 'Follows the current session',
  'dest.agents.position': 'A standing AI team that moves your project forward: you state the goal, the CEO splits it, delegates it, verifies it and delivers.',
  'dest.agents.status.title': 'Current team',
  'dest.agents.status.subagents': '{count} teammates online',
  'dest.agents.status.empty': 'No teammate is working right now.',
  'dest.agents.count': '{count} teammates online',
  'dest.agents.categorySubagent': 'Subagent',
  'dest.agents.categoryOneShot': 'One-shot subagent',
  'dest.agents.stateRunning': 'Working',
  'dest.agents.stateInactive': 'Idle',
  'dest.agents.open': 'Open this session',
  'dest.agents.detail': 'Details',
  'dest.agents.where': 'How to put the team to work',
  'dest.agents.where.items': 'Just talk|Describe the goal, the audience and the acceptance criteria; you never build the roster first.'
    + '\nDelegate in one message|Independent work starts together instead of running one after another.'
    + '\nInternal coordination|Teammates align with each other over internal messages, so you only see the delivered result.'
    + '\nIntervene anytime|Say stop and it stops; when a requirement changes, send the full revision to the same teammate.',
  'dest.agents.members': 'Team configuration',
  'dest.agents.members.count': 'Up to {count} employee seats',
  'dest.agents.members.items': 'Edit the roster|Names, roles and default routes live in Settings → Plugins → Employee settings (qianshou-employees).'
    + '\nAssign an interface|Employee settings can pin one employee to a provider and model; keys stay in provider settings.'
    + '\nVisible and editable|Roles and interface bindings are visible in settings, and you can retire one at any time.',
  'dest.agents.now.title': 'What works today',
  'dest.agents.now.items': 'Name a teammate in chat|Delegate by role, for example ask the engineer to change one piece of code.'
    + '\nReuse the same teammate|Send follow-up work of the same kind to the same conversation; its context stays intact.'
    + '\nRead the roster|Ask for the current list of subagents to see their roles and interface bindings.'
    + '\nPilot, then scale|Get one teammate right, then copy the pattern into a whole team.',
  'dest.agents.notice': 'This page lists only sessions and subagents that actually exist; it never fabricates a marketplace catalog.',
  'dest.workflows.position': 'Split one job into reusable steps, run them through teammates in parallel, and keep every process and result reviewable.',
  'dest.workflows.jobs.title': 'Background processes',
  'dest.workflows.jobs.count': '{count} background processes',
  'dest.workflows.jobs.empty': 'No background process is running right now.',
  'dest.workflows.jobRunning': 'Running',
  'dest.workflows.jobStopping': 'Stopping',
  'dest.workflows.jobCompleted': 'Completed',
  'dest.workflows.jobKilled': 'Stopped',
  'dest.workflows.jobFailed': 'Failed',
  'dest.workflows.kindScript': 'Parallel script',
  'dest.workflows.kindLoop': 'Iteration loop',
  'dest.workflows.forms.title': 'Four orchestration shapes that work',
  'dest.workflows.forms.items': 'Parallel script|Send several teammates at once, then combine the results.'
    + '\nIteration loop|Polish the same goal round after round until it meets the acceptance criteria.'
    + '\nBackground process|Hand a long task to the background and keep the conversation moving.'
    + '\nReviewable nodes|Every run stays in the conversation, ready to reopen as raw evidence.',
  'dest.workflows.run.title': 'Where a run starts',
  'dest.workflows.run.items': 'State the goal|Describe the goal and the acceptance criteria in chat.'
    + '\nAsk for parallelism|Ask explicitly for parallel work, or simply ask for a workflow.'
    + '\nWatch progress|Running processes appear in the session header task list and in the run nodes inside the conversation.'
    + '\nStop safely|Stopping loses no results, because finished steps stay in the session history.',
  'dest.workflows.notice': 'A standalone visual workflow editor is not connected yet; workflows run through chat and background processes today.',
  'dest.files.position': 'Your workspace is the library: chat, the shell and the file panel all read the same real files.',
  'dest.files.read.title': 'Three ways to read it',
  'dest.files.read.items': 'Reference in chat|Type @ to pick a workspace file or folder; the path is written into your message.'
    + '\nDrop it into chat|Attachments travel with the message instead of a copy-pasted body.'
    + '\nFile panel|Browse the workspace tree in the Files tab on the right of a session.',
  'dest.files.panel': 'Open the file panel',
  'dest.files.panelNoSession': 'Open a session first; the file panel follows that session’s workspace.',
  'dest.files.scope.title': 'Scope and limits',
  'dest.files.scope.items': 'Stay in the workspace|@ searches only the current session workspace and never reaches outside it.'
    + '\nReal directories|The file panel lists real directory content, so an empty folder really is empty.'
    + '\nNo global index|This page counts neither file totals nor sizes and keeps no global index.',
  'dest.files.notice': 'There is no “files uploaded” number here: reading happens inside a session, and this page will not duplicate a list that can go stale.',
  'dest.models.position': 'Connect your own model providers and assign routes per session or per employee.',
  'dest.models.providers.title': 'Available providers',
  'dest.models.providers.count': '{count} providers',
  'dest.models.modelCount': '{count} models',
  'dest.models.empty': 'No provider has been read yet; connect an interface and the real catalog appears here.',
  'dest.models.current': 'Default for the current session',
  'dest.models.currentValue': '{provider} / {model}',
  'dest.models.reasoning': 'Reasoning effort {effort}',
  'dest.models.routeAvailable': 'The current route is served.',
  'dest.models.routeUnavailable': 'No adapter serves the current route; pick another model before sending.',
  'dest.models.routePending': 'The route state is not known yet; the first request settles it.',
  'dest.models.failures': '{count} providers failed to load',
  'dest.models.setup.title': 'Where to configure it',
  'dest.models.setup.items': 'Models|Settings → Models: provider address, model id and API key.'
    + '\nModel routing|Settings → Model routing: the default route and binding order.'
    + '\nPer employee|Settings → Plugins → Employee settings: assign a provider and model to one employee.'
    + '\nIn session|Choose a model on the right of the conversation to switch the current session.',
  'dest.models.notice': 'Models run on your own keys and the provider bills them; this app ships no shared quota and resells no third-party quota.',
  'dest.models.noSession': 'No session is open yet, so no model directory can be read. Go back to chat and the real models appear here.',
}
