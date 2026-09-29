# Qianshou PC isolated development entry

English | [中文](README.zh.md)

This directory contains the first Qianshou PC development profile. `upstream.json` records the upstream version, commit and archive digest. Product design and architecture reports are in this task's outputs. This is not a distributable installer.

```sh
pnpm install --frozen-lockfile
pnpm run qianshou:build
pnpm run qianshou:web
pnpm run qianshou:doctor
```

Web data lives in `qianshou-pc-home` beside the source directory; desktop data uses the separate sibling `qianshou-pc-desktop-home`. The web port is 3180. Override these with `QIANSHOU_DSH_HOME` and `QIANSHOU_PC_PORT`. Configuration is copied on first launch and existing saved settings are preserved. Stop the foreground command to shut down that development instance.

The Guangzhou gateway URL is configured. Qianshou account signs in through the Shanghai authority and uses the separate managed reference `QIANSHOU_ACCOUNT_ACCESS_TOKEN`; only the explicit Use Qianshou models action changes the default route. The legacy manual reference `QIANSHOU_ACCESS_TOKEN` still accepts a normal user token, never a vendor master key or internal administrator key. Never commit or package `.credentials.yaml`, login tokens or runtime directories.

`qianshou:doctor` reports only allowlisted fields, preferring the managed account reference over the legacy manual reference. Append `-- --desktop` to check desktop data. It never refreshes or rewrites credentials; expired managed credentials direct the user back to account reconnect. Append `-- --inference` to issue a probe with at most 32 output tokens when valid credentials exist. A 200 model catalog response does not prove inference. Without a valid account identity, the result must report that sign-in is required; do not bypass gateway authentication.

The client defaults to a conservative 32k context, 4k output and text input. These development limits do not describe the server's maximum capabilities. Model IDs match the verified Guangzhou catalog, with Qianshou display names. Images, reasoning parameters, tool rounds, automatic account refresh and complete device workflows require separate validation.

`qianshou:desktop` uses the upstream Electron development launcher and requires the root build and `pnpm run build:desktop` first. It is not a packaging command. The Qianshou welcome screen, window title, menus and About name are integrated. The internal process name stays ASCII to avoid contaminating HTTP User-Agent headers. Installer icons, signing and update sources belong to the release phase.

After building the Qianshou profile, run its browser composition regression with `DSH_CLIENT_BUILD_PROFILE=qianshou QIANSHOU_TEST_BROWSER=chrome DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/qianshou-brand.e2e.ts`. This uses installed Google Chrome; omit the browser variable to use Playwright's bundled Chromium. Replay does not call a paid model.

New sessions default to CEO mode. The public picker offers CEO, Skill creation, and Call from the three corresponding presets. The home screen keeps its three large mode cards, while started conversations use the original header selector; selecting another mode opens a separate conversation and preserves the existing task. Calling mode keeps ordinary dialogue and offers image/video entries; requirements stay in the conversation without simple/professional forms. It mounts no local shell, filesystem, skill or compute-planning tools. Host media services own real quotes, confirmation, task state and results; buyers do not choose providers or install their models. CEO and skill creation retain their existing tools and authoring flows. The Agent tasks window reads actual child sessions, and live cloud delegation requires a valid Qianshou account.

CEO and the skill creator mount `present` for every user-requested file output, including outputs written by Bash, PowerShell, or code. Its persona requires a successful declaration after writing and before the final reply; prose and paths do not substitute for file cards. Safe images, GIFs, and videos can preview inline, while Office files open through the existing Sidebar preview. These declarations do not prove plugin installation, platform acceptance, or settlement. Preset edits apply to new mounts; already joined Sessions keep their previous generation until an explicit successful preset recomposition. A source update or window reload alone does not prove that an existing Session gained the tool.

CEO exposes observed local executors, the shared capability catalog and current Shanghai pool alongside Host-owned planning tools. The legacy hidden plugin creator sets `observationOnly: true` and cannot see planning or submission tools. These are separate observations: registration and a node declaration do not authorize an order or prove dispatch readiness. New paid tasks still require a Host quote and owner confirmation.

Qianshou instances disable client hot reload. Restart after a complete build so an open product window never adopts partially rebuilt plugin graphs.

The skill assistant follows local trial rejection facts instead of inferring a platform name restriction. A rejection with `platformContacted: false` has not reached Shanghai; the assistant repairs the reported package/runtime/schema issue from the current template. Existing media files and receipts remain valid local outputs, while a host-dependent renderer requires an appropriate execution ABI before publication or remote delivery.

The skill assistant calls `qianshou_skill_complete` after saving actual `SKILL.md` files, including instruction-only skills. The Host verifies the current file before displaying local trial and publication actions in the authoring conversation. A real portable trial also displays those actions; assistant prose does not declare a file saved, execution successful, platform approval or intake readiness.
