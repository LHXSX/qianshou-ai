# 千手 PC 独立开发入口

[English](README.md) | 中文

本目录是千手 PC 的首批开发配置。上游版本、提交和归档摘要见 `upstream.json`；主产品设计和详细架构报告在本次任务的 outputs 中。当前不是可发行安装包。

```sh
pnpm install --frozen-lockfile
pnpm run qianshou:build
pnpm run qianshou:web
pnpm run qianshou:doctor
```

Web 数据位于源码目录的同级 `qianshou-pc-home`，桌面数据位于同级 `qianshou-pc-desktop-home`，两者用于独立开发验收。Web 端口 3180。可通过 `QIANSHOU_DSH_HOME`、`QIANSHOU_PC_PORT` 覆盖。首次复制配置，后续不覆盖已保存设置。停止当前前台命令即可关闭该开发实例。

广州网关 URL 已配置。“千手账号”入口通过上海账号服务登录，使用独立托管引用 `QIANSHOU_ACCOUNT_ACCESS_TOKEN`；用户明确点击“使用千手模型”才设置默认路由。旧手工引用 `QIANSHOU_ACCESS_TOKEN` 仍可使用正常千手账号所得的令牌，不接受厂商主 key 或内部管理 key。不要提交或打包 `.credentials.yaml`、登录令牌与运行时目录。

`qianshou:doctor` 只报告白名单诊断字段，优先识别账号托管引用，再检查旧手工引用；追加 `-- --desktop` 检查桌面数据。诊断不会刷新或改写凭据，已过期的托管身份提示回到账号入口重新连接。追加 `-- --inference` 会在有有效凭据时发送最多 32 输出 token 的接入探测；目录返回 200 不代表推理通过。没有有效账号身份时应显示需要登录，不能改网关绕过它。

默认客户端限制为 32k 上下文、4k 输出和文本输入，是开发阶段的保守限制，不代表服务端能力上限。模型目录使用广州已核实的 ID，界面展示千手名称。图片、推理参数、工具轮次、用户登录自动刷新及完整设备业务另行验证。

`qianshou:desktop` 使用上游 Electron 开发启动器，需要先完成根构建与 `pnpm run build:desktop`；它不是安装包发布命令。千手欢迎页、窗口标题、菜单和 About 名称已接入；内部进程名保持 ASCII，避免污染 HTTP User-Agent。安装图标、签名和更新源在发行批次单独审查。

千手浏览器组合回归：先构建千手版本，然后执行 `DSH_CLIENT_BUILD_PROFILE=qianshou QIANSHOU_TEST_BROWSER=chrome DSH_SNAPSHOT=replay pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/qianshou-brand.e2e.ts`。该命令使用已安装的 Google Chrome；移除浏览器变量则使用 Playwright 自带 Chromium。回放不调用付费模型。

默认新会话采用 CEO 模式。公开选择器提供 CEO、技能创作、调用三个预设，首页保留三个大模式卡片，已开始的对话使用原有会话标题选择器；选择另一模式会开启独立会话并保留原任务。调用模式保留普通对话，只提供出图与出视频入口，需求直接在对话中描述，不分简单／专业表单。它不挂载本机 Shell、文件、技能或算力规划工具；真实报价、确认、任务状态和结果由 Host 媒体服务负责，买方无需选择机主或安装对方模型。CEO 与技能创作保留已有工具和创作流程。子代理任务窗口读取真实子会话；真实云端委派需要有效千手账号。

CEO 和技能助手挂载 `present`，用于用户要求的所有文件成果，包括由 Bash、PowerShell 或代码写出的文件。人格指令要求实际写入后、最终答复前成功声明；文字和路径不能代替文件卡片。安全图片、GIF 和视频可在原会话预览，Office 文件使用已有 Sidebar 预览。文件声明不证明插件安装、平台验收或结算。预设修改作用于新挂载；已加入的会话保留原来的 generation，直到显式成功重组预设。修改源码或重载窗口本身不能证明旧会话已获得该工具。

CEO 可观察本机已注册执行器、共享能力目录和上海当前算力池，并使用 Host 管理的规划工具。隐藏的旧插件制作预设设置 `observationOnly: true`，不呈现规划或提交工具。这些是不同的观测：已注册或节点已声明都不代表允许接单或具备派单条件。新的付费任务仍需 Host 报价及机主确认。

千手实例关闭客户端热更新。完整构建后重启，避免已打开的产品窗口载入尚未完整构建的插件依赖。

技能助手按本机试用的拒绝事实修复，不推断平台限制技能名称。`platformContacted: false` 表示尚未联系上海，助手按当前模板处理具体包结构、运行 ABI 或 schema 问题。已有媒体文件和回执仍是有效的本机成果；依赖宿主的执行器须接入对应运行 ABI，才能投稿或远端交付。

技能助手保存真实 `SKILL.md` 后调用 `qianshou_skill_complete`，纯指令技能也适用。Host 核实当前文件后，在制作对话中显示本机试用与发布操作；真实通用运行试用成功也显示同一操作卡。助手口头描述不声明文件已保存、运行成功、平台已审核或可接单。
