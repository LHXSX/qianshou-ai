# 千手 AI 运营管理台 · 接口契约 v1（冻结版）

本文是**服务端与前端之间唯一的契约**。前端按本文实现；服务端按本文实现。 两边任何一方要改形状，先改本文。

- 域名：`https://admin.qianshousuanli.com`（独立于 AI 客户端 `app.qianshousuanli.com`）
- 接口前缀：`/api/qianshou/ai/admin`
- 服务端实现：`packages/host/admin-console`（独立 systemd 服务 `qianshou-admin-console`）
- 前端实现：`apps/qianshou-admin`（独立 Vue 3 + Element Plus + Vite 工程）

## 0. 与算力运营台的关系（硬边界）

算力运营台是 `qianshousuanli.com/eco-admin/`（Vue + Element Plus，只读，管节点/调度/经济/反作弊/商务/广告线索）， **本管理台不复用它任何一行**：工程、路由、权限表、角色表全部独立。两个面的角色**不允许互通**：

- 本服务所有角色带 `surface: 'ai-admin'`；算力台的角色带 `surface: 'compute'`。
- 任何 `surface !== 'ai-admin'` 的角色都无法授予给本管理台的管理员（服务端拒绝，测试盯着）。

## 1. 传输层约定

| 项 | 约定 |
| --- | --- |
| 方法 | 全部 `POST` |
| 请求体 | JSON；`Content-Type: application/json` |
| 会话 | Cookie `qianshou_admin_sid`，服务端会话表，`HttpOnly; Secure; SameSite=Strict; Path=/` |
| CSRF | SameSite=Strict + `Origin`/`Referer` 必须等于本站源；不接受跨源写请求 |
| 缓存 | 所有响应 `cache-control: no-store` |
| 成功信封 | `{ "ok": true, ... }` |
| 失败信封 | `{ "ok": false, "code": "<机器可读>", "message": "<可直接展示给管理员的中文>" }` |

### 1.1 IP 白名单是**第一道门**，先于一切

管理台默认拒绝一切来源。不在白名单内的来源：

- 连 SPA 的 `index.html` 也拿不到（返回 `403` + 纯文本/JSON 说明，不返回前端资源）；
- 接口同样是 `403`，`{ "ok": false, "code": "ip_not_allowed" }`。

前端不需要实现白名单逻辑（拿不到页面就是被拒），但要在「白名单」页展示服务端看到的 `clientIp`。

### 1.2 状态码与 `code`

| HTTP | code | 何时 |
| --- | --- | --- |
| 400 | `bad_request` | 参数缺失/形状不对；`message` 说明缺什么 |
| 401 | `unauthenticated` | 未登录、会话过期或已被吊销 |
| 403 | `not_an_admin` | 账号密码正确，但这个账号没有被授予管理台角色 |
| 403 | `admin_disabled` | 管理员记录被停用 |
| 403 | `forbidden` | 已登录但缺权限；响应额外带 `"need": "<permission key>"` |
| 403 | `ip_not_allowed` | 来源 IP 不在白名单（含前端资源请求） |
| 409 | `confirm_required` | 高危操作缺少二次确认令牌 |
| 409 | `confirm_invalid` / `confirm_expired` | 令牌不对/过期（60 秒） |
| 409 | `confirm_mismatch` | 令牌与本次请求的操作/载荷不匹配 |
| 409 | `version_conflict` | 乐观并发：目标在预览之后被别人改过，需重新预览 |
| 429 | `rate_limited` | 登录失败过多等 |
| 502 | `upstream_unavailable` | 上游账号服务不可达/超时（**不是**「请重新登录」） |
| 503 | `dependency_unavailable` | 该业务的属主服务尚未提供接口；响应带 `module` 与 `missing` |

### 1.3 高危操作的**两步确认**（所有写操作）

写操作分两步，第二步必须带第一步发出的令牌：

1. `…/preflight`（同名 + `.preflight` 后缀）：服务端鉴权 → 计算 `before → after` 差异 → 返回一次性令牌 `{ "token": "…", "expiresAt": 1700000000000, "diff": { "before": …, "after": … } }`； 2. `…/apply`：`{ "token": "…", "reason": "≥4 字的原因" }` → 执行 + 写审计 → 返回 `{ "ok": true, "auditId": "…", "result": … }`。

令牌 60 秒有效、一次性、绑定「管理员 + 操作 + 载荷哈希」；预览后目标被改动则 `version_conflict`。

## 2. 会话与身份

### 2.1 复用既有账号体系（不造第二套账号）

- 账号、口令、TOTP 全部走**现有账号服务**（与手机端/电脑端同一套账号与同一个 `accountId`）。
- 服务端登录后**不落盘任何上游令牌**：上游 access/refresh token 只留在进程内存里； 管理台自己签发的会话 cookie 是**不透明随机串**，服务端会话表在内存中。 **服务重启 = 所有管理台会话失效**（宁可重新登录，也不留长期凭据）。 - 授权（是不是管理员、什么角色、什么数据范围）来自本管理台自己的管理员表（见 §4）。

### 2.2 端点

#### `POST /api/qianshou/ai/admin/session/login`

```jsonc
// 请求
{ "username": "…", "password": "…" }
// 200：直接登录成功（已下发会话 cookie）
{ "ok": true, "twoFactor": false }
// 200：需要第二步验证码
{ "ok": true, "twoFactor": true, "challenge": { "challengeToken": "…" } }
```

