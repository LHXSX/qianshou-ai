/**
 * The dispatcher's `WorkerCapabilities` field set, pinned as a local fixture.
 *
 * ## Why this fixture exists
 *
 * The platform's `_worker_capabilities` (`storage/repo.py:1811-1814`) keeps **only** the keys its
 * `WorkerCapabilities` dataclass declares and **silently drops everything else** — no error, no log,
 * registration still succeeds. A single misspelled key therefore loses a whole capability block
 * while every test stays green. That is exactly how `native_bins` (client) versus `native_binaries`
 * (platform) survived for two months; see `docs/dev-plan/跨边界一致性审计.md` §1.4 and §1.9.
 *
 * ## Provenance (read this before editing)
 *
 * **This is a fixture, not a live read.** The platform source is not in this repository and no SSH
 * connection is available from the environment this fixture was written in, so the field set could
 * not be read from `core/worker.py` directly. It is instead derived from a **recorded observation of
 * a real platform response**, which is the stronger evidence of the two for this purpose: the
 * captured payload is the platform's own whitelist *output*, so every key in it is by construction a
 * field the dataclass declares.
 *
 * - **Source**: `docs/dev-plan/evidence/双机验收/AT-08.json`, `observed.steps[1].capabilities` —
 *   a real worker row returned by the production dispatcher while `evidence/双机验收/AT-08.md`
 *   logged `"平台 Worker 行"` for `qianshou-at-nodeB`.
 * - **Date recorded**: `2026-09-17T05:36:48.802Z` (the capture's own `recordedAt`).
 * - **Field count observed**: 47.
 *
 * ## What this fixture does and does not prove
 *
 * **Proves** (no false negatives): a published key that is absent here is rejected by the platform
 * whitelist. All three known divergences fail this test — `native_bins` and `uptime_sec` are absent,
 * and `native_binaries` is present.
 *
 * **Does not prove**: that the set is *complete*. A dataclass field the captured row did not happen
 * to carry (for example a tier field only populated by another client generation) would be missing
 * here, so this fixture could in principle reject a key the platform would in fact keep. That is a
 * false negative, which is the safe direction, and it is why the superset assertion below is written
 * as ⊆ rather than equality: the test is a divergence alarm, not a claim to know the whole dataclass.
 *
 * **Corroborated by** (not used to build the set): `services/workers/heartbeat.py:78,109` and
 * `engine/planner.py:925` both read `native_binaries`, and the audit's full-repository grep for
 * `native_bins` in the platform's Python returns zero hits.
 *
 * ## Refreshing it
 *
 * Re-capture a worker row from the dispatcher and replace the array below together with the date and
 * the count. A field list copied from memory or inferred from the client is worth less than nothing
 * here: it would lock in the very drift this fixture exists to catch.
 */

/** Recorded date of the capture the field list below comes from. */
export const PLATFORM_CAPABILITY_FIXTURE_RECORDED_AT = '2026-09-17T05:36:48.802Z'

/** Repository-relative path of the capture, so a reviewer can re-derive the list. */
export const PLATFORM_CAPABILITY_FIXTURE_SOURCE = 'docs/dev-plan/evidence/双机验收/AT-08.json (observed.steps[1].capabilities)'

/**
 * Every key the captured platform worker row carried, alphabetically.
 *
 * Sorted so a diff of a refresh is readable; order carries no meaning on the platform side.
 */
export const PLATFORM_WORKER_CAPABILITY_KEYS: readonly string[] = Object.freeze([
  'accelerators',
  'ai_runtime_ready',
  'arch',
  'bench_capability_score',
  'bench_cpu_mb_per_sec',
  'bench_disk_mb_per_sec',
  'bench_memory_gb_per_sec',
  'client_build',
  'contribute_mode',
  'cpu_brand',
  'cpu_cores',
  'cpu_threads',
  'device_name',
  'equipped_models',
  'free_disk_mb',
  'gpu_count',
  'gpu_model',
  'hostname',
  'installed_apps',
  'installed_skills',
  'kernel_version',
  'llm_backend',
  'llm_models',
  'memory_gb',
  'model_health',
  'native_binaries',
  'ollama_models',
  'onnx_models',
  'os',
  'os_name',
  'os_version',
  'protocol_capabilities',
  'protocol_legacy',
  'protocol_profile',
  'protocol_profile_observations',
  'provided_capabilities',
  'ram_gb',
  'runtime_tiers',
  'runtimes',
  'software',
  'specialty',
  'supported_executors',
  'throttle_pct',
  'tier',
  'total_disk_mb',
  'total_memory_mb',
  'vram_mb',
])

/**
 * The two short names the platform's protocol contract allows for `os` and `arch`.
 *
 * Why values live in this fixture next to keys: the `win32` → `windows` mapping is a second,
 * independent divergence channel (audit §2.1). A key-name test cannot see it — `os: 'win32'` is a
 * legal key carrying an illegal value — so the contract test also asserts the projected value is a
 * member of these sets. Recorded from `platform_v8/protocol/ws_schema.py:44-45` (the comment that
 * states the contract) and confirmed by the capture above, whose row carries `os: "macos"` and
 * `arch: "aarch64"`.
 */
export const PLATFORM_OS_NAMES: readonly string[] = Object.freeze(['macos', 'linux', 'windows'])

/** Allowed `arch` values, same source and reasoning as {@link PLATFORM_OS_NAMES}. */
export const PLATFORM_ARCH_NAMES: readonly string[] = Object.freeze(['x86_64', 'aarch64', 'x86'])
