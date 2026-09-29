---
description: "Qianshou plugin market for both PC clients, plus read-only community bundle discovery."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-plugin-catalog

English | [中文](README.zh.md)

## Summary

Serve the PC plugin market and discover exact-version community bundles. Market installation uses the existing plugin manager and records the capability the listing declares. Mac and Windows call the same remote.


## Table of Contents

- [Use this package](#doc-section-1)
- [Plugin market](#doc-section-2)
- [Reviewed release staging](#doc-section-3)
- [Install preflight](#doc-section-4)
- [My capabilities and publish visibility](#doc-section-5)
- [Understand the implementation](#doc-section-6)
- [Further Exploration](#doc-section-7)
- [Enabling the author's own skill](#doc-section-8)
- [Dedicated bounded file runtimes](#doc-section-9)
- [Model Experience](#doc-section-10)
- [Known Limitations and Deferred Work](#doc-section-11)
- [Dev Note](#dev-note)

<a id="doc-section-1"></a>
## Use this package

The Qianshou composition mounts this authenticated owner Remote as `qianshouPluginCatalog`. The plugin manager opens discovery explicitly; ordinary startup and local inventory reads do not query the registry. Search sends only the supplied keywords and offset, without account credentials, session content or workspace paths.

`search({ query, offset })` searches the `dsh-plugin` keyword and reads each candidate's exact-version manifest. It returns only matching name/version records with a nonempty `dsh.bundle.patch` declaration. Source, observation time, excluded candidates and unavailable manifests remain separate facts. A declaration does not prove compatibility, safety or successful execution. Installation belongs to the existing plugin manager, following its explicit confirmation and script-approval flow.

| Configuration | Default | Meaning |
| --- | --- | --- |
| `registryUrl` | `https://registry.npmjs.org/` | Operator-selected HTTPS source without credentials, query or fragment. Loopback HTTP is allowed for an owned test registry. |
| `timeoutMs` | `15000` | Deadline for a complete search or market API read. |
| `connection` | `shipped` | `shipped` reads the catalog built into this plugin. `api` reads `GET {apiBaseUrl}/plugins` and separately previews `GET /qianshou-market/releases` on the same origin. |
| `apiBaseUrl` | empty | HTTPS catalog base URL, or loopback HTTP for an owned test server. Required when `connection` is `api`. For Guangzhou use `https://<guangzhou-host>/qianshou-market/` so `GET {apiBaseUrl}/plugins` reaches the existing catalog route. |
| `ordinarySkillsApiOrigin` | `https://app.qianshousuanli.com` | Independent ordinary `SKILL.md` catalog/publication origin, validated as HTTPS or owned loopback HTTP. Empty explicitly disables its network operations. It does not change the existing adapter catalog's `connection` mode. |
| `installHome` | empty | Absolute directory for `qianshou/market-installed.json`. Empty uses `DSH_HOME`, or `~/.deepseek-harness` when that is unset. |
| `publisherKeys` | `{}` | Publisher id to base64 SPKI public key. A publisher absent here cannot pass the signature step of a listing fetched over the network. |
| `operatorKeys` | `{}` | Guangzhou reviewer id to base64 SPKI Ed25519 public key. Both distinct publisher and reviewer keys must be configured before a nonempty release preview is shown. |

<a id="doc-section-2"></a>
## Plugin market

`listings()`, `installed()`, `preflight({ id })`, `installListing({ id })` and `removeListing({ id })` are the market API both PC clients call. `connection` chooses the catalog source. The built-in Article row has an empty `packageSpec`: adding it saves a capability declaration only and downloads no plugin package. The built-in Image row remains unavailable.

Private local installation and public order admission are separate. An API listing with `installable: true` and an exact registry package version may enter install preflight for any capability; it must pass the trusted publisher signature and every device check before the package manager runs. Empty-package declarations remain restricted to the exact shipped Article identity. An installed package stays a private draft and cannot pass `publishCapability`, even when its Host bundle is active. This permits a real video or image package to be installed for local trials without claiming that Shanghai can dispatch work to it.

In API mode, `listings()` also returns a separate read-only `releases` preview with its endpoint source and `available`/`unavailable` status. Each row is bounded and rechecks the publisher and reviewer Ed25519 signatures, exact version identity, metadata fields and `verificationScope: opaque-archive-bytes`. A missing route, invalid response, duplicate row or unknown signer makes this preview unavailable without breaking `/plugins`. A release never enters `listings`, receives a package spec, registers a capability or turns on orders. The preview GET downloads no archive and exposes no signed digest to the client.

The separate `officialCsvSeedStatus()` Remote reads one exact signed `qianshou.csv-profile@1.0.0` release and current account presence without claiming a license. `ready` means that release matches the fixed Host executor; it does not establish buyer rights. After the owner confirms the displayed release and digest, `installOfficialCsvSeedForOwner()` obtains an account-bound free license, checks the dual signatures, exact package and packaged sample, then saves a private receipt. A repeated click rechecks the existing receipt and online license. Other releases retain preview-only status; this action never writes `market-installed.json` or enables Shanghai orders. Shipped mode, missing trust roots, absent login, or failed signed-release checks keep the action closed.

The separately bundled offline CSV seed is one concrete adapter for the generic private creator trial. When the private seed is genuinely installed, the Host registers its fixed operation contract and package digest with compute-core, refreshes that registration before expiry, and rechecks the installed bytes at every run. The creator's saved draft cannot alter the Host contract. The generic `plugin_draft_try_sample` produces actual bounded sample output and a private data-only archive; it does not grant an online buyer license, install another plugin, publish it or enable Shanghai orders. This adapter is an example of the common tool/model/workflow contract, not a required media backend.

The optional `privatePluginActivations()` Remote reads compute-core's live generic private activation ledger. It returns display names, exact archive and candidate digests, operation adapter identities, and either `active-private` or `unavailable-private`. Missing compute-core support is reported separately from an empty ledger. This inventory is never merged into public listings, purchases, `market-installed.json`, the publish wizard or Shanghai order supply.

`submitPrivatePluginDeclaration` and `listMyPrivatePluginSubmissions` are separate Host-only functions for the Guangzhou `POST /qianshou-market/submissions` Bearer route. `previewPrivatePluginSubmission` regenerates a sanitized `qianshou.declaration.v1` ZIP from the current private activation and sends only account, operation, permission, schema digests, package size and SHA-256 to the page. After owner confirmation, `submitPrivatePluginSubmission` regenerates the exact package and checks its digest and account before passing the in-memory ZIP to the submission function. The Host copies and hashes the ZIP, checks the account before and after token refresh and the request, uses the operator-configured HTTPS origin (loopback HTTP only for tests), and never sends browser cookies or follows redirects. It projects only bounded account-bound receipts; neither the ZIP, token nor full manifest returns through the Remote or to a model. A POST with no trustworthy response is `unknown`: do not submit again automatically; read `mine` under the same account and compare the package digest first. A `declaration-reviewed` receipt is accepted only when its operator signature and exact account, archive and manifest identity match the configured trust root; it proves metadata review only and cannot install, sell or dispatch the plugin. The client confirmation flow is wired in source but still needs a new desktop build, operator configuration and real-account acceptance.

<a id="doc-section-3"></a>
## Reviewed release staging

`stageReviewedPluginArchive` is a Host-only function, separate from the market Remote and UI. It fetches fresh dual-signed metadata, then requests exactly one release by `GET /qianshou-market/releases?artifact=<releaseId>` using an operator-supplied Bearer token. It requires an existing absolute private directory (`0700`), HTTPS or loopback HTTP, a fixed same-origin endpoint, no redirect, exact signed length and SHA-256 headers, and matching streamed bytes. A random exclusive `0600` `.qspkg` file remains there only after ZIP structure, entry paths, file types, sizes, decompression and CRC checks pass. Any failure or interruption removes the candidate. This test-only token is not a buyer license; without the server's optional token configuration, the artifact route remains closed.

Staging does not extract, inspect an executable manifest or Schema, install or activate code, write `market-installed.json`, publish a capability, or enable orders. The release remains `installable: false`. A separate reviewed package format, buyer authorization, device check, executor trial and owner consent are required before installation. Focused verification: `pnpm exec vitest run packages/host/qianshou-plugin-catalog/tests/reviewed-staging.spec.ts packages/host/qianshou-plugin-catalog/tests/release-preview.spec.ts` and `pnpm exec tsc -p packages/host/qianshou-plugin-catalog/tsconfig.json --noEmit`.

The Host-only private Comfy review accepts a staged archive with exactly `manifest.json` and `comfy/workflow-api.json`. It re-verifies both signatures, archive and entry hashes, signed operation/schema IDs, the bounded data-only graph, and the fixed executor version. Its immutable identity is `releaseId + operationId + packageSha256 + manifestSha256 + graphSha256 + executorVersion`. Activation additionally requires a trusted buyer-license verifier, fresh owner approval, live Comfy node/model checks, and an exact graph-bound executor loader. None is wired to the shipped market. A successful internal activation writes only a private `0600` receipt; `installable` and `dispatchable` stay false, and a receipt alone cannot restore runtime readiness after restart. Any failed gate leaves no new receipt and disposes a loaded executor.

`installListing` reads the listing from that source, then runs the install preflight. A nonempty `packageSpec` must name a fixed registry package version such as `@publisher/writer@1.2.3`; paths, URLs, tags and ranges cannot be added through the market. It uses `pluginManager.installBundle`, then saves a declaration only when the manager reports `applied` for the named bundle and its current profile reports the same installed version with an active Host row. A `restart-required`, cancelled or mismatched install writes no declaration. After restarting, the owner may retry; the signed listing and active bundle are checked again, and an already active exact version needs no second download. The file is `qianshou/market-installed.json` under the harness home. Only the exact, owner-published built-in `qianshou.article@1` declaration can join the next hello `provided_capabilities`; a package cannot borrow its `text.transform` runner merely by declaring the same capability id. `image.generate` stays visible and is refused, so Shanghai is not told this computer can draw.

`installed()` is the saved declaration ledger. `installationActivity()` separately rechecks the current Host manager, exact package identity and active row, returning `active`, `inactive` or `unknown` per saved record. Uninstalling a package does not silently delete the owner's draft: the ledger remains, while the market and My capabilities show that the package is inactive and do not count it as installed or publishable. An old saved Article row without `packageSpec` is recognized as the built-in declaration with its existing visibility intact; other legacy rows have unknown activity until rechecked or reinstalled. No unknown status is treated as active.

Community `search` does not register a capability. A successful package install saves only a local draft: Host loading does not establish an order executor, so package-backed rows are not advertisable and cannot pass `publishCapability` yet. A failed or pending package install does not write a declaration or enable order intake. A package left in the profile after a restart-required result remains manageable in the existing plugin manager. If hello refresh fails, the saved file is what the next connection sends.

`removeListing({ id })` removes exactly one saved built-in declaration, then asks the node to refresh its hello. It does not uninstall packages or change the owner's order policy. It refuses package-backed and API listings with `remove-unavailable`. The client reads `installed()` again before showing the result; removing an absent built-in declaration reports `removed: false`, and the owner can add it again after a fresh check.

<a id="doc-section-4"></a>
## Install preflight

`preflight({ id })` runs four checks in order — signature, dependencies, model, resources — and writes nothing. The run is fail-fast: the first failure stops it, later steps stay `not-checked`, and the report names the failing step with a stable reason code plus the facts the check observed (`name=zod min=4.0.0`, `free=… required=…`). A failed report offers `fix`, `recheck`, `cancel` and `rollback`.

For a built-in row with no plugin package, the catalog digest is still validated and a mismatch fails the check. A valid digest is displayed as `not-applicable` rather than a package signature pass. Empty package dependencies and an empty plugin model route are also `not-applicable`; declared requirements still run and can fail. Resource checks continue to report their actual outcome. A successful declaration check can therefore have three `not-applicable` steps and one passed resource step.

| Step | What the check reads | Reason codes |
| --- | --- | --- |
| `signature` | A shipped row: this catalog's own SHA-256 over the row's declaration fields. An API row: a publisher's detached Ed25519 signature over those same bytes, verified against `publisherKeys`. | `SIGNATURE_MISSING`, `SIGNATURE_DIGEST_MISMATCH`, `SIGNATURE_PUBLISHER_REQUIRED`, `SIGNATURE_PUBLISHER_UNKNOWN`, `SIGNATURE_INVALID`, `SIGNATURE_MALFORMED` |
| `dependencies` | Every declared module resolves on this computer and meets its `minimumVersion`. | `DEPENDENCY_MISSING`, `DEPENDENCY_VERSION_LOW` |
| `model` | The declared model route is registered in this process's LLM service, and the listing declares no route when it needs none. | `MODEL_PROVIDER_MISSING`, `MODEL_ROUTE_MISSING` |
| `resources` | Free bytes at the declaration directory and the physical memory of this computer. | `RESOURCE_DISK_LOW`, `RESOURCE_MEMORY_LOW` |

`installListing` runs the same four checks inside its write chain and refuses with `preflight-failed` unless every step passes, so a declaration is written only for a listing this computer checked successfully. The browser runs `preflight` first to show the checks, and a failure at install time is reported as the same report.

`repairListing({ id })` attempts the repair for the failing step and answers with `repaired`, `unchanged` or `unavailable` plus a fresh report: the signature step re-reads the listing from its source; dependencies install the missing modules through `pluginManager.installBundle`; model and resources answer `owner-model-route` and `owner-free-space`, because only the owner can register a route or free disk space. `rollbackListing({ id })` removes the packages that repair installed and restores the declaration file to the bytes captured when that install attempt started; a run that changed nothing answers `declaration-unchanged`, and one whose attempt started with no declaration file answers `no-previous-declaration` and leaves the file it wrote, because this market does not delete a declaration to undo an install. Cancel is the client dropping the report and changes nothing on this computer.

Shipped rows carry their digests as constants and `tests/preflight.spec.ts` recomputes them, so editing a shipped row without recording its new digest fails that test instead of shipping a row this computer would refuse to install. `image.generate` is refused by installability before any check runs.

<a id="doc-section-5"></a>
## My capabilities and publish visibility

`myCapabilities()` also reads one reviewed Mac private video runtime without writing a market declaration: it reports `privateLocalCapabilities` only when the exact installed archive, sidecars, active Loader row, installed files, Host tools and matching executor all verify on this call. The entry offers an owner-approved local trial only; uninstalling or failed verification removes it from this live view. It never enters `market-installed.json`, the publish wizard or the node hello, and it cannot take Shanghai orders.

`myCapabilities()` reads what this computer saved and contacts no invite endpoint. Every saved row carries a `visibility`:

| Visibility | Who sees the declaration | Reaches the hello |
| --- | --- | --- |
| `draft` | This computer only. A row whose field is absent or unrecognized reads as this. | No |
| `private` | This computer only. | No |
| `invite` | This computer only, together with the account ids saved beside it. | No |
| `public` | The declaration this computer published. | Yes, and only when this node can accept the capability |

`installListing` saves `draft` and invites nobody. The three steps before publish — capability identity, run preflight and order policy — save through `saveCapabilityDraft({ id, inviteAccountIds })`, which writes `draft` whatever the page asked for and stores the invite account ids on this computer alone. No invite request leaves this process. `publishCapability({ id, visibility, confirmPublic })` is the last step for the built-in declaration only: `public` is refused with `publish-unconfirmed` unless `confirmPublic` is `true`, a capability this computer cannot accept or a package-backed row is refused with `not-advertisable`, and the four install checks run again for a built-in row. A draft saved over a published row asks the node for a fresh hello, which is what withdraws it.

`visibility` is not part of a listing's declaration bytes, so it changes neither a shipped row's digest nor a publisher signature.

The three numbers the page shows are `unknown` with a reason, never `0`: this service measures no success rate, no duration and no accelerator memory, and `0` would be a measured claim nobody measured. Whether the node can accept the capability, the free bytes at the declaration directory and the physical memory are measured here. The order-policy step reads the saved owner policy from a loaded `computeCore` service and reports it as unknown when none is loaded.

`setOwnerSupplyEnabled({ enabled })` is the separate owner master switch. For a matching owner/node it preserves every saved per-service grant, rate and resource limit, saving `idle` when enabled and `off` when disabled through the Host-only atomic `computeCore.updateOwnerSupply` command. First use remains off. Disabling also immediately applies the node's in-memory intake veto; enabling removes that veto only after the Host policy write succeeds. The contributor mirrors the saved policy on each tick and the Edge session sends the resulting `running` or `paused` in its next heartbeat. A saved `idle` policy is not evidence that Shanghai acknowledged a heartbeat or that any executor is available. With no enabled service IDs the UI explicitly says there is no service authorized to take work.

The master and `node` service switches never write the public effective policy. The compute controller restores the exact owner/node in its queue, merges only the requested fields into committed policy, and rechecks identity after withdrawal. Same-owner/node writes preserve other grants, rates and limits; revoking `node` removes only its grant and rate. Explicit first-use, legacy or changed-owner/node commands start with empty grants and rates, preserve resource limits, and authorize only this action. A service-only action leaves the master off. Unknown identity or a missing atomic Host port rejects without a complete-policy fallback. Enabling still requires the fresh local probe and runnable executor check. Author activation carries its original account/worker assertion through the same command.

`orderSources()` is separate from market declarations. It reads owner-installed, removable profile bundles, the two user skill roots and the built-in word-frequency executor; shipped Cordis bundles do not appear as user installations. Inventory never runs unselected plugins. A SKILL.md file, the old character counter and ordinary bundles remain visible but cannot receive a grant without a `word_count` task adapter. Package origin and title do not establish eligibility. An adapted bundle first passes static manifest, installed-tree digest and Loader checks; `selectOrderSource({ sourceId })` runs a word-frequency output probe and chooses the executor. A later `setLocalServiceEnabled({ serviceId: 'node', enabled: true })` probes again before saving the service grant. The old grant must be revoked and in-flight tasks drained before a switch; selection turns on neither the master switch nor the service grant. Only inline `word_count` is supported today. File, image and video tasks lack a verified direct-to-node resource input and output adapter. A market declaration is neither a loaded package nor proof of purchase entitlement. `nodeRates` are owner-local preferences, not a Shanghai quote. Signed pricing, buyer entitlement and a real Shanghai acceptance receipt still require end-to-end evidence; local isolated tests do not establish paid dispatch.

The buyer-side order product reader accepts signed six-file `qianshou.bar-chart-package.v4` inventories and sorted `qianshou.source-package.v1` inventories with 4–128 regular source files. Both require a trusted issuer receipt bound to the author manifest, exact archive version and digests. The ZIP reader refuses unexpected members, links, compression, path traversal and changed bytes. Verified files remain in a private quarantine; source staging does not install dependencies, activate a plugin, expose it in chat or report a device installation to Shanghai.

`installOrderAdapterProductLocally` copies a reviewed v5 source package from quarantine into a private buyer runtime, rechecks each signed file and the product's execution identity, and runs its actual examples inside the macOS sandbox. V5 is self-contained: its fixed empty lockfile installs no third-party dependencies. A successful local probe records the runtime digest but leaves `deviceInstalled` and `orderAvailable` false. Shanghai accepts installation only from an independent operations-trusted signer, which the desktop does not hold; local probing never opens the owner's supply switch or claims settlement. V4 media goods remain outside this generic buyer installer.

Author templates carry Chinese skill names and field titles. A reviewed `inputSchema` may describe `application/json` with a bounded `contentSchema`: a closed, nonempty object with nested objects, arrays, strings, finite numbers, integers, booleans and null. The supported keywords and resource limits match Shanghai’s reviewed JSON validator. The declaration remains part of the existing task-definition and source digests. Sample admission and local execution validate the exact input against it before the executable runs; quote and submission validate the same reviewed declaration on Shanghai. Sources without `contentSchema` retain their existing execution rules.

Publisher identities use private 0700/0600 directories and Ed25519 keys on POSIX. Windows instead stores account-bound DPAPI ciphertext in `owner-<id>.dpapi.json`, protected by the current Windows user and platform-account entropy; Windows file modes cannot enforce POSIX ownership permissions. Only fixed system PowerShell code performs protection, with bounded stdin/stdout and no private key in arguments or environment. Corrupt records, other accounts, directory junctions and unavailable DPAPI fail closed. Plaintext PEM files are never a Windows fallback. Native Windows tests must establish real protection, signing, concurrent key stability and junction rejection; Mac tests do not establish those results. Signing the author declaration still grants no package, review, pricing or execution receipt.

V1 native H3 authoring is a separate metadata binding to the audited Windows runner. The V1 source reader retains exactly four canonical adapter files under `qianshou.native-binding-package.v1`; it cannot include executable source, models, private configuration or dependencies. The public input is a Chinese plain-text video description, fixed five seconds and an optional seed. Runtime pins, the private configuration digest, actual execution recipe SHA and model-byte SHA form the immutable binding; a workflow UI file or model stat cannot replace them. `verifiedNativeH3OrderBindings(workerId)` is Host-only and accepts current account/acknowledged-worker publications only after the separately enrolled `orderNativeH3AttestorKeys` verify a dedicated device-purpose proof. It preserves the distinction between the authored task-definition file SHA and Shanghai's locked contract SHA. With missing identity, purpose keys, protocol routes or independent evidence, no published native provider is advertised. Source/unit checks do not prove Windows execution, production admission or Mac delivery.

After locked source upload, explicit author publication queues two signed independent sample challenges on the owner's current device. The Node uploads actual MP4 bytes directly to the signed immutable object-store lease, and reports distinct device signatures; local trial, deposited review evidence and administrator approval remain separate states. `orderNativeH3ChallengeKeys`, `orderNativeH3AttestorKeys` and `orderNativeH3UploadIssuanceKeys` are independent purpose roots. Missing roots may be discovered only through the dedicated authenticated `native-proof-trust` route at the configured HTTPS control origin, never from an embedded publication or upload key. Approved unchanged bindings renew through a 120-second signed presence challenge and actual current-connection witness, producing a maximum 300-second device proof without another GPU run. Source, profile, account, token, connection, actual recipe and model identities are rechecked; a changed tuple needs a new independent review. Machine-specific paths stay in private owner configuration and are not included in the market archive.

Optional task-definition `title` (1–80 characters) and `description` (1–500 characters) describe the executable service and are included in the canonical definition and source digest. Publication forms use these defaults; authors' explicit edits take priority. Without them, the form asks for service details instead of copying the conversational SKILL description.

<a id="doc-section-6"></a>
### V2 native authoring and per-device activation

The explicit native authoring tool now requires the independently verified V2 owner provider. [Source construction](src/native-h3-order-source.ts) emits five authoring files: `SKILL.md` and four canonical JSON inventory files. The V2 task type depends on the current author and public logical digest. Its exact thirteen-field declaration and six-field public binding contain no private path or owner digest; `package_digest` is explicitly the logical binding digest. V1 source parsing, inventory and published identity remain supported without changing their meaning.

[Device configuration enrollment](src/native-h3-device-config-http.ts) reads the current head, signs the independently issued twenty-one-field CAS challenge, witnesses it on the actual ACK socket and registers the exact proposed revision. Registration alone grants no supply. Explicit author publication or device enable can run the first two independent samples only under the existing authoritative missing-device condition; unknown, pending and transport failures do not trigger rendering or restart. Cache reuse also requires the same device, connection, private digest and authoritative revision.

V2 pending/binding reads request `binding_version=2`; default reads remain V1. The exact twenty-two-field feed includes the server's current device key and connection. Inventory uses GET-only reads and never enrolls configuration, renews presence, selects a runtime, executes samples or grants intake. Explicit activation rechecks source, fresh local identity, current head, proof and same-socket adapter ACK before the existing owner grant. The ordinary V2 lease remains separate from buyer input and local source metadata. The H3 configuration wizard, new Windows GPU trial and production V2 admission are not established by these source/fixture checks.

## Understand the implementation

`registry.ts` validates the external request and metadata. Each page contains at most twelve candidates, with four concurrent manifest reads and a 1 MiB response bound. The service admits at most two searches, refuses redirects and cancels and awaits owned fetches when disposed. No search cache, package code, installation process or account service is involved.

The browser must retain query ownership while a search is pending and must not present failed refreshes as a fresh empty market. Public text is displayed as text; publisher identity and licensing remain registry claims.

<a id="doc-section-7"></a>
## Further Exploration

- [Plugin manager](../../boot/plugin-manager/README.md) owns package mutations and rollback.
- [Plugin manager UI](../../client/ui-plugin-manager/README.md) owns the market page. Get calls this package; it does not open a second installer.

<a id="doc-section-8"></a>
## Enabling the author's own skill

`activateAuthorOrderSkill({ source, name })` resolves a controlled local skill to the current account's approved, archived and published product. It rechecks the product's exact publication, task and source digest before requesting the dedicated zero-price author entitlement. Existing ownership, including its original price and unknown or refunded status, is retained. Unknown or refunded ownership never starts installation or creates a second entitlement.

Authors use the normal trusted archive, reviewed local examples, independent challenge, authenticated worker observation and committed device receipt. An exact already-installed runtime is recovered without another challenge. Only verified bytes and the current device receipt allow saving the existing master switch and `node` grant; a matching owner/node retains other grants and resource limits. Source changes, missing proof, expired login or report failures remain failures. The legacy approval-only author runtime APIs announce nothing. Restart recovery reads server-held ownership and local bytes instead of trusting a renderer marker. The dedicated file path below requires its own installed proof. Authorization does not promise orders or income.

An author activation captures its original account and acknowledged worker. The Host-only bound supply write checks both inside the serialized persistence operation, rechecks the owner/node after withdrawal, and writes only the original owner binding. Switching accounts or workers before commit rejects the operation without saving the new account's master switch or `node` grant. The ordinary owner toggle request is unchanged.

<a id="doc-section-9"></a>

Fixed native H3 authors use the same explicit enable action but receive `runtimeKind: 'native-h3'`, `deviceVerified: true` and the actual configuration `runtimeDigest`; no product id, purchase entitlement or installed program is invented. A current signed device proof and a fresh fixed-provider identity check precede the normal bound master/node grant. Only an authenticated presence response with the exact `NATIVE_H3_DEVICE_SAMPLE_MISSING` code for a device with no review history permits that explicit action to queue and await its first two independent samples. Network failures, existing pending/unknown runs and ordinary conflicts never authorize GPU work or restart an old nonce. Refresh and `orderSources()` only read source-bound native identity, current physical connection/proof and saved owner policy; they never select an executor, render a sample or write a grant. A source, account, token, profile, connection or proof change prevents a successful activation receipt. These orchestration and simulated-provider tests do not establish a new Windows GPU result or Mac delivery.

Native activation synchronizes verified claims through `refreshNativeH3OrderAdapters()` on the current ACK connection. It does not use the generic purchased-adapter reconnect, which would invalidate the connection-bound proof. The final activation receipt requires the server's exact same-socket claim acknowledgment followed by fresh source, provider and device proof checks. Inventory uses a separate GET-only issued-proof reader; it cannot enroll or renew a nonce.

## Dedicated bounded file runtimes

The candidate `qianshou.quickjs-files.v1` path accepts one declared attachment and one output, each bounded to 16 KiB, in the pinned QuickJS WASM. `activatePurchasedOrderAdapter` selects the file path only from the installed reviewed v3 declaration. Its independently signed `/file/` challenge binds the account, acknowledged device, immutable archive, reviewed source/runtime, contract, complete file schema and input/output byte manifests; the authenticated worker WS must witness the execution before Shanghai commits the receipt. Local examples alone never produce a file Hello.

`verifiedPurchasedFileOrderRuntimes` rechecks current server installation and all local bytes before each Hello; the persisted dedicated proof is read without following symlinks. File signing roots come only from `orderFileAttestorKeys`, and reuse of `orderNonFilePurposeKeys` is rejected. `orderArchiveHostname`, `orderFileAttestorHostname` and `orderFileStorageHostname` must be precise hosts outside the core host. Missing configuration leaves this provider empty. The ordinary inline provider continues to exclude file declarations.

Execution uses a frozen `file_contract` plus connection-owned lease ports. Shanghai receives metadata only; attachment reads and result PUTs go directly to pinned versioned storage. The guest receives declared bytes and logical input only. Results remain subject to the independent file verifier and settlement. This slice is source-tested; the running native client was not rebuilt or restarted, purpose roots are not enrolled, and a production file device/task receipt and ordinary authorized file delivery are still pending.

`orderSources()` reports an exact local source’s approval and marketplace listing separately in `authorPublication`. A missing listing, pending listing review, rejected listing, and unavailable seller ledger do not change an approved publication into a pending one. The one-time `salePriceYuan` comes only from an explicit publication or matching seller product; the per-task execution price never fills it. Read failures mark the inventory incomplete. Account changes discard author approval and device observations from that read. A changed acknowledged worker invalidates device eligibility while preserving the same account’s publication approval.

Author eligibility includes the existing verified inline and file runtime readers, matched to the current published product, task and local artifact. Reading the inventory never installs, self-tests, claims an entitlement, changes an approval, or grants intake. The explicit author activation operation retains its signed installation, independent device verification and owner authorization requirements.

Local author trials preserve failure status and return bounded validation facts: the source check, reason, package location, repair guidance, and `platformContacted: false`. A local rejection does not establish a platform name restriction. Generic skill names and machine task identifiers need no local preregistration when their package satisfies the ABI. The embedded template declares the actual runtime capabilities; a QuickJS package excludes installed dependency trees and the legacy Node entry. A Node/Sharp/Pillow/Swift media renderer requires its own execution ABI, and an animation plan or local path cannot substitute for GIF/MP4 delivery.

The local trial form read uses the controlled source/name inventory and returns the source digest plus bounded input-schema JSON, without running, normalizing or contacting a platform. An explicit form-bound trial re-reads that source and rejects a changed digest before execution. File contracts report their missing local file-trial port instead of running the inline executor.

After writing a skill, `qianshou_skill_complete` re-reads the current controlled local inventory and actual regular file, records its SHA-256, and emits saved-skill action metadata. A portable runtime declaration enables a trial entry without claiming execution success. Successful `qianshou_try_local_skill` metadata instead records the actual executor artifact digest. Both receipts keep local file, local execution, platform review, listing and order permission distinct; missing files and failed trials produce no success action receipt.

<a id="doc-section-10"></a>

The Chinese H3 setup remotes delegate to the current contributor: read/inspect, save, explicit trial start, status and local draft creation. Their shared DTOs use a platform-neutral type project; the browser receives no private configuration path or credential. Only finite setup diagnostics cross the remote boundary. Draft creation rechecks the authenticated author, opaque setup context, revision and actual public/private provider identity throughout the importer transaction. Cordis service comparisons use stable original service identities rather than newly created context proxies.

The Host generates the exact five-file native template. Chinese display text stays in `SKILL.md`; the immutable task definition and author-plus-logical-binding task type remain independent of local presentation. The actual source reader validates the written four-file native declaration before returning local success. This path neither submits a publication nor grants supply, and canonical runtimes without approved fixed pins remain unsupported.

## Model Experience

### Owner-directed discovery

#### What the model sees

The `qianshouPluginCatalog.search` Remote serves the owner's plugin page. It registers no model tools, prompt sections or conversation messages. Selecting a search result only opens installation review; a subsequently installed plugin owns its own model-facing behavior.

#### Token effect

Registry queries and metadata validation make no model requests and add no prompt tokens.

#### KV Cache effect

Discovery does not rewrite conversation history or change the model request prefix. Installed plugins may change available tools through the existing plugin lifecycle.

## Known Limitations and Deferred Work

<a id="doc-section-11"></a>

- Private submission review states are trusted only after the pinned Guangzhou operator signature verifies against the exact account and package. This includes rejected reviews; an unsigned or altered rejection is unavailable rather than displayed as fact.
- The source is a public community directory, not a Qianshou-reviewed marketplace. Git-only packages and packages without the discovery keyword may not appear.
- Only the returned page is checked; the registry total is not a verified installable-plugin count. Metadata checks do not execute plugin functions or establish permission isolation.
- Search follows the registry's relevance semantics, which may return related candidates instead of enforcing an exact keyword filter. Filtering one page locally cannot establish a global absence of matches.
- The market declares only `text.transform` as healthy. Other listed capabilities stay visible and are not sent on hello until this node can accept them.
- `myCapabilities()` reports accelerator memory as unknown: this package runs no GPU probe. The supply probe in [compute-core](../compute-core/README.md) owns that measurement, and its result is not read here.
- The install preflight proves only what its four checks observed at that moment: a module resolves, a model route is registered, the space and memory floors are met, and a signature matches the configured key. It does not audit package code, permissions or post-install behavior.
- Registry installation still uses the profile's package-manager configuration and may be refused by the package manager's own preflight, which is separate from these four checks.

<a id="dev-note"></a>
### Dev Note

None.

Author publication management uses exact authenticated records and server revisions for withdraw, delist, archive and restore. Lifecycle permissions come from Shanghai; cloud history without a matching local source is visible only in the explicit management read and never grants a local executor. Archive preserves contracts, entitlements and ledger history; restore only returns the record to the list.

`conversationPlugins()` reads fully active user-installed removable bundles and Loader rows locally, preferring the display name read by the package manager. It does not read publications, products, entitlements or device records, place tasks or grant intake. Conversation selection rereads this inventory; `orderSources()` remains the complete intake eligibility check and uses the same display name.

The authoring template and local rejection instructions distinguish machine field names from form labels: `properties` and `required` use ASCII identifiers such as `text` and `result`, while supported `title` values can display Chinese labels. The executor and samples use those same machine names. Unsupported field keywords, including `description`, remain rejected; a Chinese request does not widen JSON validation or require the user to write JSON.

Legacy market input presentation reads source only through the existing account-authorized signed product manifest and pinned COS object verifier. Exact product, task, version and artifact identity must match. For an inline JSON definition without field schema, at least two matching flat samples can expose one varying text control and fixed primitive values; complex or ambiguous samples are unavailable. This is display metadata, not a replacement signed schema or a guarantee about arbitrary parameter values. The original JSON size validation and explicit quote confirmation remain required. The read holds archive bytes only in PC memory and never installs, executes or restores a skill.

## Explicit canonical H3 catalog branch

The native authoring template reads the current configured provider, which selects its exact ABI before preparation. Canonical software uses `qianshou.order-runtime.native-h3.canonical.v1` and its separately pinned API/runner identity. A failed canonical preparation never falls back to the Python V2 runner. The four-file source inventory, public six-field binding, V2 configuration revision, signed evidence purposes and lease contract remain unchanged. Unknown ABI or pins are rejected.

Signed binding feeds, sample orchestration and inventory recovery dispatch by the immutable declaration ABI. Inventory needs that provider's fresh identity, current connection-bound proof and actual adapter ACK; it does not require a fabricated V1 identity for a V2 or canonical installation. The canonical setup Remote reads the current owner and profile, inspects a local PNG and loopback service, saves a separate revision, and starts two explicitly requested local trials. Only two fresh, independently verified trials allow a local draft through the shared importer. Reads do not start GPU work or grant device enrollment, review, market publication or supply. Windows GPU execution and Mac delivery still require current device receipts.

## Ordinary SKILL.md publication

The owner Remote exposes `ordinarySkillChoices`, `ordinarySkillCatalog`, `ordinarySkillMine` and `submitOrdinarySkill`. `ordinarySkillsApiOrigin` independently defaults to `https://app.qianshousuanli.com`; explicit empty configuration closes network access, while the adapter catalog can retain `connection: shipped`. Direct constructor callers that omit this new field retain an existing API origin, or use the ordinary official origin when no API is configured. The ordinary route remains fixed at `/qianshou-market/skills`. Publication selects an existing user-root skill identity from the local inventory, with explicit name, summary and CNY decimal price; an empty price never becomes zero. No adapter declaration or script execution is required. The Host captures one regular-file-only ZIP snapshot with a root `SKILL.md`, at most 128 files, 512 directory entries, 512 KiB per file and 2 MiB overall. Hidden files, credentials and secret/key files are excluded; symlinks, hardlinks, path collisions and changes during capture refuse publication. The original owner, UUID, text, price and hashes are saved privately before one authenticated POST to the configured Guangzhou `/qianshou-market/skills` origin. Archives, local paths and account credentials never enter the renderer or saved intent.

Uncertain responses, duplicate calls and Loader restart only query the original owner-scoped `mine` request UUID. A missing server row does not authorize another submit. Guangzhou staff pull and manually test the immutable package before listing; published/rejected receipts are checked against pinned operator Ed25519 keys and bind package hashes, text and price. The ordinary catalog reads actual server listings and authoritative official/user author classification. Purchase and installation remain explicitly unavailable until a later consumption ledger is implemented. These Loader/HTTP/UI and real Guangzhou-source interoperability fixtures establish candidate behavior, not deployed staff review, payments, native Windows acceptance or release.