失败：`401 invalid_credentials`、`403 not_an_admin`、`403 admin_disabled`、`429 rate_limited`、`502 upstream_unavailable`。

#### `POST /api/qianshou/ai/admin/session/login-totp`

```jsonc
{ "challengeToken": "…", "code": "123456", "trustDevice": false }
// 200
{ "ok": true, "twoFactor": false }
```

#### `POST /api/qianshou/ai/admin/session/logout`

`{}` → `{ "ok": true }`（吊销服务端会话并清 cookie）。

#### `POST /api/qianshou/ai/admin/session/me`

```jsonc
{
  "ok": true,
  "admin": {
    "accountId": "167",
    "displayName": "张三",
    "roleId": "super-admin",
    "roleName": "超级管理员",
    "roleKind": "builtin",          // builtin | custom
    "scope": "all",                  // all | self
    "surface": "ai-admin"
  },
  "permissions": ["account.read", "audit.read", "…"],
  "menu": [
    { "key": "overview", "title": "总览", "group": "运营", "perm": null },
    { "key": "account", "title": "账号与额度", "group": "运营", "perm": "account.read" }
  ],
  "readiness": [
    { "key": "account", "title": "账号与额度", "status": "read-only",
      "summary": "可读真实额度与流水；异常扣费处理等待账本属主服务开放写接口。",
      "missing": [{ "interface": "POST /internal/ledger/adjust", "why": "写接口在账本属主服务" }] }
  ],
  "clientIp": "203.0.113.7"
}
```

`menu` 是**服务端按权限过滤后**的菜单；前端只渲染，不自行判断。未登录返回 `401 unauthenticated`。

## 3. 模块就绪度

`POST /api/qianshou/ai/admin/modules`

```jsonc
{
  "ok": true,
  "modules": [
    { "key": "rbac",   "title": "权限与审计", "status": "ready",
      "summary": "角色、管理员、审计、功能开关、白名单全部可用。", "missing": [] },
    { "key": "market", "title": "技能 / 专家市场", "status": "dependency-unavailable",
      "summary": "市场目录服务尚未建成。",
      "missing": [
        { "interface": "GET /internal/market/items", "why": "第三方技能/专家条目" },
        { "interface": "POST /internal/market/review", "why": "上架审核与下架" }
      ] }
  ]
}
```

`status` 三档：`ready`（读写都可用）/ `read-only`（真实数据可读，写入等属主服务）/ `dependency-unavailable`（属主服务不存在，页面为占位）。

## 4. 权限模型（服务端强制）

### 4.1 权限键

`<模块>.<动作>`。`highRisk: true` 的操作必须走 §1.3 两步确认。

| 模块 | 权限键 | 高危 |
| --- | --- | --- |
| 账号与额度 | `account.read` / `account.ledger.read` / `account.charge.adjust` | `account.charge.adjust` |
| 订阅与档位 | `subscription.read` / `subscription.manage` | `subscription.manage` |
| 技能/专家市场 | `market.read` / `market.review` / `market.pricing.manage` | `market.pricing.manage` |
| 发现页内容 | `discovery.read` / `discovery.publish` / `discovery.report.handle` | `discovery.publish` |
| 订单与工单 | `order.read` / `order.refund` / `ticket.read` / `ticket.reply` | `order.refund` |
| 企业咨询 | `enterprise.read` | 无，只读 |
| 权限与审计 | `rbac.read` / `rbac.manage` / `audit.read` / `flags.read` / `flags.manage` / `whitelist.read` / `whitelist.manage` | `rbac.manage` / `flags.manage` / `whitelist.manage` |

`POST /api/qianshou/ai/admin/rbac/permissions` 返回带 `highRisk`/`description` 的完整目录（前端按它渲染权限矩阵）。

### 4.2 数据范围

管理员记录带 `scope`：`all` = 看全部；`self` = 只看自己经办的记录。 作用点：审计查询、账号/流水列表、将来的订单与工单。**范围在服务端裁剪**，前端拿到的就是裁剪后的数据。

### 4.3 内置角色（`surface: 'ai-admin'`，权限不可改）

| id | 名称 | 关键权限 | 默认范围 |
| --- | --- | --- | --- |
| `super-admin` | 超级管理员 | 全部 | `all` |
| `ops` | 运营 | `discovery.*`、`market.review`、`ticket.*`、只读 `account`/`order` | `all` |
| `finance` | 财务 | `account.*`、`subscription.*`、`order.read`、`order.refund` | `all` |
| `support` | 客服 | `account.read`、`ticket.read`、`ticket.reply`、`order.read` | `self` |
| `auditor` | 审计员 | `audit.read`、`rbac.read`、`whitelist.read`（只读） | `all` |

自定义角色可自由组合权限键；**不能**加入非本面（`surface !== 'ai-admin'`）的角色。

### 4.4 端点

