# 千手 AI 运营管理台 · 前端工程（apps/qianshou-admin）

独立部署在 `https://admin.qianshousuanli.com`（域名根路径）的运营管理台前端。
界面契约的唯一事实来源是 [`packages/host/admin-console/API.md`](../../packages/host/admin-console/API.md)（冻结版 v1）。

包名：`@qianshou/admin-web`（`private: true`，不入库、不发布）。

## 1. 定位与硬边界

- **与算力运营台（`qianshousuanli.com/eco-admin/`）完全独立**：工程、路由、权限表、角色表、组件全部从零建，
  没有复用它的任何一行代码；两个面的角色（`surface`）不允许互通。
- **前端不做安全边界判断**：菜单、权限键、数据范围、可见性全部来自服务端 `session/me` 的下发结果，
  前端只渲染。页面上的权限提示都是「服务端这么说」，不是前端算出来的。
- **生产代码只认真实接口**：`mock/` 下的开发夹具只在显式开启时挂载，`vite build` 产物中不含 mock 代码。
- **不造假数据**：依赖未就绪的模块（市场 / 发现页 / 订单工单）是占位页，
  缺口信息全部来自服务端 `503` 响应的 `module` / `missing[]` 与 `session/me` 的 `readiness`，页面上没有任何演示条目。

## 2. 技术栈

| 依赖 | 版本（实际解析） | 说明 |
| --- | --- | --- |
| Vue | 3.5.39 | `<script setup lang="ts">` |
| Vue Router | 4.6.4 | HTML5 history 模式（生产挂在域名根） |
| Element Plus | 2.14.5 | 全量引入 + 中文语言包（内网管理台，体积可接受） |
| Vite | 8.0.16 | `base: '/'` |
| TypeScript | 6.0.3 | `strict` + `noUncheckedIndexedAccess` |
| vue-tsc | 3.3.11 | 构建前类型检查 |

不引入 pinia：会话状态只是 `src/session/store.ts` 里的一个 `reactive` 单例，比状态管理库小得多。
不引入 axios：`src/api/client.ts` 用 `fetch` 封装契约信封，唯一出网入口。

## 3. 本地开发

```bash
# 1) 安装依赖（在仓库根执行；本工程属于 pnpm workspace apps/*）
pnpm install --filter @qianshou/admin-web...

# 2) 开发服务器（默认 4175，接口转发到本机 admin-console:7090）
pnpm --filter @qianshou/admin-web run dev

# 后端未启动时，可以只跑前端 + 开发夹具后端（不进入生产构建）
pnpm --filter @qianshou/admin-web run dev:mock
```

后端地址可覆盖（`vite.config.ts` 里的 `QIANSHOU_ADMIN_API_TARGET`）：

```bash
QIANSHOU_ADMIN_API_TARGET=http://127.0.0.1:7090 pnpm --filter @qianshou/admin-web run dev
```

默认开发行为：浏览器请求同源相对路径 `/api/qianshou/ai/admin/...`，
由 Vite dev server 代理到 `http://127.0.0.1:7090`（`packages/host/admin-console`）。

### 3.1 开发夹具后端的边界

`mock/server.ts` 是一个 Vite 插件（`apply: 'serve'`），只在
`QIANSHOU_ADMIN_DEV_MOCK=1 pnpm run dev:mock` 时挂载：

- 它不含生产依赖，`vite build` 不会把它打进任何 chunk（可用 `grep -r "开发夹具" dist/` 验证为空）；
- 它返回的数据是**明确标注的开发夹具**，仅用于在没有后端时演练「接口形状 / 错误分类 / 两步确认」三条链路；
- **未覆盖 `credential/*` 与 `pool/*`**（夹具菜单里没有这两个 key，`session/me` 也不返回）：这两页要真练，
  需要把 `QIANSHOU_ADMIN_API_TARGET` 指到真实的 admin-console（或后续单独补夹具）；
- 它刻意复刻了契约里的边界行为：`account/adjustment/*`、`subscription/manage/*`、`market|discovery|order/overview`
  一律返回 `503 dependency_unavailable`（含 `module` + `missing[]`），令牌 60 秒一次性、原因少于 4 字回 `400`。

