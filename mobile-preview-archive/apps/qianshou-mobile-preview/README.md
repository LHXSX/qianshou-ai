# Qianshou mobile browser face

English | [中文](README.zh.md)

This browser face owns its window layer in `src/window/`: `startWindowEntry`, `MobileWorkspace`, `projectMobileWorkspace` and `materializeWindow`. Its DOM painter is the only rendering operation, and it is the painter every mount injects. The repository's existing UI layering is reused; no separate package named “UL” is introduced or claimed.

## Run the UI preview

From the repository root, run `pnpm exec vite --config apps/qianshou-mobile-preview/vite.config.ts` and open `http://127.0.0.1:4175/`. This is a loopback static UI development server, not an Agent application launcher. Supported Agent runtimes still launch through `dsh` profiles. No package installation or root configuration change is required.

The account proxy targets `https://qianshousuanli.com` by default. Set `QIANSHOU_PREVIEW_ACCOUNT_ORIGIN` before starting Vite to select an HTTPS origin or a loopback HTTP fixture. The page displays the selected origin in Connection settings. The proxy preserves account API paths and Bearer headers while removing ambient request cookies and response cookies. The built static output requires a deployment-owned account proxy; it does not contain a backend.

The AI development proxy translates Origin only when its original authority exactly matches the incoming loopback Host and browser fetch metadata is absent or same-origin. External or malformed origins remain unchanged, and production Host/Origin validation remains mandatory. This applies to the entire `/api/qianshou/ai/` prefix, including image and subscription requests.

## Account and conversations

Sign-in and TOTP use `createAccountClient`, followed by `/auth/me` identity verification. Credentials live only in memory and a page reload requires sign-in again. Only a non-secret browser device id is persisted in localStorage. PC command journals use `IndexedDbWindowJournalStore`; unavailable storage prevents startup. Closing the page disposes the controller and database. A back-forward cache restore reloads the disposed page.

The sidebar discovers Windows and Mac workers from the verified account. Only a successful lookup with no online PC displays “No remote host”. Signed-out, unavailable and failed lookups remain distinct. PC ownership and heartbeat checks come from `createAccountPcDirectory`; a reported PC URL alone never grants session access.

A trusted embedding application may supply `window.qianshouMobileHost` before the entry loads. Its typed `agent` port must reach an account-owned Qianshou Agent Session with the existing planner, tools and loop. Its `authorizePc` port must establish a server-authorized same-account PC transport. These ports must verify account ownership at their authority; a client-supplied account id is not authentication. The preview supplies neither port by default. Set `QIANSHOU_PREVIEW_AGENT_ORIGIN` to opt into the dedicated mobile-Agent HTTP adapter; the fixed same-origin proxy forwards only to the configured HTTPS or loopback origin and does not embed a platform key. The endpoint must be assembled with `dsh-host-mobile-agent-gateway` and an account-private runtime resolver. Missing deployment configuration remains unavailable. Configured ports are labeled “Configured”, not verified healthy.

The shared controller owns new conversations, history selection, original-text submission, per-conversation input retention, in-flight duplicate protection and PC delivery receipts. The DOM editor stays mounted through background refreshes to preserve IME composition. Local creative suggestions and request drafts only prepare text; the Agent makes the semantic and execution decisions. No raw LLM fallback, fake reply, phone compute contribution or automatic paid generation exists.

## Original-image understanding

The image-aware HTTP port advertises `supportsImageInput` and submits original PNG, JPEG, WebP or GIF bytes through `/api/qianshou/mobile-agent/v1/submit-images`. The shared workspace captures image bytes on its existing ordered admission chain, retains the original request id, and refuses PC or text-only adapters that cannot accept images. Limits are four files, 8 MiB each and 16 MiB combined; the authority performs full raster validation. A confirmed image rejection exposes a bounded failure code, while a network failure stays uncertain and is never retried automatically.

The browser helper distinguishes understanding and OCR from editing before the existing edit router. Uploads without an operation receive a short clarification; ordinary text never automatically includes a recent image. Explicit recent-image follow-ups require the same account and Session, a five-minute window and no more than two intervening user turns. Encoding preserves original bytes without canvas resizing or remote URL fetching and discards late reads after cancellation or binding changes. Page-level routing and production activation require their own acceptance evidence.

## Account settings and dictation

