---
description: "侧栏底部账户卡与个人中心页：档位、额度和身份来自宿主账号会话与订阅网关。"
kind: "package-reference"
---

# 千手账户区

[English](README.md) | 中文

## 概述

同一份读模型上的两个界面：

- **账户卡**在左侧栏底部——身份、档位胶囊、剩余额度与低额度提示，在任何面板里都看得见；
- **个人中心**是主面板的一整页（`qianshou-account`）——完整明细：账号字段、档位、额度环、滚动窗口用量与并发上限。

点账户卡即打开该页。两者共用**同一个** `AccountViewService` 实例，所以两处不可能对额度给出不同说法。

## 目录

- [使用这个包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [界面不可丢的设计规则](#design-rules-the-ui-must-not-drop)
- [模型体验](#model-experience)
- [已知限制与待办](#known-limitations-and-deferred-work)
- [开发说明](#dev-note)

## 使用这个包

profile 挂载它时它自行注册；产品代码没有可调用的 API。

| 界面 | 插槽 | id |
| --- | --- | --- |
| 账户卡 | `sidebar.footer.action` | `qianshou-account` |
| 个人中心 | `main` | `qianshou-account` |
| 侧栏导航行 | `sidebar.panellist` | `qianshou-account` |

它读的两条路由在宿主上**都只收 POST**：

```
POST /api/qianshou/account/state   -> { ok, state, account }
POST /api/qianshou/ai/status       -> { ok, version, tier, credit, limits }
```

对其中任一条发 `GET` 会得到纯文本 `404 not found`——宿主没为它们注册 `GET`。所以 `endpoints.ts` 把方法写死，并由契约测试断言它。

## 理解实现

| 文件 | 职责 |
| --- | --- |
| `endpoints.ts` | 两条路径与唯一的请求形状（POST、JSON、`credentials: 'include'`）。 |
| `status.ts` | 正文 → 事实。每个字段都收窄；读不出来的字段变 `null`，绝不猜。 |
| `store.ts` | `AccountViewService`：两次读取、短 TTL、单飞、强制刷新、失败分类。 |
| `use-account-view.ts` | `useSyncExternalStore` 桥，让「读快照」与「订阅」在同一次渲染里成对发生。 |
| `AccountCard.tsx` / `.module.css` | 侧栏底部账户卡。 |
| `AccountPage.tsx` / `.module.css` | 个人中心页。 |
| `foot.css` | 账户卡与设置行之间的那一条分隔线。 |
| `AccountPanelIcon.tsx` | 侧栏导航图标。 |
| `locales.ts` | `qianshou.account` 字典。 |

`store.ts` 刻意让两次读取**彼此独立**：网关故障时不能把「你已登录」一起藏起来——那恰恰是用户最需要这个事实的时刻。

## 界面不可丢的设计规则

1. **账户在设置之上，设置在正底部。** 这是上游默认，也是 VS Code 的做法（`ACCOUNTS_ACTION_INDEX` 先 push，Manage 齿轮后 push）。曾经设计过「把卡片重排到设置之下」并**撤回**：它需要对另一个包的 footer 内部结构做更强的假设，而换来的只是一个偏好。
2. **跨包的样式只写 `[data-slot="…"]` 选择器。** `foot.css` 用的是渲染器明文承诺的定位接缝，没有写任何 CSS Module 哈希类名，所以上游重建不可能静默弄坏它。
3. **读不出来绝不画成 0。** `monthlySp` 缺失时画斜纹「未知」条，不画 0%；`200` 但正文解析不了归为 `unavailable`，不是「没有额度」。
4. **「读不到」与「未登录」是两种状态。** 它们导向相反的用户动作：重试 与 去登录。
5. **`force` 刷新就真的去读。** 用户点了刷新，不能拿 TTL 缓存糊弄他。
6. **SP 不是元。** 额度单位是 `SP`（1 SP = 0.01 元），按上游 list price 计价；订阅价里还含服务与路由成本。`plan.hint` 用话说明了这件事——否则「390 SP」摆在 ¥39 的档位旁边会被读成算错账。

## 模型体验

账户卡是与模型无关的界面：它不出现在模型上下文、提示词或工具输出里，也不渲染任何上游模型标识。它显示的是网关报出的**已发布**档位名（`tier.label`），只有在网关没给时才回落到本地字典。

## 已知限制与待办

- **这里不做登录与登出。** 完整的凭据流程（含强制的 2FA 一步与注册）已经在 **设置 → 账户**（`ui-settings-general`）。目前没有「打开设置到指定小节」的 API，所以账户卡暂时不跳转；个人中心页也刻意不复制第二套登录实现——那会让 2FA 分支将来各走各的。
- **账号身份由本包自己读。** 复用设置侧的 store 能省掉每次读取的一个 POST 往返，代价是把侧栏耦合到设置外壳上。两者读同一个端点，所以不会互相矛盾；重复的是一次请求，不是两份真相。
- **`account.balance` 刻意不用。** 那是上游给的数字、单位未经验证；用户被计费对照的是档位额度。
- **两条路由的档位来源不一致。** `/api/qianshou/ai/status` 按「订阅 → 角色」解析档位，而 `/api/qianshou/ai/chat/completions` 按「订阅 → `basic`」。因此运营方按角色拿到的档位会显示在这一页上，却不会在 OpenAI 兼容那条路上被承认。这是宿主侧的不一致，**这里没有修**。
- **没有每轮刷新。** 可用的客户端事件里没有「一轮结束」信号，所以账户卡在挂载时、TTL 到期时和用户显式请求时刷新，而不是每条回复之后。

## 开发备注

现在存在的验证：

- `tests/store.client.spec.ts` —— 22 条测试，覆盖真实抓取的正文、只收 POST 的形状、TTL／单飞／force 规则、全部失败分类与 dispose 路径。
- `tests/apply.client.spec.ts` —— 5 条装配测试，跑在真实 cordis 上下文与真实槽位注册表上：三处注册、字典、卸载，以及**注入面身份稳定**。
- 已做反向验证：把方法改成 `GET`、以及去掉比例夹取，各自都让测试变红；恢复后变绿。
- 实测（运行中的工作台、Chrome、forge 外观）：账户卡在 `x=12, y=772`、`256×56`，位于 `y=848` 的设置行**之上**，分隔线 `0.5px`，phase `ready`，文案 `111111 / 普通版 / 普通版 · 剩余 390.00 SP`，控制台零异常。

### 本包已经付过学费的两个坑

1. **注入面身份不稳定会让挂载效应静默失效。** `inject` 工厂每次渲染都会跑；每次都返回新对象字面量，`refresh` 就每次都是新身份，于是 `useEffect(() => refresh(), [refresh])` 永远重新触发、永远不落定成"只读一次"。现象是卡片卡在 `idle`、界面什么都不显示、**控制台一行错也没有**——所以现在注入面只构造一次，并用测试钉住身份。
2. **样式注入必须有 `typeof document` 守卫。** 装配路径要在无 DOM 的环境（测试运行器）里也能跑完，否则注册断言会以"插件没注册"的形式失败，而真正的原因是环境假设写死了。

两条路由也在真实宿主上确认过**只收 POST**：`GET` 回纯文本 `404 not found`，`POST` 回 `200` 与 JSON。而 `404` 会被读成"没有这个功能"，不是"读不到"。