- `POST /rbac/permissions` → `{ ok, groups: [{ module, title, items: [{ key, title, highRisk, description }] }] }`
- `POST /rbac/roles/list` → `{ ok, roles: [{ id, name, kind, surface, description, permissions, scopeDefault, memberCount }] }`
- `POST /rbac/roles/preflight` `{ op: "create"|"update"|"delete", id?, name?, permissions?, scopeDefault?, description? }` → `{ ok, confirm: { token, expiresAt, diff: { before, after } } }` - `POST /rbac/roles/apply` `{ token, reason }` → `{ ok, auditId, result }` - `POST /rbac/admins/list` → `{ ok, admins: [{ accountId, displayName, roleId, scope, enabled, createdAt, createdBy }] }` - `POST /rbac/admins/preflight` `{ op: "grant"|"update"|"revoke", accountId, roleId?, scope?, displayName? }` - `POST /rbac/admins/apply` `{ token, reason }` → `{ ok, auditId, result }`

## 5. 审计

- `POST /audit/list` `{ from?, to?, actorId?, actionPrefix?, result?: "allow"|"deny", limit?: 50, offset?: 0 }` → `{ ok, total, entries: [{ id, at, actorId, actorRole, ip, action, target, result, reason, summary }] }` - `POST /audit/detail` `{ id }` → `{ ok, entry: { …, before, after, diff: [{ path, before, after }] } }`

审计**只追加**（JSONL），记录：谁（accountId + 角色）、何时、从哪个 IP、做了什么动作、目标、改前值 → 改后值、结果（allow/deny）、原因。 以下都必须留痕：登录成功/失败、被拒的越权请求、白名单拒绝、全部写操作。

## 6. 功能开关

- `POST /flags/list` → `{ ok, flags: [{ key, title, enabled, rolloutPercent, description, updatedAt, updatedBy, version }] }`
- `POST /flags/preflight` `{ key, title?, enabled?, rolloutPercent?, description? }`
- `POST /flags/apply` `{ token, reason }`

## 7. IP 白名单

- `POST /whitelist/status` →
  ```jsonc
  { "ok": true, "enabled": true, "clientIp": "203.0.113.7",
    "entries": [{ "cidr": "203.0.113.0/24", "note": "办公出口", "addedBy": "167", "addedAt": 1700000000000 }],
    "escapeHatch": { "loopbackAlwaysAllowed": true, "cliHint": "ssh root@203.0.113.20 'node /srv/qianshou-agent/packages/host/admin-console/src/main.ts whitelist add 203.0.113.7/32'" } }
  ```
- `POST /whitelist/entries/preflight` `{ op: "add"|"remove", cidr, note? }`
- `POST /whitelist/entries/apply` `{ token, reason }`

逃生路径（白名单为空也不会锁死）：**本机回环（`127.0.0.1` / `::1`）永远放行**，因此在服务器上 `curl 127.0.0.1:7090` 或 SSH 本地执行 CLI 永远可以把自己加回白名单。

## 8. 业务模块

### 8.1 账号与额度（`read-only`）

- `POST /account/list` `{ query?, limit?, offset? }` → `{ ok, total, accounts: [{ accountId, tier, grantedSp, usedSp, remainingSp, callCount, lastCallAt }] }` - `POST /account/detail` `{ accountId }` → `{ ok, account, reservations: [] }` - `POST /account/ledger` `{ accountId, limit?, offset? }` → `{ ok, total, entries: [{ at, model, inputTokens, outputTokens, sp }] }` - `POST /account/adjustment/preflight` `{ accountId, deltaSp, reason }` → 目前 `503 dependency_unavailable` （需要账本属主服务开放写接口；请求依然过权限校验并写审计）

### 8.2 订阅与档位（`read-only`）

- `POST /subscription/list` `{ query?, limit?, offset? }` → `{ ok, total, entries: [{ accountId, tier, from, to, grantedBy, reason, active }] }` - `POST /subscription/tiers` → `{ ok, source, tiers: [{ id, label, monthlySp, monthlyYuan, contextLimitTokens, concurrency, windowFiveHourSp }] }`（档位目录的**唯一来源**是模型网关的 `tiers.ts`，本服务动态读取；读不到时 `source` 如实说明） - `POST /subscription/manage/preflight` `{ op, accountId?, tier?, … }` → 目前 `503 dependency_unavailable`

### 8.3 技能 / 专家市场（`dependency-unavailable`）

- `POST /market/overview` → `503 dependency_unavailable`（缺市场目录服务）

### 8.4 发现页内容（`dependency-unavailable`）

- `POST /discovery/overview` → `503 dependency_unavailable`（缺内容服务）

### 8.5 订单与工单（`dependency-unavailable`）

- `POST /order/overview` → `503 dependency_unavailable`（缺订单/工单服务）

### 8.5b 模型路由（`dependency-unavailable`）

- `POST /models/overview` → `503 dependency_unavailable` 缺口指向模型网关已有端点：`POST /api/qianshou/ai/admin/names`、`POST /api/qianshou/ai/admin/bind`（7080 工作台进程；认工作台会话的 `isAdmin`，不是本台 cookie）。

### 8.6 健康检查

- `POST /health` → `{ ok: true, service: "qianshou-admin-console", version, uptimeMs }`（同样过白名单）

## 8.7 上游密钥（`credential/*`，受控写）

模型网关向上游发请求用的密钥。**这一节的每一条都是安全要求，不是建议。**

### 谁能改、谁能看

| 动作 | 要求 |
| --- | --- |
| 看（`credential/list`） | 权限 `credential.read` |
| 改（`credential/preflight`、`credential/apply`） | 权限 `credential.manage` **且** 角色必须是 `super-admin`（服务端硬判定，返回 `403 forbidden` + `need: "super-admin"`） |

