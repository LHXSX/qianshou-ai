# 自动封装 Comfy API 候选

[English](README.md) | 中文

该 Node 库在现有 PC Host 内创建机主私有、鉴权且仅回环监听的 API。只使用 Node 内置模块，复用已运行的 Comfy 和已有模型，不需要 Python 依赖、动态生成脚本、公网 IP，普通用户不用选择路径或复制工作流。它不启动、中断或重启 Comfy，不下载模型，不登记广州，不代用户授权，不颁发正式收费资格，也不收费。

当前只支持已经存在的 Qwen Image 2.1 INT8 ConvRot 文生图工作流，固定 2048×1152、八步。这是研究工作流参数，不是官方报价档位。固定模板清空提示词并使用私有输出前缀。创建 API 前，工厂只读查询 Comfy 设备元数据、三个实际模型列表和八个节点定义，检查输入名称、枚举、数值范围、连线输出类型与输出节点。模型缺失或未知工作流保留不可用/未支持，不猜图结构，也不兜底下载。模型文件 SHA 尚未知；返回的工作流 SHA 仅识别生成的固定模板，不是受审发行回执。

`createComfyPilot(options)` 是可导入的库工厂，不是独立应用启动命令。参数由 Host 提供固定 `http://127.0.0.1:<端口>` Comfy 地址、私有目录、API 端口、随机私有 Bearer、请求期限、结果上限、持久的匿名 `ownerScopeId` 及异步当前账号授权回调。`ownerScopeId` 标识持久机主/设备运行实例，与 Sharing 命令的临时 `scopeId` 不同。回调分别核验 `connect`、`execute` 和原任务 `recover`；新执行仍需真实闲时及资源许可。暂停可以禁止 `execute`，同时保留原任务只读恢复。不同机主 scope 不能打开原数据库。Host 必须提供账号绑定并在生命周期结束关闭工厂；库不代用户生成授权。

私有 API 提供 `GET /healthz`、`/v1/models`、`/v1/workflows`、`/v1/jobs/{requestId}`、`/v1/jobs/{requestId}/image`；`POST /v1/jobs` 只接受精确 `{requestId, workflowId, prompt}`。调用方不能传节点图、模型路径、命令、价格、URL 或参数表单。工厂保留固定工作流参数，只替换文本与自身 UUID 输出前缀。鉴权必须是私有 Bearer，拒绝 Origin/Cookie。上游直连回环 HTTP，不继承代理、不跟随重定向，要求有界正 Content-Length 和整次请求期限。

SQLite 在唯一一次 Comfy `/prompt` POST 前同步记录请求 UUID 与执行权。相同请求返回原记录，修改后的同 UUID 请求冲突，未知任务继续占槽。上游 ID 初始为调用方明确指定的 prompt UUID，收到不同的真实接受 UUID 后立即持久化。POST 响应丢失绝不重发，只按原已存 history UUID 读取。若后端忽略调用方 UUID 且丢失接受响应，则无法自动找回，继续保留 unknown。这里不声称 Comfy 清空 history 或机器断电后的完整恢复。

完成后只读取固定输出节点及匹配 UUID 的 PNG 文件名。交付前校验 PNG signature、CRC、IHDR 尺寸、有界解压、扫描行长度/滤镜和精确 Content-Length。交付失败保留原任务，不再生成。私有普通单链接部分文件只在原下载内容前缀一致时续写；最终文件 rename 后、SQLite 成功提交前中断也可恢复。Windows ACL 归属及原生验收仍未验证。工厂不替代广州正式媒体验真或账本结算。

在 Mac-PC 根目录执行 `node --test packages/host/node-contributor/tests/fixtures/comfy-pilot-node-tests.mjs`；八个 CPU 用例使用真实回环 HTTP 和 SQLite，覆盖已接受 POST 及原结果 GET 飞行中的账号切换。定向 Vitest 包装用例执行这组检查。真实 Loader 回归挂载当前已登录机主路由和实际工厂，只用元数据 fixture，验证明确授权后自动创建、已有 Qwen 服务保留、GPU POST 为零。这些是源码/CPU 检查，不是 Windows 原生验收或生产生成回执。

`SharingPilot` 提供 Host 内部 typed `open`、`observe`、`submit`、`get`、`result`、`close`；私有地址和 Bearer 保留在 Host 内。Sharing coordinator 按持久机主/设备拥有实例，当前明确授权后自动匹配固定 Comfy 工作流，上报真实元数据，并在暂停、撤销、换账号或退出时只关闭自身回环 API。已有 Qwen API 就绪时仍保留运行；新的持久任务封装复用同一 Comfy/模型，不要求用户改地址、选图或选路径。广州确认仍需实际上报/挑战 ACK。不计费研究中转是下一阶段独立消费者；这组 CPU 用例不能证明其租约/上传端到端或原生自动创建。视频没有已支持的本机工作流，继续保持不可用；正式收费安装、资格和账本结算独立。
