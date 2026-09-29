/* The companion has one local Chinese locale; no remote content is rendered as HTML. */
const copy = {
  title: '千手协作端', subtitle: '让这台电脑，成为你的协作设备。', pairTitle: '连接主控', pairIntro: '填写千手智能体主控地址和一次性配对码。',
  name: '这台设备的名称', endpoint: '主控地址', code: '一次性配对码', codeHint: '首次配对需要主控生成的配对码；已配对时留空即可重连。远程地址必须使用 HTTPS / WSS。',
  connect: '确认并连接', disconnect: '断开连接', forget: '清除本机配对凭据', workspaces: '允许访问的工作区', addFolder: '添加', workspaceHint: '文件操作仅限以下目录。修改目录授权前先断开连接。',
  desktop: '远程桌面', desktopHint: '使用已安装的 RustDesk。屏幕、鼠标、键盘权限及连接确认由 RustDesk 管理。', openRustDesk: '打开 RustDesk',
  tasksEyebrow: 'LOCAL APPROVAL', tasksTitle: '待办与执行记录', footer: '执行输出和读取的文件内容会返回主控。每个任务都需要你确认；断开连接会取消运行中的命令。',
  connected: '已连接', connecting: '连接中', offline: '未连接', empty: '尚无远程任务', emptyHint: '完成配对后，主控发来的任务会出现在这里。确认之前不会执行。', noFolders: '尚未授权目录', remove: '移除',
  command: '运行命令', read: '读取文件', write: '写入文件', list: '浏览目录', desktopJob: '打开远程桌面',
  'awaiting-approval': '等待本机确认', running: '正在执行', completed: '已完成', failed: '失败', rejected: '已拒绝', cancelled: '已取消', interrupted: '已中断',
  approve: '同意执行', reject: '拒绝', cancel: '取消任务', output: '执行输出', result: '结果', scope: '命令将以本机用户权限运行。工作目录不等于操作系统沙箱，请核对完整命令。', workspace: '工作区',
}
const $ = id => document.getElementById(id)
for (const node of document.querySelectorAll('[data-copy]')) node.textContent = copy[node.dataset.copy]
let busy = false
const element = (tag, text, className) => { const node = document.createElement(tag); if (text !== undefined) node.textContent = text; if (className) node.className = className; return node }
const errorCopy = {
  UPDATE_PREPARING: '正在准备重启升级，请稍后再操作；如果升级取消，操作会恢复。',
  CHOOSE_WORKSPACE_FIRST: '请先添加至少一个允许访问的工作区。', PAIR_CODE_REQUIRED: '首次连接需要一次性配对码。', SYSTEM_KEYCHAIN_UNAVAILABLE: '系统安全密钥存储不可用，无法安全保存设备凭据。',
  TLS_REQUIRED_FOR_REMOTE: '远程主控必须使用 HTTPS / WSS；HTTP 仅允许本机回环地址。', RUSTDESK_NOT_INSTALLED: '这台电脑尚未安装 RustDesk。', ANOTHER_JOB_RUNNING: '请等待当前任务完成，或先取消当前任务。',
  CANCEL_RUNNING_JOB_FIRST: '请先取消运行中的任务。', DISCONNECT_TO_EDIT_WORKSPACES: '修改目录授权前请先断开连接。',
}
function showError(message) { $('error').hidden = !message; $('error').textContent = errorCopy[message] || message || '' }
async function invoke(action, payload) {
  const result = await window.qianshou.invoke(action, payload)
  if (!result.ok) { showError(result.error); return undefined }
  showError(null); return result.value
}
function draw(state) {
  if (document.activeElement !== $('name')) $('name').value = state.name
  if (document.activeElement !== $('endpoint')) $('endpoint').value = state.endpoint
  $('connection').textContent = copy[state.connected ? 'connected' : state.connecting ? 'connecting' : 'offline']
  $('connection').className = 'status ' + (state.connected ? 'online' : '')
  $('connect').disabled = state.connected || state.connecting || busy
  $('disconnect').disabled = !state.connected && !state.connecting
  $('add-folder').disabled = state.connected || state.connecting
  if (state.error) showError(state.error)
  const folders = $('folders'); folders.replaceChildren()
  if (!state.workspaces.length) folders.append(element('p', copy.noFolders, 'caption'))
  for (const workspace of state.workspaces) {
    const row = element('div', undefined, 'folder')
    const text = element('div'); text.append(element('strong', workspace.name), element('code', workspace.path))
    const remove = element('button', copy.remove, 'text-button'); remove.disabled = state.connected || state.connecting
    remove.onclick = () => invoke('remove-folder', workspace.id)
    row.append(text, remove); folders.append(row)
  }
  $('task-count').textContent = String(state.jobs.length)
  const jobs = $('jobs'); jobs.replaceChildren()
  if (!state.jobs.length) { const empty = element('div', undefined, 'empty'); empty.append(element('div', '◇', 'empty-icon'), element('h3', copy.empty), element('p', copy.emptyHint)); jobs.append(empty) }
  for (const job of [...state.jobs].reverse()) {
    const card = element('article', undefined, 'job')
    const head = element('div', undefined, 'section-head')
    head.append(element('h3', copy[job.kind === 'desktop' ? 'desktopJob' : job.kind]), element('span', copy[job.status] || job.status, 'badge ' + job.status))
    const workspace = state.workspaces.find(item => item.id === job.workspaceId)
    card.append(head, element('p', `${copy.workspace} · ${workspace?.path || job.workspaceId}`, 'caption'), element('code', job.id, 'job-id'))
    const details = job.kind === 'command' ? job.payload.command : job.kind === 'write' ? `${job.payload.path}\n\n${job.payload.content}` : job.payload.path
    if (details) card.append(element('pre', details, 'payload'))
    if (job.kind === 'command' && job.status === 'awaiting-approval') card.append(element('p', copy.scope, 'scope'))
    if (job.output) { const output = element('details'); output.open = job.status === 'running'; output.append(element('summary', copy.output), element('pre', job.output)); card.append(output) }
    if (job.error) card.append(element('p', errorCopy[job.error] || job.error, 'failure'))
    if (job.result !== undefined) { const result = element('details'); result.append(element('summary', copy.result), element('pre', JSON.stringify(job.result, null, 2))); card.append(result) }
    if (job.status === 'awaiting-approval' || job.status === 'running') {
      const actions = element('div', undefined, 'row')
      for (const action of job.status === 'awaiting-approval' ? ['approve', 'reject'] : ['cancel']) {
        const button = element('button', copy[action], action === 'approve' ? 'primary' : '')
        button.disabled = action === 'approve' && (!state.connected || state.jobs.some(item => item.status === 'running'))
        button.onclick = async () => { button.disabled = true; await invoke(action, job.id) }
        actions.append(button)
      }
      card.append(actions)
    }
    jobs.append(card)
  }
}
$('connect').onclick = async () => {
  busy = true; $('connect').disabled = true
  await invoke('connect', { endpoint: $('endpoint').value, code: $('code').value, name: $('name').value })
  $('code').value = ''; busy = false
  const state = await invoke('snapshot'); if (state) draw(state)
}
for (const [id, action] of [['disconnect', 'disconnect'], ['add-folder', 'choose-folder'], ['forget', 'forget-pairing'], ['rustdesk', 'rustdesk']]) $(id).onclick = () => invoke(action)
window.qianshou.onState(draw)
invoke('snapshot').then(async state => { if (state) { draw(state); await invoke('application-ready') } })
