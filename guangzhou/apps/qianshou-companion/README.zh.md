# 千手协作端

[English](README.md) | 中文

千手协作端是千手智能体的独立被控端。它主动连接主控，展示本机授权的工作目录和收到的任务，只有用户在本机点击批准后才执行。主控浏览器的身份与设备身份分开验证，设备没有开放监听端口。

## 启动与配对

在仓库根目录安装工作区依赖并构建主控插件后，在本目录执行 `pnpm build`、`pnpm start`。macOS 安装 Python 3 后可执行 `pnpm package:mac` 生成 `dist/千手协作端.app`；该脚本复用 `apps/desktop/node_modules/electron` 中的 Electron，只产生本地临时签名，尚未进行 Apple 公证。Windows 和 Linux 使用同一 Electron 源码；无需运行其二进制即可制作便携包，但目标系统上的启动与操作仍需另外验证。

macOS 打包器将本目录 `package.json` 中的产品版本写入应用元数据，包括 `CFBundleShortVersionString` 和 `CFBundleVersion`。产品版本由三段数字组成，与内置 Electron 运行时版本分别记录。

所有发行打包脚本都会在应用元数据中写入 `name: qianshou-companion` 和 `distribution: bundled`。更新器要求这些标记及有效的产品版本；源码启动或元数据不可读时保持禁用。这一明确边界也支持 macOS 的 `Electron` 可执行文件名，因为 Electron 的 `app.isPackaged` 文件名判断会把它视为开发运行。

## Windows 和 Linux 便携包

执行 `pnpm build` 后，在具备 Python 3 和 curl 的机器执行 `python3 scripts/package-portable.py win32 linux`。脚本直接从官方 GitHub release 下载 Electron 44.0.0 x64，同时核对 release API 的 SHA-256 与 `SHASUMS256.txt`，检查应用可达导入图，并在 `dist/portable` 输出 Windows ZIP 与 Linux tar.gz。脚本至少保留 4 GiB 磁盘空间，拒绝覆盖已有最终压缩包。相邻 `runtime-cache` 目录复用已校验的运行时下载，也可通过 `--output` 指定其他输出目录。

每个压缩包内含中英文启动说明、运行时原有许可证、`BUILD_MANIFEST.json` 和逐文件校验清单；外部发行 manifest 记录最终压缩包 SHA-256。Windows 用户完整解压后启动 `QianshouCompanion.exe`，Linux 用户解压后在图形桌面会话执行 `./start-qianshou.sh`。包内明确标记**已打包，未在目标系统启动验收**，不提供签名安装器；更新通过帮助菜单进行。Linux 需要匹配的 Electron 桌面库、可用的 Chromium 沙箱和安全密钥服务，启动脚本不会关闭沙箱。Windows 可执行文件沿用运行时文件图标，产品图标另附为 `qianshou.png`。

各平台打包器共用 `scripts/bundle_files.py`，只复制可达 JavaScript 依赖图及必需静态资源。运行时仍引用仓库依赖或缺失分块时，打包会失败；过期编译文件不会进入发行包。可将独立 `peer` 和 `executor` 模块复制到临时目录后导入，以验证无需工作区依赖也能加载。

先在协作端中选择允许进行文件操作的目录。在主控的设备页面生成五分钟有效的一次性配对码，将主控地址、设备名称和配对码输入协作端，再点击连接。完成配对后，后续连接使用系统安全存储加密的设备凭证；主控只保存其 SHA-256 摘要。协作端启动时不会自动连接，用户可随时断开或删除本机配对记录。删除本机记录不等于撤销主控上的旧设备，应同时在主控设备页面撤销。

`http://127.0.0.1:3081` 仅适用于在同一台机器验证双端。不同机器必须填写可访问且证书有效的 HTTPS 地址，协作端将使用 WSS；应用不会禁用证书校验、自动开放路由器端口或安装 VPN。主控默认保持本机监听，真实跨网连接需要另行配置经过认证的网络入口。

使用广州中转时，主控持有人先在设备页导入私有中转配置并启用。对方只接收公开 HTTPS 地址与新的配对码，不接收中转注册凭据。配对和本机任务批准仍然必需。此中转承载设备任务与回执；RustDesk 屏幕传输仍使用独立连接。

Mac 打包脚本接受 `QIANSHOU_COMPANION_MAC_OUTPUT`，可指定隔离的发行应用路径，拒绝空值或纯空白值，并拒绝覆盖该明确指定的输出。

## 发行包本机回环验收

标准 Web CLI 与协作端完成构建、Mac 协作端安装后，在本目录执行 `node scripts/verify-packaged-loopback.mjs`。脚本把已安装协作端模块复制到隔离临时目录，以全新 `DSH_HOME` 启动 `apps/cli/lib/bin.js --profile web --host 127.0.0.1 --port 0 --no-open`，再用启动 URL 换取已认证的浏览器 cookie，全程不打印两种凭据。它通过正式 HTTP 配对和真实设备 WebSocket 路由，验证测试脚本明确批准后的命令与文件读取回执、执行前取消及设备撤销。结束时移除临时主目录、工作目录、凭据、监听端口和子进程，并写出 `dist/PACKAGED_LOOPBACK_RECEIPT.json`。脚本不调用模型，也不导入用户 API 凭据。这验证的是同一台机器上的发行代码行为，不代表界面批准、其他操作系统、跨电脑网络或 RustDesk 桌面会话已经验收。

