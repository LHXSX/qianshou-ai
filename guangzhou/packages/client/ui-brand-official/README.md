---
description: "Build-selected DeepSeek and Qianshou brand occupants for the sidebar and conversation hero; for users and maintainers choosing or replacing brand presentation."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-brand-official

English | [中文](README.zh.md)

## Summary

This package supplies the sidebar identity for `official` DeepSeek Harness builds and `forge` Qianshou builds. Qianshou also uses the same vector mark in the conversation hero. Other profiles retain the declaring shells' fallbacks. Choose a matching build profile or provide a replacement brand package for another identity. The package has no runtime state and does not affect model requests.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this plugin in the browser roster, then build the client with the profile matching the deployment's identity.

### Choosing the profile

`DSH_CLIENT_BUILD_PROFILE=official` selects the DeepSeek sidebar mark and name while preserving the hero's declaring fallback. `forge` selects the localized Qianshou sidebar identity and the same Qianshou mark in the hero. The private identity waits for the locale service. Other profile values leave all brand slots on their declaring fallbacks; the plugin still loads, but registers no occupants.

### Qianshou identity

The Qianshou mark is a native SVG: one coordinating center and six curved arms inside a rounded tile. A 32-unit viewBox retains a one-unit outer inset and 2.5-unit arm strokes, keeping the graphic legible at the requested 24px rail and 34px expanded-sidebar or hero sizes. The tile uses the theme's brand accent; the center and arms use its matching foreground ink. It has no raster assets or animation and is decorative inside the shell's accessible control.

The localized name uses two lines with a full-height title and a secondary subtitle. Only the subtitle truncates horizontally when space is limited. The [sidebar shell](../ui-sidebar/README.md#brand-and-new-session) owns the natural-height row and the clearance around its controls. The forge build also fills `sidebar.right.tab.guide` with the live session model catalog, existing composer tools, and an empty task state, expands that rail when an empty session first mounts, and registers four product pages for Agent plaza, Workflows, Files and data, and Models and API.

Each product page states its own positioning line, grouped fact cards, an actionable "where to use this" list, and one honest boundary note. What it shows is read from the client services the deployment already runs: the session list mirror (`ctx.sessions`) supplies the addressable subagent roster and the host-reported background processes, and the per-session model directory (`ctx.modelDirectories`) supplies the providers that answered, the providers that failed, and the current route. An empty source renders an empty state, never a placeholder count, and a page whose source is not mounted says so. The only buttons are actions that perform a verified navigation: returning to the conversation, selecting one of the four product panels, opening the right sidebar's Files tab (a real `ctx.sidebarRight.openTab('files')`, offered only while a session gives that tab a workspace), and opening a listed subagent conversation. Catalog rows in the rail select the current Session model. More models opens Models and API; View all opens Task center.

### Replacing the brand

A deployment with another identity leaves this package out and composes a package that occupies the sidebar and hero slots. Occupying a slot is the composition route; this package has no runtime brand configuration.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

Nested `ctx.slots.inject()` calls install the two sidebar occupants together when their declarations exist and withdraw both when those declarations disappear. The Qianshou hero occupant independently waits on its own declaration and shares the sidebar's [`ForgeBrandMark`](src/client/ForgeBrand.tsx) component. Both registration paths support late declarations, redeclaration, and plugin teardown without retaining state. The browser half is [`src/client/index.ts`](src/client/index.ts); the node half is an empty Loader seat. The browser title is selected separately by `DSH_CLIENT_TITLE`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the brand surface is not enough. They move from the slots this package occupies to the shell that renders them.

- [ui-sidebar](../ui-sidebar/README.md) — declares `sidebar.brand.mark` and `sidebar.brand.name` and renders their fallbacks.
- [ui-conversation](../ui-conversation/README.md) — declares `conversation.hero.brand.mark` in the hero.
- [Web client architecture](../../../.agents/notes/implemented/architecture/2026-07-19-gui-web-client-architecture.md) — how browser plugin rows load and register slots.

-----

<a id="model-experience"></a>
## Model Experience

None, as the package contributes browser presentation only; nothing here reaches a model request.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define how brand presentation is supplied. They are current package constraints, not a brand-design comparison or a task backlog.

- **One occupant set** — alternative presentation belongs in another Cordis package occupying the same slots.
- **The browser title is independent** — `DSH_CLIENT_TITLE` selects title text at build time rather than through a UI slot.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

**Runtime invariant:** No companion is published. The package retains no mutable state; occupants install and leave with their declaring slots and plugin lifetime.
