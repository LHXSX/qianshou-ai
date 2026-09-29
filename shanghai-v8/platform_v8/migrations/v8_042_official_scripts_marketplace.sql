-- v8_042: 官方脚本全量上架商店（幂等 upsert by slug）
-- 共 56 个官方应用
-- 由 platform_v8/scripts/marketplace/seed_official_apps.py 生成 · 手改请同步生成器
BEGIN;

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '词频统计', 'word-count', '千手官方', 'text',
    '一键统计文本词频、行数与字数分布。词频统计。官方脚本，开箱即用。', 'free', 0,
    'word_count', 'single_file', ARRAY['txt','md','log','csv']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "一键统计文本词频、行数与字数分布", "features": ["中英文混排分词统计", "多文件批量并行统计", "TOP-N 高频词排序输出"], "scenarios": [{"name": "内容分析", "desc": "公众号/文案团队分析高频用词"}, {"name": "日志排查", "desc": "快速统计日志关键词出现次数"}], "capability_tags": ["文本", "统计", "批量"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、md、log、csv", "输出：JSON 词频表 + 汇总统计", "分布式：最多切 10 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'word-count'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'word-count');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '行数统计', 'line-count', '千手官方', 'text',
    '总行/空行/非空行一目了然。行数/字数统计(总行/空行/非空)。官方脚本，开箱即用。', 'free', 0,
    'line_count', 'single_file', ARRAY['txt','log','csv','md']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "总行/空行/非空行一目了然", "features": ["总行数/空行/非空行三维统计", "多文件汇总", "大文件分片并行"], "scenarios": [{"name": "代码盘点", "desc": "统计代码/配置文件规模"}, {"name": "数据验收", "desc": "核对导出数据行数是否完整"}], "capability_tags": ["文本", "统计"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、log、csv、md", "输出：JSON 统计报告", "分布式：最多切 10 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'line-count'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'line-count');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '文本去重', 'dedup-lines', '千手官方', 'text',
    '去除重复行，输出唯一行与重复统计。去除重复行 · 输出唯一行 + 重复统计。官方脚本，开箱即用。', 'free', 0,
    'dedup_lines', 'single_file', ARRAY['txt','csv','log']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "去除重复行，输出唯一行与重复统计", "features": ["保序去重", "输出重复次数明细", "适合清洗名单/URL 列表"], "scenarios": [{"name": "名单清洗", "desc": "手机号/邮箱名单去重"}, {"name": "URL 池维护", "desc": "爬虫 URL 池去重"}], "capability_tags": ["文本", "清洗"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、csv、log", "输出：去重后的文本 + 重复项统计", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'dedup-lines'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'dedup-lines');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '文本排序', 'text-sort', '千手官方', 'text',
    '字典序/数字序/倒序/去重一步到位。文本行排序 (字典/数字/反向/去重)。官方脚本，开箱即用。', 'free', 0,
    'text_sort', 'single_file', ARRAY['txt','csv','log']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "字典序/数字序/倒序/去重一步到位", "features": ["四种排序模式自由组合", "大文件稳定排序", "可同时去重"], "scenarios": [{"name": "榜单整理", "desc": "打分结果按数值排序"}, {"name": "词表整理", "desc": "词库按字典序规整"}], "capability_tags": ["文本", "排序"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、csv、log", "参数：params.mode 选 dict/numeric/reverse，可叠加 unique", "输出：排序后的文本", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'text-sort'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'text-sort');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '文本切分', 'text-split', '千手官方', 'text',
    '按行数或分隔符把大文件切成小份。文本切分 (按行/分隔符)。官方脚本，开箱即用。', 'free', 0,
    'text_split', 'single_file', ARRAY['txt','csv','log']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "按行数或分隔符把大文件切成小份", "features": ["按行数等分", "按自定义分隔符切分", "结果自动打包下载"], "scenarios": [{"name": "数据分发", "desc": "大名单切成小份分给多组处理"}, {"name": "导入限制", "desc": "绕过系统单次导入行数上限"}], "capability_tags": ["文本", "切分"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、csv、log", "参数：params.lines_per_chunk 或 params.delimiter", "输出：切分后的多个文件（ZIP 打包）", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'text-split'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'text-split');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '批量替换', 'text-replace', '千手官方', 'text',
    '字面或正则规则批量替换文本内容。文本批量替换 (字面/正则·EC_PARAMS 配)。官方脚本，开箱即用。', 'free', 0,
    'text_replace', 'single_file', ARRAY['txt','md','csv','log']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "字面或正则规则批量替换文本内容", "features": ["字面/正则双模式", "多文件批量执行", "替换命中数统计"], "scenarios": [{"name": "文案改版", "desc": "全站文案术语统一替换"}, {"name": "数据修正", "desc": "批量修正格式错误字段"}], "capability_tags": ["文本", "正则", "批量"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、md、csv、log", "参数：params.pattern + params.replacement，regex=true 启用正则", "输出：替换后的文本", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'text-replace'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'text-replace');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '文本比对', 'text-diff', '千手官方', 'text',
    '两份文本的差异一屏看清（unified diff）。文本差异比对 (unified diff)。官方脚本，开箱即用。', 'free', 0,
    'text_diff', 'multi_file', ARRAY['txt','md','json']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "两份文本的差异一屏看清（unified diff）", "features": ["标准 diff 格式输出", "支持大文件比对", "增删行统计"], "scenarios": [{"name": "合同改动核对", "desc": "两版合同差异快速定位"}, {"name": "配置审计", "desc": "上线前后配置文件比对"}], "capability_tags": ["文本", "比对"], "usage": ["输入：多选文件批量上传", "支持格式：txt、md、json", "输出：unified diff 差异报告", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'text-diff'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'text-diff');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '信息提取', 'text-extract', '千手官方', 'text',
    '从杂乱文本里提取邮箱/手机/URL/IP/身份证。提取邮箱/手机/URL/IP/身份证 (基础 PII)。官方脚本，开箱即用。', 'free', 0,
    'text_extract', 'single_file', ARRAY['txt','log','csv','html']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "从杂乱文本里提取邮箱/手机/URL/IP/身份证", "features": ["五类常见实体一次提取", "批量文件并行", "结果按类型分组去重"], "scenarios": [{"name": "线索整理", "desc": "从网页存档批量提取联系方式"}, {"name": "安全审计", "desc": "扫描文档中的敏感信息暴露"}], "capability_tags": ["文本", "PII", "提取"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、log、csv、html", "输出：JSON 分类提取结果", "分布式：最多切 10 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'text-extract'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'text-extract');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '文本脱敏', 'text-mask', '千手官方', 'text',
    '邮箱/手机/卡号自动打码，安全外发。文本脱敏 (邮箱/手机/卡号等打码)。官方脚本，开箱即用。', 'free', 0,
    'text_mask', 'single_file', ARRAY['txt','csv','log']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "邮箱/手机/卡号自动打码，安全外发", "features": ["常见敏感字段自动识别", "保留格式仅遮蔽关键位", "批量处理"], "scenarios": [{"name": "对外交付", "desc": "样例数据脱敏后发给客户"}, {"name": "合规留档", "desc": "日志留存前抹除个人信息"}], "capability_tags": ["文本", "脱敏", "合规"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、csv、log", "输出：脱敏后的文本", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'text-mask'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'text-mask');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '正则提取', 'regex-extract', '千手官方', 'text',
    '自定义正则批量抽取目标内容。正则批量提取 (EC_PARAMS.pattern)。官方脚本，开箱即用。', 'free', 0,
    'regex_extract', 'single_file', ARRAY['txt','log','html','csv']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "自定义正则批量抽取目标内容", "features": ["完整正则语法", "多文件批量", "命中上下文可选输出"], "scenarios": [{"name": "日志取数", "desc": "从访问日志提取订单号"}, {"name": "网页取数", "desc": "从 HTML 源码抽取指定字段"}], "capability_tags": ["文本", "正则"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、log、html、csv", "参数：params.pattern 填正则表达式", "输出：命中结果列表（JSON）", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'regex-extract'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'regex-extract');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'JSON 校验', 'json-validate', '千手官方', 'text',
    '批量校验 JSON 语法并给出错误定位。JSON 语法批量校验 + 统计。官方脚本，开箱即用。', 'free', 0,
    'json_validate', 'single_file', ARRAY['json','jsonl','txt']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "批量校验 JSON 语法并给出错误定位", "features": ["批量文件并行校验", "错误行列定位", "统计汇总"], "scenarios": [{"name": "接口联调", "desc": "校验对方回传的数据包"}, {"name": "数据入库前检查", "desc": "JSONL 数据集质检"}], "capability_tags": ["JSON", "校验"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件 / 多选文件批量上传", "支持格式：json、jsonl、txt", "输出：校验报告（合法/非法/错误位置）", "分布式：最多切 10 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'json-validate'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'json-validate');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'JSON 过滤', 'json-filter', '千手官方', 'text',
    'jq 风格表达式筛选 JSON 行数据。JSON 行过滤 (jq-like)。官方脚本，开箱即用。', 'free', 0,
    'json_filter', 'single_file', ARRAY['json','jsonl']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "jq 风格表达式筛选 JSON 行数据", "features": ["jq-like 表达式", "大数据集分片并行", "输出命中率统计"], "scenarios": [{"name": "数据抽样", "desc": "从全量数据筛出目标子集"}, {"name": "质检", "desc": "筛出缺字段的脏数据"}], "capability_tags": ["JSON", "过滤", "批量"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：json、jsonl", "参数：params.expr 填过滤表达式，如 .price > 100", "输出：过滤后的 JSONL", "分布式：最多切 10 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'json-filter'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'json-filter');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'CSV 转 JSON', 'csv-to-json', '千手官方', 'text',
    'CSV/TSV 秒变 JSONL 或 JSON 数组。CSV/TSV 转 JSONL 或 JSON 数组 · 批量结果打包。官方脚本，开箱即用。', 'free', 0,
    'csv_to_json', 'single_file', ARRAY['csv','tsv','txt']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "CSV/TSV 秒变 JSONL 或 JSON 数组", "features": ["表头自动识别为字段名", "批量转换结果打包", "编码自动探测"], "scenarios": [{"name": "数据迁移", "desc": "老系统 CSV 导出转 JSON 进新系统"}, {"name": "开发提效", "desc": "测试数据快速转格式"}], "capability_tags": ["CSV", "JSON", "转换"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：csv、tsv、txt", "输出：JSONL / JSON 数组文件", "分布式：最多切 20 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'csv-to-json'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'csv-to-json');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'URL 解析', 'url-parse', '千手官方', 'text',
    '批量拆解 URL 的协议/域名/路径/参数。URL 批量解析 (scheme/host/path/query)。官方脚本，开箱即用。', 'free', 0,
    'url_parse', 'single_file', ARRAY['txt','csv']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "批量拆解 URL 的协议/域名/路径/参数", "features": ["批量解析", "query 参数展开为键值对", "非法 URL 标记"], "scenarios": [{"name": "投放分析", "desc": "广告落地页 UTM 参数批量拆解"}, {"name": "SEO 审计", "desc": "站内链接结构盘点"}], "capability_tags": ["URL", "解析"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、csv", "输出：JSON 结构化解析结果", "分布式：最多切 10 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'url-parse'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'url-parse');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'Base64 编码', 'base64-encode', '千手官方', 'encoding',
    '文本/文件批量转 Base64。Base64 编码。官方脚本，开箱即用。', 'free', 0,
    'base64_encode', 'inline', ARRAY['txt','bin','png','jpg']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "文本/文件批量转 Base64", "features": ["文本与二进制均可", "批量处理", "与解码工具成对使用"], "scenarios": [{"name": "接口调试", "desc": "生成接口需要的 Base64 载荷"}, {"name": "嵌入资源", "desc": "小图标转 Base64 嵌入页面"}], "capability_tags": ["编码", "Base64"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、bin、png、jpg", "输出：Base64 编码结果", "分布式：最多切 10 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'base64-encode'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'base64-encode');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'Base64 解码', 'base64-decode', '千手官方', 'encoding',
    'Base64 还原为原始内容。Base64 解码 (对称 base64_encode)。官方脚本，开箱即用。', 'free', 0,
    'base64_decode', 'inline', ARRAY['txt']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "Base64 还原为原始内容", "features": ["批量解码", "非法输入定位", "与编码工具成对使用"], "scenarios": [{"name": "报文还原", "desc": "抓包数据快速还原"}, {"name": "附件恢复", "desc": "邮件附件 Base64 还原成文件"}], "capability_tags": ["编码", "Base64"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt", "输出：解码后的原始内容", "分布式：最多切 10 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'base64-decode'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'base64-decode');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '批量哈希', 'hash-batch', '千手官方', 'encoding',
    'SHA256/MD5/SHA1 批量摘要计算。批量哈希 (SHA256 / MD5 / SHA1 · params.algorithm)。官方脚本，开箱即用。', 'free', 0,
    'hash_batch', 'single_file', ARRAY['txt','bin','zip']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "SHA256/MD5/SHA1 批量摘要计算", "features": ["三种算法可选", "多文件并行", "输出对照表便于校验"], "scenarios": [{"name": "完整性校验", "desc": "分发包哈希清单生成"}, {"name": "重复检测", "desc": "以哈希判断文件是否重复"}], "capability_tags": ["哈希", "校验", "批量"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、bin、zip", "参数：params.algorithm 选 sha256/md5/sha1", "输出：每个输入的哈希值清单", "分布式：最多切 10 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'hash-batch'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'hash-batch');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'MD5 校验码', 'md5-batch', '千手官方', 'encoding',
    '批量生成 MD5 摘要。批量 MD5 校验码。官方脚本，开箱即用。', 'free', 0,
    'md5_batch', 'single_file', ARRAY['txt','bin','zip']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "批量生成 MD5 摘要", "features": ["批量并行", "大文件流式计算", "清单格式兼容 md5sum"], "scenarios": [{"name": "发布校验", "desc": "软件包发布附带 MD5"}, {"name": "数据比对", "desc": "两批文件是否一致"}], "capability_tags": ["哈希", "MD5"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、bin、zip", "输出：MD5 清单", "分布式：最多切 10 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'md5-batch'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'md5-batch');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'CRC32 校验', 'crc32-batch', '千手官方', 'encoding',
    '轻量快速的批量校验码。批量 CRC32 快速校验码。官方脚本，开箱即用。', 'free', 0,
    'crc32_batch', 'single_file', ARRAY['txt','bin','zip']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "轻量快速的批量校验码", "features": ["速度极快", "批量并行", "适合海量小文件"], "scenarios": [{"name": "传输校验", "desc": "内网大批量文件传输核验"}, {"name": "嵌入式场景", "desc": "固件资源校验码生成"}], "capability_tags": ["哈希", "CRC32"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、bin、zip", "输出：CRC32 清单", "分布式：最多切 10 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'crc32-batch'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'crc32-batch');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '哈希碰撞搜索', 'hash-collision-search', '千手官方', 'encoding',
    'CPU 算力凭证：搜索指定前缀的哈希碰撞。哈希前缀碰撞搜索 (CPU PoW · 仅单份文本)。官方脚本，开箱即用。', 'free', 0,
    'hash_collision_search', 'inline', ARRAY['txt']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "CPU 算力凭证：搜索指定前缀的哈希碰撞", "features": ["标准 PoW 工作量证明", "可验证的算力测试", "适合节点性能压测"], "scenarios": [{"name": "节点跑分", "desc": "衡量节点真实 CPU 算力"}, {"name": "教学演示", "desc": "直观理解工作量证明"}], "capability_tags": ["计算", "PoW"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt", "参数：params.prefix 指定目标前缀（越长越难）", "输出：满足前缀条件的 nonce 与哈希", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'hash-collision-search'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'hash-collision-search');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'PDF 转文本', 'pdf-to-text', '千手官方', 'doc',
    '文本页直提、扫描页自动 OCR 的智能转换。PDF 智能转文本 (按页: 文本→MarkItDown/PyMuPDF · 扫描→PP-OCRv6)。官方脚本，开箱即用。', 'per_use', 0.05,
    'pdf_to_text', 'single_file', ARRAY['pdf']::text[],
    1024, false, 'none', 'workload',
    'published', true, '{"tagline": "文本页直提、扫描页自动 OCR 的智能转换", "features": ["按页并行提速", "文本页与扫描页自动分流", "保留段落结构"], "scenarios": [{"name": "资料数字化", "desc": "扫描版 PDF 批量转可检索文本"}, {"name": "知识库构建", "desc": "PDF 文档入库前预处理"}], "capability_tags": ["PDF", "OCR", "文档"], "usage": ["输入：上传单个文件 / 多选文件批量上传", "支持格式：pdf", "输出：纯文本 / Markdown", "分布式：最多切 20 片并行，多节点同时加速", "计费：每次 0.05 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'pdf-to-text'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'pdf-to-text');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'PDF 元信息', 'pdf-info', '千手官方', 'doc',
    '页数/尺寸/加密状态/元数据一键读取。PDF 元信息。官方脚本，开箱即用。', 'free', 0,
    'pdf_info', 'single_file', ARRAY['pdf']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "页数/尺寸/加密状态/元数据一键读取", "features": ["不解析正文速度快", "批量盘点", "加密与权限标记"], "scenarios": [{"name": "文档盘点", "desc": "网盘 PDF 资产清点"}, {"name": "预检", "desc": "OCR 前先探页数估算成本"}], "capability_tags": ["PDF", "元数据"], "usage": ["输入：上传单个文件", "支持格式：pdf", "输出：JSON 元信息报告", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'pdf-info'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'pdf-info');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'Word(.doc) 转文本', 'doc-to-text', '千手官方', 'doc',
    '老格式 .doc 提取纯文本。Word(.doc) 提取纯文本 (antiword/catdoc/soffice)。官方脚本，开箱即用。', 'free', 0,
    'doc_to_text', 'single_file', ARRAY['doc']::text[],
    512, false, 'none', 'workload',
    'published', true, '{"tagline": "老格式 .doc 提取纯文本", "features": ["兼容陈年 .doc 格式", "批量转换", "自动编码处理"], "scenarios": [{"name": "档案迁移", "desc": "历史 Word 档案批量提取"}, {"name": "检索建库", "desc": "老文档全文检索预处理"}], "capability_tags": ["Word", "文档"], "usage": ["输入：上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：doc", "输出：纯文本", "分布式：最多切 20 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'doc-to-text'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'doc-to-text');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'Word(.docx) 转文本', 'docx-to-text', '千手官方', 'doc',
    '.docx 提取纯文本，批量并行。Word(.docx) 提取纯文本。官方脚本，开箱即用。', 'free', 0,
    'docx_to_text', 'single_file', ARRAY['docx']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": ".docx 提取纯文本，批量并行", "features": ["保留段落顺序", "批量并行", "表格文本一并提取"], "scenarios": [{"name": "内容审核", "desc": "批量文档进审核流水线"}, {"name": "语料准备", "desc": "训练语料清洗第一步"}], "capability_tags": ["Word", "文档"], "usage": ["输入：上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：docx", "输出：纯文本", "分布式：最多切 20 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'docx-to-text'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'docx-to-text');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '智能阅卷', 'case-digest', '千手官方', 'doc',
    '案卷自动提炼：时间线、证据链与争议焦点。智能阅卷/案卷提炼(自定义标签+时间线+证据+争议)· 律所垂直。官方脚本，开箱即用。', 'per_use', 0.5,
    'case_digest', 'single_file', ARRAY['pdf','docx','txt']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "案卷自动提炼：时间线、证据链与争议焦点", "features": ["自定义提炼标签", "时间线自动梳理", "证据与争议焦点标注"], "scenarios": [{"name": "律所办案", "desc": "开庭前快速吃透案卷"}, {"name": "法务尽调", "desc": "合同纠纷材料预梳理"}], "capability_tags": ["法律", "AI", "阅卷"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件 / 多选文件批量上传", "支持格式：pdf、docx、txt", "输出：结构化阅卷报告", "计费：每次 0.50 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'case-digest'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'case-digest');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '图片压缩', 'image-compress', '千手官方', 'image',
    '批量压缩图片体积，画质损失可控。批量图片压缩。官方脚本，开箱即用。', 'free', 0,
    'image_compress', 'multi_file', ARRAY['png','jpg','jpeg','webp']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "批量压缩图片体积，画质损失可控", "features": ["质量参数可调", "多文件/整包并行", "压缩率报告"], "scenarios": [{"name": "网站提速", "desc": "首页图片瘦身"}, {"name": "存储降本", "desc": "相册归档前批量压缩"}], "capability_tags": ["图片", "压缩", "批量"], "usage": ["输入：上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：png、jpg、jpeg、webp", "参数：params.quality 1-100（默认 80）", "输出：压缩后的图片（ZIP）", "分布式：最多切 20 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'image-compress'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'image-compress');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '格式转换', 'image-convert', '千手官方', 'image',
    'PNG/JPG/WebP/BMP 批量互转。批量图片格式转换。官方脚本，开箱即用。', 'free', 0,
    'image_convert', 'multi_file', ARRAY['png','jpg','jpeg','webp','bmp']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "PNG/JPG/WebP/BMP 批量互转", "features": ["常见格式全覆盖", "批量并行", "透明通道妥善处理"], "scenarios": [{"name": "平台适配", "desc": "统一转 WebP 降流量"}, {"name": "交付规范", "desc": "按客户要求统一格式"}], "capability_tags": ["图片", "转换"], "usage": ["输入：上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：png、jpg、jpeg、webp、bmp", "参数：params.target 选 png/jpg/webp/bmp", "输出：目标格式图片（ZIP）", "分布式：最多切 20 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'image-convert'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'image-convert');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '图片缩放', 'image-resize', '千手官方', 'image',
    '按宽高或比例批量缩放。批量图片缩放。官方脚本，开箱即用。', 'free', 0,
    'image_resize', 'multi_file', ARRAY['png','jpg','jpeg','webp']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "按宽高或比例批量缩放", "features": ["等比或定尺寸", "批量并行", "小图不放大可选"], "scenarios": [{"name": "电商主图", "desc": "统一输出 800×800"}, {"name": "头像规范", "desc": "批量出多尺寸头像"}], "capability_tags": ["图片", "缩放"], "usage": ["输入：上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：png、jpg、jpeg、webp", "参数：params.width / params.height / params.scale 三选一", "输出：缩放后的图片（ZIP）", "分布式：最多切 20 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'image-resize'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'image-resize');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '缩略图生成', 'image-thumbnail', '千手官方', 'image',
    '批量生成规格统一的缩略图。批量生成缩略图。官方脚本，开箱即用。', 'free', 0,
    'image_thumbnail', 'multi_file', ARRAY['png','jpg','jpeg','webp']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "批量生成规格统一的缩略图", "features": ["等比裁剪居中", "批量并行", "文件名保持对应"], "scenarios": [{"name": "相册索引", "desc": "为图库生成预览图"}, {"name": "列表页提速", "desc": "商品列表缩略图"}], "capability_tags": ["图片", "缩略图"], "usage": ["输入：上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：png、jpg、jpeg、webp", "参数：params.size 默认 256", "输出：缩略图（ZIP）", "分布式：最多切 20 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'image-thumbnail'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'image-thumbnail');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '图片元信息', 'image-info', '千手官方', 'image',
    '尺寸/格式/EXIF 批量读取。图片元信息提取。官方脚本，开箱即用。', 'free', 0,
    'image_info', 'multi_file', ARRAY['png','jpg','jpeg','webp','bmp']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "尺寸/格式/EXIF 批量读取", "features": ["EXIF 拍摄信息提取", "批量盘点", "异常文件标记"], "scenarios": [{"name": "素材盘点", "desc": "设计素材库属性清点"}, {"name": "合规检查", "desc": "外发前查 EXIF 泄露"}], "capability_tags": ["图片", "元数据"], "usage": ["输入：上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：png、jpg、jpeg、webp、bmp", "输出：JSON 元信息清单", "分布式：最多切 20 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'image-info'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'image-info');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '视频压缩', 'video-compress', '千手官方', 'video',
    '多文件体积均衡、超大文件按时段并行压缩。视频压缩 (多文件体积均衡 / 超大按时段并行)。官方脚本，开箱即用。', 'per_use', 0.3,
    'video_compress', 'single_file', ARRAY['mp4','mov','mkv','avi']::text[],
    2048, false, 'none', 'workload',
    'published', true, '{"tagline": "多文件体积均衡、超大文件按时段并行压缩", "features": ["超大文件切段并行提速", "码率/CRF 可调", "批量任务打包交付"], "scenarios": [{"name": "网课发布", "desc": "课程视频压到平台限制内"}, {"name": "归档降本", "desc": "监控/素材冷存前压缩"}], "capability_tags": ["视频", "压缩", "并行"], "usage": ["输入：上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：mp4、mov、mkv、avi", "参数：params.crf 18-32（默认 26，越大越小）", "输出：压缩后的视频", "分布式：最多切 10 片并行，多节点同时加速", "计费：每次 0.30 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'video-compress'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'video-compress');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '视频元信息', 'video-info', '千手官方', 'video',
    '时长/分辨率/码率/编码批量探测。视频元信息 (支持批量 / ZIP)。官方脚本，开箱即用。', 'free', 0,
    'video_info', 'multi_file', ARRAY['mp4','mov','mkv','avi','zip']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "时长/分辨率/码率/编码批量探测", "features": ["批量/ZIP 整包盘点", "编码与码率明细", "损坏文件标记"], "scenarios": [{"name": "媒资盘点", "desc": "素材库属性清单"}, {"name": "转码预检", "desc": "压缩前先探源片参数"}], "capability_tags": ["视频", "元数据"], "usage": ["输入：上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：mp4、mov、mkv、avi、zip", "输出：JSON 元信息清单", "分布式：最多切 20 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'video-info'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'video-info');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '视频抽帧', 'video-thumbnail', '千手官方', 'video',
    '批量抽取关键帧生成封面/缩略图。视频抽帧缩略图 (支持批量 / ZIP)。官方脚本，开箱即用。', 'free', 0,
    'video_thumbnail', 'multi_file', ARRAY['mp4','mov','mkv','zip']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "批量抽取关键帧生成封面/缩略图", "features": ["均匀抽帧", "批量/ZIP 支持", "时间戳命名"], "scenarios": [{"name": "封面候选", "desc": "短视频封面批量出图"}, {"name": "内容审核", "desc": "抽帧走图片审核流水线"}], "capability_tags": ["视频", "抽帧"], "usage": ["输入：上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：mp4、mov、mkv、zip", "参数：params.count 每个视频抽几帧（默认 3）", "输出：帧图片（ZIP）", "分布式：最多切 20 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'video-thumbnail'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'video-thumbnail');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '音频提取', 'audio-extract', '千手官方', 'video',
    '从视频中批量抽出音轨。从视频提取音频。官方脚本，开箱即用。', 'free', 0,
    'audio_extract', 'single_file', ARRAY['mp4','mov','mkv','avi']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "从视频中批量抽出音轨", "features": ["批量并行", "格式可选", "码率保真"], "scenarios": [{"name": "播客制作", "desc": "视频访谈转音频节目"}, {"name": "转写前置", "desc": "先抽音频再送转写"}], "capability_tags": ["音频", "提取"], "usage": ["输入：上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：mp4、mov、mkv、avi", "参数：params.format 选 mp3/wav/m4a", "输出：音频文件（mp3/wav）", "分布式：最多切 20 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'audio-extract'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'audio-extract');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '音频转码', 'audio-transcode', '千手官方', 'video',
    'wav/mp3/m4a/flac 批量互转。音频转码。官方脚本，开箱即用。', 'free', 0,
    'audio_transcode', 'single_file', ARRAY['wav','mp3','m4a','flac','ogg']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "wav/mp3/m4a/flac 批量互转", "features": ["常见格式全覆盖", "码率可调", "批量并行"], "scenarios": [{"name": "设备适配", "desc": "车载/老设备只认 mp3"}, {"name": "归档统一", "desc": "录音资产统一格式"}], "capability_tags": ["音频", "转码"], "usage": ["输入：上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：wav、mp3、m4a、flac、ogg", "参数：params.target + params.bitrate", "输出：目标格式音频", "分布式：最多切 20 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'audio-transcode'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'audio-transcode');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'LLM 批量对话', 'llm-chat', '千手官方', 'ai',
    '一批 prompt 并行问大模型，结果打包返回。LLM 对话 (单 prompt 或批量)。官方脚本，开箱即用。', 'per_use', 0.1,
    'llm_chat', 'inline', ARRAY['txt','jsonl']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "一批 prompt 并行问大模型，结果打包返回", "features": ["批量 prompt 并行", "系统提示词可配", "结果与输入一一对应"], "scenarios": [{"name": "内容生产", "desc": "批量生成标题/文案候选"}, {"name": "评测", "desc": "同题多模型横评取数"}], "capability_tags": ["LLM", "批量", "AI"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、jsonl", "参数：params.model / params.system 可选", "输出：逐条回答（JSONL）", "分布式：最多切 10 片并行，多节点同时加速", "计费：每次 0.10 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'llm-chat'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'llm-chat');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '智能摘要', 'llm-summarize', '千手官方', 'ai',
    '长文一键提炼要点摘要。LLM 摘要。官方脚本，开箱即用。', 'per_use', 0.1,
    'llm_summarize', 'inline', ARRAY['txt','md']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "长文一键提炼要点摘要", "features": ["长文分段归纳", "要点保真", "风格可指定"], "scenarios": [{"name": "会议纪要", "desc": "长记录浓缩成决议清单"}, {"name": "资讯速读", "desc": "行业报告快速掌握"}], "capability_tags": ["LLM", "摘要", "AI"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、md", "参数：params.max_len 控制摘要长度", "输出：摘要文本", "计费：每次 0.10 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'llm-summarize'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'llm-summarize');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '批量翻译', 'llm-translate', '千手官方', 'ai',
    '大模型驱动的多语种批量翻译。批量文本翻译。官方脚本，开箱即用。', 'per_use', 0.1,
    'llm_translate', 'params_only', ARRAY['txt','jsonl','csv']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "大模型驱动的多语种批量翻译", "features": ["术语一致性好", "批量并行", "保留格式标记"], "scenarios": [{"name": "出海本地化", "desc": "商品描述批量翻译"}, {"name": "文档国际化", "desc": "手册多语言版本"}], "capability_tags": ["LLM", "翻译", "批量"], "usage": ["输入：无需上传文件，仅配置参数 / 直接粘贴文本（≤1MB）", "支持格式：txt、jsonl、csv", "参数：params.target_lang 目标语言", "输出：译文（与原文对照）", "分布式：最多切 10 片并行，多节点同时加速", "计费：每次 0.10 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'llm-translate'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'llm-translate');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '文本分类', 'llm-classify', '千手官方', 'ai',
    '自定义标签体系的批量文本分类。批量文本分类。官方脚本，开箱即用。', 'per_use', 0.1,
    'llm_classify', 'params_only', ARRAY['txt','jsonl','csv']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "自定义标签体系的批量文本分类", "features": ["零样本分类无需训练", "批量并行", "置信度输出"], "scenarios": [{"name": "工单分流", "desc": "客服工单自动归类"}, {"name": "舆情打标", "desc": "评论情感与主题分类"}], "capability_tags": ["LLM", "分类", "AI"], "usage": ["输入：无需上传文件，仅配置参数 / 直接粘贴文本（≤1MB）", "支持格式：txt、jsonl、csv", "参数：params.labels 填标签列表", "输出：逐条分类结果（JSONL）", "分布式：最多切 10 片并行，多节点同时加速", "计费：每次 0.10 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'llm-classify'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'llm-classify');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '结构化抽取', 'llm-extract', '千手官方', 'ai',
    '从自由文本抽取指定字段成结构化数据。批量结构化信息抽取。官方脚本，开箱即用。', 'per_use', 0.1,
    'llm_extract', 'params_only', ARRAY['txt','jsonl']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "从自由文本抽取指定字段成结构化数据", "features": ["自定义抽取 schema", "批量并行", "缺失字段显式标记"], "scenarios": [{"name": "简历解析", "desc": "批量简历转结构化人才库"}, {"name": "票据录入", "desc": "报销单要素自动抽取"}], "capability_tags": ["LLM", "抽取", "结构化"], "usage": ["输入：无需上传文件，仅配置参数 / 直接粘贴文本（≤1MB）", "支持格式：txt、jsonl", "参数：params.schema 定义要抽取的字段", "输出：结构化 JSON（按 schema）", "分布式：最多切 10 片并行，多节点同时加速", "计费：每次 0.10 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'llm-extract'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'llm-extract');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '文本向量化', 'embedding', '千手官方', 'ai',
    '批量生成文本 embedding 向量。向量化 (embedding)。官方脚本，开箱即用。', 'per_use', 0.05,
    'embedding', 'single_file', ARRAY['txt','jsonl']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "批量生成文本 embedding 向量", "features": ["批量并行", "向量维度标准", "直接可入向量库"], "scenarios": [{"name": "语义检索", "desc": "知识库向量化建索引"}, {"name": "聚类分析", "desc": "海量文本相似度聚类"}], "capability_tags": ["Embedding", "向量", "AI"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：txt、jsonl", "输出：向量数据（JSONL）", "分布式：最多切 10 片并行，多节点同时加速", "计费：每次 0.05 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'embedding'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'embedding');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '本地大模型对话', 'local-llm-chat', '千手官方', 'ai',
    '派发到装有本地 LLM 的节点，数据不出网。本地大模型对话 (llama.cpp · 派到装有指定模型的节点)。官方脚本，开箱即用。', 'per_use', 0.2,
    'local_llm_chat', 'inline', ARRAY['txt']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "派发到装有本地 LLM 的节点，数据不出网", "features": ["llama.cpp 本地推理", "数据不经第三方", "按模型能力智能派单"], "scenarios": [{"name": "隐私问答", "desc": "敏感内容不出内网"}, {"name": "离线推理", "desc": "无外网环境的 AI 能力"}], "capability_tags": ["本地LLM", "隐私", "AI"], "usage": ["输入：直接粘贴文本（≤1MB） / 无需上传文件，仅配置参数", "支持格式：txt", "参数：params.model 指定节点已装模型", "输出：模型回答", "计费：每次 0.20 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'local-llm-chat'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'local-llm-chat');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '图片智能分析', 'image-caption', '千手官方', 'ai',
    '本机 LLM 视觉识图：描述、OCR、场景理解。图片智能分析 (本机 LLM 视觉识图/OCR/场景梳理 · 对齐 RAG/png)。官方脚本，开箱即用。', 'per_use', 0.15,
    'image_caption', 'single_file', ARRAY['png','jpg','jpeg','webp']::text[],
    4096, false, 'none', 'workload',
    'published', true, '{"tagline": "本机 LLM 视觉识图：描述、OCR、场景理解", "features": ["识图描述+文字提取一体", "批量并行", "本地视觉模型隐私可控"], "scenarios": [{"name": "图库打标", "desc": "海量图片自动生成描述标签"}, {"name": "证据整理", "desc": "截图批量提取关键信息"}], "capability_tags": ["视觉", "AI", "批量"], "usage": ["输入：上传单个文件 / 多选文件批量上传 / 上传 ZIP/TAR 压缩包整包处理", "支持格式：png、jpg、jpeg、webp", "输出：逐图分析报告（JSON）", "分布式：最多切 8 片并行，多节点同时加速", "计费：每次 0.15 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'image-caption'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'image-caption');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '转写精修', 'audio-transcribe-refine', '千手官方', 'ai',
    'Whisper 转写 + 本地 LLM 校对与事件梳理。语音转写 + 本地 LLM 校对/事件梳理 (Whisper + llama.cpp)。官方脚本，开箱即用。', 'per_use', 0.4,
    'audio_transcribe_refine', 'single_file', ARRAY['wav','mp3','m4a','mp4']::text[],
    4096, false, 'none', 'workload',
    'published', true, '{"tagline": "Whisper 转写 + 本地 LLM 校对与事件梳理", "features": ["转写后自动纠错润色", "关键事件自动梳理", "长音频分段处理"], "scenarios": [{"name": "庭审记录", "desc": "录音转规范文稿"}, {"name": "访谈整理", "desc": "口语转可发布稿件"}], "capability_tags": ["语音", "LLM", "转写"], "usage": ["输入：上传单个文件", "支持格式：wav、mp3、m4a、mp4", "输出：校对稿 + 事件时间线", "计费：每次 0.40 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'audio-transcribe-refine'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'audio-transcribe-refine');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '视频智能解析', 'video-analyze', '千手官方', 'ai',
    '抽音转写 + 抽帧识图，还原事情经过。视频智能解析 (抽音转写 + 抽帧识图 + 事情经过 · 对齐 RAG/mp4)。官方脚本，开箱即用。', 'per_use', 0.5,
    'video_analyze', 'single_file', ARRAY['mp4','mov','mkv']::text[],
    4096, false, 'none', 'workload',
    'published', true, '{"tagline": "抽音转写 + 抽帧识图，还原事情经过", "features": ["音画双通道理解", "时间线还原", "关键帧证据截图"], "scenarios": [{"name": "取证分析", "desc": "监控/行车记录仪视频还原经过"}, {"name": "内容审核", "desc": "视频内容合规快检"}], "capability_tags": ["视频", "AI", "解析"], "usage": ["输入：上传单个文件", "支持格式：mp4、mov、mkv", "输出：结构化解析报告", "计费：每次 0.50 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'video-analyze'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'video-analyze');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'π 估算', 'pi-compute', '千手官方', 'compute',
    'Monte Carlo 法分布式估算圆周率。π 估算 (Monte Carlo)。官方脚本，开箱即用。', 'free', 0,
    'pi_compute', 'params_only', '{}'::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "Monte Carlo 法分布式估算圆周率", "features": ["多节点采样并行", "结果自动聚合", "算力网络入门示例"], "scenarios": [{"name": "算力体验", "desc": "第一个分布式任务"}, {"name": "教学演示", "desc": "直观理解蒙特卡洛"}], "capability_tags": ["计算", "分布式"], "usage": ["输入：无需上传文件，仅配置参数", "参数：params.samples 采样数（默认 1e8）", "输出：π 估算值与收敛精度", "分布式：最多切 10 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'pi-compute'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'pi-compute');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'Monte Carlo 模拟', 'monte-carlo', '千手官方', 'compute',
    '通用蒙特卡洛：自定义函数的大规模随机模拟。Monte Carlo 通用计算。官方脚本，开箱即用。', 'per_use', 0.1,
    'monte_carlo', 'params_only', ARRAY['py','json']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "通用蒙特卡洛：自定义函数的大规模随机模拟", "features": ["按 sample 均分到多节点", "sum/mean/var 自动聚合", "金融/物理/工程通用"], "scenarios": [{"name": "风险定价", "desc": "期权定价蒙特卡洛"}, {"name": "工程仿真", "desc": "可靠性随机模拟"}], "capability_tags": ["计算", "模拟", "分布式"], "usage": ["输入：无需上传文件，仅配置参数 / 直接粘贴文本（≤1MB）", "支持格式：py、json", "参数：params.samples + 自定义被积函数", "输出：均值/方差等统计量", "分布式：最多切 10 片并行，多节点同时加速", "计费：每次 0.10 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'monte-carlo'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'monte-carlo');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'FFT 频谱分析', 'fft-compute', '千手官方', 'compute',
    '快速傅里叶变换，信号频谱一键出。快速傅里叶变换。官方脚本，开箱即用。', 'free', 0,
    'fft_compute', 'single_file', ARRAY['csv','txt','wav']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "快速傅里叶变换，信号频谱一键出", "features": ["numpy 高性能实现", "采样率可配", "峰值频率自动标注"], "scenarios": [{"name": "振动分析", "desc": "设备振动信号找故障频率"}, {"name": "音频分析", "desc": "音频频谱特征提取"}], "capability_tags": ["计算", "信号", "FFT"], "usage": ["输入：直接粘贴文本（≤1MB） / 上传单个文件", "支持格式：csv、txt、wav", "输出：频谱数据（JSON/CSV）", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'fft-compute'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'fft-compute');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'ONNX 推理', 'onnx-infer', '千手官方', 'compute',
    '上传 ONNX 模型与数据，分布式批量推理。ONNX 模型推理。官方脚本，开箱即用。', 'per_use', 0.1,
    'onnx_infer', 'multi_file', ARRAY['onnx','npy','json','zip']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "上传 ONNX 模型与数据，分布式批量推理", "features": ["任意 ONNX 模型", "批量数据分片并行", "CPU/GPU 节点自动匹配"], "scenarios": [{"name": "模型批跑", "desc": "训练好的模型对全量数据打分"}, {"name": "边缘推理", "desc": "把推理压力分散到节点"}], "capability_tags": ["ONNX", "推理", "分布式"], "usage": ["输入：多选文件批量上传", "支持格式：onnx、npy、json、zip", "参数：params.model_url 指向模型文件", "输出：推理结果（JSONL）", "分布式：最多切 10 片并行，多节点同时加速", "计费：每次 0.10 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'onnx-infer'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'onnx-infer');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '网页抓取', 'crawl-url-fetch', '千手官方', 'crawl',
    '单 URL 抓取，返回 HTML/正文/元数据。单 URL 抓取 · 返回 HTML/文本/元数据。官方脚本，开箱即用。', 'per_use', 0.02,
    'crawl_url_fetch', 'params_only', ARRAY['txt']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "单 URL 抓取，返回 HTML/正文/元数据", "features": ["白名单合规抓取", "正文自动提取", "编码自动处理"], "scenarios": [{"name": "内容归档", "desc": "重要页面留档"}, {"name": "竞品监测", "desc": "单页内容变化跟踪"}], "capability_tags": ["爬虫", "抓取"], "usage": ["输入：无需上传文件，仅配置参数", "支持格式：txt", "参数：params.url 目标地址", "输出：HTML + 提取正文 + 元数据", "计费：每次 0.02 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'crawl-url-fetch'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'crawl-url-fetch');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '批量抓取', 'crawl-batch-fetch', '千手官方', 'crawl',
    'URL 列表分发多节点并行抓取。多 URL 批量抓取 · 按 URL 数均分到多节点并行。官方脚本，开箱即用。', 'per_use', 0.05,
    'crawl_batch_fetch', 'params_only', ARRAY['txt','csv']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "URL 列表分发多节点并行抓取", "features": ["按 URL 均分多节点", "失败自动重试", "结果与 URL 对应"], "scenarios": [{"name": "行业数据", "desc": "批量收集公开页面数据"}, {"name": "死链巡检", "desc": "全站外链批量核查"}], "capability_tags": ["爬虫", "批量", "分布式"], "usage": ["输入：无需上传文件，仅配置参数", "支持格式：txt、csv", "输出：逐 URL 抓取结果（打包）", "分布式：最多切 10 片并行，多节点同时加速", "计费：每次 0.05 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'crawl-batch-fetch'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'crawl-batch-fetch');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '网页结构化抽取', 'crawl-url-extract', '千手官方', 'crawl',
    'CSS 选择器/正文算法抽取网页指定字段。单 URL 抓取 + 结构化抽取 (CSS selector / readability)。官方脚本，开箱即用。', 'per_use', 0.03,
    'crawl_url_extract', 'params_only', ARRAY['txt']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "CSS 选择器/正文算法抽取网页指定字段", "features": ["CSS selector 精准取数", "readability 正文兜底", "字段级输出"], "scenarios": [{"name": "商品取数", "desc": "标题/价格/库存定点抽取"}, {"name": "资讯聚合", "desc": "正文与发布时间入库"}], "capability_tags": ["爬虫", "抽取", "结构化"], "usage": ["输入：无需上传文件，仅配置参数", "支持格式：txt", "参数：params.selectors 定义字段与选择器", "输出：结构化 JSON", "计费：每次 0.03 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'crawl-url-extract'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'crawl-url-extract');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'URL 可用性检查', 'url-check', '千手官方', 'crawl',
    '批量检查链接状态码与响应时间。批量 URL 可用性检查。官方脚本，开箱即用。', 'free', 0,
    'url_check', 'params_only', ARRAY['txt','csv']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "批量检查链接状态码与响应时间", "features": ["批量并行探测", "重定向链跟踪", "超时与错误分类"], "scenarios": [{"name": "死链清理", "desc": "站点/文档死链盘点"}, {"name": "监控巡检", "desc": "关键链接定期体检"}], "capability_tags": ["URL", "巡检", "批量"], "usage": ["输入：无需上传文件，仅配置参数 / 直接粘贴文本（≤1MB）", "支持格式：txt、csv", "输出：状态报告（JSON/CSV）", "分布式：最多切 10 片并行，多节点同时加速", "计费：免费（借调节点仅收算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'url-check'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'url-check');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '价格监控', 'price-monitor', '千手官方', 'crawl',
    '批量商品页价格定点监控。批量商品价格监控。官方脚本，开箱即用。', 'per_use', 0.05,
    'price_monitor', 'params_only', ARRAY['txt','csv']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "批量商品页价格定点监控", "features": ["多商品并行", "价格变动对比", "历史快照可回溯"], "scenarios": [{"name": "比价选品", "desc": "同款多平台价格盘点"}, {"name": "调价预警", "desc": "竞品价格变动跟踪"}], "capability_tags": ["监控", "电商", "批量"], "usage": ["输入：无需上传文件，仅配置参数", "支持格式：txt、csv", "输出：价格快照（JSON/CSV）", "分布式：最多切 10 片并行，多节点同时加速", "计费：每次 0.05 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'price-monitor'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'price-monitor');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    '库存监控', 'stock-monitor', '千手官方', 'crawl',
    '批量商品库存状态监控。批量商品库存监控。官方脚本，开箱即用。', 'per_use', 0.05,
    'stock_monitor', 'params_only', ARRAY['txt','csv']::text[],
    0, false, 'none', 'workload',
    'published', true, '{"tagline": "批量商品库存状态监控", "features": ["有货/无货状态判定", "批量并行", "变化对比输出"], "scenarios": [{"name": "补货提醒", "desc": "紧俏商品到货监控"}, {"name": "渠道盘点", "desc": "分销渠道库存核查"}], "capability_tags": ["监控", "电商"], "usage": ["输入：无需上传文件，仅配置参数", "支持格式：txt、csv", "输出：库存快照（JSON/CSV）", "分布式：最多切 10 片并行，多节点同时加速", "计费：每次 0.05 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'stock-monitor'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'stock-monitor');

INSERT INTO we_apps (
    name, slug, author_name, category, description, pricing_model, price,
    task_type, input_kind, accept_formats, min_memory_mb, gpu_required,
    sandbox_network, launch_kind, status, verified_author, display_meta
) VALUES (
    'Blender 分布式渲染', 'blender-render', '千手官方', 'render',
    '按帧切分派发 GPU 节点，渲染农场开箱即用。Blender 渲染 (按帧并行)。官方脚本，开箱即用。', 'per_use', 1.0,
    'blender_render', 'single_file', ARRAY['blend','zip']::text[],
    8192, true, 'none', 'workload',
    'published', true, '{"tagline": "按帧切分派发 GPU 节点，渲染农场开箱即用", "features": ["按帧并行到多 GPU 节点", "帧序列自动合成视频", "断点续渲"], "scenarios": [{"name": "动画出片", "desc": "个人动画师租用网络算力"}, {"name": "产品渲染", "desc": "电商 3D 素材批量出图"}], "capability_tags": ["渲染", "GPU", "分布式"], "usage": ["输入：上传单个文件", "支持格式：blend、zip", "参数：params.frame_start / frame_end / samples", "输出：渲染帧序列 / 合成视频", "分布式：最多切 20 片并行，多节点同时加速", "计费：每次 1.00 EDG（借调节点另计算力费）"]}'::jsonb
)
ON CONFLICT (slug) DO UPDATE SET
    name = EXCLUDED.name, category = EXCLUDED.category,
    description = EXCLUDED.description, pricing_model = EXCLUDED.pricing_model,
    price = EXCLUDED.price, task_type = EXCLUDED.task_type,
    input_kind = EXCLUDED.input_kind, accept_formats = EXCLUDED.accept_formats,
    min_memory_mb = EXCLUDED.min_memory_mb, gpu_required = EXCLUDED.gpu_required,
    display_meta = EXCLUDED.display_meta, updated_at = now();

INSERT INTO we_app_versions (app_id, version, changelog, signed, created_at)
SELECT id, '1.0.0', '官方首发', true, now() FROM we_apps WHERE slug = 'blender-render'
  AND NOT EXISTS (SELECT 1 FROM we_app_versions v JOIN we_apps a ON v.app_id = a.id WHERE a.slug = 'blender-render');
COMMIT;
