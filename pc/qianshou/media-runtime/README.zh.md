# 固定工作流本地执行适配器（发布候选）

[English](README.md) | 中文

`comfy_runtime.py` 实现 Host 的 `qianshou.media-runtime.v1`：仅回环监听，私有 token 鉴权，固定受审图像或视频工作流，固定输出路径。任务内容只替换方案允许的文本、参考图或首尾帧输入；用户不能提交节点图、模型路径、URL 或任意启动命令。

每个 attempt 在 SQLite 完成持久化后仅提交一次 `/prompt`，预先使用 attempt UUID 作为 Comfy prompt_id。响应丢失或进程重启后，只查询 `/history/{原UUID}` 和原产物。未知请求占用执行槽，不因超时解除或重新生成。下载失败只恢复原文件交付。它不修改旧图像/视频试用记录，不调用上海传媒体，不自行结算或生成收益。

上游响应必须具备有界正 Content-Length，读取长度精确相等后才写入结果；部分文件只能在私有普通单链接文件且内容匹配原结果前缀时续写。Unix 在结果 rename 后 fsync 父目录，再提交成功状态。格式 magic 只作最低类型检查，完整解码与正式账单证明由广州独立验真完成。CPU 合同验证的是适配器进程重启与原 history 可用，不证明 Comfy 后端重启、history 清空或机器掉电后的全链路恢复。

安装包中必须包含该执行文件、`recipes.json` 和固定的工作流 JSON。recipes 的每项包含精确 cap5、固定 media 参数、工作流路径、允许替换的输入节点字段及唯一输出节点/collection。工作流文件 SHA 必须匹配 capability.workflow_sha256；profiles 必须精确等于 Host 从受审安装清单传入的环境变量。输出目录固定为同账号 `attempts/{attemptId}/result/{assetId}/result.png|mp4`，输入沿用 Host `attempts/{attemptId}/assets/{assetId}.png|jpg|webp`。配置上游仅允许 `http://127.0.0.1:端口`，禁止代理、重定向和继承上游凭据。

启动参数：`--bind 127.0.0.1 --port {PORT} --token-file {AUTH_TOKEN_FILE} --instance-id {INSTANCE_ID}`。主程序路径和 recipes/graph 应纳入广州受审 flat-file 包，程序 SHA 即 executor_sha256。这里只提供源代码和 CPU 合同验收：尚未生成受审发布清单、平台解释器包、正式档位/报价、设备独立验收回执。Windows 原生 executable 包装、5080 当前 Comfy 是否支持调用方指定 prompt_id、H3/统一API的鉴权与原任务查询合同均需真实验收；不得用该候选替换现役试用通道。

运行 CPU 合同检查：`python3 -m unittest discover -s qianshou/media-runtime -p 'test_*.py'`。这些测试不使用 GPU，不产生商业订单或设备资格。
