/** Render only public update state; all download and activation effects stay in the main process. */
const words = {
  zh: {
    eyebrow: '千手 · 软件更新', title: '让工作台保持最新', description: '后台下载，工作结束后再重启。你的会话、接口与密钥继续保留。', privacy: '仅连接官方更新服务，不使用模型额度。基于 DeepSeek Harness 开源项目构建。', later: '稍后', check: '检查更新', retry: '重试', cancel: '取消下载', restart: '重启升级',
    idle: '准备检查', checking: '正在检查更新', current: '已是最新版本', available: '发现新版本', downloading: '正在后台下载', staging: '正在验证和准备新版', waiting: '新版已准备，等待任务结束', ready: '新版已准备好', restarting: '正在准备重启', error: '暂时无法完成更新', unsupported: '当前系统暂无匹配版本',
    preserved: '更新只替换应用程序，用户数据继续保留。', busy: '正在执行或等待处理的任务结束后，可以安全重启。', safe: '已验证官方签名与安装包完整性。点击重启后生效。', currentDetail: '将继续在后台检查后续版本。', source: '源码启动不支持替换应用，请安装官网发布版。', failed: '请稍后重试。当前版本和任务不受影响。', integrity: '更新包未通过验证，已经停止安装。请稍后重试。', cancelled: '下载已取消，当前程序继续运行。',
  },
  en: {
    eyebrow: 'QIANSHOU · SOFTWARE UPDATE', title: 'Keep your workspace current', description: 'Download in the background. Restart after work finishes. Conversations and your API credentials stay on this computer.', privacy: 'Official updates only. No model quota is used. Built on the open-source DeepSeek Harness project.', later: 'Later', check: 'Check updates', retry: 'Retry', cancel: 'Cancel download', restart: 'Restart and update',
    idle: 'Ready to check', checking: 'Checking for updates', current: 'You are up to date', available: 'New version available', downloading: 'Downloading in the background', staging: 'Verifying and preparing the update', waiting: 'Update ready — waiting for work to finish', ready: 'Ready to update', restarting: 'Preparing to restart', error: 'Update could not complete', unsupported: 'No matching release for this system',
    preserved: 'Only the application is updated. Your local data stays in place.', busy: 'Finish running and pending work before restarting.', safe: 'Publisher signature and package integrity verified. Restart to apply.', currentDetail: 'The application will keep checking for later releases.', source: 'Install the official packaged app to use application updates.', failed: 'Try again later. The current version and tasks are unaffected.', integrity: 'Update verification failed. Installation was stopped.', cancelled: 'Download cancelled. The current application keeps running.',
  },
}
const byId = id => document.getElementById(id)
let current
function render(state) {
  current = state
  const t = state.locale === 'en' ? words.en : words.zh
  document.documentElement.lang = state.locale === 'en' ? 'en' : 'zh-CN'
  for (const id of ['eyebrow', 'title', 'description', 'privacy']) byId(id).textContent = t[id]
  byId('phase').textContent = t[state.phase] ?? t.error
  byId('version').textContent = state.version ? `${state.currentVersion} → ${state.version}` : state.currentVersion
  byId('detail').textContent = state.phase === 'ready' ? t.safe : state.phase === 'waiting' ? t.busy : state.phase === 'current' ? t.currentDetail : state.error === 'SOURCE_BUILD' ? t.source : state.error === 'CANCELLED' ? t.cancelled : /SIGNATURE|INTEGRITY|MANIFEST|UNSAFE|DOWNGRADE/.test(state.error ?? '') ? t.integrity : state.phase === 'error' ? t.failed : t.preserved
  const progress = byId('progress')
  progress.hidden = !['downloading', 'staging'].includes(state.phase)
  progress.value = state.progress ?? 0
  const notes = byId('notes'); notes.replaceChildren()
  for (const note of state.notes ?? []) { const item = document.createElement('li'); item.textContent = note; notes.append(item) }
  const primary = byId('primary')
  primary.textContent = state.phase === 'ready' ? t.restart : state.phase === 'error' ? t.retry : t.check
  primary.disabled = ['checking', 'downloading', 'staging', 'waiting', 'restarting'].includes(state.phase)
  byId('secondary').textContent = state.phase === 'downloading' ? t.cancel : t.later
  byId('secondary').disabled = state.phase === 'restarting'
}
byId('primary').addEventListener('click', () => { void window.qianshouUpdate.invoke(current?.phase === 'ready' ? 'install' : 'check') })
byId('secondary').addEventListener('click', () => { void window.qianshouUpdate.invoke(current?.phase === 'downloading' ? 'cancel' : 'hide') })
window.qianshouUpdate.subscribe(render)
void window.qianshouUpdate.invoke('snapshot').then(result => { if (result.ok) render(result.value) })
