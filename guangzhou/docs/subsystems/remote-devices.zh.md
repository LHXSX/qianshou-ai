# 远程设备

[English](remote-devices.md) | 中文

远程设备子系统通过 `ctx.remoteDevices` 协调已配对的协作电脑和有限任务。[Host 协调器](../../packages/host/remote-devices/README.zh.md)负责设备认证与持久回执；[协作端](../../apps/qianshou-companion/README.zh.md)负责本机批准和执行。远程工作区路径始终是对端元数据，不表示主控机器上的目录。

## 公开记录

`DeviceInfo` 包含配对身份、显示名称、平台、架构、公布的工作区、连接状态与观测时间，不暴露凭证或配对码。`RemoteJob` 包含实际请求身份、目标、操作、载荷、状态、时间和输出；可选 result 与 error 字段记录对端结果。`cancelRequested` 独立于终态记录取消意图。精确定义和输入限制由 [protocol.ts](../../packages/host/remote-devices/src/protocol.ts)负责。

## 任务生命周期

提交会验证请求及已授权工作区，持久化 `awaiting-approval` 任务，再发送给在线对端。返回的回执仅确认已接受。读取状态不启动或重试执行。取消会记录并转发请求；对端终态回执决定任务是已完成、失败、被拒绝、被取消或被中断。配对与撤销仍是经过认证的人工操作，不属于面向模型的服务。

重连会同步保留的任务和回执，不授予自动执行权限。这些有限任务不向另一台机器派发 Harness Session 或子智能体。部署前置条件与原生机器验收边界见[远程协作](../qianshou-remote-devices.zh.md)。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxremotedevices--remotedevicesservice"></a>

### `ctx.remoteDevices` — `RemoteDevicesService`

Authenticated task coordination without access to pairing secrets or device revocation.

```ts cordis-catalog
/**
 * Read public device metadata without exposing credentials or pairing codes.
 * @returns Cloned devices including connectivity and advertised workspace IDs.
 */
devices(): DeviceInfo[]

/**
 * Persist a validated task before delivering it to the selected online peer.
 * @param value - Untrusted finite task request, validated by the coordinator.
 * @returns The actual task in awaiting-approval state; acceptance does not mean execution.
 * @throws If the device is offline, its workspace is absent, input is invalid or task capacity is exhausted.
 */
submit(value: unknown): Promise<RemoteJob>

/**
 * Read a retained task receipt without starting or retrying work.
 * @param id - Existing task identity.
 * @returns A cloned receipt, or undefined when the task is absent or no longer retained.
 */
task(id: string): RemoteJob | undefined

/**
 * Record a cancellation request and forward it to an available peer.
 * @param id - Existing task identity.
 * @returns Request acceptance; a terminal receipt still determines the execution outcome.
 * @throws If the task is unknown or persistence fails.
 */
cancel(id: string): Promise<{ accepted: true }>
```

Source: [`packages/host/remote-devices/src/service.ts`](../../packages/host/remote-devices/src/service.ts)
<!-- END GENERATED cordis-surface -->
