# Employee settings

English | [中文](employee-settings.zh.md)

The employee-settings subsystem exposes `ctx.employeeSettings`, the Host-owned routing authority behind user-configured employees. It stores a bounded roster of named roles with an optional exact provider/model route and a team default route, and it resolves one role into a credential-free assignment at dispatch time. The service is loaded through its own `@deepseek-ai/dsh-tool-subagent/employee-settings` subpath, so a deployment that does not want user-configured employees simply never mounts it.

Team preferences are sampled, not enforced. Every new delegation resolves against the current roster, while a running or reusable employee keeps the route and transcript recorded at its own creation; a later roster edit — including removing a role — affects only subsequent dispatches. Removing a role neither cancels an existing child session nor reroutes its conversation, so stopping a worker remains an explicit operation rather than a side effect of editing settings.

## Public records

`Employee` is one persistent role: a stable lowercase id, a display name, the user-written responsibility text, and an optional `AllowedModelRoute` or `null` to follow the team default. `EmployeeSettings` is the whole team preference: the roster plus `defaultRoute`, where `null` follows the CEO conversation's own route. `EmployeeAssignment` is the detached result of a resolution — the resolved employee, the effective route, and the `source` that decided it (`employee`, `team`, or `ceo`) — and is safe to include in a tool result because it carries no credentials. `AllowedModelRoute` and its validator live in [model-selection.ts](../../packages/subagent/tool-subagent/src/model-selection.ts). The settings namespace, its schema, and the validator are defined in [employee-settings.ts](../../packages/subagent/tool-subagent/src/employee-settings.ts).

## Ownership and boundaries

The service owns exactly three things: the `qianshou-employees` settings namespace, the resolution order, and the rejection of malformed input. `current()` returns a detached roster snapshot so a caller cannot mutate the settings source, and `resolve(id)` returns the employee override first, then the team default, then the CEO's latest logged request route. The shipped initial roster is a set of role templates for product, design, engineering, review, and writing work; templates describe responsibilities and do not create running workers. Discovery and dispatch surfaces built on top of this service are owned by the [tool-subagent package](../../packages/subagent/tool-subagent/README.md), whose `list_employees` tool reports the resolved route and its source.

Credentials are deliberately out of scope. Provider API keys and other secrets stay in provider settings, and the validator rejects any field outside the declared set, so a credential can never be smuggled into the roster document. Roster growth is bounded at 24 entries, ids must be unique lowercase names with optional hyphens, routes must carry non-empty provider and model ids, and a route is validated against the live LLM adapter before each dispatch — an assignment that changes during that asynchronous check is rejected rather than silently downgraded. Catalog membership stays advisory: a listed model can be used when the adapter accepts it, and an unlisted one is never assumed to work.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxemployeesettings--employeesettingsservice"></a>

### `ctx.employeeSettings` — `EmployeeSettingsService`

Host-owned routing service; settings edits affect subsequent dispatches only.

```ts cordis-catalog
/**
 * Read current role and route preferences without exposing the mutable settings source.
 * @returns A detached, credential-free roster snapshot.
 */
current(): EmployeeSettings

/**
 * Resolve one employee against the latest user-owned team preferences.
 * @param id - Exact stable employee id returned by list_employees.
 * @returns The selected role, route and inheritance source.
 */
resolve(id: string): EmployeeAssignment
```

Source: [`packages/subagent/tool-subagent/src/employee-settings.ts`](../../packages/subagent/tool-subagent/src/employee-settings.ts)
<!-- END GENERATED cordis-surface -->

## Further Exploration

- [Tool-subagent package](../../packages/subagent/tool-subagent/README.md) — the delegation tool, employee discovery, and route preflight.
- [Subagent](subagent.md) — providers, one-shot start requests, and continuable children.
- [Settings](settings.md) — namespaces, layered resolution, and owner scopes.
- [LLM streaming](llm-streaming.md) — adapters, provider catalogs, and the resolved model vocabulary.
