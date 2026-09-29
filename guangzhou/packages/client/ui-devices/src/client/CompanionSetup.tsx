import { useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DeviceState, CompanionRelease } from './controller.ts'
import { remoteCoordinatorAddress } from './invitation.ts'
import css from './DevicesPage.module.css'

type Props = PropsLocale<'qianshou.devices'> & { state: DeviceState; relayAddress?: string | null; reload: () => Promise<void> }
const platforms = ['darwin-arm64', 'win32-x64', 'linux-x64'] as const
const officialDownloadUrl = 'https://qianshousuanli.com/#/downloads#qianshou-agent'
/** Installable releases and a shareable guide, without copying a browser credential or loopback address. */
export function CompanionSetup({ state, relayAddress, reload, t }: Props) {
  const [address, setAddress] = useState(() => remoteCoordinatorAddress(window.location.origin) ?? '')
  const [target, setTarget] = useState<CompanionRelease['id']>('darwin-arm64')
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState(false)
  const normalized = remoteCoordinatorAddress(address)
  const selected = state.releases.find(release => release.id === target)
  const paired = state.pairing !== null && Date.parse(state.pairing.expiresAt) > Date.now()
  const platformKey = (id: CompanionRelease['id']) => id === 'darwin-arm64' ? 'macInstall' : id === 'win32-x64' ? 'windowsInstall' : 'linuxInstall'
  async function copyInvite() {
    setCopyError(false)
    if (!normalized || !state.pairing || !(Date.parse(state.pairing.expiresAt) > Date.now())) return
    const download = selected
      ? [`${t('archive')}: ${selected.filename}`, `${t('checksum')}: ${selected.sha256}`, t('downloadPrivate')]
      : [`${t('officialDownload')}: ${officialDownloadUrl}`, t('downloadOfficial')]
    const guide = [t('inviteTitle'), ...download,
      t(platformKey(target)), `${t('address')}: ${normalized}`, t('addressUnverified'),
      `${t('code')}: ${state.pairing.code}`, `${t('expires')}: ${new Date(state.pairing.expiresAt).toLocaleString()}`,
      t('inviteSteps'), t('invitePermissions'), t('inviteNoCredentials'), t(selected ? 'inviteTransfer' : 'inviteOfficial')].join('\n\n')
    try { await navigator.clipboard.writeText(guide); setCopied(true) }
    catch { setCopyError(true) }
  }
  return <section className={css.setup} aria-label={t('setupTitle')}>
    <div className={css.sectionHead}><div><h2>{t('setupTitle')}</h2><p>{t('setupHint')}</p></div>
      <Button size="sm" onClick={() => { void reload() }} disabled={state.releasesLoading}>{t('refresh')}</Button></div>
    <a className={css.download} href={officialDownloadUrl} target="_blank" rel="noopener noreferrer">{t('officialDownload')} ↗</a>
    {state.releasesLoading && <p>{t('releasesLoading')}</p>}
    {state.releasesError && <p role="alert">{t('releaseError')}: {state.releasesError}</p>}
    <div className={css.releases}>{platforms.map((id) => {
      const release = state.releases.find(item => item.id === id)
      const label = id === 'darwin-arm64' ? t('macPlatform') : id === 'win32-x64' ? t('windowsPlatform') : t('linuxPlatform')
      return <div className={css.release} key={id}>
        <h3>{label}</h3>
        <p>{t(platformKey(id))}</p>
        {release ? <><small>{release.version} · {(release.bytes / 1024 / 1024).toFixed(1)} {t('mebibytes')}</small>
          <small>{t(release.validation === 'local-mac-verified' ? 'macValidation' : 'portableValidation')}</small>
          <a className={css.download} href={release.href} download={release.filename}>{t('downloadArchive')}</a>
          <details><summary>{t('checksum')}</summary><code>{release.sha256}</code></details></>
          : <small>{t('releaseMissing')}</small>}
      </div>
    })}</div>
    <div className={css.invite}>
      <h3>{t('inviteTitle')}</h3>
      <p>{t(selected ? 'downloadPrivate' : 'downloadOfficial')}</p>
      <label>{t('address')}<Input value={address} placeholder={t('addressPlaceholder')} onChange={(e) => { setAddress(e.target.value); setCopied(false) }} /></label>
      {relayAddress && <Button size="sm" onClick={() => { setAddress(relayAddress); setCopied(false) }}>{t('relayUseAddress')}</Button>}
      <p>{t(normalized ? 'addressUnverified' : 'addressMissing')}</p>
      <label>{t('recipientPlatform')}<select value={target} onChange={(e) => { setTarget(e.target.value as CompanionRelease['id']); setCopied(false) }}>
        <option value="darwin-arm64">{t('macPlatform')}</option><option value="win32-x64">{t('windowsPlatform')}</option><option value="linux-x64">{t('linuxPlatform')}</option>
      </select></label>
      <Button onClick={() => { void copyInvite() }} disabled={!normalized || !paired}>{t(copied ? 'copied' : 'copyInvite')}</Button>
      {!paired && <p>{t('pairBeforeCopy')}</p>}
      {copyError && <p role="alert">{t('copyFailed')}</p>}
      <ol><li>{t(selected ? 'inviteTransfer' : 'inviteOfficial')}</li><li>{t('inviteSteps')}</li><li>{t('invitePermissions')}</li></ol>
    </div>
  </section>
}
