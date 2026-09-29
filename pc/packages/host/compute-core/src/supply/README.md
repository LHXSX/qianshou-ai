# Local supply reference

English | [中文](README.zh.md)

This directory owns local hardware observations, owner contribution policy, and a narrow adapter for audited Edge HTTP responses. The authenticated Host facade owns routing and background refresh. This library does not start an app or create an account, scheduler, execution lease, or ledger.

## Host integration

Use [SupplyController](controller.ts) through `querySupplySnapshot(signal?)`, `updateSupplyPolicy(completePolicy, signal?)`, and `close()`. [Public DTOs](types.ts) contain no tokens or account balances. The initial policy must explicitly set all fields; the first-use Host policy is off with no enabled services. `FileSupplyPolicyStore` receives a dedicated absolute file path under the Host-owned private data directory and uses the existing atomic-write utility with mode 0600. One Host instance owns a policy file; this controller serializes its own writes and does not coordinate independent processes.

The Host supplies real foreground-task/voice state and active-task count. The isolated contribution runner marks its exact live agent until disposal; foreground detection excludes that agent while the total active-task count still includes it. Session names cannot grant an exemption. A voice producer must return a boolean to establish activity. Unknown values block admission. The Host must refresh on activity changes and periodically while contribution is enabled; snapshots apply policy at observation time, and the controller creates no timer. `close()` aborts in-flight probing/publication and withdraws future offers. Withdrawal does not cancel an executing server lease.

All timeouts and response/process byte limits are explicit composition settings. Injected probe/transport ports must honor their AbortSignal. A policy update aborts older queued observations, withdraws before saving, then probes again. A failed save preserves the old policy. If saving succeeds but probing fails, the new policy remains saved: refresh after an error instead of assuming the update rolled back.

## Policy fields

`mode` is off, idle, or allowed. Both enabled modes prioritize foreground work and voice. Idle mode also requires measured idle seconds to meet the configured threshold. `maxConcurrency` is a safe integer at least 1; `minIdleSeconds` and `minFreeMemoryBytes` are nonnegative safe integers. The active-task count must be known and below the limit, and free memory must meet the threshold.

Enabled service IDs are unique strings matching letters, digits, underscore, dot, colon, or hyphen, with 1–256 characters and at most 128 entries. Owner rate settings reference enabled IDs uniquely; `amountMinor` is a nonnegative safe integer, `unit` is nonblank and at most 64 characters, and `currency` is three uppercase letters. These are owner preferences, not platform quotes, reservations, or published tariffs. No rate is invented when the owner has not provided one.

## Real observations

[Local probes](local-probe.ts) read OS CPU/memory facts and bounded GPU commands. Apple unified memory is not presented as dedicated GPU memory. Windows AdapterRAM can reflect a driver reporting limit. Linux GPU discovery currently covers NVIDIA through nvidia-smi; failure produces an explicit unknown/probe error, not a fabricated GPU. Idle observation uses the shared platform reader: macOS IOHIDSystem or Windows GetLastInputInfo. Invalid, empty or failed readings remain unknown. macOS was exercised on the development host; the native Windows probe test requires Windows and is skipped elsewhere.

Tool entries are verified only after their configured version command exits successfully. This proves the executable can start, not that every task or plugin capability passes an end-to-end self-test. Tool commands/arguments are trusted Host configuration, never caller-provided shell text. Ollama discovery accepts only an explicitly configured literal loopback origin and reads `/api/tags`. Installed models remain pending with `MODEL_INFERENCE_NOT_VERIFIED`; no inference, download, or cloud credential lookup occurs. A cloud model configured in the agent is not local installed supply.

The registry owns `advertisement_proof` for every semantic capability. Host and packaged-desktop name matchers permit only `software-probe` rows; this retains installed-tool evidence without proving an executor exists. Model inference requires `executor-self-test`, and GPU placement or resident-service bindings use `host-binding`. Package imports, version commands and model inventory cannot advertise local LLM generation, image captioning, speech transcription or ONNX inference as healthy. Their inventory remains visible. The probe projector omits these declarations and does not attach model metadata from unrelated inventory rows. A future inference adapter must bind its tested model and workflow to its own executor advertisement; this module does not create that evidence.

`eligibility.ready` only describes local admission. Without an authenticated advertisement port, `advertisingState` is `not-connected` and advertised IDs are empty. A real port maps verified local services to existing server capabilities and returns only acknowledged IDs. The adapter does not infer a capability version from a local tool version.

## Existing Edge HTTP contract

[EdgeSupplyApi](edge-api.ts) accepts HTTPS origins, or literal loopback HTTP for local services and SSH tunnels. It obtains a bearer token from a Host-owned provider, refuses redirects, bounds streamed responses, supports cancellation, and returns stable errors without upstream error text. `queryIdentity` reads `/api/v8/auth/me`; `queryCapabilities` reads `/api/v8/developer/task-types`; workload list/detail use `/api/v8/workloads` and `/api/v8/workloads/{id}`. List responses are direct arrays, detail responses direct objects. The task catalogue is `{ok, items, total}` and does not establish online availability or capability versions.

`queryQuote` uses the existing non-reserving `POST /api/v8/economy/quote` contract: task type, nonnegative workload, speed t24/t8/t2, and quality standard/double/high. Monetary strings retain decimal precision. `authority: estimate-only` is a local projection meaning the response does not reserve money or authorize submission. There is no enabled submit/cancel operation in this module.

The source audit is the Shanghai V8 source snapshot: `platform_v8/api/v8/developer.py:439`, `economy.py:528`, `protocol/http_schema.py:261`, and `api/v8/workloads.py`. Source inspection is not production acceptance. Real Worker assignment uses shard_id + authenticated worker_id + attempt starting at 0, with an opaque server-issued lease_token (`protocol/ws_schema.py:175`, `services/artifact_lease.py:33`). Its HMAC does not sign the agent's complete capability envelope. Do not map it to a locally minted lease or pretend that a client can verify the server HMAC without the server secret. Legacy cancel carries no attempt and requires an explicit reconciliation policy before safe integration.

## Validation and remaining integration

Run `node node_modules/typescript/bin/tsc -p packages/host/compute-core/tests/local-supply/tsconfig.json` and `node node_modules/vitest/vitest.mjs run packages/host/compute-core/tests/local-supply` from the repository root. Tests use isolated temporary policy files and loopback HTTP. The library requires the existing `@deepseek-ai/dsh-atomic-write` workspace dependency when assembled into compute-core; its source alias is resolved by the repository test/typecheck configuration.

Live integration requires an actual test account access-token provider, authenticated Worker registration/heartbeat, an isolated task namespace, and a rule that prevents production charges. A dedicated SQLite test environment is supported by the existing Edge bootstrap; it must not share production database, Redis, file storage, credentials, or sessions. Real cross-machine acceptance additionally needs the agent's own isolated planning session, authorized tools, actual model execution, server lease/result acceptance, and returned result bytes. A fixed runner, mocked LLM, passing adapter test, or isolated test environment does not establish production completion.