第二道判定是刻意的：权限键可以授权给自定义角色，而换上游密钥会影响**全部用户**， 不该靠"多勾一个权限"就能扩散出去。

### 值永不回显

**任何响应、日志与审计里都不出现密钥明文。** 列表只给： 键名、是否已配置、**指纹**（sha256 前 8 位）、更新时间、更新人、上一次指纹。 指纹只能回答"这次改的和上次是不是同一把"，无法反推密钥本身。

### 端点

- `POST /credential/list` `{}` → `{ ok, credentialsPath, fileExists, fileMode, keys: [{ ref, configured, fingerprint, updatedAt, updatedBy, previousFingerprint, shadowedByEnvironment, restartRequired, restartService, restartCommand }], activation: { fileWatcher, gatewayCache, restartRequired, restartService, restartCommand, note }, backups: { dir } }` - `POST /credential/preflight` `{ ref, value }` → `{ ok, confirm: { token, expiresAt, diff: { ref, before, after: { ref, configured, fingerprint, restartRequired }, probe, restartCommand } } }` - `probe` 是**真实连通性测试**的结论（预览阶段就打一次上游）； - `diff` 里只有指纹，**没有 `value`**。 - `POST /credential/apply` `{ ref, value, token, reason }` → `{ ok, auditId, result: { ref, fingerprint, previousFingerprint, propagatedByFileWatcher, restartRequired, restartService, restartCommand, backupPath, updatedAt, updatedBy } }`

`apply` 必须回传与预览**完全一致**的 `ref` 与 `value`（载荷哈希绑定；不一致回 `409 confirm_mismatch`）。

### 写入前的连通性测试（失败即拒绝写入）

`apply` 在动盘之前用新密钥向真实上游发一次最小请求（`max_tokens: 1`）。结论分四类， **分类不同则给管理员的建议不同**：

| 情形 | HTTP | `code` | 含义 |
| --- | --- | --- | --- |
| 上游 401 / 403 | 400 | `credential_rejected` | 密钥被拒（确定性失败） |
| 上游 429 | 502 | `upstream_unavailable` | 限流，**不能证明密钥无效** |
| 上游 5xx / 超时 | 502 | `upstream_unavailable` | 上游或链路问题，**不能证明密钥无效** |
| 该 `ref` 没有探测目标 | 502 | `probe_not_configured` | 管理台不猜该打哪个地址 |

失败时响应带 `written: false`，凭据文件**逐字节不变**，也不留下备份。

### 写入协议：备份 → 锁 → 原子替换 → 复核 → 失败回滚

1. **备份**：把"改之前"的完整凭据文件写到管理台数据目录的 `credential-backups/`（`0600`； 文件名带时间戳，同秒撞名时追加序号，**绝不覆盖**已有回滚点）； 2. **跨进程写者锁**：与凭据体系同一套 `<file>.lock`（`wx` 独占创建）协议， 所以工作台的凭据插件与本管理台不会互相顶掉状态； 3. **原子替换**：临时文件 `wx` 创建 → `rename`，读者只会看到完整的旧内容或新内容； 4. **权限复核**：结果必须是 `0600`（凭据体系对 group/other 权限位**抛错**， 宽权限会让工作台重启后加载不了凭据插件）； 5. **失败回滚**：任何一步失败都用那份备份还原。

写入格式的两条硬约束（**实测结论，不是风格偏好**）：

- 只改 `refs:` 段里那一个值，**不加任何自己的顶层键** —— 凭据解析器会拒绝未知顶层键， 写坏了工作台下次启动就加载不了凭据； - 值必须是**裸标量**，禁空白、引号、`#` 与控制字符。网关的**文件兜底**路径用自写正则 取值且**不剥引号**，所以 `"sk-xxx"` 会让网关拿到带引号的 key（上游 401）。

### 生效机制：**必须重启工作台**

- **文件层热生效**：工作台的凭据插件监听该文件（chokidar），改动会被自动加载；
- **网关层不生效**：模型网关 `apiKey()` 对**已解析成功的密钥永久缓存** （只有 `null` 才走 30 秒冷却重试），所以 `DEEPSEEK_API_KEY` 改完**必须**重启工作台。

因此响应里带 `restartRequired: true` 与 `restartCommand`。**管理台不代执行重启** （重启会断开全部在线会话，那应当是一次显式的运维决定）。

### 审计

每次改动（含**被拒**的尝试）都写审计：谁、何时、改了哪个键、 **旧指纹 → 新指纹**（绝不记明文）、连通性结论的分类。 越权尝试（非 super-admin）按 `credential.apply` + `result: "deny"` 留痕。

## 8.8 上游号池（`pool/*`，受控写）

**运营在后台贴一枚 Cursor 凭据就能往号池里加一个号**，不用 SSH、不用敲命令。 它与 §8.7 同构（同一套权限、同一套两步确认、同一条写入协议、同一张探测失败四类表）， 因为危险等级相同：号池里的凭据会被拿去给用户发请求。

### 存储形状（三条硬约束）

