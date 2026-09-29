# qs_new4 / E_light4_sage 的 Comfy 源码闭包

本目录只归档固定视频配方需要的 **供应商提交锁、最小本地补丁、H3 采样节点固定源码及许可**。它不含模型权重、媒体、设备私有配置、凭据、运行日志或安装后的 Python 环境。其他工作流不在支持范围内。此目录的源码装配与语法校验不等于新电脑安装或 GPU 出片验收。

## 锁定来源

| 组件 | 固定版本和提交 | 许可 | 固定图用途 |
| --- | --- | --- | --- |
| ComfyUI | 0.30.0 / `9a9fdb10ed144ce760d9682cb247526ea23cc525` | GPL-3.0 | 核心加载、LoRA bypass、原生 `MiniMaxH3ImageToVideo` |
| ComfyUI-KJNodes | 1.3.9 / `b7646ad70a7daa7aeb919ca542274758d26ba2df` | GPL-3.0 | `PathchSageAttentionKJ`；原拼写保留 |
| ComfyUI_LayerStyle | 2.0.38 / `d94bef1ee5ed3656f5ff1bb2830a4ffd94f40935` | MIT | `LayerUtility: PurgeVRAM V2` |
| ComfyUI-VideoHelperSuite | 1.7.9 / `2984ec4c4b93292421888f38db74a5e8802a8ff8` | GPL-3.0 | `VHS_VideoCombine` |

精确公开 origin、Git tree、许可与补丁 SHA 在 [vendor-lock.json](vendor-lock.json)。固定图还使用本目录 `custom_nodes/h3_benchmark_sampler` 的三个 GPL-3.0-or-later Python 模块及其 LICENSE/COPYING。`ComfyUI-MiniMax-H3-Image-Studio` 仅提供 H3 图像节点，固定视频图不调用它。

本包另增加 `custom_nodes/qs_h3_source_attestor` 两个本项目自研、按 Apache-2.0 提供的 Python 源文件；它只注册进程内只读路由，不创建任务。装配器逐字节钉住它们。此授权不改变旁边的 GPL-3.0-or-later 采样节点或供应商许可；见 [包内声明](../NOTICE.md)。

供应商应按 **完整固定 Git 提交** 检出。KJNodes 的顶层 `__init__.py` 导入多个 `nodes` 模块；LayerStyle 的顶层 `__init__.py` 动态导入所有 `py/*.py`；VideoHelperSuite 顶层还导入 server、documentation 和 latent_preview。仅复制单个节点文件不能形成可加载包。依赖安装应读取四个固定提交内各自的 `requirements.txt`/`pyproject.toml`，再通过上级接入包的依赖锁和只读 preflight 核验。

## 在新目录装配源码

需要 Python 3.11+ 和 Git。命令只写入一个**尚不存在**、显式给出的输出目录：

```powershell
python .\assemble_comfy.py --output <新的软件源码目录>
```

默认从 `vendor-lock.json` 的四个公开 origin 获取固定提交。网络离线时可分别传入 `--comfyui-source`、`--kjnodes-source`、`--layerstyle-source`、`--videohelpersuite-source`，值须为有相同公开 origin、且包含固定 commit 的本地 Git clone；装配器只读取它们的提交，不采纳未提交文件。它拒绝已存在的输出、输出位于供应商源码树内、提交/tree/许可/版本不符、补丁来源改变、目标字节或语法不符。失败时保留新的部分输出供检查，不覆盖或删除已有文件。

装配器先锁定 `core.autocrlf=false`，再对干净的固定供应商 checkout 执行 `git apply --check` 和 `git apply`。`comfyui-0.30.0.patch` 只修改 `comfy/ops.py`、`comfy/sd.py`、`comfy/weight_adapter/bypass.py`、`comfy_extras/nodes_minimax_h3.py`；额外复制 `comfy/minimax_lora_guard.py`。`kjnodes-1.3.9.patch` 只修改 `nodes/model_optimization_nodes.py`。装配末尾核每个本地差异文件的 **raw SHA256 和 CRLF→LF SHA256**，两者因固定 LF 输出应相同；用 `compile(bytes, ..., 'exec')` 做语法检查，不 import/exec 模块、不生成 pyc、不启动服务或 GPU。

KJ 补丁的显式 HQ `sageattn_qk_int8_pv_fp16_cuda` 分支，仅在运行时核到 CUDA SM 12.0 才使用已验证的 per-warp 内核；其他设备明确拒绝该显式分支。固定 `qs_new4` 图选择 SageAttention `auto`，但别的 GPU 上的完整 H3 出片仍需独立兼容核验。新目标 KJ 文件内容摘要与现役 V1 不同；更新身份 pin 并做新 self-test 之前，不可拿旧样片/证明冒充新包验收。

