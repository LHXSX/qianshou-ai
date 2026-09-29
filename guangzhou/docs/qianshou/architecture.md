# Qianshou product layer architecture

English | [中文](architecture.zh.md)

This document maps the layer the Qianshou team builds on top of DeepSeek Harness: the shell users see, the design tokens that colour it, the settings surface that hosts product features, the account and subscription path, the admin console, and the packaging chain. It is an ordered map; each mechanism is named and its owner is linked rather than restated.

## The shell

The product window is a three-column frame owned by `packages/client/ui-layout`. The app frame reads a sidebar preference, a right-rail preference, and the viewport width, then solves the columns in `packages/client/ui-layout/src/client/columns.ts`. The solver reserves a centre minimum, collapses the right rail to zero when the remaining space cannot hold its minimum, and clamps the sidebar between its own bounds.

Column ownership is exclusive: the sidebar carries navigation and history, the main column carries the current work, and the right rail carries supplementary material for that work. Content destinations that are not navigation belong in settings, never in the sidebar.

Region order does not change with viewport width. The team activity dock stays on the right of the conversation at every width; it changes shape, not position.

## Design tokens

Two palettes live in `packages/client/ui-theme/src/qianshou-palettes.ts`. The dark palette is a near-black neutral base with a gold accent; the light palette is a white base with a deep blue accent. In both, every surface token is neutral, so accent colour appears only on actions, selection, focus, and state.

Tokens are published on `document.body` under `--dsw-alias-*`. The light and dark selections are surfaced by the theme row in settings, and each preview swatch reads the same tokens, so a palette change reaches the previews without a second definition.

The rules that keep colour disciplined, the contrast floors, and the layout contract live in `.agents/skills/qianshou-design-system`. Its `LAYOUT.md` owns the alignment axis, the region internal layouts, the expanded-state rule, and the narrow-width thresholds.

## Settings as the product surface

`settings.section` is the registration point for product features. A section supplies an order, a label, and an injected face; the settings dialog renders them alongside the upstream sections.

Product sections registered there include the agent plaza, task centre, workflows, marketplace, account and plan, files and data, models and API, collaboration devices, and model routing. The sidebar panel list keeps only the conversation entry and the account entry.

A section that also needs to be reachable by identifier keeps its `main` registration, because other code selects those panels by id.

## Account, plan, and usage

`packages/host/account-session` owns the account session: it resolves the account from the service, caches the verified identity, and decides when a failure is authoritative. A verification failure that is transient — network, server error, unparseable payload, rate limit, abort — keeps the last verified identity for a grace window instead of clearing it.

`packages/host/model-gateway` owns the subscription gateway. It publishes the platform-visible model names, routes them to backends, records per-call usage in an audit ledger, and reports the account's tier and credit. The tiers and their model availability live in `packages/host/model-gateway/src/tiers.ts`.

The account centre and the plan section read the same store, so the two surfaces cannot disagree.

## Admin console

The gateway exposes five admin routes: the published-name directory, a binding append, the site-wide audit ledger, a subscription grant, and a subscription query. Authorization is fail-closed: the route refuses when the deployment injects no administrator claim, and the administrator set is a deployment-level configuration rather than a default.

The console that drives them is the model-routing settings section in `packages/client/ui-settings-routing`.

## Model routing and the local adapter

The default model provider is served by `packages/llm/llm-deepseek`. That plugin declares one provider route and reads its endpoint from its own configuration; when no endpoint is configured it falls back to the public DeepSeek endpoint. The deployment that points the product at the local subscription gateway must therefore supply that endpoint explicitly.

## Packaging

`apps/qianshou-desktop` owns the macOS shell. Two paths produce an application bundle: `scripts/package-mac.ts` builds a distributable bundle, and `scripts/install-mac.mjs` installs from a source checkout for local use. Both must write a shell manifest whose name, product name, and distribution match, because the shell resolves its entry point from that manifest.

The in-application updater lives in `apps/qianshou-updater`. It fetches a signed manifest, verifies the archive against a fixed public key and per-file digests, stages the new version beside the existing installation, and switches after the host exits. Archive authenticity does not replace Developer ID signing or notarization.

## Where to go next

- Layout and colour rules: `.agents/skills/qianshou-design-system`
- Contributor workflow and build discipline: [development.md](development.md)
- Product-facing walkthrough: [usage.md](usage.md)
- Package contracts: each `packages/*/*/README.md`