The full-page account surface puts sign-in below the conversation and offers four vertical choices: account, phone, WeChat and registration. Phone and WeChat remain visibly disabled until their services are connected; account sign-in, TOTP and registration use the existing Shanghai account client. The account dialog reads the real Shanghai profile, edits only changed display name, phone, country and language fields, and distinguishes service failure from an empty result. Username and email remain read-only. The login-device view preserves server status and IP fields, refuses revocation of the current session, and requires confirmation for other-session revocation. Password and TOTP changes clear the local session after Shanghai confirms that all sessions require reauthentication. Delayed writes cannot clear a later account. Avatar, notification preferences and trusted-device administration are not exposed.
The full-page account surface puts sign-in below the conversation and offers account, phone code, WeChat and registration choices. Phone code login and registration use Shanghai SMS endpoints; an acknowledged send shows the masked number, and login handles a TOTP challenge before verifying `/auth/me`. WeChat login remains unavailable until its server exchange is connected. The account dialog reads the real Shanghai profile, edits only changed display name, phone, country and language fields, and distinguishes service failure from an empty result. Username and email remain read-only. The login-device view preserves server status and IP fields, refuses revocation of the current session, and requires confirmation for other-session revocation. Password and TOTP changes clear the local session after Shanghai confirms that all sessions require reauthentication. Delayed writes cannot clear a later account. Avatar, notification preferences and trusted-device administration are not exposed.

The CNY recharge page reads Shanghai payment-channel availability before offering Alipay or WeChat Native. A WeChat order renders its server-issued QR code for scanning with another device; it does not claim same-phone payment. The page stores only an order recovery marker, never automatically creates a second order after an uncertain write, and treats only the account-owned order status `paid` as credited.

Voice input is opt-in. Local recognition requires browser support and an installed language; the page does not download a language or fall back to a browser service. Browser-service recognition requires explicit disclosure and consent before microphone activation. The real voice controller contributes final text only after recognition ends; hold-to-talk releases into the editable composer, and upward cancellation discards the recording. Automatic sending is an explicit preference and is off by default. Account or conversation changes, backgrounding, page disposal and hot-module disposal cancel recording and reject late results. Actual microphone quality and platform permissions need device acceptance.

The message view decorates the shared Session projection with speaker, time and user-triggered copy controls. It never interprets user text as HTML. The mounted editor grows with text, keeps IME composition through refreshes, and retains the shared send deduplication and account/Session separation.

## UI feature mapping

This is a mobile browser integration and interaction preview. It does not mount the complete `ui-slot-react` / `ui-renderer` plugin roster, replace the existing PC interface or complete the full UI plugin migration. The shared mobile frame projects conversation text, admission receipts and original Session tool-state summaries. Login restores account-owned history before creating a first conversation; a running Agent Session offers cancellation on its original binding.

| Surface | Current connection |
| --- | --- |
| Login, TOTP, account worker discovery | Shared account client; production user login still requires acceptance |
| Mobile conversation, PC targeting, input drafts | Shared window mobile controller and frame; real Agent and authorized PC transports must be supplied |
| Tool progress and cancellation | Shared Agent event projection and Session cancel; full tool cards remain deferred |
| Specialist/subagent tree, delivered files and attachments | Not connected |
| Text messages, profile, login-device management, registration and dictation | Shanghai account APIs, shared Session projection, QianshouVoice when supplied, and consented Web Speech recognition |
| Approval prompts, interactive questions and computer-view streams | Not connected |

## Verification and remaining work

Run `pnpm exec vitest run apps/qianshou-mobile-preview/tests` for DOM interaction, account/TOTP identity admission, registration, honest empty/error states, original-text Agent submission, duplicate clicks, stable device identity and a real Vite-to-local-HTTP cookie isolation check. Settings update checks only inspect official release metadata; they do not install or reload an update. Shanghai payment channels and subscription plans are read from their real APIs; prices are never invented locally, and the wallet link opens Shanghai without putting a token in the URL. The isolated test HTTP and model fixtures are not production services. The product-output snapshot is owner-local in the browser-face spec. These tests do not establish production login, actual cloud Agent execution, PC relay authorization or native mobile installation.

Run `pnpm exec tsc --noEmit -p apps/qianshou-mobile-preview/tsconfig.json` and `pnpm exec vite build --config apps/qianshou-mobile-preview/vite.config.ts --outDir /tmp/qianshou-mobile-preview-build`. The current source graph has pre-existing strict diagnostics in vendored Cordis, cosmokit and schemastery; scoped comparison distinguishes those from preview diagnostics. Cloud history now comes from server-owned Session persistence; production runtime provisioning, subscription-bound model credentials, authenticated PC relay assembly and deployment remain separate work.