| 项 | 约定 | 为什么 |
| --- | --- | --- |
| 号池的一个号 | `.credentials.yaml` 的 `refs:` 段里**一个 ref** | 不引入第二种存储：工作台的凭据插件照旧加载同一个文件 |
| ref 名 | `CURSOR_CK_<sha256(authId) 前 8 位>` | 稳定（同一账号永远同一个 ref → 天然去重）、不含 PII、满足键名严格度 |
| 值 | **归一化后的 `crsr_…` API key**（69 字符） | 它是 YAML 裸标量安全值（无冒号/引号/空白）且**不过期**；会话 JWT 会过期，落盘等于埋一个"过几天全线 401"的雷 |
| 标签/状态/最后验证时间 | 管理台数据目录的 `pool.json`（`0600`） | 照 `upstream-key-meta.ts` 的做法；**绝不往凭据文件加顶层键**（解析器拒未知顶层键，写坏了工作台下次启动加载不了凭据插件） |

### 谁能改、谁能看

| 动作 | 要求 |
| --- | --- |
| 看（`pool/list`） | 权限 `credential.read` |
| 改（`pool/preflight`、`pool/apply`、`pool/remove`） | 权限 `credential.manage` **且** 角色必须是 `super-admin`（服务端硬判定，`403` + `need: "super-admin"`） |

越权尝试写审计 `result: "deny"` + `reason: "not_super_admin"`，动作名是 `pool.add.apply` / `pool.remove.apply`，并且**在打上游之前就被拒**（判定在探测之前）。

### 值永不回显

任何响应、日志、审计、管理台数据文件里都不出现凭据明文。列表只给： ref、标签、状态、**指纹**（sha256 前 8 位）、最后验证时间、`authId`、邮箱。

### 三种输入形态，都必须支持

| 形态 | 处理 |
| --- | --- |
| `crsr_…`（69 字符） | 已经是归一化后的长期 key，落盘的就是它 |
| `userId::eyJ…`（`::` 可能写成 `%3A%3A`） | **必须先剥掉包装，只发 JWT** |
| 裸 JWT（`type` 是 `session` 或 `web`） | 直接可用 |

第四种（认不出来的形状）**明确拒绝并说明理由**（`400 bad_request`）： "先试一个再说"会让排查变成猜谜。

### 剥包装：为什么这一步是成败关键（实测矩阵）

| 发给上游的东西 | 结果 |
| --- | --- |
| 整串（含 `%3A%3A`） | 401 |
| 解码后的 `userId::jwt` | 401 |
| **只发 JWT** | **200** |
| 只发 `userId` | 401 |

> **一条要记住的教训：同一 bug 骗出来的三次失败不是三个证据。** 上表里三行 401 来自**同一个** bug（把包装一起发了出去），只是输入的编码写法不同。 它们不是三次独立确认 —— 同一个动作的三种写法不是三个证据，**证据的数量不构成证据的 强度**。真正下结论的是那个 200。  这条教训值得写进契约，因为它是可复现的思维方式：任何"多试几种写法"的验证都会收到 一串**同源**的失败，而把它们当成"三次都失败"会让人去怀疑凭据本身（"是不是这把 凭据坏了"），排查从此停在完全错误的方向。判断一个失败是不是独立证据，要问的是 "它和上一个是同一个原因吗"，而不是"它出现了几次"。

### 验活与归一化（实测的协议事实）

```text
POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetMe              # 验活 + 取身份（会话凭据或票）
POST https://api2.cursor.sh/aiserver.v1.DashboardService/CreateUserApiKey   # 会话凭据 → 长期 key
POST https://api2.cursor.sh/auth/exchange_user_api_key                      # API key → 1 小时票
Headers: Authorization: Bearer <剥过包装的会话凭据 / crsr_… / 换来的票>
         Content-Type: application/json
         x-cursor-client-type: cli
         x-cursor-client-version: cli-2026.08.11-e8db854
GetMe                body {}                                            → 200 { authId, userId, email, … }
CreateUserApiKey     body {"name":"qianshou-pool","scopes":["user:read"]} → 200 { apiKey: "crsr_…" }
exchange_user_api_key body {}                                           → 200 { accessToken, refreshToken }
```

- `x-cursor-checksum` **无关**（实测带真 checksum / 假 checksum / 不带，全部 200），所以不加。
- `200` 但正文里没有 `authId` → 按"无法确认"处理（`502`）：**号池的主键就是它**，猜一个等于埋重复号。
- 会话形态的顺序是**先验活、再归一化**：反过来的话，一枚过期 JWT 会先铸出一把新 key 才被否掉， 在 Cursor 账号里留下一串没人用的 key。

#### `crsr_…` API key 的验活必须**两步**（实测，2026-09 广州服务器，用号池里那把真 key）

| 做法 | 结果 |
| --- | --- |
| `crsr_…` 直接打 `GetMe`（只带 `Authorization`） | **401** |
| `crsr_…` 直接打 `GetMe` + `x-cursor-client-type/version` | **401** |
| `crsr_…` 直接打 `GetMe` + ide 的 `x-cursor-checksum` | **401** |
| **先 `POST /auth/exchange_user_api_key` 换票 → 再用票打 `GetMe`** | **200**（换票 200 0.67s 934B / 取身份 200 0.72s，带回 `authId`、`email`） |

结论是**确定性**的：**API key 不是身份凭据**，它在身份接口上恒被拒；必须先换一张票。 换来的票 `type = api_key_token`、**有效期 3600 秒**，所以：

