// @vitest-environment jsdom
/**
 * Ownerless-copy registrations inside the assembled web client: the five
 * seats, the `settings` dictionaries, the locale-following nav label, the
 * loopback-only document action over the real settings mirror, and recovery
 * across Loader rebuilds of the declaring chain.
 */
import { describe, expect, onTestFinished, vi } from 'vitest'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { ok, type RemoteMock } from '@deepseek-ai/dsh-remote-mock'
import type { SettingsNamespaceView } from '@deepseek-ai/dsh-settings/types'
import { createClientTest, type TestClient, webApp } from '@deepseek-ai/dsh-client-test-runtime/src/assembly/index.ts'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { LOCALE_SETTINGS_NAMESPACE, LocaleSettingsSchema } from '@deepseek-ai/dsh-client-locale/src/locale-settings.ts'
import { inject } from '../src/client/index.ts'
import { CloseLabel, HeaderContent, TriggerContent } from '../src/client/chrome.tsx'
import { GeneralSection } from '../src/client/GeneralSection.tsx'
import { AccountSection } from '../src/client/AccountSection.tsx'
import type { AccountSectionInjected } from '../src/client/AccountSection.tsx'
import { SettingsDocumentAction } from '../src/client/SettingsDocumentAction.tsx'
import type { SettingsDocumentActionInjected } from '../src/client/SettingsDocumentAction.tsx'

const SELF = '@deepseek-ai/dsh-client-ui-settings-general'
const SIDEBAR = '@deepseek-ai/dsh-client-ui-sidebar'
const it = createClientTest({ roster: webApp })
/** The whole roster's first boot pays the cold module transform of every plugin package. */
const COLD_BOOT_TIMEOUT_MS = 60_000
/** Dictionary namespace this plugin owns; every seat it fills declares it. */
const NS = 'settings'

/** The seats this plugin fills for a loopback browser (slot name → expected component). */
const SEATS = [
  ['settings.trigger', TriggerContent],
  ['settings.header', HeaderContent],
  ['settings.action', SettingsDocumentAction],
  ['settings.close', CloseLabel],
  ['settings.section', GeneralSection],
] as const

/** One Host view of the locale preference, including its revision fence. */
function localeView(preference: string, revision = 0): SettingsNamespaceView {
  return {
    ns: LOCALE_SETTINGS_NAMESPACE,
    // The Remote wire serializes nested Schema values before the client rehydrates them.
    schema: JSON.parse(JSON.stringify(LocaleSettingsSchema.toJSON())) as SettingsNamespaceView['schema'],
    value: { preference },
    applies: 'live',
    secrets: [],
    revision,
  }
}

async function client(mock: RemoteMock, start: () => Promise<TestClient>, hasDocument = false) {
  const settings = mock.remote.settings
  settings.describe.mockResolvedValue(ok({ writable: true, hasDocument, namespaces: [localeView('zh')] }))
  const c = await start()
  // The locale adopts the Host preference once the describe mirror holds the document.
  await c.ctx.settingsScope.describe().ensure()
  return { c, settings }
}

/** This plugin's rows in a seat: the list seats also carry feature-owned rows (the product's other sections and actions). */
function ownEntries(c: TestClient, name: (typeof SEATS)[number][0]) {
  return c.ctx.slots.entries(name).filter(entry => entry.locale === NS)
}

function generalEntry(c: TestClient) {
  return ownEntries(c, 'settings.section').find(entry => entry.component === GeneralSection)!
}

function generalLabel(c: TestClient): string | undefined {
  return resolveSlotLabel(generalEntry(c).options.label)
}

function accountEntry(c: TestClient) {
  return c.ctx.slots.entries('settings.section').find(entry => entry.component === AccountSection)!
}

function accountLabel(c: TestClient): string | undefined {
  return resolveSlotLabel(accountEntry(c).options.label)
}

function actionInjectedOf(c: TestClient): SettingsDocumentActionInjected {
  const entry = ownEntries(c, 'settings.action')[0]!
  return (entry.inject as unknown as () => SettingsDocumentActionInjected)()
}

function expectSeated(c: TestClient): void {
  for (const [name, component] of SEATS) {
    expect(ownEntries(c, name).map(entry => entry.component)).toEqual([component])
  }
}

