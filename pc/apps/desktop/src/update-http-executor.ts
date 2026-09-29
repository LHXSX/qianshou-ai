/** Electron-native inactivity deadlines for updater checks, full downloads, and blockmap requests. */
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor.js'
import type { ClientRequest, IncomingMessage } from 'electron'
import type { RequestOptions } from 'node:http'

/** Retains electron-updater transport and proxy handling while bounding silent connections. */
export class DesktopUpdateHttpExecutor extends ElectronHttpExecutor {
  /**
   * @param idleTimeoutMs - Maximum silence before headers or between response chunks, not a total download deadline.
   * @param proxyLogin - Existing updater login event forwarding.
   * @param allowedOrigin - Package-sealed Qianshou origin; no redirect origin fallback.
   */
  constructor(private readonly idleTimeoutMs: number, proxyLogin?: ConstructorParameters<typeof ElectronHttpExecutor>[0],
    private readonly allowedOrigin?: string) {
    super(proxyLogin)
    if (allowedOrigin !== undefined) {
      const origin = new URL(allowedOrigin)
      if (origin.protocol !== 'https:' || origin.origin !== allowedOrigin || origin.username || origin.password) {
        throw new Error('desktop update: expected a sealed HTTPS origin')
      }
    }
    if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1000 || idleTimeoutMs > 2_147_483_647) {
      throw new Error('desktop update: HTTP idle timeout must be an integer from 1000 through 2147483647')
    }
  }

  /** Reject foreign metadata, artifact and blockmap origins before creating a network request. */
  override createRequest(options: RequestOptions, callback: (response: IncomingMessage) => void): ClientRequest {
    if (this.allowedOrigin !== undefined) {
      const host = options.hostname ?? options.host
      if (typeof host !== 'string' || Object.keys(options.headers ?? {}).some(key => key.toLowerCase() === 'host')
        || !this.trustedURL((options.protocol ?? 'https:') + '//' + host + (options.port === undefined ? '' : ':' + options.port))) {
        throw new Error('DESKTOP_UPDATE_UNTRUSTED_ORIGIN')
      }
    }
    return super.createRequest({ ...options, redirect: 'manual' }, callback)
  }

  protected override addRedirectHandlers(request: ClientRequest, options: RequestOptions, reject: (error: Error) => void,
    redirectCount: number, handler: (options: RequestOptions) => void): void {
    if (this.allowedOrigin === undefined) { super.addRedirectHandlers(request, options, reject, redirectCount, handler); return }
    request.on('redirect', (_statusCode, _method, redirectURL) => {
      request.abort()
      if (!this.trustedURL(redirectURL)) reject(new Error('DESKTOP_UPDATE_UNTRUSTED_ORIGIN'))
      else if (redirectCount > this.maxRedirects) reject(this.createMaxRedirectError())
      else handler(ElectronHttpExecutor.prepareRedirectUrlOptions(redirectURL, options))
    })
  }

  private trustedURL(value: string): boolean {
    try { const url = new URL(value); return url.origin === this.allowedOrigin && url.protocol === 'https:' && !url.username && !url.password }
    catch { return false }
  }

  override addErrorAndTimeoutHandlers(request: ClientRequest, reject: (error: Error) => void): void {
    // The upstream socket timer is for Node HTTP; Electron ClientRequest has response/close events instead.
    super.addErrorAndTimeoutHandlers(request, reject, this.idleTimeoutMs)
    let response: IncomingMessage | undefined
    let timer: ReturnType<typeof setTimeout>
    const stop = (): void => {
      clearTimeout(timer)
      request.off('response', onResponse)
      request.off('abort', stop)
      request.off('error', stop)
      response?.off('data', refresh)
      response?.off('end', stop)
      response?.off('error', stop)
    }
    const refresh = (): void => {
      clearTimeout(timer)
      timer = setTimeout(() => {
        stop()
        reject(Object.assign(new Error('Desktop update connection timed out'), { code: 'ETIMEDOUT' }))
        request.abort()
      }, this.idleTimeoutMs)
    }
    const onResponse = (incoming: IncomingMessage): void => {
      response = incoming
      response.on('data', refresh)
      response.once('end', stop)
      response.once('error', stop)
      refresh()
    }
    request.once('response', onResponse)
    // Electron 44 can emit writable close after finish, before response headers arrive.
    request.once('abort', stop)
    request.once('error', stop)
    refresh()
  }
}
