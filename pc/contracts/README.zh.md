# contracts/v1 · 千手跨边界契约的固定副本

[English](README.md) | 中文

**唯一源在算力仓，此处为固定副本，不得手改。**

| 项 | 值 |
|---|---|
| 来源仓库 | 千手算力私有源码快照。抓取时 `contracts/` 尚未提交，因此没有 Git blob 可引用；以下按文件内容哈希对账。 |
| 来源路径 | `contracts/v1/*.json`（10 个文件）；总览与三个设计决定见来源仓 `contracts/README.md` |
| 复制时间 | 2026-09-21T21:39:24+0800 |
| 复制方式 | `cp` 后 `chmod 0444`；未改动任何字节 |
| 校验命令 | `shasum -a 256 contracts/v1/*.json`（下表为该命令在本仓与来源仓的真实输出，两边逐字节一致） |

## SHA-256

```
c13753c0ed880f76e12ea701443f1c0aceb40d78e6fcf1fc71691bb3f382475e  contracts/v1/capabilities.registry.json
64d8e666a5674d605f5bec7340ed73dc2d21157a00ad27c42fd648effa2c64d9  contracts/v1/capability-manifest.schema.json
27b52cac73e6ab3a1ac84907b415c1fce72bf5a0955b56c162a1c2d7c8d27808  contracts/v1/capability.schema.json
3f71b35e5ace280dc43a6a9f26ab232ac6213cbd6da593c42f61f7241d128e80  contracts/v1/identity.schema.json
d5cf5b120173301be00b83db5ac44abad813fa0f80ea3c1a0da96540bc1e75da  contracts/v1/intent.schema.json
6c8d30d98244cba599d2d0ed179313d48bb37db013c808c63a5ca4bdbb384d24  contracts/v1/ledger.schema.json
9aa6f3a7e901bd0b866a4595e95e01e2890fe11ee3a71d739cb752c794b9c101  contracts/v1/offer.schema.json
a81b53dc6723753d3c2884aa8ced953f2621cb18dcd7928e54e39f66ae258330  contracts/v1/result.schema.json
914be467e9ad4fc7888e39ae578d8b44f557c959518dafaddb0481b9d4c1e2b1  contracts/v1/route-plan.schema.json
361cd6319e111917e805ccf486e8c864ba940744b7f98ed97f9f16d7f817af5c  contracts/v1/task.schema.json
```

## 本仓怎么用它

- 不手写第二份 TS 类型或 Python dataclass。需要类型时从 JSON Schema 派生；需要校验时用仓内既有的 JSON Schema 校验器（`packages/core/tools/src/json-schema.ts` 的 `assertSupportedJsonSchema` / `validateJsonSchemaValue`，十份文件都在它强制的子集内）。
- `packages/host/qianshou-capability` 在插件加载时读取 `capabilities.registry.json`（能力名、标题、`legacy_task_types` 落地名）和 `intent.schema.json`（`goal` / `budget` 子节点）；文件缺失或结构不符会在加载时报错，不会静默退化为空目录。
- 更新副本只有一种方式：从来源仓重新 `cp`，重算 SHA-256，改写本文件的时间与哈希表。**不要**在这里修字段、补枚举或"顺手"改描述——那会把升级变成"有格式契约、无词汇纪律"。

## 边界

- 契约描述的是平台 ↔ 节点线上传输层对象；上海现网 `GET /api/v8/capabilities` 与 `POST /api/v8/economy/estimate` 的响应字段不是这些 schema 的实例。本仓 Host 对服务端响应做白名单投影并记录字段出处，不把服务端字段冒充成契约对象。
- 来源仓 `contracts/README.md` §6.1 列出的三个未解问题（多实现 OR/AND、语义名空间归属、`min_version` 单位）在本副本中同样未解。
