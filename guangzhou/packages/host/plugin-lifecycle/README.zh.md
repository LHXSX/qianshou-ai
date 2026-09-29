---
description: "在经过核验的千手能力插件上执行可回滚的暂存、激活、停用和移除生命周期。"
kind: "package-reference"
---

# 千手插件生命周期

[English](README.md) | 中文

<a id="use-this-package"></a>

## 概述

在 `compute-core` 生成已核验安装方案后，协调能力插件的本地生命周期。本包核验暂存元数据和不透明文件，按插件身份串行化操作，并记录 active、disabled 或 rolled_back 状态。部署代码负责传输、文件系统原子性、进程隔离和 Loader 注册；本包绝不求值插件字节。

## 目录

- [使用方式](#use-this-package)
- [生命周期边界](#lifecycle-boundary)
- [持久化已验证的包](#persist-verified-packages)
- [离线安装真实包](#install-real-package)
- [Model Experience](#model-experience)
- [已知限制与待完成工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="lifecycle-boundary"></a>

## 使用方式

把 `planCapabilityPluginInstall` 返回的 `ComputePluginInstallPlan` 传给 `PluginLifecycle.install`。提供包含 `readStagedPackage`、原子 `activate`、`deactivate` 和 `remove` 方法的部署适配器。`CordisLoaderDeployment` 是真实 Cordis Loader 的具体接缝：暂存回调提供已经扫描过的 `entrySpecifier`，适配器再调用 Loader 的 `create`、`update({ disabled: true })`、`remove` 和 `await()`，并把 fiber 排空作为状态转换屏障。适配器可以在本包之外获取或解包字节，但必须只提交准备激活的暂存包。

<a id="persist-verified-packages"></a>

## 生命周期边界

`PluginLifecycle` 在激活前核验暂存 manifest 指纹、包摘要、允许的相对路径和确定性的文件摘要。它拒绝路径穿越、重复文件和额外文件。同一身份及相同内容的重复安装是幂等的；同一身份的操作会串行化。激活失败会尝试停用和清理，然后保留 `rolled_back` 收据。停用保留暂存数据以便重新激活；卸载会停用并移除数据。

生命周期不会下载、导入、求值或执行代码。部署适配器必须负责目录原子替换、崩溃恢复、资产扫描、操作系统进程隔离和运行时 Loader 注册。`CordisLoaderDeployment` 只接受部署适配器选出的受信 specifier，不会从包字节推导导入路径。上海继续只承担元数据控制面。

<a id="persist-verified-packages"></a>
<a id="install-real-package"></a>

## 持久化已验证的包

把 `LocalPluginStore` 作为 Host 自有部署适配器的文件系统暂存提供者。为它指定私有 `root`、正整数 `maxBundleBytes` 和 `maxFileCount`。用签名核验过的 `ComputePluginInstallPlan` 和全部载荷字节调用 `stage`，再把 `readStagedPackage` 作为部署的暂存回调。该存储会核验规范化相对路径、精确文件集、资源上限、manifest 指纹和字节摘要。它拒绝符号链接，并通过重命名提交完整的内容目录；它既不解析可执行入口，也不运行代码。

Host 完成真实激活或停用后，可以用 `setInstallation` 保存机主偏好。`getInstallation` 在重启后读取该偏好；`desiredState: enabled` 不构成存在活跃 Loader 或已核验可广告能力的证据。Host 必须重新核验发布者信任与机主授权、获取新的安装计划、重新校验存储字节、通过真实 Loader 激活，并自检能力，然后才可对外广告。`forgetInstallation` 只在 Loader 停止后移除重启偏好。不可变载荷仍然保留，用于经明确授权的版本回滚。

`verifyStagedPluginPackage` 会针对完整暂存字节重新校验此前已授权的计划；在持久化或将字节交给受信 Loader 适配器之前使用它。

每个安装身份都包含插件与版本。该存储不决定哪个版本可以并发运行。调用方拥有该策略以及替换前的 Loader 排空责任；原子收据不会让文件系统持久化与进程激活变成同一个事务。被中断的暂存目录永远不会被选作已提交包。

<a id="install-real-package"></a>
<a id="model-experience"></a>

## 离线安装真实包

`PluginPackageSource` 是传输接缝：它按已核验方案产出一份不受信任的文件清单，并且从不写入插件存储。本包提供三种来源。

- `DirectoryPluginPackageSource` 读取已解包的目录树。
- `ArchivePluginPackageSource` 通过 `readPluginZipArchive` 读取本地 `.zip`。该读取器不依赖外部库，只接受 stored 与 deflate 两种方式，并拒绝加密、Zip64、多磁盘归档、符号链接或特殊文件条目、路径穿越与绝对路径、重复名称、CRC 或大小不符以及超预算的包。
- `StaticPluginPackageSource` 返回调用方已持有的条目。

本包不提供 HTTPS 下载器：真实市场端点需要真实服务器，本包不得假装已抓取某个 URL。

`loadVerifiedPluginPackage` 把这些字节变成 `StagedPluginPackage`：统一执行同一份字节预算（`PluginPackageLimits`：文件数、单文件字节、总字节），核验规范化相对路径，按已签名方案重算整包摘要，并逐项核验 `contract.assets`（存在性、字节大小、sha256）。包只承载载荷文件：声称自身包摘要的 manifest 文档必须覆盖写着该摘要的文件本身，这是散列不动点，因此身份来源仍然是已签名方案。

`LocalPluginInstaller` 在 Host 私有根目录下原子提交该包：

```
<root>/generations/<identityKey>/<packageDigest>-<manifestFingerprint>/
<root>/receipts/<identityKey>.json
<root>/journal/<identityKey>.json
<root>/.staging/<name>/
```

它先暂存并 fsync 载荷，把它 `rename` 进按内容寻址的代目录，重新读取并重算磁盘上的散列，向 `PluginLoaderRegistry` 接缝索取经过校验的 Loader specifier，原子写入收据，最后删除 journal。收据是可见性提交点。`recover()` 是 Host 启动步骤：它会删除无人引用的暂存目录、回滚尚未写入收据的晋升（保留此前已提交的代）、清理已提交事务遗留的 journal、移除孤儿代，并撤回任何字节已不再核验通过的安装。存在遗留 journal 时 `install` 会以 `PLUGIN_INSTALLER_RECOVERY_REQUIRED` 失败，而不是覆写未完成事务。

`uninstall` 先通过注册表撤销广告，再等待可选的 Host `awaitInFlight` 钩子，最后才删除收据与载荷，因此在途任务不会失去自己的文件。先删收据再删载荷，可以避免崩溃后继续广告已经失效的字节。

`PluginLoaderRegistry` 是接缝而非 Loader。`InMemoryPluginLoaderRegistry` 只记录注册并校验 specifier；接入真实 Cordis Loader 仍是 Host 侧步骤，本包不声称任何插件已被加载或执行。

<a id="known-limitations-and-deferred-work"></a>

## Model Experience

本包不提供模型工具，也不提供付款或审批回调。宿主可以通过用户鉴权 UI 或独立市场消费者展示生命周期记录。

<a id="dev-note"></a>

## 已知限制与待完成工作

- `PluginLifecycle` 把实时执行状态保留在进程内。`LocalPluginStore` 会持久化已验证的字节与期望状态，但 Host 必须在重启后对账真实 Loader 状态；持久化偏好既不能授予权限，也不能证明能力就绪。
- 真实市场端点、HTTPS 下载、发布者密钥轮换、沙箱策略和移动端安装适配器尚未在此实现。包摄取刻意仅限本地。
- `recover()` 会撤回字节不再核验通过的收据，但不会撤销 Loader 广告；请在启动阶段、任何广告出现之前运行它。
- Cordis 适配器仍依赖宿主提供的 Loader 实例。`InMemoryPluginLoaderRegistry` 只记录注册，不加载任何内容。
- 生命周期成功收据不能证明本机能够运行原生 H3、图像或视频执行器。

### 开发备注

源码和测试刻意把包字节保持为不透明数据。不要向本包加入便捷导入或 Shell 执行路径；这些职责必须放在单独评审的部署适配器中。
