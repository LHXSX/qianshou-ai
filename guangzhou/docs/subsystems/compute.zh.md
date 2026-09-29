# 算力

[English](compute.md) | 中文

算力子系统通过 `ctx.computeCore` 提供经过鉴权的能力读取、本地规划草稿、授权后的开发者任务发布，以及已准入任务的执行。它把远端账户查询、本地任务状态、执行器选择、受控工作目录和结果消费统一放在 Host 服务后面。目录条目不能证明节点在线、价格有效或收益已结算；发布可能通过核心开发者任务入口冻结预算。

能力保持不透明：千手只处理节点上报的 `capabilityId`、版本和插件摘要，不提供或推断 H3、图片、视频等具体模型能力。节点智能体完成本机自检后才发布广告，调度中心只从在线节点广告中选择 `capabilityId@version@pluginDigest` 精确匹配项；本页的执行器注册表只是统一智能体调用节点自有执行器的接缝。

## 公共记录

`ComputeConnectionState` 报告已配置的读取功能，不暴露凭据。`ComputeCapability`、`ComputePlanDraft` 和 `ComputeWorkloadSummary` 分别承载能力、本地规划和用户可见的任务投影；字段契约位于 [protocol.ts](../../packages/host/compute-core/src/protocol.ts)。工作目录输入输出规则位于 [task-workspace.ts](../../packages/host/compute-core/src/task-workspace.ts)，任务生命周期状态位于 [task-state.ts](../../packages/host/compute-core/src/task-state.ts)，准入记录位于 [employee-task-coordinator.ts](../../packages/host/compute-core/src/employee-task-coordinator.ts)。下面的生成区域包含 `ctx.computeCore` 方法签名。

[常驻任务循环](../../packages/host/compute-core/src/resident-loop.ts)是由 Host 驱动的 tick 接缝：发送已脱敏心跳，并按顺序协调已验证的被动邀请。它只负责顺序和关闭；计时器、资源观察、队列传输、执行和上传仍由独立适配器负责。

## 本地执行与准入

`ctx.computeCore` 通过现有鉴权连接读取配置的算力核心，并在本地保存有上限的草稿和任务尝试。`executeTask` 只接受版本化的 `ComputeTaskEnvelope` 和受控的 `ComputeLocalTaskRequest`；受控运行器把输入暂存到私有工作目录，调用执行器注册表中的精确能力版本，核验输出，等待结果消费者完成，并在消费者结束后清理。`coordinateTask` 只有在调度验证和调度决策完成后才保存已准入的员工任务。取消和关闭会停止新任务，并在存储关闭前完成活动清理。

## 归属与限制

算力包负责配置、本地存储、执行器注册和任务生命周期机制。调度服务负责节点身份、受信签名密钥、租约、远程传输、价格和结算。算力包 README 说明配置和实现职责；本页负责共享公共记录和 `ctx.computeCore` 服务引用。

## 插件市场信任边界

`planCapabilityPluginInstall` 会解析不可信 manifest，并核验包摘要、宿主兼容性、声明权限的显式授予以及部署方提供的签名；它只返回冻结的 `verified` 方案，绝不下载、解包、加载或执行插件代码。事务式暂存、进程隔离、回滚和资产扫描由部署适配器负责。GPU 与本地模型权限需要原生复核。上海继续只承担元数据控制面，不能安装、扣费或结算插件。

## 报价与估算边界

当前经过源码核验的 v8 合同提供鉴权账户身份、已公布任务类型、用户可见的任务进度，以及带必填 `idempotency_key` 的 `POST /api/v8/developer/tasks`。它没有定义报价或估算请求路径、请求体、响应封套、归属绑定、有效期或签名规则，也没有定义价格币种合同。`ComputeQuote` 及其解析器仍是未使用的本地元数据类型；`QianshouCoreClient` 不提供报价或估算方法，也不会从能力目录猜测价格。已配置核心报告 `submission: true` 且 `quoting: false`。未知的开发者任务 POST 会记入本机账本，并且不会自动重试。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxcomputecore--computeservice"></a>

### `ctx.computeCore` — `ComputeService`

Core catalogue, local drafts, and authorized developer-task publish.