## 边界与核验结果

### Comfy 进程内源码证明

先完成根目录 `manifest.json` 冻结，再通过本机私有环境变量 `H3_CANONICAL_MANIFEST_PATH` 指向其**绝对路径**。Comfy 必须用 `python -B main.py --listen 127.0.0.1 --port <本机端口>` 启动；等价的 `PYTHONDONTWRITEBYTECODE=1` 也可使 `sys.dont_write_bytecode` 为真。路由拒绝非 Windows、非单一 loopback 监听、旧 `__pycache__`/`.pyc`/`.pyo`、额外 `custom_nodes` 搜索根。`extra_model_paths.yaml` 可注册本机模型分类目录，不能增加外部 `custom_nodes` 执行源。新装配目录不得有旧字节码。

`POST /qs-h3/v1/source-attestation` 只接受本机回环 TCP，请求 JSON 恰为：

```json
{"schemaVersion":1,"classTypes":["固定图按字典序的全部17个class_type"],"sourceManifestSha256":"manifest.json原始UTF-8字节的64位小写SHA256"}
```

请求中的 `classTypes` 必须逐项等于 `manifest.requiredGraphClassTypes`。成功响应为 `schemaVersion=1`、本次 Comfy 启动稳定的随机 `processToken`、`sourceManifestSha256`、`classOrigins`、`classOriginSha256`、`ffmpegSha256`。`classOrigins` 按 `classType` 排序，每行为 `{classType,moduleName,classQualname,moduleRelativePath,sourceOrigin,sourceRawSha256,sourceSize}`；路径仅为 Comfy 安装根相对 POSIX 路径。`classOriginSha256` 是这些行按 `json.dumps(rows,ensure_ascii=False,sort_keys=True,separators=(',',':'),allow_nan=False).encode('utf-8')` 取 SHA256。`ffmpegSha256` 为 VHS 模块实际选中 ffmpeg 可执行文件的内容 SHA，不返回其路径。错误只返回 `400 invalid_request`、`403 loopback_required`、`409 source_identity_changed` 或 `503 source_attestation_unavailable`；启动前闸失败则路由不存在。

进程启动时从私有 manifest 冻结完整 Comfy `.py` 清单与 VHS `video_formats` 的固定 13 个 JSON：物理相对位置、原始字节长度/SHA，以及 Windows file ID、写入时间、变更时间。每次请求对源码和 JSON 用短时独占、拒 reparse/hardlink 的同一文件句柄复读；manifest 以兼容另一端长持读句柄的 Share.Read 短时复读。另核固定物理根、全目录增删、manifest generation、实际 `nodes.NODE_CLASS_MAPPINGS` 中固定 17 类及各自执行方法所在源文件。首次成功查询另冻结类对象与执行方法代码对象身份和 VHS 实际 ffmpeg 身份，随后重映射、猴子补丁、磁盘改后恢复原字节均拒绝；需要闲置重启和新自检。私有路径、mtime/file ID 与配置不进入响应。该证明绑定实际已加载的类与磁盘源码；它不证明任意进程内全局对象绝不被其他受信代码改写，接单端仍须在关键阶段重验且实际 Comfy 运行验收尚未执行。

固定图 17 类的供应商源码已经通过 AST 静态检查：`FUNCTION` 或 V3 `execute` 都由对应类所在 `.py` 自身定义。动态注册结果只有实际 Comfy 启动后才能核验。`torch`、SageAttention、CUDA、ffmpeg 等外部原生二进制不在 Python 源码清单内；ffmpeg 单独有内容摘要，其他原生依赖需独立版本/硬件闸。所有 VHS format JSON 均受辅助清单与目录精确增删核验。

隔离目录的四供应商本地克隆装配、`git apply --check`、实际 apply、节点注册文件静态检查、最终字节与无磁盘语法检查已通过。attestor 的 Windows 无服务合成测试 11 项通过：覆盖 900 以上源文件、跨进程只读共享、改后恢复、旧字节码、类重映射、方法猴子补丁、VHS JSON/ffmpeg、父 junction 在检查与打开句柄间改接同 baseline 字节且外部字节不变。另 1 项动态目录 symlink 因 Windows 权限 1314 未执行，不能计通过。没有在新机安装 Python/GPU 依赖，没有真实 Comfy 包加载或视频任务测试。现役 Comfy、8790、8188、模型和任务没有改动。
