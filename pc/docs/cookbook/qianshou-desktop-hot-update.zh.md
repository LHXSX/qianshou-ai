# 桌面更新

[English](qianshou-desktop-hot-update.md) | 中文

已安装的签名包固定产品身份、目标地址以及 `nightly`、`beta` 或 `stable` 通道。界面不能改更新 URL。初始 feed、清单、安装包与 blockmap 请求都固定为 `https://qianshousuanli.com`，拒绝包括 `www` 在内的跨域跳转与 HTTPS 降级。稳定版使用 `latest[-mac].yml`，内测使用 `beta[-mac].yml`，原 nightly 独立保留。千手与 DSH 的命名空间仍然隔离。

## 后台准备与安全重启

已打包的千手签名版检查固定通道，且本设备允许自动更新时，在后台下载一次完整安装包。平台签名与文件校验仍决定是否准备完成。重启需要用户另外点击确认；后台下载不会自行安装或中断任务。当前千手禁用差分下载，因为所固定的库另有差分跳转路径；发布器仍保留 blockmap，供未来验证后的协议使用。传输失败不自动重试。关闭自动更新的设备选择会跨防休眠设置变更和版本重启保留。

安装前，Host 同步关闭智能体、后台作业和媒体提交的准入。原任务 GET 轮询与交付仍可读。真实脱离 HTTP 的图像/视频执行、未解提交、供给节点任务、私有封装 API 的持久占位及已配置的本机 Comfy 队列，在忙或结果未知时阻止安装。普通智能体及后台作业中断沿用原来的明确确认。准备失败会释放维护门；更新锁不会更改用户授权、重投 GPU 请求或删除回执。

旧图片的失败历史本身不会永久锁住更新。本机 Comfy 空闲只证明该本机服务状态，不能证明远端 5080/H3 的未知提交已经完成。已知交付地址仅通过原 GET 恢复，不授权再次提交 GPU。ImageTrial 的原路径交付恢复和共享维护登记表已合入当前源码，并通过实建启动核对。

## 签名内测首次安装

第一个可持续更新的内测版需要完成签名，再通过可信安装器安装一次。在平台本机配置文件中设置 `QIANSHOU_DESKTOP_DISTRIBUTION=internal-beta`、`QIANSHOU_DESKTOP_UPDATE_CHANNEL=beta` 和 `DSH_DESKTOP_APP_ID=com.qianshou.desktop.internal`。打包仍要求正常平台签名及 Mac 公证；这种发行方式拒绝 `DSH_DESKTOP_UNSIGNED=1`。包内标记为 `dshDesktopInternalBuild=false`。

签名内测继续使用原默认 `Qianshou PC Internal/dsh-home`，并保留已有的明确 `DSH_HOME`，不会把会话复制到新 home。以前仅用于测试的用户数据目录覆盖需要明确迁移选择，不能自动猜路径。首次安装前保持原 home 不变并备份。原任务仍活跃时不要安装。首次签名版本必须高于已安装的 `0.1.6-alpha.2`；之后内测版保持同一 bundle 身份及可信签名人。Mac、Windows 的首次安装和更新验收分别留回执。

包内固定平台地址 `https://qianshousuanli.com/qianshou-desktop/feeds/{mac-arm64,mac-x64,win-x64}/`，内测文件为 `beta-mac.yml`、`beta.yml`。先发布不可变版本文件，再原子切换并验证通道。公网文件哈希、安装签名、旧版到新版更新及原 home 保留都验证之后，通道才是发布证据。不得开启无签名通道或生成替代密钥。

## 强制更新策略与证据

新版发送 `X-Client-Update-Protocol: qianshou.desktop-update-policy.v1`。强制策略必须逐项匹配包内 bundle ID、平台、架构、通道、当前版本及固定 feed，并验证目标版本更新。过期或畸形响应保留已知阻断。策略不能替换包内地址，也不能绕过安装维护门。发行规则未配置时返回不强制。

此候选已有 CPU 与源码证据，尚无签名发布证据。当前 Mac 的有效 Developer ID Application 身份为零，该 checkout 没有本机 `.env.macos`、`.env.windows` 发行配置。真实 Windows 签名硬件仍未验证。要宣称自动交付，还必须提供签名包、签名连续性、首次安装、公网通道及真实签名 beta 到 beta 更新的证据。