```ts cordis-catalog
/** Report configured features; this is not a connectivity or account validation probe.
 * @returns Current local configuration state.
 */
status(): ComputeConnectionState

/** Read fresh local resource facts independently of cloud model configuration.
 * @param signal - Cancellation for bounded local probes.
 * @returns Actual observations and saved owner policy; unknown facts stay unknown.
 */
querySupplySnapshot(signal?: AbortSignal): Promise<SupplySnapshot>

/** Persist a complete owner policy without buying or submitting a task.
 * @param policy - Complete policy validated by the supply controller before persistence.
 * @param signal - Caller cancellation; a committed policy remains saved after a probe error.
 * @returns Fresh local supply state after the committed change.
 */
updateSupplyPolicy(policy: SupplyPolicy, signal?: AbortSignal): Promise<SupplySnapshot>

/** Read the current account's advertised task types, not live node inventory.
 * @param signal - Caller cancellation bound to the upstream request.
 * @returns Advertised capabilities from the configured core.
 */
capabilities(signal?: AbortSignal): Promise<ComputeCapability[]>

/** Read existing owner-visible local drafts.
 * @returns Locally stored planning drafts.
 */
plans(): Promise<ComputePlanDraft[]>

/** Create a draft only for a capability verified against the core catalog.
 * @param input - Untrusted UI or model planning request.
 * @param signal - Cancellation checked again before the local commit.
 * @returns The newly persisted local draft.
 */
async createPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft>

/** Persist a local owner confirmation; this never quotes, submits, or charges.
 * @param input - Untrusted `{ id, decision }` from a conversation card or compute page.
 * @param signal - Cancellation checked before the local commit.
 * @returns The updated local draft.
 */
async confirmPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft>

/** Publish an approved local draft through `POST /api/v8/developer/tasks`.
 * Unknown submit results stay in the local ledger and are never retried automatically.
 * This method never POSTs `/api/v8/workloads`.
 * @param input - Untrusted `{ id }` from a conversation card or compute page.
 * @param signal - Cancellation checked before the core POST.
 * @returns The draft with a core-issued `workloadId`.
 */
async publishPlan(input: unknown, signal?: AbortSignal): Promise<ComputePlanDraft>

/** Read a workload with the configured account; ownership is enforced by the core.
 * @param id - Workload identity provided by the user or a core receipt.
 * @param signal - Caller cancellation.
 * @returns Owner-visible workload summary.
 */
workload(id: string, signal?: AbortSignal): Promise<ComputeWorkloadSummary>

/** Execute one already-admitted assignment through an exact local plugin version.
 * @param task - Versioned assignment received from the dispatch layer.
 * @param request - Controlled input provider, workspace limits, cancellation and result consumer.
 * @returns Result-consumer receipt after all local workspace files have been cleaned up.
 */
executeTask<T>(task: ComputeTaskEnvelope, request: ComputeLocalTaskRequest<T>): Promise<T>

/** Read a local task attempt without treating it as a remote completion receipt.
 * @param taskId - Local task identity.
 * @param attempt - Attempt number.
 * @returns Stored attempt state, or null when absent.
 */
task(taskId: string, attempt: number): Promise<ComputeTaskState | null>

/** Persist one lifecycle event for a local task attempt.
 * @param taskId - Local task identity.
 * @param attempt - Attempt number.
 * @param event - Lifecycle event to apply.
 * @param now - Canonical current UTC timestamp.
 * @returns Updated persisted attempt state.
 */
transitionTask(taskId: string, attempt: number, event: ComputeTaskEvent, now: string): Promise<ComputeTaskState>

/** Admit one verified passive offer through the unified scheduler and task store.
 * @param input - Verified offer and current scheduling context.
 * @returns Admission decision and persisted state when accepted.
 */
coordinateTask(input: EmployeeTaskCoordinateInput): Promise<EmployeeTaskCoordinationResult>

/** Cancel core reads and drain accepted local writes on plugin removal. */
async close(): Promise<void>
```

Source: [`packages/host/compute-core/src/service.ts`](../../packages/host/compute-core/src/service.ts)
<!-- END GENERATED cordis-surface -->

## 延伸阅读

- [算力核心包](../../packages/host/compute-core/README.zh.md) — 配置、本地存储、执行器和任务运行器。
- [远程设备](remote-devices.zh.md) — 配对机器的鉴权有限任务协同。
- [Cordis 目录](../cordis-api/service.zh.md) — 运行时共享的生成服务签名。

### 开发备注

生成区域通过现有分析器、投影器、渲染器及语言映射器限定 compute 包实际生成并逐字比较，可复用脚本已归档到项目交接收据。当时全仓生成器仍被其他 `connections`、`subagents` 和 `employeeSettings` 归属阻塞；这些归属现已修复，因此整个目录及其运行时 API 产物可以整体重新生成并通过校验，分页工作的记录见 `docs/dev-plan/` 下的报告。
