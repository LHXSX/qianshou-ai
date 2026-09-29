# 千手产品层的开发

[English](development.md) | 中文

本文覆盖工作环境准备、这一层所需的构建纪律、一次改动必须通过的门禁，以及团队对自己要求的验证标准。前提是本仓库的一份检出，以及可用的 Node 运行时。

## 构建纪律

产品皮肤在构建期由一个环境变量选择，打包器会把它内联进客户端代码。**每一次**客户端构建都必须设置它，包括单包构建：

```bash
DSH_CLIENT_BUILD_PROFILE=forge npx tsdown --env.DSH_BUILD_FACE client
DSH_CLIENT_BUILD_PROFILE=forge npx tsdown --config packages/client/<package>/tsdown.config.ts
```

遗漏它会**把 forge 分支编译掉**，而且症状是静默的：首屏回落到非 forge 形态、导航项消失、品牌名改变，不报任何错。`scripts/verify-client-artifacts.ts` 正是为抓这一类而存在，它检查两件事：每个客户端产物是否比它赖以构建的源码更新，以及品牌产物里是否含千手门面文案。

客户端产物（`packages/*/*/lib/client.js`）是**入库的**。改了源码却不重建，运行中的界面就会继续显示上一版——先重建，再验证，然后才看结果。

## 门禁

一次提交会跑暂存的 lint 配置、第三方声明检查、空白检查与 vendor 清单守卫。一次推送额外跑客户端类型检查与产物门禁。只要暂存了 Markdown，文档配对就会被检查。

类型检查用项目引用，会缓存结果。需要干净结论时加 `--force`：

```bash
npx tsc -b tsconfig.client.json --force
npx tsc -b tsconfig.host.json --force
```

## 验证标准

布局或行为上的结论用**量测**确认，而不是读源码推断。团队运行一个开了远程调试端口的 Chrome 实例，驱动真实界面并把元素几何读回来：

- **对齐**：界面上的每个块报出同一条左边缘，而不只是一个看起来合理的值；
- **稳定**：控制行在触发展开前后报出相同高度；
- **容纳**：没有任何控件的右边缘越过它的容器；
- **响应**：量测在宽视口与窄视口各做一次，且两处的区域顺序相同。

守卫要**双向**验证：把被保护的条件破坏掉，确认检查确实变红。

## 设计权威

界面改动前先查 `.agents/skills/qianshou-design-system`。它的 `SKILL.md` 拥有色板锚值、对比度下限、层级规则、间距档位与反模式清单；它的 `LAYOUT.md` 拥有结构、对齐轴、展开态规则与窄宽度阈值。

改颜色必须重新计算对比度，计算脚本在该技能里。

## 文档

面向人的文档是**双语配对**：一个 Markdown 文件及其对侧，外加一个 `*.i18n.yaml` sidecar，记录两侧在最后一次确认一致时的 blob 哈希。改了一侧就要把另一侧带上并重新记录：

```bash
node_modules/.bin/tsx scripts/verify-translation-pairing.ts --write docs/qianshou/architecture.md
```

段落占**一个物理行**，折行检查会强制这一条。文档描述**当前状态**：活的机制直接点名，历史归提交、Agent Note 或事后复盘。

非平凡的改动至少带一份 `.agents/notes/` 下的 Agent Note，记录为什么这样决定、放弃了什么、以及怎么验证。

## 运行界面

开发工作台从本检出运行，而打包链可以产出一个应用包。两者是**分开的安装、各自独立的数据目录**；工作台的会话令牌**每次重启都会变**——重启前打开的浏览器标签会一直显示认证提示，直到用当前令牌重新打开。令牌写在 `.artifacts/bridge/workbench.token`。