/** The page authority the `connection` plugin classifies at apply, reconfigured through the jsdom instance vitest exposes. */
function setPageUrl(url: string): void {
  (globalThis as unknown as { jsdom: { reconfigure(settings: { url: string }): void } }).jsdom.reconfigure({ url })
}

describe('ui-settings-general apply', () => {
  it('declares the services it uses', () => {
    expect(inject).toEqual(['slots', 'locale', 'connection', 'remote', 'remote.settings', 'settingsScope'])
  })

  it('fills the five seats of the shell it declares, with the locale-following General label', async ({ mock, start }) => {
    const { c } = await client(mock, start)
    expect(c.ctx.locale.getSnapshot().active).toBe('zh')
    expectSeated(c)
    const entry = generalEntry(c)
    expect(entry.options).toMatchObject({ id: 'general', order: 0 })
    // The nav label is a locale-following thunk; owners resolve at read time.
    expect(generalLabel(c)).toBe('通用设置')
    expect(c.ctx.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    // The General items and the onboarding steps are feature-owned rows; this plugin seats none of its own.
    expect(c.ctx.slots.entries('settings.general.item').filter(row => row.locale === NS)).toEqual([])
    expect(c.ctx.slots.entries('settings.onboarding').filter(row => row.locale === NS)).toEqual([])
    const { controller, hooks } = actionInjectedOf(c)
    expect(controller.store.getSnapshot().status).toBe('idle')
    expect(hooks.snapshot).toBe(controller.store)
    // Copy rides the standard locale seat: every row this plugin seats declares the namespace.
    for (const [name, component] of SEATS) {
      expect(c.ctx.slots.entries(name).find(row => row.component === component)!.locale).toBe(NS)
    }
  }, COLD_BOOT_TIMEOUT_MS)

  it('seats the account section under its own copy namespace with a wired action face', async ({ mock, start }) => {
    const { c } = await client(mock, start)
    const entry = c.ctx.slots.entries('settings.section').find(row => row.component === AccountSection)!
    expect(entry.locale).toBe('settings.account')
    expect(entry.options).toMatchObject({ id: 'account', order: 5 })
    expect(resolveSlotLabel(entry.options.label)).toBe('账号')
    expect(c.ctx.locale.bind('settings.account')('title')).toBe('账号')
    // The face is assembled from the plugin's own controller, so the section
    // never builds a transport of its own.
    const face = (entry.inject as unknown as () => AccountSectionInjected)()
    expect(face.hooks.snapshot.getSnapshot()).toMatchObject({
      session: null, step: 'credentials', mode: 'login', loading: true, error: null,
    })
    for (const action of ['refresh', 'verify', 'login', 'submitTotp', 'register', 'logout', 'showForm'] as const) {
      expect(typeof face[action]).toBe('function')
    }
  }, COLD_BOOT_TIMEOUT_MS)

  it('drives every account action through the page\'s own same-origin fetch', async ({ mock, start }) => {
    const { c } = await client(mock, start)
    const entry = c.ctx.slots.entries('settings.section').find(row => row.component === AccountSection)!
    const face = (entry.inject as unknown as () => AccountSectionInjected)()
    // The plugin builds no transport of its own: every action must reach the
    // route through the page's `fetch`, with the session cookie attached.
    const urls: string[] = []
    // `init` is declared (and unused) so the mock matches the real `fetch`
    // signature: the assertions below read `call[1]`, and the page only sets
    // those options if it actually passes a second argument.
    const fetchStub = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      urls.push(url)
      if (url.endsWith('/login')) {
        return Response.json({ ok: true, twoFactor: true, challenge: { challenge_token: 'ch-apply', default_method: 'totp' } })
      }
      if (url.endsWith('/login-totp')) return Response.json({ ok: true, account: null })
      if (url.endsWith('/register')) return Response.json({ ok: true, signedIn: false })
      if (url.endsWith('/logout')) return Response.json({ ok: true })
      return Response.json({ ok: true, state: 'signed-out', account: null })
    })
    vi.stubGlobal('fetch', fetchStub)
    await face.refresh()
    await face.verify()
    await face.login('owner', 'pw')
    expect(face.hooks.snapshot.getSnapshot()).toMatchObject({ step: 'totp', notice: 'totpRequired' })
    await face.submitTotp('123456', true)
    await face.register('pw', 'owner', '')
    await face.logout()
    face.backToCredentials()
    face.showForm('register')
    vi.unstubAllGlobals()
    // A 2FA answer takes no state read: the sign-in is not finished yet, so
    // nothing about the session has changed to observe.
    expect(urls).toEqual([
      '/api/qianshou/account/state',
      '/api/qianshou/account/me',
      '/api/qianshou/account/login',
      '/api/qianshou/account/login-totp',
      '/api/qianshou/account/state',
      '/api/qianshou/account/register',
      '/api/qianshou/account/state',
      '/api/qianshou/account/logout',
      '/api/qianshou/account/state',
    ])
    for (const call of fetchStub.mock.calls) {
      expect(call[1]).toMatchObject({ method: 'POST', credentials: 'same-origin', cache: 'no-store' })
    }
    // Leaving the code step clears the notice it carried, so the last
    // published notice is gone and the form switch is the only visible change.
    expect(face.hooks.snapshot.getSnapshot()).toMatchObject({
      session: 'signed-out', account: null, step: 'credentials', mode: 'register', notice: null, loading: false,
    })
  }, COLD_BOOT_TIMEOUT_MS)

  it('registers the zh/en settings dictionaries and frees the seats when its row unloads', async ({ mock, start }) => {
    const { c, settings } = await client(mock, start)
    const english = localeView('en', 1)
    settings.mutate.mockResolvedValueOnce(ok(english))
    const t = c.ctx.locale.bind(NS)
    expect(t('title')).toBe('设置')
    expect(t('connection.error')).toBe('连接异常')
    expect(t('connection.connecting')).toBe('自动重连中')
    expect(t('connection.connected')).toBe('连接成功')
    c.ctx.locale.setLocale('en')
    expect(t('close')).toBe('Close')
    expect(t('connection.reconnect')).toBe('Disconnected, reconnect now')
    expect(t('connection.connecting')).toBe('Reconnecting')
    await vi.waitFor(() => {
      expect(settings.mutate.mock.calls).toEqual([
        [LOCALE_SETTINGS_NAMESPACE, [{ op: 'set', path: ['preference'], value: 'en' }], 0],
      ])
      expect(c.ctx.settingsScope.describe().getSnapshot().view?.namespaces).toEqual([english])
    })
    await c.unload(SELF)
    await c.flush()
    // The (ns, locale) seats are free again — the dictionary disposer ran.
    expect(() => { c.ctx.locale.register(NS, 'zh', {})() }).not.toThrow()
    expect(() => { c.ctx.locale.register(NS, 'en', {})() }).not.toThrow()
  })

  it('the nav label thunk follows the active locale without re-registration', async ({ mock, start }) => {
    const { c, settings } = await client(mock, start)
    const english = localeView('en', 1)
    const chinese = localeView('zh', 2)
    settings.mutate.mockResolvedValueOnce(ok(english)).mockResolvedValueOnce(ok(chinese))
    const zhVersions = SEATS.map(([name]) => c.ctx.slots.getVersion(name))
    c.ctx.locale.setLocale('en')
    // No ledger churn: freshness rides the thunk (and the renderer's locale
    // subscription), not re-registration.
    SEATS.forEach(([name], i) => {
      expect(c.ctx.slots.getVersion(name)).toBe(zhVersions[i]!)
      expect(ownEntries(c, name)).toHaveLength(1)
    })
    expect(generalLabel(c)).toBe('General')
    // The account section follows the same locale seat: its label thunk reads
    // the account namespace, so English copy reaches the real nav row.
    expect(accountLabel(c)).toBe('Account')
    await vi.waitFor(() => {
      expect(c.ctx.settingsScope.describe().getSnapshot().view?.namespaces).toEqual([english])
    })
    c.ctx.locale.setLocale('zh')
    expect(generalLabel(c)).toBe('通用设置')
    expect(accountLabel(c)).toBe('账号')
    await vi.waitFor(() => {
      expect(settings.mutate.mock.calls).toEqual([
        [LOCALE_SETTINGS_NAMESPACE, [{ op: 'set', path: ['preference'], value: 'en' }], 0],
        [LOCALE_SETTINGS_NAMESPACE, [{ op: 'set', path: ['preference'], value: 'zh' }], 1],
      ])
      expect(c.ctx.settingsScope.describe().getSnapshot().view?.namespaces).toEqual([chinese])
    })
  })

  it('reads availability from the shared mirror and follows its reconnect refresh', async ({ mock, start }) => {
    const { c } = await client(mock, start, true)
    const { controller } = actionInjectedOf(c)
    // Boot reads the document twice: the mirror's own `ensure` at apply, then
    // the `connection/reset` of the first connection. The action's load adds none.
    expect(c.mock.log.calls('settings/describe')).toHaveLength(2)
    await controller.load()
    expect(c.mock.log.calls('settings/describe')).toHaveLength(2)
    expect(controller.store.getSnapshot().status).toBe('ready')
    c.connection.reconnect()
    await c.mock.streams.opened('$events', 2)
    await vi.waitFor(() => { expect(c.mock.log.calls('settings/describe')).toHaveLength(3) })
  })

  it('withholds the Host document action off-loopback', async ({ mock, start }) => {
    const loopbackUrl = location.href
    setPageUrl('http://198.51.100.7:3000/')
    onTestFinished(() => { setPageUrl(loopbackUrl) })
    const { c } = await client(mock, start)
    expect(c.connection.isLoopback).toBe(false)
    expect(ownEntries(c, 'settings.action')).toEqual([])
    // Off-loopback settings stay process-local: no describe read, so the browser language stands.
    expect(c.mock.log.calls('settings/describe')).toEqual([])
    expect(c.ctx.locale.getSnapshot().active).toBe('en')
    await c.unload(SELF)
    await c.flush()
    for (const [name] of SEATS) expect(ownEntries(c, name)).toEqual([])
  })

  it('re-registers after a Loader rebuild of the declaring chain (stale disposers must not block)', async ({ mock, start }) => {
    const { c, settings } = await client(mock, start)
    const before = SEATS.map(([name]) => ownEntries(c, name)[0])
    await c.reload(SIDEBAR)
    await c.flush()
    expectSeated(c)
    SEATS.forEach(([name], index) => {
      expect(ownEntries(c, name)[0]).not.toBe(before[index])
    })
    expect(c.ctx.slots.spec('settings.general.item')).toEqual({ kind: 'list', scope: 'root' })
    expect(c.ctx.slots.entries('settings.general.item').filter(row => row.locale === NS)).toEqual([])
    // The recovered registrations still ride the locale path.
    const english = localeView('en', 1)
    const chinese = localeView('zh', 2)
    settings.mutate.mockResolvedValueOnce(ok(english)).mockResolvedValueOnce(ok(chinese))
    c.ctx.locale.setLocale('en')
    expect(generalLabel(c)).toBe('General')
    expect(accountLabel(c)).toBe('Account')
    c.ctx.locale.setLocale('zh')
    expect(generalLabel(c)).toBe('通用设置')
    expect(accountLabel(c)).toBe('账号')
    await vi.waitFor(() => {
      expect(settings.mutate.mock.calls).toEqual([
        [LOCALE_SETTINGS_NAMESPACE, [{ op: 'set', path: ['preference'], value: 'en' }], 0],
        [LOCALE_SETTINGS_NAMESPACE, [{ op: 'set', path: ['preference'], value: 'zh' }], 1],
      ])
      expect(c.ctx.settingsScope.describe().getSnapshot().view?.namespaces).toEqual([chinese])
    })
  })

  it('removes every seat and the item declaration when its row unloads', async ({ mock, start }) => {
    const { c } = await client(mock, start)
    expect(c.ctx.slots.spec('settings.general.item')).toBeDefined()
    await c.unload(SELF)
    await c.flush()
    for (const [name] of SEATS) expect(ownEntries(c, name)).toHaveLength(0)
    expect(c.ctx.slots.spec('settings.general.item')).toBeUndefined()
  })
})
