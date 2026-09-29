# contracts/v1 · Fixed copy of the Qianshou cross-boundary contracts

English | [中文](README.zh.md)

**The single source lives in the compute repository; this is a fixed copy and is never edited by hand.**

| Item | Value |
|---|---|
| Source repository | Private Qianshou compute source snapshot. `contracts/` was uncommitted at capture time, so there is no Git blob to cite; the reconciliation below uses file content hashes. |
| Source path | `contracts/v1/*.json` (10 files); the overview and three design decisions live in the source repository's `contracts/README.md` |
| Copied at | 2026-09-21T21:39:24+0800 |
| Copy method | `cp` followed by `chmod 0444`; not one byte changed |
| Verification command | `shasum -a 256 contracts/v1/*.json` (the table below is that command's real output in this repository and in the source repository, identical byte for byte) |

## SHA-256

```
c13753c0ed880f76e12ea701443f1c0aceb40d78e6fcf1fc71691bb3f382475e  contracts/v1/capabilities.registry.json
64d8e666a5674d605f5bec7340ed73dc2d21157a00ad27c42fd648effa2c64d9  contracts/v1/capability-manifest.schema.json
27b52cac73e6ab3a1ac84907b415c1fce72bf5a0955b56c162a1c2d7c8d27808  contracts/v1/capability.schema.json
3f71b35e5ace280dc43a6a9f26ab232ac6213cbd6da593c42f61f7241d128e80  contracts/v1/identity.schema.json
d5cf5b120173301be00b83db5ac44abad813fa0f80ea3c1a0da96540bc1e75da  contracts/v1/intent.schema.json
6c8d30d98244cba599d2d0ed179313d48bb37db013c808c63a5ca4bdbb384d24  contracts/v1/ledger.schema.json
9aa6f3a7e901bd0b866a4595e95e01e2890fe11ee3a71d739cb752c794b9c101  contracts/v1/offer.schema.json
a81b53dc6723753d3c2884aa8ced953f2621cb18dcd7928e54e39f66ae258330  contracts/v1/result.schema.json
914be467e9ad4fc7888e39ae578d8b44f557c959518dafaddb0481b9d4c1e2b1  contracts/v1/route-plan.schema.json
361cd6319e111917e805ccf486e8c864ba940744b7f98ed97f9f16d7f817af5c  contracts/v1/task.schema.json
```

## How this repository uses it

- No second copy of the types is hand-written in TypeScript or as Python dataclasses. Types are derived from the JSON Schema; validation uses the repository's existing JSON Schema validator (`assertSupportedJsonSchema` / `validateJsonSchemaValue` in `packages/core/tools/src/json-schema.ts`, whose enforced subset covers all ten files).
- `packages/host/qianshou-capability` reads `capabilities.registry.json` (capability name, title, `legacy_task_types` landings) and `intent.schema.json` (the `goal` / `budget` subtrees) at plugin load; a missing file or unexpected structure fails that load rather than silently degrading to an empty catalog.
- There is exactly one way to update the copy: `cp` again from the source repository, recompute the SHA-256 values, and rewrite the timestamp and hash table in this file. **Do not** change a field, extend an enum or "just tidy up" a description here — that turns an upgrade into a format contract with no vocabulary discipline.

## Scope

- The contracts describe the objects transported over the platform ↔ node line; the response fields of the deployed Shanghai `GET /api/v8/capabilities` and `POST /api/v8/economy/estimate` are not instances of these schemas. This repository's Host projects server responses through an allowlist and records each field's origin rather than passing server fields off as contract objects.
- The three open questions listed in the source repository's `contracts/README.md` §6.1 (multi-implementation OR/AND, ownership of the semantic name space, the unit of `min_version`) are equally unresolved in this copy.