- 它**只用于这一次验活**，绝不进凭据文件、不进 `pool.json`、不进审计、不进响应 （落盘存的永远是**长期有效的那一个**：会话形态是新铸的 `crsr_…`，API key 形态就是用户给的 `crsr_…`）； - 写前探测（`apply` 对将要落盘的那把值再探一次）同样走这条两步路径 —— 会话形态下 新铸的 key 也是 API key，直接打 `GetMe` 一样是 401。

> **两组 401 的归属不一样，别混为一谈。** 「剥包装」那张表里的三行 401 是**同一个 bug 的三种写法**（同源失败，不构成多条证据）；这里的三种头部组合 401 是**三条不同的路 都指向同一个结论**（key 不是身份凭据，是独立证据的收敛）。判断一个失败算不算证据， 问的永远是"它和上一个是同一个原因吗"，不是"它出现了几次"。

#### 调用次数（以实际序列为准，用例逐条断言）

| 形态 | `preflight` | `apply` |
| --- | --- | --- |
| `crsr_…` API key | 2 次（换票 → 取身份） | 2 次（换票 → 取身份；落盘值就是刚验过的那一串，**不重复探**） |
| 会话凭据 | 1 次（`GetMe` 验活） | 4 次（`GetMe` → `CreateUserApiKey` → 换票 → 取身份，最后两步是对**将要落盘的那把新 key** 的写前探测） |

`preflight` 一次都不铸 key（归一化只在 `apply`），所以预览不会在 Cursor 账号里留下废弃的 key。

### 端点

- `POST /pool/list` `{}` → `{ ok, keys: [{ ref, label, status, fingerprint, lastVerifiedAt, authId, email, addedAt, addedBy, previousFingerprint, shape }], fileError, activation, metadataPath }` - `status`：`active`（凭据文件里有值）/ `missing`（只剩元数据 —— 有人手工删过那一行；**必须显示出来，不能让界面骗人**）； - `fileError`：凭据文件读不懂时**降级展示**（和 §8.7 的列表同一个取舍），写入路径仍然会因此拒绝； - 非号池的引用（如 `DEEPSEEK_API_KEY`）**不出现在这里**。 - `POST /pool/preflight` `{ op?: "add" | "remove"（默认 add）, credential?, label?, ref? }` - `op: "add"` → `{ ok, confirm: { token, expiresAt, diff: { ref, action: "add"|"duplicate"|"replace", identity: { authId, email }, fingerprint, fingerprintSubject, valueKnown, shape, existingRef, duplicateBasis, previousFingerprint, probe, note } } }` - `fingerprint` 只从**将要落盘的那把值**算，所以它的含义由 `fingerprintSubject` 说清： `"stored-value"`（`crsr_…` 输入，落盘值就是它本身）；会话输入在预览阶段**还没有**落盘值 （归一化发生在 `apply`），于是 `fingerprint: null` + `fingerprintSubject: null` + `valueKnown: false`。**不报"贴进来那一串的指纹"** —— 那个值与真正落盘的值不是同一个， 报它等于让预览与结果对不上（正是两步确认要防的"预览看到 A、执行的是 B"）。 - `probe` 探的是**输入凭据**（会话形态下它还不是落盘值）：结论、`kind`、耗时都如实给出。 - `op: "remove"` → `{ ok, confirm: { token, expiresAt, diff: { ref, action: "remove", before: {…}, after: null, probe: null } } }` - 令牌绑"管理员 + 动作（`pool.add` / `pool.remove`）+ 载荷哈希"；add 的令牌拿去 remove 会回 `409 confirm_mismatch`。 - 号池**没有单独的 remove 预览端点**：确认令牌必须绑住确切载荷，而四个端点里只有 `preflight` 发令牌，所以移除的预览由 `op: "remove"` 分支承担（形状见上）。 - **预览不产生持久副作用**：只验活（`GetMe`）与取身份，**绝不调 `CreateUserApiKey`**。归一化会真的 在 Cursor 账号里铸一把 key，那种副作用只能发生在 `apply`。 - `POST /pool/apply` `{ credential, label, token, reason }` → `{ ok, auditId, result: { ref, fingerprint, previousFingerprint, action, backupPath, updatedAt, updatedBy, written } }` - `action: "duplicate"`（同一枚凭据已在池中）时 `written: false`、`backupPath: null`、`updatedAt: null`、 并给出 `duplicateBasis` / `existingRef`：**不报错也不写盘**（运营的意图已经达成，报错会让人反复重试）。 - `POST /pool/remove` `{ ref, token, reason }` → 同上形状（`action: "remove"`、`fingerprint: null`）

`apply` 必须回传与预览**完全一致**的 `credential` 与 `label`（载荷哈希绑定；不一致回 `409 confirm_mismatch`）。 `apply` 里的每一步都重算（**不信任预览时算出来的任何东西**）：身份、ref、归一化、判重、探测。

**部分成功要如实说**：凭据写进号池之后，如果管理台自己的元数据（标签/验活时间）没写成功， 响应是 `500 metadata_write_failed` + **`written: true`** —— 号本身是可用的，界面必须按 "号已进池、记账没成"来渲染，而不是"新增失败"（那会让运营再贴一次）。移除时同理。

### 写前真实探测（`apply` 动盘之前，失败即拒绝写入）

