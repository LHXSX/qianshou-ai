# 连接中心

[English](connections.md) | 中文

连接子系统通过 `ctx.connections` 把公开 GitHub 账号或 SSH 目标以非密钥形式保存、用一次真实的有限读取进行测试，并把访问权授予选定的员工预设。它把已校验的元数据、在途操作取消、实时预设授权和外部提供方读取统一放在一个 Host 服务后面。保存一条记录并不建立连通性，探测结果是进程内的证据，不是被存储的事实。

提供方的工作走既有的 Subprocess 与 Credentials 服务，而不是自带通道：`ssh` 和 `gh` 在共享的进程归属规则下执行，密钥值从不进入连接记录。该服务不对远端系统执行任何写操作——不克隆、不发布、不建 issue、不部署——也不暴露任意命令端点。

## 公共记录

`ConnectionId` 是一条已保存记录的稳定品牌化身份。`ConnectionView` 是每个已鉴权读取方收到的、已分离的非密钥行：身份、种类、提供方目标、凭据引用、修订号和更新时间。`ConnectionDraft` 是保存操作接受的不受信浏览器输入，`ConnectionRecord` 是视图背后的存储形状。`ConnectionProbe` 承载最近一次测试结果——结果、时间、实际使用的认证方式，以及身份／详情或稳定的错误码——绝不含原始 stderr 或密钥值。`GithubRepositoryPage` 承载一页公开仓库元数据和可选的 `nextPage`。`SshInspection` 承载固定命令 `uname -s && pwd && id -un` 的结果。字段契约位于 [types.ts](../../packages/host/connections/src/types.ts)，输入校验位于 [validation.ts](../../packages/host/connections/src/validation.ts)。

## 职责与边界

[registry.ts](../../packages/host/connections/src/registry.ts) 拥有已校验元数据和活动操作：保存或删除连接会取消并排空其在途读取、作废探测证据，凭据引用变更会作废匹配的探测，每次模型读取都会在异步工作前后校验确切的实时 Agent 及其实际组合出的预设。[providers.ts](../../packages/host/connections/src/providers.ts) 执行 GitHub HTTP／CLI 与 OpenSSH 读取，[process.ts](../../packages/host/connections/src/process.ts) 使用 Subprocess 提供方实现环境清理、有界收集、取消和进程树完全停稳，[routes.ts](../../packages/host/connections/src/routes.ts) 在 `/api/qianshou/connections` 下暴露已鉴权的用户操作，[tools.ts](../../packages/host/connections/src/tools.ts) 通过常规的 `tools/pre-execute` 策略注册读取工具。

这个子系统不拥有什么，和它拥有什么同样重要。访问授权挂在员工预设上，因此预设名册及其组合由 [agent presets](../../packages/preset/agent-presets/README.zh.md) 包拥有；被撤销的连接或变更后的预设无法返回迟到的成功，因为每次读取都会重新校验两者。密钥存储与按操作解析属于 [credentials](credentials.zh.md) 接缝，进程归属属于 [subprocess](subprocess.zh.md) 接缝。模型 API 连接是完全不同的界面，走 Models 设置页。

连接在设计上是只读的。SSH 支持既有的 agent 或密钥认证，并要求主机密钥已被信任；未知主机密钥、不可用凭据和不可达服务器都会显式失败，连接器从不接受指纹，也不会自动索要密码。GitHub 在公开的 github.com 上读取已鉴权的 `user` 和分页的公开 `user/repos`。GitHub Enterprise、交互式 OAuth／设备登录、任意 SSH 执行和所有远端写操作都不属于本子系统，需要另行批准的执行路径。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxconnections--connectionsregistry"></a>

### `ctx.connections` — `ConnectionsRegistry`

One Host owns the metadata file and all active read requests.

```ts cordis-catalog
/** List non-secret rows, limited to an actor's live preset when called by a tool.
 * @param actor - Model caller; omitted only by authenticated user routes.
 * @returns Detached rows; callers cannot mutate registry state.
 */
list(actor?: Agent): ConnectionView[]

/** Save configuration, revoke in-flight reads and clear old probe evidence.
 * @param input - Untrusted browser draft.
 * @returns The committed non-secret view.
 */
save(input: unknown): Promise<ConnectionView>

/** Revoke a connection and drain its owned operations before returning.
 * @param id - Connection address.
 * @returns Acknowledgment after durable removal.
 */
delete(id: ConnectionId): Promise<{ deleted: true }>

/** Perform a real bounded authentication/read probe and store only public evidence.
 * @param id - Saved connection address.
 * @param signal - Browser or tool cancellation.
 * @param actor - Model caller; omitted by the authenticated user probe.
 * @returns Success or stable failure evidence for this exact connection revision.
 */
async probe(id: ConnectionId, signal: AbortSignal, actor?: Agent): Promise<ConnectionProbe>

/** Read public repository metadata through the saved account.
 * @param id - GitHub connection address.
 * @param page - One-based page, capped at 1000.
 * @param signal - Request cancellation.
 * @param actor - Model caller; omitted by authenticated user routes.
 * @returns One bounded repository page.
 */
async repositories(id: ConnectionId, page: number, signal: AbortSignal, actor?: Agent): Promise<GithubRepositoryPage>

/** Run the fixed read-only SSH inspection; arbitrary commands are not exposed.
 * @param id - SSH connection address.
 * @param signal - Request cancellation.
 * @param actor - Required live model caller.
 * @returns Verified OS, directory and login user.
 */
async inspect(id: ConnectionId, signal: AbortSignal, actor: Agent): Promise<SshInspection>

/** Cancel reads using a changed credential reference; old probes are invalidated.
 * @param ref - Updated Host credential reference.
 * @returns Completion after matching readers drain.
 */
async credentialChanged(ref: string): Promise<void>

/** Stop admitting operations, cancel all readers and await quiescence. */
async close(): Promise<void>
```

Types: [Agent](core.zh.md)

Source: [`packages/host/connections/src/registry.ts`](../../packages/host/connections/src/registry.ts)
<!-- END GENERATED cordis-surface -->

## 延伸阅读

- [连接包](../../packages/host/connections/README.zh.md) — 配置、提供方命令、路由表和面向模型的工具。
- [凭据](credentials.zh.md) — 密钥引用与存储提供方。
- [子进程](subprocess.zh.md) — 进程归属与有界输出。
- [Agent 预设](../../packages/preset/agent-presets/README.zh.md) — 承载访问授权的实际组合。
- [工具](tools.zh.md) — 策略与持久化工具调用记录。