## 4. 构建与部署

```bash
pnpm --filter @qianshou/admin-web run typecheck   # vue-tsc --noEmit
pnpm --filter @qianshou/admin-web run build       # typecheck + vite build → dist/
pnpm --filter @qianshou/admin-web run build:only  # 只跑 vite build
pnpm --filter @qianshou/admin-web run test        # vitest（__tests__/）
pnpm --filter @qianshou/admin-web run preview     # 本地预览 dist/
```

- 资源 base 固定 `/`，所以 `dist/index.html` 里引用的是 `/assets/...`（**不是** `./assets/...`），
  可以用 `grep -o 'src="[^"]*"' dist/index.html` 直接确认。
- SPA 使用 history 模式，**部署时必须把未命中的路径回落到 `dist/index.html`**
  （否则 `/rbac`、`/audit` 这类深链刷新会 404）。由服务端 `qianshou-admin-console` 负责静态托管与回落。
- 白名单是第一道门：不在白名单内的来源拿不到 `index.html`，也拿不到任何接口。
- `dist/` 是本工程自己声明的构建产物（见本目录 `.gitignore`），不提交进仓库。

## 5. 目录与模块划分

```
src/
  api/
    endpoints.ts          # 全站唯一的路径字面量来源（39 个端点）
    client.ts             # fetch 封装：POST + JSON + 同源凭据 + 信封校验 + 401 钩子
    errors.ts             # HTTP/code → AdminApiError 分类（错误文案与提示的唯一来源）
    confirm.ts            # 两步确认：preflight → apply，reason ≥ 4 字校验
    types.ts              # 契约类型（与 API.md 一一对应）
    modules/*.ts          # 按业务分模块的取数函数（session/modules/rbac/audit/flags/whitelist/accounts/subscriptions/upstream-keys/pool/placeholders）
  components/
    AppLayout.vue         # 侧栏（菜单来自 session/me）+ 顶栏（身份/clientIp/退出）
    ConfirmApplyDialog.vue# 通用两步确认弹窗（预览差异 → 填原因 → 执行）
    DangerConfirmDialog.vue# 高危操作的二次确认弹窗（danger 实心 + 只读事实摆在前）
    DiffView.vue          # before → after 差异表（预览与审计详情共用）
    ErrorAlert.vue        # 统一错误渲染（401/403/403 need/502/503 分流）
    PlaceholderModuleView.vue # 三个依赖未就绪模块的占位骨架
  session/store.ts        # 会话快照（身份/权限/菜单/就绪度/clientIp）+ 退出登录
  router/index.ts         # 路由表 + 登录守卫（不挂权限元数据）
  utils/                  # format / module-status / diff-rows / cidr / async-state（纯函数，可单测）
  views/                  # 13 个页面（含上游密钥 / 上游号池）
mock/server.ts            # 仅开发期的夹具后端（未覆盖 pool/*，见 §3.1）
__tests__/                # 单测（66 个用例）
```

页面与路由：

| 路由 | 文件 | 依赖接口 |
| --- | --- | --- |
| `/login` | `views/LoginView.vue` | `session/login`、`session/login-totp`（+`session/me` 收尾） |
| `/overview` | `views/OverviewView.vue` | `session/me`、`modules`、`health` |
| `/account` | `views/AccountView.vue` | `account/list`、`account/detail`、`account/ledger`、`account/adjustment/preflight` |
| `/subscription` | `views/SubscriptionView.vue` | `subscription/list`、`subscription/tiers` |
| `/market` | `views/MarketReviewView.vue` → 接单技能、历史接单商品和插件商品审核 | `market/order-publications`、`market/order-adapter-products`、`market/reviews` 及既有审核入口 |
| `/discovery` | `views/DiscoveryView.vue` → 占位 | `discovery/overview`（同上） |
| `/order` | `views/OrderView.vue` → 占位 | `order/overview`（同上） |
| `/rbac` | `views/RbacView.vue` | `rbac/permissions`、`rbac/roles/{list,preflight,apply}`、`rbac/admins/{list,preflight,apply}` |
| `/audit` | `views/AuditView.vue` | `audit/list`、`audit/detail` |
| `/whitelist` | `views/WhitelistView.vue` | `whitelist/status`、`whitelist/entries/{preflight,apply}` |
| `/flags` | `views/FlagsView.vue` | `flags/list`、`flags/{preflight,apply}` |
| `/credential` | `views/UpstreamKeysView.vue` | `credential/list`、`credential/{preflight,apply}` |
| `/pool` | `views/PoolView.vue` | `pool/list`、`pool/preflight`（op=add/remove 两个分支）、`pool/apply`、`pool/remove` |

