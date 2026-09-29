---
description: "千手开发节点的内联执行与生命周期回传。"
kind: "reference"
---

# 千手开发节点

[English](README.md) | 中文

## 概述

[守护入口](node-daemon.mts) 将已明确授权的设备连接到 Edge 调度中心。默认暂停，使用实测宿主供给和明确的任务范围。该源码入口不证明桌面安装包已发布，也不代表自主智能体执行器已经实现。

## 执行

[派单处理器](execute-offer.ts) 接收 `word_count` 及其 `text.transform` 别名的内联文本。不支持的类型、空值内联输入和文件引用会在上报执行前拒绝。它不下载 `code_url`。传输层单独约束配置的任务范围与运行模式。

守护进程把已准入的派单交给接单代理。代理用自己的时钟减去 `startedAtMs`，缺省时钟是 `Date.now`；起点必须是同一次时钟的读数。`execute-offer.ts` 自己的耗时仍用一对 `performance.now()` 测量。

这条处理器在执行前用原始任务凭据发送进度为零的 `shard_progress`。它的结果耗时由单调时钟测量，单位为毫秒。发送回执只表示 `sent-awaiting-verification`；验收、执行计数和结算归上海管理。同一任务分配的重复成功投递由现有传输层去重。

执行或结果提交失败会发送 `EDGE_EXECUTION_FAILED`，不包含原始异常或任务正文。进度或失败帧发送失败会向连接所有者抛出。取消的连接不能发送迟到完成。内置执行为同步处理，不提供计算中途取消或模型规划循环。

## 验证与限制

[测试](tests/execute-offer.spec.ts) 通过测试独占的本地 socket 运行真实传输层，并将发出的进度与结果帧和[预期报文](tests/expected/execution-success.json) 比较。覆盖实测耗时、不支持的输入、取消、重复成功投递及结果大小失败。这些测试不证明生产数据库更新、安装包安装或业务结算。

供给探测描述已安装的工具与软件包。该处理器不能执行探测所广告的全部能力；能力广告与执行器覆盖仍须单独核对。

## 本机状态出口

[状态端点](node-status-server.ts) 只绑 `127.0.0.1`，把"这台节点在做什么"交出去，使主人自己的界面（以及后续的 PC 客户端）读机器数据，而不是去解析终端输出。`GET /status` 返回[快照](node-status.ts)：连接状态与原因、已上线时长、正在跑的分片、收到/接单/成功/失败/拒绝计数、最近一次拒绝、以及带轮询核验结论的最近结果。`POST /command` 只收主人的两条命令：`{"command":"tasks"}` 与 `{"command":"abort","target":"<shardId>"|"all","reason":"..."}`。中止复用已有的拒绝帧并携带 `EDGE_CANCELED_BY_OWNER`，记录为 `canceled-by-owner`，既不计为失败，也不安排重试。

只绑回环地址是硬要求而不是默认值：`startNodeStatusSurface` 根本没有 host 参数，非回环来源会被显式授权检查拒绝，带浏览器 Origin 的请求一律拒绝，可选口令只从 `QIANSHOU_NODE_OWNER_PROOF` 读取。快照把预计收益如实报为"不可得"而不是猜一个数字，因为派单帧里没有价格字段。

## 延伸阅读

- [执行回传决策](../../.agents/notes/implemented/bug-fix/2026-09-19-node-execution-reporting.zh.md)。
- [算力核心](../../packages/host/compute-core/README.zh.md)。
