---
name: quickjs-char-count-example
description: 统计文字里的字符数量，支持中文、英文和表情符号。
metadata:
  displayName: 文字统计
  category: text
---

# 文字统计

填写「文字内容」，返回字符数量。中文、英文字母和单个表情符号都按一个字符统计。

技能助手通过 `qianshou_try_local_skill` 试用，选择当前扫描目录里的命令名，输入例子为 `{"text":"千手AI"}`，输出应为 `{"count":4}`。

`scripts/order_adapter/task-definition.json` 的 `inputSchema.contentSchema` 声明中文字段名称、必填项和长度限制；本机自检、试用和平台派单都按同一份声明检查。修改任务时同时修改执行代码、输入输出声明和至少两组不同的期望样例。

这是 v3 通用运行 ABI 示例。`scripts/order_adapter/src/adapter.quickjs.js` 只声明 `run(input)`，不导入宿主 API。本机样例通过后仍需独立审核和平台真实受理，才能发布接单。