侧栏菜单完全由 `session/me` 的 `menu` 渲染；服务端下发了前端没有实现路由的 key 时，
侧栏会把它显示为「前端未实现」而不是静默丢弃（避免契约与前端悄悄漂移）。

## 6. 契约端点 → 代码位置

`src/api/endpoints.ts` 是全站唯一出现路径字面量的地方，下表列出每个端点的实际调用点：

| 契约 | 端点 | 调用文件 |
| --- | --- | --- |
| §2.2 | `session/login` | `src/api/modules/session.ts` |
| §2.2 | `session/login-totp` | `src/api/modules/session.ts` |
| §2.2 | `session/logout` | `src/api/modules/session.ts` |
| §2.2 | `session/me` | `src/api/modules/session.ts` |
| §3 | `modules` | `src/api/modules/modules.ts` |
| §4.4 | `rbac/permissions` | `src/api/modules/rbac.ts` |
| §4.4 | `rbac/roles/list` | `src/api/modules/rbac.ts` |
| §4.4 | `rbac/roles/preflight` | `src/api/modules/rbac.ts`（经 `src/api/confirm.ts`） |
| §4.4 | `rbac/roles/apply` | `src/api/modules/rbac.ts`（经 `src/api/confirm.ts`） |
| §4.4 | `rbac/admins/list` | `src/api/modules/rbac.ts` |
| §4.4 | `rbac/admins/preflight` | `src/api/modules/rbac.ts`（经 `src/api/confirm.ts`） |
| §4.4 | `rbac/admins/apply` | `src/api/modules/rbac.ts`（经 `src/api/confirm.ts`） |
| §5 | `audit/list` | `src/api/modules/audit.ts` |
| §5 | `audit/detail` | `src/api/modules/audit.ts` |
| §6 | `flags/list` | `src/api/modules/flags.ts` |
| §6 | `flags/preflight` | `src/api/modules/flags.ts` |
| §6 | `flags/apply` | `src/api/modules/flags.ts` |
| §7 | `whitelist/status` | `src/api/modules/whitelist.ts` |
| §7 | `whitelist/entries/preflight` | `src/api/modules/whitelist.ts` |
| §7 | `whitelist/entries/apply` | `src/api/modules/whitelist.ts` |
| §8.1 | `account/list` | `src/api/modules/accounts.ts` |
| §8.1 | `account/detail` | `src/api/modules/accounts.ts` |
| §8.1 | `account/ledger` | `src/api/modules/accounts.ts` |
| §8.1 | `account/adjustment/preflight` | `src/api/modules/accounts.ts` |
| §8.2 | `subscription/list` | `src/api/modules/subscriptions.ts` |
| §8.2 | `subscription/tiers` | `src/api/modules/subscriptions.ts` |
| §8.2 | `subscription/manage/preflight` | `src/api/modules/subscriptions.ts` |
| §8.3 | `market/overview` | `src/api/modules/placeholders.ts` |
| §8.4 | `discovery/overview` | `src/api/modules/placeholders.ts` |
| §8.5 | `order/overview` | `src/api/modules/placeholders.ts` |
| §8.5b | `models/overview` | `src/api/modules/placeholders.ts` |
| §8.6 | `health` | `src/api/modules/modules.ts` |
| §9 | `credential/list` | `src/api/modules/upstream-keys.ts` |
| §9 | `credential/preflight` | `src/api/modules/upstream-keys.ts`（经 `src/api/confirm.ts`） |
| §9 | `credential/apply` | `src/api/modules/upstream-keys.ts`（经 `src/api/confirm.ts`） |
| §8.8 | `pool/list` | `src/api/modules/pool.ts` |
| §8.8 | `pool/preflight`（`op: add` / `op: remove`） | `src/api/modules/pool.ts`（经 `src/api/confirm.ts`） |
| §8.8 | `pool/apply` | `src/api/modules/pool.ts`（经 `src/api/confirm.ts`） |
| §8.8 | `pool/remove` | `src/api/modules/pool.ts`（经 `src/api/confirm.ts`） |