`preflight` 会把探测结论如实放进 `diff.probe`（让管理员在按下确认之前知道通不通）， 但**强制点是 `apply`** —— 预览可以被绕过，写入前不行。`apply` 拿的是**将要落盘的那把值** 再打一次上游（会话形态下刚铸出来的 `crsr_…` 必须自己再验一次：输入的 JWT 有效 不等于铸出来的 key 可用；`crsr_…` 输入则复用验活那一次，不重复打）。失败分类照 §8.7 那张表：

| 情形 | HTTP | `code` | 含义 |
| --- | --- | --- | --- |
| 上游 401 / 403 | 400 | `credential_rejected` | 凭据被拒（确定性失败） |
| 上游 429 | 502 | `upstream_unavailable` | 限流，**不能证明凭据无效** |
| 上游 5xx / 超时 | 502 | `upstream_unavailable` | 上游或链路问题，**不能证明凭据无效** |
| 没有探测目标 | 502 | `probe_not_configured` | 管理台不猜该打哪个地址 |

失败时响应带 `written: false`，凭据文件**逐字节不变**，也不留下备份。 `preflight` 在拿到 `authId` 之前就失败时（输入凭据被拒/上游不可达）也走这张表， 但**不发令牌** —— 连"要加的是哪个号"都说不出来时，管理员无从确认自己确认了什么。

### 去重规则（三条判据，任一命中即同一个号）

| 判据 | 命中意味着 | 它挡住的场景 | 结果 |
| --- | --- | --- | --- |
| **值相同**（在凭据文件的真实内容上逐字节比） | 同一把 key 必然是同一个号 | 元数据丢失/损坏时把同一个号重复入库 | `duplicate`（不写盘） |
| ref 名相同 | 同一个 `authId`（ref 由它派生） | 同一个账号换了一枚新 key | `replace` |
| `authId` 相同（元数据里的身份） | 同一个 Cursor 账号 | ref 命名规则变过、或历史 ref 被手工改过 | `replace` |

**第三条最硬**：它不依赖任何身份信息就能成立，所以元数据坏了也不影响判重。 反过来只比前两条会漏掉一种真实情形 —— **同一枚 key 已经躺在池子里**。 元数据的可靠性从来不是判重的前提：值来自凭据文件本身，不是 `pool.json` 里的指纹。

一个必须说清的边界：**会话形态在预览阶段用不到第三条判据**（落盘值要等 `apply` 归一化才存在， 而每次归一化都会铸一把新 key，值必然与池子里的不同），所以那条路径在预览里只能靠 ref / `authId` 判重；`apply` 归一化之后会**再判一次**（那时三条都可用），以 `apply` 的结论为准。 `crsr_…` 形态三条判据在预览阶段就都可用。

### 写入协议与移除

写入整条复用 §8.7 的协议（备份 → 跨进程写者锁 → 原子替换 → 权限复核 `0600` → 失败回滚）， 实现上就是同一个 `writeKey`。

**移除是同一个协议的另一半**（`deleteKey`）：只删管理台元数据会留下一个**还能被网关取到**的 凭据 —— 那是最坏的一种"删成功"。移除会真的把 `refs:` 段里那一行删掉，并清掉 `pool.json` 里的 元数据。`pool/remove` 只接受号池的 ref（`CURSOR_CK_xxxxxxxx`）：`DEEPSEEK_API_KEY` 之类 走这里会被拒（破坏性操作必须有边界）。

### 审计

每次改动（含**被拒**的尝试）都写审计：谁、何时、哪个 ref、**旧指纹 → 新指纹**、 探测结论分类、身份（邮箱/`authId`）；**绝不记明文**。 `apply` 的动作名是 `pool.add.apply`，移除是 `pool.remove.apply`；重复入库记 `pool.add.apply` + `result: "allow"` + 摘要写明"未重复写入"（那次操作在事后必须看得见）。

### 生效机制：**如实说明消费方还没接**

号池的号落在同一个凭据文件里，所以工作台的凭据插件会热加载它；但**"把号用起来"是消费方 （模型网关的号池路由）的事，那条路由尚未接入**。因此 `activation.restartRequired` 目前是 `false` 且响应里明确写着"不声称已经生效" —— 接入之后，如果那个消费方也像 `apiKey()` 一样 永久缓存成功值，`connectivity.ts` 里的 `CURSOR_POOL_PROBE_TARGET` 要改成 `restartRequired: true`。

### 已验证与尚未验证（**不要混为一谈**）

已经用**真实凭据**验证过的（见上面的实测矩阵）：
- `crsr_…` API key 直接打 `GetMe` 恒 401（三种头部组合），**必须先换票**；换票 + 取身份两步走通（200）；
- 会话凭据（裸 JWT / `userId::JWT`）的剥包装、`GetMe`、`CreateUserApiKey`；
- 换来的票的 `type` 与有效期（`api_key_token` / 3600 秒）。

**尚未做过真实凭据端到端**的（本管理台这条链路上的部分）：
- 管理台进程里"贴 → 预览 → 确认 → 落盘 → 列表 → 移除"的完整一次 —— 上游交互全部在打桩的 `fetch` 上验证过（桩按上面的实测矩阵实现），但没有在服务器上真跑过一次。 需要一枚可丢的测试凭据时，请提供后再做。

