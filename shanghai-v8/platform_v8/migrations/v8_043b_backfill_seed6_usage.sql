-- v8_043b: 回填 v8_037 已上架 6 个种子应用的 display_meta.usage
-- （v8_043 生成器跳过了 SKIP 集合里的 slug）
BEGIN;

UPDATE we_apps SET display_meta = coalesce(display_meta,'{}'::jsonb) || '{
  "usage": [
    "输入：上传 JSON 记录数组文件，或粘贴 JSON 文本",
    "支持格式：json",
    "输出：带表头/样式的规范 Excel 工作簿",
    "计费：免费（借调节点仅收算力费）"
  ]
}'::jsonb, updated_at = now() WHERE slug = 'excel-export';

UPDATE we_apps SET display_meta = coalesce(display_meta,'{}'::jsonb) || '{
  "usage": [
    "输入：上传单张图片",
    "支持格式：png、jpg、jpeg、webp、bmp",
    "输出：识别文本 + 可选坐标框",
    "分布式：可多图并行加速",
    "计费：每次 0.05 EDG（借调节点另计算力费）"
  ]
}'::jsonb, updated_at = now() WHERE slug = 'ocr-image';

UPDATE we_apps SET display_meta = coalesce(display_meta,'{}'::jsonb) || '{
  "usage": [
    "输入：上传 PDF 文件",
    "支持格式：pdf",
    "输出：按页 OCR 文本 / Markdown",
    "分布式：可按页切片并行",
    "计费：每次 0.10 EDG（借调节点另计算力费）"
  ]
}'::jsonb, updated_at = now() WHERE slug = 'pdf-ocr';

UPDATE we_apps SET display_meta = coalesce(display_meta,'{}'::jsonb) || '{
  "usage": [
    "输入：上传合同文件",
    "支持格式：pdf、txt、docx",
    "输出：风险条款结构化审查报告",
    "计费：每次 0.50 EDG（借调节点另计算力费）"
  ]
}'::jsonb, updated_at = now() WHERE slug = 'contract-review';

UPDATE we_apps SET display_meta = coalesce(display_meta,'{}'::jsonb) || '{
  "usage": [
    "输入：上传音频文件",
    "支持格式：wav、mp3、m4a、flac",
    "输出：带时间戳的转写文本",
    "计费：每次 0.20 EDG（借调节点另计算力费）"
  ]
}'::jsonb, updated_at = now() WHERE slug = 'whisper-transcribe';

UPDATE we_apps SET display_meta = coalesce(display_meta,'{}'::jsonb) || '{
  "usage": [
    "输入：多选案卷材料（PDF/图片/文档）批量上传",
    "支持格式：pdf、png、jpg、jpeg、docx、txt",
    "输出：阅卷摘要与结构化要点",
    "分布式：包编排多任务并行",
    "计费：免费（借调节点仅收算力费）"
  ]
}'::jsonb, updated_at = now() WHERE slug = 'qianshou-law';

COMMIT;