## 操作与权限

`list`、`read`、`write` 文件任务只接受授权目录中的相对路径，拒绝路径穿越和符号链接；读写单文件限制为 512,000 字节，目录最多返回 1,000 项。写入使用临时文件替换，不自动创建目录。设备上拥有本机文件系统权限的其他进程仍可能改变目录，工作目录限制不是操作系统级别的隔离。

`command` 命令任务显示完整命令，由本机用户逐条批准。工作目录只是命令的起点，命令以本机登录用户权限运行，可以访问该用户有权限访问的其他目录；当前版本不宣称提供 shell 沙箱。一次只执行一个任务，命令最长运行五分钟，输出保留最近 100,000 字符。取消、断线或退出会终止本次命令及其进程组，任务状态与取消请求分别记录。

`desktop` 任务经本机批准后，打开已经安装的 RustDesk，尝试读取其公开连接 ID 并回传。主控使用该 ID 打开自己的 RustDesk；桌面图像、键鼠与远程访问确认由 RustDesk 处理，千手协作端不设置密码、不跳过确认、不代替系统屏幕权限。macOS 同时查找 `/Applications` 与当前用户的 `~/Applications`。RustDesk 未安装时任务会明确失败。macOS 需要用户授予屏幕录制与辅助功能等权限，Linux Wayland 和登录界面的支持范围以 RustDesk 官方说明为准。

## 连接和结果

任务以稳定 ID 去重，传输完整输出快照，回执确认后才从待发送队列移除。断线不会自动重新执行命令；协作端进程重启时把未结束任务标记为 `interrupted`，重新连接只同步状态。撤销设备会立即使其旧凭证失效。收到替换连接或认证错误后停止自动重试，避免旧实例抢占新实例。

协议位于 [remote-devices](../../packages/host/remote-devices/README.zh.md)，实现取舍与远程部署验证清单位于 [远程协作设计](../../docs/qianshou-remote-devices.zh.md)。当前本机自动化测试验证真实 WebSocket 双端和执行器；它不等于另一台 Windows/Linux 设备已经安装、联网或完成桌面接管验收。

## 通过主控交付安装包

打包后，使用明确的运行目录执行 `python3 scripts/prepare-downloads.py --output "$DSH_HOME/qianshou/companion-downloads"`。脚本暂存既有的已校验 Windows/Linux 归档与本机已签名 Mac 应用的 ZIP，再发布 `manifest.json`；至少保留 4 GiB 空闲空间，并拒绝覆盖内容不同的已有归档。首次安装下载路由代码后需重建或重启主控；后续归档更新可直接读取清单，无需重启。

主控的「协作设备 → 客户端下载与接入指引」提供经过认证的下载、校验值和平台说明。主控方下载后把完整文件交给另一台电脑；接收方不需要主控浏览器会话、API 密钥、源码、Node.js 或 Python。macOS 用户解压并把应用移入「应用程序」；当前临时签名版本未经 Apple 公证，接收方需通过系统自己的打开流程确认来源。Windows 用户运行完整解压后的 `QianshouCompanion.exe`；Linux 用户使用解压后的图形会话启动脚本，并满足桌面、沙箱和凭据存储依赖。

配对说明需要新的配对码及非回环 HTTPS origin。页面明确标注连通性仍需另一台电脑实际连接验证，不会把 `127.0.0.1`、浏览器认证令牌或私有下载入口变成接收方地址。应用不会创建公开入口或打开路由器端口。配对后应先发送查看目录任务，确认本地审批和实际结果，再使用命令或桌面控制；RustDesk 和操作系统权限仍是独立条件。


## 预览版发行验证

0.2.1 压缩包声明预览渠道，保留 DeepSeek MIT、ws MIT 与 Electron/Chromium 许可说明。Mac 使用临时签名，不代表 Apple 公证。运行 `node scripts/verify-packaged-loopback.mjs <companion-app-resources> <controller-cli> <bundled-node>` 可使用最终主控运行时，替代默认源码 CLI。此隔离测试启动全新的临时 HTTP 服务，将打包协作端模块移到仓库之外导入，验证配对、本机批准、执行、回执、取消、撤销授权和所拥有进程的退出清理。它不会打开两端 GUI、使用模型密钥，也不代表跨电脑或跨网络验收。

## 应用内更新

“帮助 → 检查软件更新”打开与主控一致的更新窗口。新版后台下载、验签，待本机审批、任务执行和记录保存全部空闲后，点击“重启升级”。准备切换时暂停接收新任务；取消或超时会恢复接收。更新使用独立目录，不覆盖设备授权记录，也不接收主控或运营方的 LLM 密钥。首个支持应用内更新的版本为 0.2.1，旧版需先正常安装一次。完整验证与进程切换规则见 [共享更新器](../qianshou-updater/README.zh.md)。