在代码/用例这一侧已经钉住的：
- `.credentials.yaml` 的解析器接受写入结果（用例里跑的是真正的 `parseCredentialsDocument`）；
- 票**不落盘**：凭据文件、`pool.json`、审计、响应里都搜不到它（有用例逐文件扫过）；
- 调用序列（换票在前、`GetMe` 在后，且 `GetMe` 带的是票不是原 key）有用例断言。

### 前端接入要求

- 页面依赖 `pool/list`、`pool/preflight`、`pool/apply`、`pool/remove`，写操作走两步确认弹窗 （展示 `diff`：新增/替换/已在池中 + 身份 + 指纹 + 探测结论，填原因）； - 列表**永不回显明文**：只显示 ref、标签、指纹、状态、最后验证时间、身份； - 状态 `missing` 要显式渲染成"这个号的凭据已经不在文件里了"； - 新增表单用 `type=password`，并提示三种可粘贴的形态； - 侧栏入口：服务端 `rbac.ts` 的 `MENU` 里已有 `{ key: 'pool', title: '上游号池', group: '安全', perm: 'credential.read' }`， `session/me` 会对有 `credential.read` 的角色返回它。前端把它映射到一个路由即可 （**不要**自行判断权限，也不要在前端再维护一份菜单表）。

## 9. 前端页面清单（必须实现）

| 页面 | 依赖接口 | 要点 |
| --- | --- | --- |
| 登录 | `session/login`、`session/login-totp` | 两步入；错误按 `code` 分文案（尤其是 `not_an_admin` 与 `upstream_unavailable` 不能说成同一件事） |
| 总览 | `session/me`、`modules` | 就绪度矩阵：`ready` / `read-only` / `dependency-unavailable` 三色 + 缺什么接口 |
| 账号与额度 | `account/*` | 列表 + 详情抽屉 + 流水；「异常扣费处理」按钮可见但点开说明为何暂时不可用（依赖属主服务） |
| 订阅与档位 | `subscription/*` | 订阅列表 + 档位目录只读 |
| 技能/专家市场 | `market/overview` | **占位页**：写清缺哪个服务、需要哪些接口 |
| 发现页内容 | `discovery/overview` | 占位页 |
| 订单与工单 | `order/overview` | 占位页 |
| 企业咨询 | `enterprise/leads`、`enterprise/lead` | 官网申请只读分页与详情；仅 `enterprise.read` + `all` 范围 + 上海管理员身份 |
| 权限管理 | `rbac/*` | 角色矩阵（勾选权限）+ 管理员授权；写操作走两步确认弹窗（展示 before→after 差异 + 填原因） |
| 审计日志 | `audit/*` | 过滤（时间/操作人/动作前缀/结果）+ 分页 + 详情（before→after 差异） |
| 白名单 | `whitelist/*` | 当前 `clientIp` 高亮显示 + 条目增删（两步确认）+ 逃生路径说明 |
| 功能开关 | `flags/*` | 开关 + 灰度百分比 + 两步确认 |
| 上游密钥 | `credential/*` | 列表**永不回显明文**（只有指纹/更新时间/更新人）+ 更新表单（`type=password`、可清空）+ 两步确认（预览阶段显示真实连通性结论）；显式标注「需重启工作台才生效」与重启命令 |
| 上游号池 | `pool/*` | 贴一枚 Cursor 凭据即可加号（三种形态，见 §8.8）；列表只显示指纹/身份/状态；写操作两步确认；移除是高危操作；`status: missing` 要显式渲染。（⚠️ 侧栏入口需要先在 `rbac.ts` 的 `MENU` 补一条，见 §8.8 末尾） |

布局要求：侧栏菜单完全来自 `session/me` 的 `menu`，前端**不硬编码权限判断**； `403 forbidden` 统一渲染成「权限不足（需要 `need`）」；`401` 一律跳登录页。


## 企业咨询只读增量（本地候选）

`POST /api/qianshou/ai/admin/enterprise/leads` 接收 `{limit?: 1..100, offset?: 0..100000}`；`POST /enterprise/lead` 接收正整数 `{id}`。两者需现有管理台 Cookie、`enterprise.read` 和 `all` 范围，再由服务端使用当前管理员会话中的上海令牌固定 GET 上海 `/api/v8/admin/enterprise/leads` 与 `/{id}`；上海端另验 `is_admin`。浏览器不得自带上海令牌或上游 URL。列表只转出摘要；备注与来源 IP 只在详情中返回，字段均按白名单投影。接口未部署、上海权限不足、会话过期或上海不可用须显式报错，不返回伪造空列表。该增量依赖上海迁移 `v8_058_enterprise_leads.sql` 与路由部署。

## 支付管理增量（本地候选）

支付页面已接上海订单、手工充值和提现审批接口，使用独立 `payment.read` / `payment.manage`、完整数据范围和当前管理员的上海账号令牌。端点、双确认载荷、审计与不确定结果处理见[支付接线契约](payments/README.zh.md)。全局列表依赖上海新增 admin/payment/orders 部署；不能以个人历史替代。退款、SP 同步和费率政策不在本轮范围。

### 工作台 SP / 订阅确认写入

账号与订阅写入使用已存在的权限键、专用服务身份、明确订阅期限及绑定原因的一次性确认。`preflight/apply/check` 路径、非密配置变量、轮换和未知结果语义见 [工作台管理协议](workbench/README.zh.md)。上海 CNY 支付仍独立，服务 401 不代表操作者退出登录。
