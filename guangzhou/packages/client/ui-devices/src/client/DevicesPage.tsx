import { useEffect, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import type { DeviceState, JobKind } from './controller.ts'
import type { DevicesKey } from './locales.ts'
import css from './DevicesPage.module.css'
import { CompanionSetup } from './CompanionSetup.tsx'
import { RelayConnectionSection } from './RelayConnectionSection.tsx'
import type { RelayState } from './relay-controller.ts'

/** Controller capabilities injected through the main panel slot. */
export interface DevicesFace {
  hooks: { devices: ObservableSnapshot<DeviceState>; relay: ObservableSnapshot<RelayState> }
  relayAct: (action: 'import' | 'enable' | 'disable') => Promise<void>
  attach: () => () => void
  refresh: () => Promise<void>
  loadReleases: () => Promise<void>
  act: (path: string, body: unknown) => Promise<void>
}
/** Slot-bound controller hooks and typed device-workspace translations. */
export type DevicesPageProps = InjectFace<DevicesFace> &
  PropsLocale<'qianshou.devices'>
const statusKeys: Record<string, DevicesKey> = {
  'awaiting-approval': 'awaiting',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  rejected: 'rejected',
  cancelled: 'cancelled',
  interrupted: 'interrupted',
}
const terminal = new Set([
  'completed',
  'failed',
  'rejected',
  'cancelled',
  'interrupted',
])
/** Device workspace uses the same live coordinator data as the companion. */
export function DevicesPage({
  useDevices,
  useRelay,
  relayAct,
  attach,
  refresh,
  loadReleases,
  act,
  t,
}: DevicesPageProps) {
  const state = useDevices(s => s)
  const relay = useRelay(s => s)
  const [selected, setSelected] = useState(''),
    [workspace, setWorkspace] = useState(''),
    [kind, setKind] = useState<JobKind>('command'),
    [command, setCommand] = useState(''),
    [path, setPath] = useState('.'),
    [content, setContent] = useState(''),
    [copy, setCopy] = useState(false),
    [desktopError, setDesktopError] = useState('')
  useEffect(attach, [attach])
  const device =
    state.devices.find(d => d.id === selected) ?? state.devices[0]
  const chosenWorkspace =
    device?.workspaces.find(w => w.id === workspace) ?? device?.workspaces[0]
  const ready =
    device?.connected &&
    chosenWorkspace &&
    !state.busy &&
    (kind !== 'command' || command.trim()) &&
    (!['list', 'read', 'write'].includes(kind) || path.trim())
  function submit() {
    if (!device || !chosenWorkspace || !ready) return
    const payload =
      kind === 'command'
        ? { command }
        : kind === 'write'
          ? { path, content }
          : kind === 'read' || kind === 'list'
            ? { path }
            : {}
    void act('jobs', {
      deviceId: device.id,
      workspaceId: chosenWorkspace.id,
      kind,
      payload,
    })
  }
  async function desktop(id: string) {
    setDesktopError('')
    const bridge = (
      window as unknown as {
        qianshouDesktop?: {
          openRustDesk: (id: string) => Promise<{ ok: boolean; error?: string }>
        }
      }
    ).qianshouDesktop
    if (bridge) {
      try {
        const r = await bridge.openRustDesk(id)
        if (!r.ok) setDesktopError(r.error ?? 'DESKTOP_UNAVAILABLE')
      } catch (e) {
        setDesktopError(String(e))
      }
    } else {
      await navigator.clipboard.writeText(id)
    }
  }
  return (
    <div className={css.page}>
      <header className={css.header}>
        <div>
          <span className={css.eyebrow}>{t('eyebrow')}</span>
          <h1>{t('heading')}</h1>
          <p>{t('description')}</p>
        </div>
        <Button
          variant="primary"
          disabled={state.busy}
          onClick={() => {
            void act('pairings', {})
          }}
        >
          {t('pair')}
        </Button>
      </header>
      {state.error && (
        <div role="alert" className={css.error}>
          {t('error')}: {state.error}
        </div>
      )}
      <RelayConnectionSection state={relay} act={relayAct} t={t} />
      <CompanionSetup state={state} reload={loadReleases} relayAddress={relay.status.phase === 'online' ? relay.status.endpoint : null} t={t} />
      {state.pairing && (
        <section className={css.pairing}>
          <div>
            <span>{t('code')}</span>
            <strong>{state.pairing.code}</strong>
            <small>
              {t('expires')}{' '}
              {new Date(state.pairing.expiresAt).toLocaleTimeString()}
            </small>
          </div>
          <Button
            onClick={() => {
              const code = state.pairing?.code
              if (!code) return
              void navigator.clipboard
                .writeText(code)
                .then(() =>{  setCopy(true) })
            }}
          >
            {t(copy ? 'copied' : 'copy')}
          </Button>
          <p>{t('network')}</p>
        </section>
      )}
      <div className={css.columns}>
        <section className={css.catalog}>
          <div className={css.sectionHead}>
            <h2>{t('title')}</h2>
            <Button
              size="sm"
              onClick={() => {
                void refresh()
              }}
            >
              {t('refresh')}
            </Button>
          </div>
          {state.loading && <p>{t('loading')}</p>}
          {!state.loading && !state.devices.length && (
            <div className={css.empty}>
              <DeviceIcon size={42} />
              <h3>{t('empty')}</h3>
              <p>{t('emptyHint')}</p>
            </div>
          )}
          {state.devices.map(d => (
            <button
              className={css.device}
              data-selected={device?.id === d.id}
              key={d.id}
              onClick={() => {
                setSelected(d.id)
                setWorkspace('')
              }}
            >
              <span className={css.deviceTop}>
                <DeviceIcon size={28} />
                <strong>{d.name}</strong>
                <small data-online={d.connected}>
                  {t(d.connected ? 'online' : 'offline')}
                </small>
              </span>
              <span>
                {d.platform} · {d.arch}
              </span>
              <small>
                {d.workspaces.map(w => w.name).join(' · ') ||
                  t('unavailable')}
              </small>
            </button>
          ))}
        </section>
        <section className={css.task}>
          <h2>{t('task')}</h2>
          <label>
            {t('select')}
            <select
              value={device?.id ?? ''}
              onChange={(e) => {
                setSelected(e.target.value)
                setWorkspace('')
              }}
              disabled={!device}
            >
              {state.devices.map(d => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('workspace')}
            <select
              value={chosenWorkspace?.id ?? ''}
              disabled={!chosenWorkspace}
              onChange={(e) =>{  setWorkspace(e.target.value) }}
            >
              {device?.workspaces.map(w => (
                <option key={w.id} value={w.id}>
                  {w.name} — {w.path}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t('kind')}
            <select
              value={kind}
              onChange={(e) =>{  setKind(e.target.value as JobKind) }}
            >
              {(['command', 'list', 'read', 'write', 'desktop'] as const).map(
                k => (
                  <option key={k} value={k}>
                    {t(k)}
                  </option>
                ),
              )}
            </select>
          </label>
          {kind === 'command' && (
            <label>
              {t('commandLabel')}
              <textarea
                value={command}
                onChange={(e) =>{  setCommand(e.target.value) }}
                rows={3}
              />
            </label>
          )}
          {['list', 'read', 'write'].includes(kind) && (
            <label>
              {t('path')}
              <Input value={path} onChange={(e) =>{  setPath(e.target.value) }} />
            </label>
          )}
          {kind === 'write' && (
            <label>
              {t('content')}
              <textarea
                rows={6}
                value={content}
                onChange={(e) =>{  setContent(e.target.value) }}
              />
            </label>
          )}
          <p className={css.hint}>
            {t(kind === 'desktop' ? 'desktopHint' : 'approval')}
          </p>
          <Button variant="primary" disabled={!ready} onClick={submit}>
            {t('submit')}
          </Button>
          {device && (
            <Button
              onClick={() => {
                if (window.confirm(t('revokeConfirm')))
                  void act('device-revoke', { deviceId: device.id })
              }}
              disabled={state.busy}
            >
              {t('revoke')}
            </Button>
          )}
        </section>
      </div>
      <section className={css.history}>
        <div className={css.sectionHead}>
          <h2>{t('jobs')}</h2>
          <span>{state.jobs.length}</span>
        </div>
        {!state.jobs.length && <p className={css.hint}>{t('noJobs')}</p>}
        {state.jobs
          .slice()
          .reverse()
          .map((job) => {
            const result =
              typeof job.result === 'object' && job.result !== null
                ? (job.result as Record<string, unknown>)
                : {}
            const id = typeof result.id === 'string' ? result.id : null
            return (
              <article key={job.id} className={css.job}>
                <div className={css.jobHead}>
                  <strong>
                    {t(job.kind)} ·{' '}
                    {state.devices.find(d => d.id === job.deviceId)?.name ??
                      job.deviceId}
                  </strong>
                  <span>{t(statusKeys[job.status] ?? 'unknown')}</span>
                  {!terminal.has(job.status) && (
                    <Button
                      size="sm"
                      disabled={job.cancelRequested}
                      onClick={() => {
                        void act('job-cancel', { jobId: job.id })
                      }}
                    >
                      {t(job.cancelRequested ? 'cancelRequested' : 'cancel')}
                    </Button>
                  )}
                </div>
                {job.output && <pre>{job.output}</pre>}
                {job.error && <p role="alert">{job.error}</p>}
                {job.result !== undefined && (
                  <pre>{JSON.stringify(job.result, null, 2)}</pre>
                )}
                {id && job.kind === 'desktop' && (
                  <Button
                    variant="outline"
                    onClick={() => {
                      void desktop(id)
                    }}
                  >
                    {t('openDesktop')} · {id}
                  </Button>
                )}
              </article>
            )
          })}
        {desktopError && <p role="alert">{desktopError}</p>}
      </section>
    </div>
  )
}
/** Decorative device glyph for the sidebar and empty catalog. */
export function DeviceIcon({ size = 20 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden="true"
    >
      <rect x="2.5" y="3.5" width="19" height="13" rx="2" />
      <path d="M8 21h8M12 17v4M8 10l2 2 5-5" />
    </svg>
  )
}
