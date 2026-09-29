# 千手智能体桌面主控

[English](README.md) | 中文

这是独立的本机 Electron 主控，使用沙箱窗口加载已编译的 Harness web 工作台。应用单独拥有后端进程、数据目录、浏览器会话和单实例锁，不替换官方 Harness 桌面，也不接管已经运行的服务。

先构建仓库的 host、CLI 与品牌 web 前端，并确保 `apps/desktop/node_modules/electron` 的运行时已下载。运行 `node apps/qianshou-desktop/scripts/install-mac.mjs`，即可安装 `~/Applications/千手智能体.app`。安装脚本完成本机签名，把旧应用保留为带时间戳的备份，并写入私有安装回执。此命令保留为依赖稳定源码目录及已配置 Node 的开发安装方式；公开预览版使用下文独立便携打包器。

Host 编译与打包需要分别完成：只有 `lib/types` 无法满足 Loader 对 `lib/index.js` 或导出子路径的加载。增加 profile 插件或包导出后，需重建相关 Host 包，并在启动前验证已安装桌面端所用的 web profile；详见 [Loader 入口构建记录](../../.agents/notes/implemented/bug-fix/2026-09-13-qianshou-loader-entry-builds.zh.md)。

默认源码在 `~/.local/share/qianshou-agent/source`，数据在 `~/.local/share/qianshou-agent/home`，使用 web profile，地址为 `127.0.0.1:3081`。可在 `~/.local/share/qianshou-agent/desktop/config.json` 覆盖 sourcePath、nodePath、home、port，或通过 `QIANSHOU_SOURCE`、`QIANSHOU_NODE`、`QIANSHOU_HOME`、`QIANSHOU_PORT` 设置。安装时记录终端的 PATH，确保从 Finder 打开时仍能找到开发工具；可用配置的 path 或 `QIANSHOU_PATH` 覆盖。应用拒绝使用原服务端口 3080，也拒绝公开网络监听。退出只清理本桌面端启动的后端：POSIX 上为进程组，Windows 上为对应 PID 拥有的进程树。端口被占用时明确报错，不接管已有服务。

认证地址仅在内存中读取；`home/desktop-logs` 的日志脱敏 URL token，在 POSIX 上申请 0600 权限，Windows 上的访问取决于目录的账号权限。麦克风只对可信主页面的音频请求开放。预加载接口仅提供 `window.qianshouDesktop.openRustDesk(id)`：ID 必须为 6–12 位数字，使用已安装的 RustDesk 执行 `--connect`，返回进程启动成功 `{ok:true}` 或错误 `{ok:false,error}`，不提供任意命令或文件系统 API；启动成功不代表已连通远端或已获远控授权。可用 `QIANSHOU_RUSTDESK` 设置 RustDesk 可执行文件的绝对路径。

ESM 入口在等待 Electron ready 前完成模块求值。运行 `node --test apps/qianshou-desktop/tests/*.test.mjs` 检查 ESM 入口先完成加载再响应 ready、真实子进程启动、取消、退出清理、端口隔离、日志脱敏与权限规则。Windows 主控提供下文说明的独立便携预览版，尚未提供 Linux 主控包。

本次 Mac 交付已完成安装与工作台窗口的初始启动，具体日期、证据和剩余检查见[本机交付验证记录](../../QIANSHOU_VERIFICATION.md)。系统麦克风授权、真实麦克风与扬声器表现、实际远程桌面会话仍需在设备上验收；进程测试和自动化浏览器测试不代表这些项目已通过。

受信 preload 还提供可选中转能力，用于原生注册信息导入、明确启用或关闭，以及不含凭据的状态查询。每次启动时中转都关闭。设置与安全细节见[中转指南](relay/README.zh.md)。

## 便携预览版