复核方式（新增/改动端点时跑一遍）：

```bash
grep -rn "ENDPOINTS\." src/ | grep -v "src/api/endpoints.ts"
```

## 7. 两步确认（所有写操作）

`src/api/confirm.ts` + `src/components/ConfirmApplyDialog.vue` 是唯一实现：

1. 打开弹窗立即调用 `…/preflight`（纯预览，不改数据），展示 `diff.before → diff.after` 与令牌倒计时；
2. 管理员填 `reason`（≥ 4 字，本地也会校验一次），点确认才走 `…/apply`；
3. 令牌 60 秒一次性：
   - 过期后「确认执行」被禁用，必须点「重新预览」；
   - 服务端回 `409 confirm_expired / confirm_invalid / confirm_required / version_conflict` 时，
     弹窗会丢弃旧预览并提示重新预览，避免对着过期差异反复点击；
4. `account/adjustment` 这类**只有 preflight、没有 apply** 的接口（属主服务未开放写接口）：
   弹窗只展示预览结果并如实说明「当前没有可执行的第二步」，不会伪造成功。

## 8. 错误分类（严格按契约 §1.2）

`src/api/errors.ts` 是文案与分支的唯一来源，`ErrorAlert.vue` 负责渲染：

| 情形 | 判定 | 页面表现 |
| --- | --- | --- |
| `401 unauthenticated` | `isUnauthenticated` | 清会话 + 跳登录页（`main.ts` 注册的唯一 401 钩子） |
| `403 forbidden` | `isForbidden` | 「权限不足」并显示缺失的权限键 `need` |
| `403 ip_not_allowed` | `isIpNotAllowed` | 「来源 IP 不在白名单」+ 逃生路径指引 |
| `403 not_an_admin` | `isNotAnAdmin` | 「该账号不是管理台管理员」（与密码错误分开说） |
| `403 admin_disabled` | `isAdminDisabled` | 「管理员已被停用」 |
| `429 rate_limited` | `code` | 登录失败过多被限流 |
| `502 upstream_unavailable` | `isUpstreamUnavailable` | 「上游账号服务不可达」——**文案里刻意不出现「重新登录」**（有单测盯着） |
| `503 dependency_unavailable` | `isDependencyUnavailable` | 展开 `module` + `missing[]` 清单（占位页的数据源） |
| 网络失败 | `transport_unavailable` | 「无法连接到管理台服务」 |

## 9. 验证与证据

```bash
pnpm --filter @qianshou/admin-web run typecheck   # 通过（无输出即无错误）
pnpm --filter @qianshou/admin-web run test        # 3 个用例文件 / 31 个用例通过
pnpm --filter @qianshou/admin-web run build       # 成功，产出 dist/
```

单测覆盖的是最容易被做错、且服务端无法替前端兜底的部分：

- `__tests__/errors.spec.ts`（12）：`401/403(need)/403 not_an_admin/403 admin_disabled/403 ip_not_allowed/409/429/502/503`
  的分类与文案，其中「502 不得出现『重新登录』字样」是显式断言；
- `__tests__/client.spec.ts`（7）：POST+JSON+同源凭据、401 只触发一次钩子、403/502 不跳登录、
  200 缺 `ok:true` 信封判为 `unexpected_response`、纯文本 403 保留原文、fetch 失败归一；
