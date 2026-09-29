# 员工设置

[English](employee-settings.md) | 中文

员工设置子系统通过 `ctx.employeeSettings` 提供用户配置的员工背后的、由 Host 拥有的路由权限。它存储一份有界的名册：具名角色，各带一条可选的精确提供方／模型路由，另有一条团队默认路由；并在派工时把一个角色解析为不含凭据的指派。该服务通过自己的 `@deepseek-ai/dsh-tool-subagent/employee-settings` 子路径加载，因此不希望使用用户配置员工的部署只需不挂载它。

团队偏好是采样读取的，不是强制施加的。每次新的委派都按当前名册解析，而正在运行或可复用的员工保留其创建时记录的路由和 transcript；此后对名册的编辑——包括删除某个角色——只影响后续派工。删除角色既不会取消既有的子会话，也不会改派它的会话，因此停止一个员工始终是显式操作，而不是编辑设置的副作用。

## 公共记录

`Employee` 是一个持久角色：稳定的全小写 id、显示名、用户撰写的职责文本，以及一条可选的 `AllowedModelRoute` 或 `null`（表示跟随团队默认）。`EmployeeSettings` 是整份团队偏好：名册加 `defaultRoute`，其中 `null` 表示跟随 CEO 会话自身的路由。`EmployeeAssignment` 是一次解析得到的已分离结果——解析出的员工、生效路由，以及决定该路由的 `source`（`employee`、`team` 或 `ceo`）——因为它不含凭据，可以安全地放进工具结果。`AllowedModelRoute` 及其校验器位于 [model-selection.ts](../../packages/subagent/tool-subagent/src/model-selection.ts)。设置命名空间、其 schema 与校验器定义在 [employee-settings.ts](../../packages/subagent/tool-subagent/src/employee-settings.ts)。

## 职责与边界

该服务只拥有三件事：`qianshou-employees` 设置命名空间、解析顺序，以及对畸形输入的拒绝。`current()` 返回已分离的名册快照，因此调用方无法改动设置真源；`resolve(id)` 先取员工自身的路由覆盖，再取团队默认，最后取 CEO 最近一次记录的请求路由。随包发布的初始名册是一组角色模板，覆盖产品、设计、工程、复核与写作工作；模板描述职责，不会创建正在运行的员工。建立在该服务之上的发现与派工界面由 [tool-subagent 包](../../packages/subagent/tool-subagent/README.zh.md) 拥有，其 `list_employees` 工具报告解析后的路由及其来源。

凭据被刻意排除在外。提供方 API 密钥和其他密钥留在提供方设置里，校验器会拒绝声明集合之外的任何字段，因此凭据永远无法被夹带进名册文档。名册规模上限为 24 条，id 必须是唯一的全小写名称（可含连字符），路由必须带有非空的提供方与模型 id；并且在每次派工前都会针对实时 LLM 适配器校验路由——在该异步校验期间发生变化的指派会被拒绝，而不是被静默降级。目录成员资格仅供参考：适配器接受时可以使用未列出的模型，但绝不会假定它可用。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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

## 延伸阅读

- [tool-subagent 包](../../packages/subagent/tool-subagent/README.zh.md) — 委派工具、员工发现与路由预检。
- [子智能体](subagent.zh.md) — 提供方、一次性启动请求与可续子智能体。
- [设置](settings.zh.md) — 命名空间、分层解析与所有者作用域。
- [LLM 流式](llm-streaming.zh.md) — 适配器、提供方目录与解析后的模型词汇。
