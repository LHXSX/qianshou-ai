# Developing the Qianshou product layer

English | [中文](development.zh.md)

This document covers the working setup, the build discipline this layer requires, the gates a change must pass, and the verification standard the team holds itself to. It assumes a checkout of this repository and a working Node runtime.

## Build discipline

The product skin is selected at build time by an environment variable that the bundler inlines into client code. Every client build must set it, including a build of a single package:

```bash
DSH_CLIENT_BUILD_PROFILE=forge npx tsdown --env.DSH_BUILD_FACE client
DSH_CLIENT_BUILD_PROFILE=forge npx tsdown --config packages/client/<package>/tsdown.config.ts
```

Omitting it compiles the forge branches out. The symptom is silent: the hero falls back to the non-forge variant, navigation entries vanish, and the brand name changes. No error is raised. `scripts/verify-client-artifacts.ts` exists to catch exactly this, and it checks two things: that each client bundle is newer than the sources it is built from, and that the forge marker text is present in the brand bundle.

Client bundles are committed artifacts under `packages/*/*/lib/client.js`. A source change that is not followed by a rebuild leaves the running interface showing the previous revision. Rebuild, then verify, then look at the result.

## Gates

A commit runs the staged lint configuration, the third-party notices check, a whitespace check, and the vendor manifest guard. A push additionally runs a client typecheck and the client artifact gate. The documentation pairs are checked whenever Markdown is staged.

Type checking uses project references, which cache results. Use `--force` when a clean result matters:

```bash
npx tsc -b tsconfig.client.json --force
npx tsc -b tsconfig.host.json --force
```

## Verification standard

A layout or behaviour claim is verified with a measurement, not with a reading of the source. The team runs a Chrome instance with a remote debugging port, drives the real interface, and reads element geometry back:

- alignment: every block on the surface reports the same left edge, not merely a plausible one;
- stability: a control row reports the same height before and after an expansion is triggered;
- containment: no control reports a right edge beyond its container;
- responsiveness: the measurements are taken at a wide and a narrow viewport, and the region order is the same at both.

A guard is verified in both directions: break the condition it protects and confirm the check turns red.

## Design authority

Interface work consults `.agents/skills/qianshou-design-system` before editing. Its `SKILL.md` owns the palette anchors, the contrast floors, the hierarchy rules, the spacing scale, and the catalogue of anti-patterns; its `LAYOUT.md` owns the structure, the alignment axis, the expanded-state rule, and the narrow-width thresholds.

Colour changes require a recomputed contrast ratio. The script that computes it is in the skill.

## Documentation

Human-facing documents are bilingual pairs: a Markdown file and its counterpart, with an `*.i18n.yaml` sidecar recording the blob hash of each side as of the last confirmed-consistent state. Editing one side requires bringing the other along and re-recording:

```bash
node_modules/.bin/tsx scripts/verify-translation-pairing.ts --write docs/qianshou/architecture.md
```

Paragraphs occupy one physical line; the wrap check enforces this. Documents describe current state: a live mechanism is named directly, and history belongs in commits, Agent Notes, or postmortems.

A non-trivial change carries at least one Agent Note under `.agents/notes/` recording why the decision was made, what was given up, and how to verify it.

## Serving the interface

The development workbench runs from this checkout and the packaging chain can produce an application bundle. The two are separate installations with separate data directories, and the workbench session token changes on every restart; a browser tab opened before a restart shows an authentication notice until it is reopened with the current token. The token is written to `.artifacts/bridge/workbench.token`.
