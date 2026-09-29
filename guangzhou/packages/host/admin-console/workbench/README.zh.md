# 工作台 SP 与订阅管理

[English](README.md) | 中文

账号与订阅页沿用 `account.charge.adjust`、`subscription.manage` 权限，并要求 `all` 数据范围，先获取属主实时预览，再执行一次确认操作。管理台不写账本或订阅文件。上海 CNY 支付仍使用独立接口与余额。

## 运行配置

在管理台（7090）配置以下非密值：

- `QIANSHOU_ADMIN_WORKBENCH_BASE_URL`：固定工作台 origin，HTTPS 或同机回环 HTTP，不含路径、查询和用户信息。
- `QIANSHOU_ADMIN_WORKBENCH_KEY_ID`：已配置的服务密钥 ID。
- `QIANSHOU_ADMIN_WORKBENCH_KEY_REF`：`$DSH_HOME/.credentials.yaml` 中的大写引用名。
- `QIANSHOU_ADMIN_WORKBENCH_AUDIENCE`：与工作台（7080）配置一致、限定同环境的 audience。

工作台 `internalAdmin` 配置同一 audience，并添加 `{id, credentialRef, scopes: ['ledger.adjust', 'subscription.grant']}`。两进程各自的仅属主可读写 refs 文件保存专用随机 256 位服务密钥；密钥值不进入命令参数、URL、浏览器状态、环境变量、日志或本文。32 字节 base64url 值长 43 字符。每次请求重新读取引用，拒绝符号链接、组或其他用户访问权限，也拒绝与引用同名的环境变量歧义；没有缓存或环境凭据回退。

轮换顺序：两侧配置新密钥 ID/引用，过渡期间保留旧密钥的接收能力，切换管理台非密引用配置，验证只读预览成功后再撤下旧工作台密钥。配置缺失时禁止写入。“已配置”就绪度不代表服务探测成功；真实预览仍须通过鉴权与字段检查。

## 操作与确认

`POST /api/qianshou/ai/admin/account/adjustment/{preflight,apply,check}` 与 `/api/qianshou/ai/admin/subscription/manage/{preflight,apply,check}` 复用既有管理台会话、RBAC 与一次性确认存储。预览生成操作 UUID，原因必须在预览前填写。服务端把网关规范化的 `after` 和实时 `before` 一起绑定到确认载荷；执行时两者必须匹配。操作者 ID、角色来自已验证管理台会话，服务身份另用 Bearer 凭据和 `X-Qianshou-Service-Key-Id`。

只调用 `/internal/ledger/adjust`、`/internal/subscriptions/grant`。前者使用 `accountId`、非零 `deltaSp`、充值/收益桶及规范化后的当前档位；后者必须明确档位、生效和到期时间，永久权益必须显式传 `to: null`。界面不默认永久或 30 天。两者均绑定 `reason`、`ref` 与可信 `_admin` 委托，不伪造浏览器头、不跟随重定向、不自动重试。

预览发送 `dryRun: true`；执行移除该字段，沿用同一个 UUID。管理台在发送前持久化意图审计，在验证成功回执后记录结果审计。令牌一旦消费就不可复用，包括超时后。界面防止连续点击，保留原操作回执，并在身份变化时清空私有预览与读取结果。内存恢复存储跨路由卸载保留规范化载荷与 ref，不保留可复用令牌；退出或身份变化即清空。完整刷新浏览器不会恢复这份内存，服务端审计与原操作号仍是人工核查依据。

核查以相同载荷和 UUID 发送 `dryRun: true`，不能创建新业务记录。如果属主报告 `created: false`，其既有记录核查必须在成功 flush 持久化后才返回成功；这可能重试同一记录的落盘，但不会追加第二笔调账。新建 UUID 不是不确定资金操作的恢复方式。操作内容冲突单独报错。

## 错误与交付边界

服务凭据拒绝返回 `401 workbench_service_unauthorized`，不会清除操作者管理台登录；有效服务凭据但范围或委托不足返回 `403 workbench_service_forbidden`。网关写入超时、回执异常或持久化失败属于带原 ref 的不确定结果，不能当成功或提示重试。意图审计失败阻止写入；结果审计失败保留原操作供核查。

测试使用真实管理台 HTTP、原生凭据解析和真实网关鉴权/账本处理器，并覆盖真实 Vue 账号及订阅视图。部署必须包含配套网关改动、密钥引用、属主数据路径及新版管理台/网页构建。本地测试不等于生产账号、支付或订阅验收。本轮未引入 CNY/SP 换算、费率政策、退款、删除账本或自动对账。
