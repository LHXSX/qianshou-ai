# 千手手机外壳

[English](README.md) | 中文

`apps/qianshou-mobile` 是独立的手机产品界面。它不是桌面工作台的自适应缩小版，也不贡献算力。该外壳在 iPhone 390×844 上呈现对话、智能体目录、发现、任务、调度、账户和左侧抽屉，图标为专用 SVG，栅格素材位于 `public/media/`。

## 启动

在仓库根目录执行：

```sh
pnpm install
pnpm --filter @qianshou/mobile dev
```

用手机宽度视口打开 `http://127.0.0.1:4174/`。当前复刻使用设计样例内容，不会登录 PC 会话、提交真实任务或扣费。

## 限制

配对、PC 窗口命令送达和商店支付仍由 `@deepseek-ai/dsh-client-pc-window-bridge` 与主机移动网关负责。本应用只拥有展示和本地交互。
