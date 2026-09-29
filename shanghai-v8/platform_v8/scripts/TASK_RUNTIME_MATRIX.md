# 生产任务脚本运行矩阵

生产脚本唯一来源为 `platform_v8/scripts/tasks/`（92 个 `.py`）。根目录
`task_scripts/` 是弃用副本，不能作为提交、下载或测试基线。

## 运行类别

| 类别 | 脚本 | 最小运行依赖 | 最小输入 | 运行策略 |
|---|---|---|---|---|
| 文本/编码 | `base64_*`、`text_*`、`word_count`、`line_count`、`json_*`、`regex_extract`、`dedup_lines`、`csv_to_json`、`encoding_detect`、`field_stats`、`statistics_summary` | Python 标准库 | stdin 文本或 `EC_PARAMS` | 必须离线 smoke-test |
| 计算 | `pi_compute`、`monte_carlo`、`fft_compute`、`hash_*`、`crc32_batch` | Python 标准库（FFT 可选 numpy） | stdin 或 params | 限制样本、行数与输出条目 |
| 图片/PDF/OCR | `image_*`、`pdf_*`、`ocr_image`、`photo_restore` | Pillow、PyMuPDF/pdfplumber、OCR runtime | 文件或 `EC_INPUT_DIR` | 缺依赖须返回 `env_missing_*` |
| 音视频 | `audio_*`、`video_*`、`whisper_transcribe`、`blender_render` | ffmpeg/ffprobe、Whisper、Blender | 二进制输入或文件目录 | 限制时长、分辨率、帧数与产物大小 |
| LLM/模型 | `llm_*`、`embedding`、`onnx_infer`、`contract_review`、`case_digest`、`ai_*` | 受信模型服务、onnxruntime、numpy | params + 文件/文本 | 禁止任意私网 endpoint 与本地路径 |
| 网络/爬虫 | `url_*`、`crawl_*`、`geo_*`、`seo_rank`、`*_monitor`、`*_search` | requests/受信网络出口 | URL 或 params | URL、DNS、重定向、响应字节数均受限 |
| 文档 OCR | `pdf_to_text`、`pdf_preflight`、`pdf_ocr` | PyMuPDF；扫描件另需 PP-OCRv6/PaddleOCR | 单/多 PDF + `EC_SLICE_META` | 预检文本层后按页切片；正文不写日志，扫描件缺 OCR runtime 必须显式失败 |
| 平台/第三方 | `douyin_*`、`weibo_*`、`xhs_crawler`、`xiaohongshu_search`、`ticket_*`、`snap_*`、`auto_post`、`app_register`、`captcha_solve` | 显式供应商集成 | 显式 demo 开关 | 未接真实供应商时不可伪装生产成功 |

## 必须遵守的脚本契约

1. 输入优先顺序：`EC_PARAMS`、`EC_INPUT_DIR`、stdin；切片任务还必须读取
   `EC_SLICE_META`。
2. 输出为单行 JSON，包含 `status`（`ok` 或 `failed`）、`task_type`、
   `contract_version`、`summary_text`；失败另含 `error`。
3. 缺包或缺工具返回 `failure_class` 为 `env_missing_pkg` 或
   `env_missing_tool`，不得输出 traceback 或空成功。
4. 大二进制产物写入 `EC_OUTPUT_DIR`；stdout 只传受限大小的兼容内容和
   manifest（文件名、媒体类型、字节数、SHA-256）。
5. 新增脚本必须同时补运行类别、最小 smoke-test、输入上限和输出契约。

## 跨模块交接

- 聚合器识别脚本核心结果、SliceMeta 的最终字段、PULL watchdog：引擎负责人确认。
- registry 准入、脚本下载、服务端 SSRF 二次防护：API/services 负责人确认。
- artifact 上传、`EC_OUTPUT_DIR` 扫描与 WebSocket 大消息限制：客户端负责人确认。