- `__tests__/utils.spec.ts`（12）：reason 少于 4 字本地拒绝、令牌剩余时间不为负、
  diff 行构造（缺失字段显示「（未提供）」而不是 undefined）、CIDR 覆盖判断、就绪度三档映射、展示层格式化。

用例目录刻意命名为 `__tests__` 而不是 `apps/*/tests`：仓库根的 vitest 配置会把后者纳入整仓测试，
而那套配置不认本工程的 `@/*` 别名；分开之后两组测试互不干扰。

### 9.1 已验证的连接方式

- 开发链路：`pnpm --filter @qianshou/admin-web run dev:mock` 起 4175，逐条 `curl` 打通全部 31 个契约端点，
  并验证了两步确认的完整分支（无令牌 `409 confirm_required` / 错令牌 `409 confirm_invalid` /
  原因过短 `400 bad_request` / 正常 `200 ok:true auditId` / 同一令牌二次使用 `409`）。
- 生产链路：`dist/` 用 `vite preview` 在根路径 `/` 下服务，`/assets/index-*.js` 与深链 `/login` 均返回 200。

### 9.2 尚未验证（需要后端配合）

- **未与真实 `packages/host/admin-console` 联调**：本工程验证的是「契约形状 + 前端行为」，
  真实服务的字段取值、状态码、`menu` 构成仍需联调确认。
- 未验证真实登录（需要真实账号 + TOTP）、未验证真实写操作落库与审计条目生成。
- 未做浏览器端 E2E（无 Playwright 用例）；渲染正确性目前由类型检查 + 单测 + 人工接口冒烟覆盖。

## 10. 维护约定

- 契约变了，**先改 `packages/host/admin-console/API.md`**，再同步本工程的
  `src/api/types.ts`（形状）、`src/api/endpoints.ts`（路径）、`src/utils/module-status.ts`（就绪度档位）三处。
- 新增页面时必须让服务端菜单 key 与路由名一致（`src/router/index.ts` 的 `ROUTE_NAMES`），
  否则侧栏会显示「前端未实现」。
- 不要在 `src/` 里写 mock 数据；开发夹具只放在 `mock/`，并由 `QIANSHOU_ADMIN_DEV_MOCK` 开关控制。
- 不要在前端新增「某角色能看某菜单/某按钮」的判断：可见性来自服务端 `menu` 与接口返回的 `403 need`。

接单技能审核页在投稿待审期间定时串行读取平台回执，隐藏页面和正在提交的人工审核暂停自动读取。账号变化时清空旧快照，迟到回复不能恢复旧账号数据；打开的详情抽屉随同一投稿的新回执更新，审核员未提交的说明保留。尚未生成回执与无效、过大回执分别展示；隔离执行样本仅证明结构核验，不代表语义已获买方认可。自动刷新不会批准、驳回、修改价格或签发回执。

发布记录管理读取中央服务器的 lifecycle 权限与 revision，明确显示作者账号、撤回、下架、归档及恢复；确认捕获版本，账号切换丢弃旧确认。归档只隐藏并停止新业务，保留合同、权益与账本；恢复不自动重新上架。广州写路由要求 market.review、scope=all、当前同主体上海管理授权、精确记录及持久化前后审计，队列只读委托不能升级授权。

### API 连接的账号与设备观察

设备列表分别显示广州核验的登录账号名称、设备名称、操作系统/架构、GPU 与内存，以及图像/视频 API 的模型名称；完整系统版本、CPU、显存和工作流放在详情。账号、设备名、GPU 和模型支持搜索。旧设备缺少字段时显示待同步或待检测，Mac 统一内存不编造独立显存。设备配置是本机报告，账号名称由广州验证上海 auth/me 后保存，不能由节点自称。前后端仅允许公开标签和有限配置字段，不投影 IP、token 或模型私有路径；这些信息不直接授予收费资格。

本轮 Vue 类型检查/生产构建及 19 项真实挂载与 HTTP 投影回归通过，包括账号变化、旧观察缺失、无效路径/凭据字段和完整详情。源码构建不等于 Windows 原生验收。
