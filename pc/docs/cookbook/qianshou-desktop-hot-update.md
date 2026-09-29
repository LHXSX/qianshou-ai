# Desktop updates

English | [中文](qianshou-desktop-hot-update.zh.md)

The installed signed package fixes the product identity, target feed and `nightly`, `beta` or `stable` channel. The renderer cannot switch an update URL. The initial feed and every metadata, package or blockmap request must use `https://qianshousuanli.com`; cross-origin redirects, including `www`, and HTTPS downgrades are refused. Stable uses `latest[-mac].yml`, beta uses `beta[-mac].yml`, and the legacy nightly feed remains separate. Qianshou and DSH retain separate namespaces.

## Background preparation and safe restart

A packaged signed Qianshou release checks its fixed feed, then downloads the complete package once in the background when this device's automatic-update preference is enabled. Platform signature verification and checksum validation still determine readiness. A separate user restart action is required; no background download installs or interrupts a task. Qianshou currently disables differential downloads because the pinned library has a separate redirect path; published blockmaps remain available for a future verified protocol. Transfer failures do not automatically retry. A disabled device preference persists across sleep-setting changes and version restarts.

Before installation, the Host closes agent, job and media submission admission synchronously. Original GET polling and delivery remain available. Actual detached image/video work, unsettled submissions, provider attempts, pilot journal slots and the configured local Comfy queue prevent installation while busy or unknown. Agent and ordinary job interruption retains its existing explicit confirmation. The gates are released if preparation fails; an updater lock does not change owner grants, replay GPU submissions or delete receipts.

Old failed image history does not itself hold a permanent maintenance lock. A local Comfy idle observation is evidence about that local service only; it does not resolve a remote 5080/H3 unknown submission. Known delivery references recover through original GET requests and do not authorize another GPU POST. Original-path ImageTrial delivery recovery and the shared maintenance registry are merged in the current source and verified in the actual built startup.

## Signed beta bootstrap

The first sustainable internal release must be signed and installed once through a trusted installer. Set the file-owned packaging values `QIANSHOU_DESKTOP_DISTRIBUTION=internal-beta`, `QIANSHOU_DESKTOP_UPDATE_CHANNEL=beta`, and `DSH_DESKTOP_APP_ID=com.qianshou.desktop.internal`. Packaging still requires normal platform signing and Mac notarization; `DSH_DESKTOP_UNSIGNED=1` is refused for this distribution. Its package marker is `dshDesktopInternalBuild=false`.

The signed beta keeps the internal default `Qianshou PC Internal/dsh-home` and an existing explicit `DSH_HOME`. It never copies sessions into a new home. A previous test-only user-data override needs an explicit migration choice rather than an automatic guessed path. Keep the existing home unchanged and back it up before the initial installer. Do not install while an original task remains active. Version the bootstrap above the installed `0.1.6-alpha.2`; future beta releases must use the same bundle identity and trusted signer. Mac and Windows bootstrap/update acceptance are separate receipts.

The package fixes the target feed under `https://qianshousuanli.com/qianshou-desktop/feeds/{mac-arm64,mac-x64,win-x64}/`; beta filenames are `beta-mac.yml` and `beta.yml`. Publish immutable versioned binaries before an atomic, verified feed change. A feed is not release evidence until the public binary hash, installed signature, old-to-new update and retained home have been verified. No unsigned feed or substitute key is permitted.

## Required-update policy and evidence

New clients declare `X-Client-Update-Protocol: qianshou.desktop-update-policy.v1`. A required policy must match the exact package bundle ID, platform, architecture, channel, current version and sealed feed; its newer target version is validated. A stale or malformed response preserves a previous block. Policy cannot replace the embedded feed or bypass installation admission. Unconfigured release rules return no-force.

This work candidate has CPU/source evidence, not signed release evidence. The current Mac has zero valid Developer ID Application identities and no local `.env.macos` or `.env.windows` release configuration in this checkout. Actual Windows signing hardware remains unverified. Signed packages, signer continuity, first-install acceptance, public feeds and a real signed beta-to-beta update remain required before claiming automatic delivery.
