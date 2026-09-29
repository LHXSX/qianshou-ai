---
description: "校验千手发布签名并下载与当前平台匹配的归档，供桌面端暂存和切换版本。"
kind: "package-library"
---

# 千手签名更新

[English](README.md) | 中文

## 概述

两个桌面应用都可以检查官网发布清单，为当前角色、操作系统和架构下载经过认证的归档。检查更新不会下载或安装归档。下载操作会验证完整归档后才返回缓存路径。安装与进程重启由桌面端的暂存和引导模块负责。

## 目录

- [使用核心模块](#use-the-core)
- [了解验证机制](#understand-verification)
- [暂存与切换版本](#stage-and-activate)
- [已知限制](#known-limitations)
- [模型体验](#model-experience)
- [开发备注](#dev-note)

<a id="use-the-core"></a>
## 使用核心模块

从 [manifest.mjs](manifest.mjs) 导入 `checkForUpdate(target, options)`，传入已安装应用的 `role`、`platform`、`arch` 和 `currentVersion`。结果为 `available`、`current` 或 `unsupported`。可用更新包含签名发布信息、选中的归档，以及编码为 base64 的原始签名封装。应用通过 `options.signal` 传入取消信号；生产调用使用随应用安装的公钥和固定官网地址。

应用授权下载后，将原始可用更新对象传给 [download.mjs](download.mjs) 中的 `downloadUpdate(available, options)`。提供绝对路径的私有 `cacheDirectory`，与会话、设置和工作区分开。进度包含已接收字节、签名总字节及其比例；100% 表示传输完成，Promise 仅在验证完成后才成功返回。返回信息包含已验证路径、SHA-256、字节大小和用于暂存的签名封装。

读取持久回执时，使用 `Buffer.from(receipt.envelope, 'base64')` 解码封装，调用 `verifyReleaseEnvelope(bytes, target)`，然后调用 `verifyArchive(verified, archivePath)`。当前安装版本允许同版本验证；可选的 `currentVersion` 会拒绝更低版本。只有 `checkForUpdate` 能生成允许下载的结果，并且版本必须严格高于当前版本。重建或修改的选择对象不能绕过签名验证。

<a id="understand-verification"></a>
## 了解验证机制

清单地址固定为 `https://qianshousuanli.com/downloads/qianshou-agent/updates/latest.json`。[public-key.pem](public-key.pem) 固定 Ed25519 验签公钥，对应私钥不属于应用资源。schema-1 封装包含 base64 载荷字节及对这些原始字节的签名。无签名清单、不兼容的引导版本、重复目标、无效版本和不支持的格式均拒绝处理。归档 URL 必须精确匹配相同 HTTPS 来源与签名版本目录；重定向、凭据、查询参数、片段和编码路径替换都会被拒绝。

清单上限为 1 MiB，每个归档最大为 1 GiB。清单操作超时为 30 秒，归档传输超时为 15 分钟。发布时间超过本机时钟五分钟的清单会被拒绝。归档字节流式写入新建 0700 目录中的独占 0600 文件，验证精确大小和 SHA-256 后，通过同目录重命名发布。取消或失败只清理本次传输的私有目录。已有符号链接或 Windows 目录联接路径会被拒绝；POSIX 缓存的所有者和写权限也会被检查。

核心复用 Node 维护的 [Ed25519 验证](https://nodejs.org/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback)、[文件接口](https://nodejs.org/api/fs.html#fspromisesopenpath-flags-mode)和 [fetch](https://nodejs.org/api/globals.html#fetch)。测试注入临时公钥、固定时钟和 fetch 传输，不改变生产 URL 规则。核心失败通过稳定的 `UpdateError.code` 表达，不包含远程响应正文或私有文件系统路径。取消操作保留调用方提供的终止原因。

<a id="stage-and-activate"></a>
## 暂存与切换版本

[stage.mjs](stage.mjs) 将已验证下载安装到应用私有的 `updatesDirectory/versions` 目录。调用 `stageUpdate(download, { updatesDirectory, target, signal })` 后，回执包含原始签名封装和推导出的安装位置。macOS 使用完整 `.app`，Windows 使用完整便携目录，Linux 支持协作端的完整 `tar.gz` 目录。产品名称和执行入口来自固定角色/平台映射，不由可编辑清单或本地回执指定。已有安装和用户数据均不被覆盖。

归档检查完成后才开始解压。绝对路径、目录穿越、盘符路径、重复名称、大小写冲突、特殊文件、逃逸符号链接及链接下的文件都会被拒绝；Tar 硬链接不受支持。条目上限为 120,000 个，解压后总大小上限为 6 GiB。macOS 框架内部链接会保留，解压后的 `.app` 必须通过 `codesign --verify --deep --strict`。安装文件与认证归档内读取的 SHA-256 逐一对比，不信任可修改的本地哈希列表。`verifyStagedUpdate(receipt, options)` 在启动前重复完整检查，也检测额外文件，因此大更新会有可见的验证等待阶段。

在 Electron 内，暂存通过其内置 `original-fs` 读写和校验真实文件；普通 Node 辅助进程使用 `node:fs`。ASAR 资源保持归档中的完整字节，不作为虚拟目录处理，也不修改进程级 ASAR 设置。ZIP 和 tar 解析器在完整检查后提供条目数据流，暂存模块使用同一真实文件系统写入，并拒绝位于任何文件之下的成员。取消时会关闭本次归档输入与解析器，等待已开始的写入结束，再仅删除尚未完成的私有暂存目录。

[bootstrap.mjs](bootstrap.mjs) 管理 `pending`、`committed`、`active` 和 `failed` 回执。用户授权重启后，主进程先调用 `prepareActivation(receipt, { updatesDirectory, target, currentVersion, currentExecutable, currentPid })`，完成较慢的验证并记录待切换尝试，此时已有工作仍可继续。随后才取得任务维护租约，在 `launchActivation(activation, { helperExecutable, helperScript, electronRunAsNode })` 前后再次检查租约，并正常关闭应用；最终检查失败则取消待切换尝试。独立的 [runner.mjs](runner.mjs) 辅助进程等待该父 PID 退出，再启动完整新应用。Electron 可通过 `ELECTRON_RUN_AS_NODE=1` 运行辅助进程；真正的应用只接收清理后的系统会话环境，不继承该开关、`NODE_OPTIONS` 或 API 凭据。

启动时，`bootstrapUpdate({ updatesDirectory, target, currentVersion, currentExecutable })` 返回 `continue`、`wait` 或 `forward`。主进程在 `wait` 时不接受工作；在 `forward` 时通过辅助进程启动返回的 `activation`，并正常退出。待切换的新应用从 bootstrap 收到尝试身份。在启动后端或打开本地存储之前，必须等待 `acknowledgeDataAccess({ updatesDirectory, target, currentVersion, currentExecutable, attemptId, token })` 成功，将版本持久标记为 `committed`，因为启动本身也可能写入更新的数据格式；此状态不表示界面已就绪。后端和界面就绪、尚未接受工作时，以相同参数调用 `acknowledgeReady` 才将版本改为 `active`；协作端要求窗口就绪。回执通过刷盘临时文件和原子替换写入，POSIX 平台还会刷新父目录。

主进程仅在 bootstrap 返回 `pending: true` 时调用上述确认方法，重试 committed 版本时使用 bootstrap 返回的尝试身份。普通首次安装或已 active 的正常重启没有 pending 尝试，无需更新确认即可打开数据；更新中心仍在应用正常就绪后启动。

`cancelActivation(activation)` 只能取消尚未启动且身份匹配的 pending 尝试，例如最终维护租约检查失败时。正在等待父进程退出的辅助进程会观察到取消，不启动任何进程。新进程失败或就绪超时，只能在提交数据访问或就绪确认之前返回前一应用。辅助进程先要求自己启动的新子进程终止，再等待确认退出；子进程不响应会阻止回退。`committed` 和 `active` 版本均不会自动降级。若已 committed 的应用退出或始终无法显示界面，重新打开原安装只会重试同一已验证的新版本；bootstrap 会返回尝试身份以便重试就绪确认。辅助进程报告 `committed-not-ready`，不会宣称完成或启动旧应用。数据访问前的失败尝试不会自行反复重启，辅助进程也不会终止原应用。

<a id="known-limitations"></a>
## 已知限制

- 归档认证不能证明 Developer ID 签名、公证或另一台电脑上的成功运行；macOS 检查验证已有 ad-hoc 应用包的完整性。Windows 和 Linux 生命周期测试采用注入的进程实现，目标系统实机启动验收需要另行完成。
- 私有目录和链接检查保护更新缓存，但不能隔离已经具备同一用户完整文件权限的代码。Windows 的保密性依赖用户配置目录 ACL，而非 POSIX 权限位。
- 更换公钥需要通过可信应用更新分发替换公钥。核心拒绝降级，但不承诺在官网服务或网络不可用时获取最新发布。

<a id="model-experience"></a>
## 模型体验

此库不发送提示词、不调用模型，也不改变正在执行的智能体任务。

<a id="dev-note"></a>
## 开发备注

在源码根目录运行 `node --test apps/qianshou-updater/tests/manifest.test.mjs apps/qianshou-updater/tests/download.test.mjs apps/qianshou-updater/tests/stage.test.mjs apps/qianshou-updater/tests/bootstrap.test.mjs apps/qianshou-updater/tests/tar-cancellation.test.mjs`。这些测试使用临时目录、临时签名密钥、真实 ZIP/tar 文件、回环 HTTP 传输和注入的进程启动，不访问官网更新服务，也不修改已安装应用。发行构建将[桌面构建](../desktop/package.json)中精确锁定的 `yauzl` 3.4.0 和 `tar` 一并打入共享更新器与独立辅助进程，安装后的应用不依赖开发工作区中的依赖包。锁定的 ZIP 读取器使用标准 Node 数据流清理方式，支持随包 Node 运行时下的大型压缩条目。ZIP 解压在完整验证条目索引后，将原始文件名字节按严格 UTF-8 读取，也兼容未设置 UTF-8 标记的 Apple `ditto` 归档。
