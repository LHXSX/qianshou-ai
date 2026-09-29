/** Authenticate only to this application's owned loopback service for the update idle lease. */
export function controllerUpdateHooks({ origin, webSession, ready }) {
  async function request(path, body) {
    if (!ready()) throw Object.assign(new Error('Local backend is unavailable'), { code: 'READINESS_UNAVAILABLE' })
    const cookies = await webSession.cookies.get({ url: origin })
    const cookie = cookies.map(value => `${value.name}=${value.value}`).join('; ')
    if (!cookie) throw Object.assign(new Error('Local session is unavailable'), { code: 'READINESS_UNAVAILABLE' })
    const response = await fetch(`${origin}/api/qianshou/${path}`, {
      method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(8000),
      headers: { Cookie: cookie, Origin: origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const value = await response.json()
    if (!response.ok) throw Object.assign(new Error('Update readiness request was declined'), { code: value.code ?? 'READINESS_UNAVAILABLE' })
    return value
  }
  return {
    readiness: () => request('update-readiness'),
    prepareRestart: () => request('update-prepare', {}),
    commitRestart: lease => request('update-commit', { leaseId: lease.leaseId }),
    cancelRestart: lease => request('update-cancel', { leaseId: lease.leaseId }),
  }
}

/** Wait for the exact main frame to acknowledge successful client-plugin mounting. */
export function waitForApplicationReady({ window, ipcMain, origin, signal, timeoutMs = 90_000 }) {
  return new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); ipcMain.removeListener('qianshou:application-ready', listener); signal?.removeEventListener('abort', aborted) }
    const listener = event => {
      if (event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame) return
      let actual
      try { actual = new URL(event.senderFrame.url).origin } catch { return }
      if (actual !== origin) return
      cleanup(); resolve()
    }
    const aborted = () => { cleanup(); reject(new Error('APPLICATION_READY_CANCELLED')) }
    const timer = setTimeout(() => { cleanup(); reject(new Error('APPLICATION_READY_TIMEOUT')) }, timeoutMs)
    ipcMain.on('qianshou:application-ready', listener)
    if (signal?.aborted) aborted()
    else signal?.addEventListener('abort', aborted, { once: true })
  })
}
