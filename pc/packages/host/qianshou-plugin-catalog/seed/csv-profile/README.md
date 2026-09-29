# Official CSV profile seed, v1

English | [中文](README.zh.md)

`qianshou.csv-profile-1.0.0.qspkg` is a reproducible, data-only ZIP. It contains exactly five regular files: `manifest.json`, `schemas/input.json`, `schemas/output.json`, `samples/basic-input.json`, and `samples/basic-output.json`. `node packages/host/qianshou-plugin-catalog/scripts/build-csv-profile-seed.mjs` regenerates the manifest and artifact from the checked-in schemas and sample. The package is 3,058 bytes with SHA-256 `257064f2a39b3b5bf4a410bebfba138af769bf4e1a7a23054b3aa31ca993f480`.

The operation is `csv.profile` under the existing Shanghai semantic class `text.transform`. Its execution is a distinct, bounded RFC 4180 CSV parser, not the built-in text transformation or word-count runner. The reviewed `qianshou.csv-profile.adapter.v1` lives in `src/official-seed-csv.ts`; no JavaScript from the archive is evaluated. It requires no workspace, network, GPU, model, or filesystem permission. The parser accepts up to 1 MiB of CSV, 10,000 data rows, 64 columns and a 20-row preview.

`installPrivateOfficialCsvSeed` copies this exact package to an existing owner-only directory after an active owner approval and a real packaged sample trial. `runPrivateOfficialCsvSeed` rechecks the receipt and package on each use. This is local private use only (`dispatchable: false`). It does not create a Guangzhou buyer license, market entry, Shanghai declaration, order switch, or charge. Guangzhou review/signing and free acquisition use separate contracts; a buyer-facing caller must verify those before invoking local installation.

The `official-seed-csv-tools` subpath is mounted only by the Qianshou CEO and plugin-creator agent presets. It offers read-only status, explicit owner-approved offline private installation, and execution on CSV text the user supplied in the conversation. The market catalog service alone registers no model-facing CSV tools. Every tool result states that no buyer license or external order right has been established.

Check the artifact and a real Loader/Host install/run with `pnpm exec vitest run packages/host/qianshou-plugin-catalog/tests/official-seed-csv.spec.ts packages/host/qianshou-plugin-catalog/tests/official-seed-csv.host.spec.ts`. The pure adapter and package format are OS independent. The install-directory permission model still needs a real Windows validation before promising Windows installation.