产品版本 0.2.1 与底层 Harness 引擎版本分别记录。先用 `node apps/desktop/scripts/prepare-runtime.ts` 准备经过校验的官方 Node/pnpm 运行时。完整构建 Host 后，将 `QIANSHOU_WEB_DIST` 指向干净的品牌 web 构建，运行 `node apps/qianshou-desktop/scripts/package-mac.ts`。`QIANSHOU_RELEASE_OUTPUT` 可选择新输出目录，已有产物绝不覆盖。打包器只读取已安装依赖图，不执行安装器或改写工作区包管理器状态，保留各包许可证，只复制工作区声明的运行文件，并生成包内相对依赖链接。唯一版本的第一方插件也暴露在运行时根目录，以支持 Cordis 动态加载 profile。

两个主控打包器都根据[中转锁文件](relay/frpc.lock.json)加入公共中转模块、Apache 许可的 FRPC 及显式 ISRG 根证书。归档、可执行文件、许可证和 CA 的哈希均按目标平台校验，绝不将源码中的 Mac 可执行文件用于 Windows。`QIANSHOU_FRPC_CACHE` 可指定包含已锁定官方归档的缓存目录。登记令牌、测试和源码生成清单不进入包内；每个包独立生成目标平台清单。认证及运维限制见[专用中转服务](../qianshou-relay/README.zh.md)。

macOS arm64 预览版内含 Electron、Node、pnpm 与完整 web profile。分发启动按移动后的应用位置解析不可变资源，忽略旧源码/Node 覆盖，保留用户数据目录，并在 PATH 前加入内置工具。帮助菜单打开包内快速入门与可选本地语音安装说明。语音资源从安装器拥有的路径清单读取，现有环境与显式 Host 配置优先。预览版仅做临时签名，没有 Apple 公证。发布前必须通过全新数据目录的认证启动、前端加载与所拥有进程的退出清理；单测或 `--version` 不代表运行依赖完整。参阅包内 `QUICK_START.md` / `QUICK_START.zh.md` 与[打包说明](../../.agents/notes/implemented/feature/2026-09-13-qianshou-portable-preview.zh.md)。

## Windows x64 预览版

未签名的 Windows 主控按 [Electron 44.0.0 平台要求](https://github.com/electron/electron/blob/v44.0.0/README.md#platform-support)面向 Windows 10/11 x64。ZIP 通过 `QianshouAgent.exe` 启动，包含 Windows Node 程序和目标平台原生依赖。Windows 真机启动与端到端验收尚未验证，发行保留 `verified: false`。用户安装与手动检查见 [Windows 快速入门（可切换中文）](QUICK_START.windows.md)。

Windows 打包器使用已准备的 `win-x64` 运行时、经过校验的 Electron 归档、干净的品牌 web 构建及经过验证的目标原生包覆盖。在仓库根目录的 POSIX 构建终端运行 `QIANSHOU_WEB_DIST=<clean-web-directory> QIANSHOU_WINDOWS_NATIVE_OVERRIDES=<overrides.json> QIANSHOU_RELEASE_OUTPUT=<fresh-output-directory> node apps/qianshou-desktop/scripts/package-windows.ts`；包内脚本 `package:windows` 指向同一入口。发行打包负责人执行此操作，分别记录归档、原生文件及依赖解析证据，不将它们等同于目标系统验收。输出目录已经存在时会拒绝打包。

Windows 分发启动解析 `resources/runtime/node/node.exe`，将继承的 `Path`/`PATH` 合并为子进程环境中的一个条目；除非配置了数据目录覆盖，否则保留 `%USERPROFILE%\.local\share\qianshou-agent\home`。主控使用既有 [PowerShell 执行器](../../packages/shell/pwsh-local/README.zh.md)，不新增仅支持 CMD 的执行器。退出等待限定 PID 的 `taskkill /T /F` 辅助程序和后端结束；失败或超时会显示并记录错误，不视为清理成功。

打包器将 Windows 专用快速入门及语音指南映射为普通包内名称，并改写中英配对链接，不包含 Mac 语音安装器。系统 TTS 取决于可用的 Windows 声音，听写和连续语音需要另外配置识别资源。平台限制及验证责任见 [Windows 语音指南（可切换中文）](voice/README.windows.md)和 [Windows 主控决策](../../.agents/notes/implemented/feature/2026-09-13-qianshou-windows-controller.zh.md)。
