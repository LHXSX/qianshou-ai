/** Real Electron policy exercise with Chromium synthetic devices, never a physical microphone. */
import { app, BrowserWindow, protocol, session } from 'electron'
import { writeFile } from 'node:fs/promises'
import { installProductPermissions } from '../../lib/types/product-permissions.js'

app.setName('Qianshou Permission QA')
app.setPath('userData', process.argv[2])
app.commandLine.appendSwitch('use-fake-device-for-media-stream')
protocol.registerSchemesAsPrivileged([{ scheme: 'dsh-app', privileges: { standard: true, secure: true, supportFetchAPI: true } }])
async function main() {
  await app.whenReady()
  protocol.handle('dsh-app', request => new Response(new URL(request.url).pathname === '/child' ? '<html><body>frame</body></html>'
    : '<html><body><iframe src="dsh-app://app/child" allow="microphone"></iframe></body></html>',
    { headers: { 'Content-Type': 'text/html' } }))
  let owner = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
  installProductPermissions(session.defaultSession, () => owner)
  const media = async (target, constraints) => target.executeJavaScript(`(async () => {
    try { const stream = await navigator.mediaDevices.getUserMedia(${JSON.stringify(constraints)});
      const kinds = stream.getTracks().map(track => track.kind); stream.getTracks().forEach(track => track.stop());
      return { allowed: true, kinds, stopped: stream.getTracks().every(track => track.readyState === 'ended') };
    } catch (error) { return { allowed: false, error: error.name }; }
  })()`)
  const report = { method: 'real Electron with Chromium synthetic media devices; no physical microphone or speaker acceptance', checks: {} }
  try {
    await owner.loadURL('dsh-app://app/')
    report.checks.ownedAudio = await media(owner.webContents, { audio: true })
    report.checks.ownedVideo = await media(owner.webContents, { video: true })
    report.checks.ownedMixed = await media(owner.webContents, { audio: true, video: true })
    const child = owner.webContents.mainFrame.frames[0]
    report.checks.subframeAudio = child === undefined ? { error: 'missing-frame' } : await media(child, { audio: true })
    const other = new BrowserWindow({ show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } })
    await other.loadURL('dsh-app://app/')
    report.checks.otherWindowAudio = await media(other.webContents, { audio: true })
    other.destroy()
    await owner.loadURL('dsh-app://untrusted/')
    report.checks.otherOriginAudio = await media(owner.webContents, { audio: true })
    const { ownedAudio, ...denied } = report.checks
    report.passed = ownedAudio.allowed === true && ownedAudio.stopped === true
      && Object.values(denied).every(result => result.allowed === false)
    await writeFile(process.argv[3], `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 })
    app.exit(report.passed ? 0 : 1)
  } catch (error) {
    await writeFile(process.argv[3], JSON.stringify({ ...report, passed: false, error: error.name }), { mode: 0o600 })
    app.exit(1)
  }
}
void main().catch(error => { console.error(error.name); app.exit(1) })
