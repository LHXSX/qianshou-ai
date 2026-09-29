-- ═══════════════════════════════════════════════════════════════════════════
-- v8_041 · 应用展示层元数据 (2026-08-08)
--
-- 背景: 商店详情页要达到效果图丰满度 (tagline / 主要特性 / 典型场景 / 能力标签),
-- we_apps 只有 description 一列。展示层运营内容与调度类 manifest 字段分离,
-- 收敛进一个 JSONB, 开发者提交 / 官方运营均写这里。
--
-- display_meta 结构:
--   { "tagline": str, "features": [str], "scenarios": [{"name","desc"}],
--     "capability_tags": [str] }
-- ═══════════════════════════════════════════════════════════════════════════

ALTER TABLE we_apps ADD COLUMN IF NOT EXISTS display_meta JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ── 官方种子应用运营文案 (基于 task_registry 真实能力撰写, 不夸大) ──

UPDATE we_apps SET
  description = '通用 OCR 识别是千手生态的官方文字识别能力，基于 RapidOCR / PaddleOCR 推理引擎，支持对印刷体图像中的文字进行检测与识别。任务经生态调度派发至具备 OCR 能力层的节点执行，本机满足条件时也可离线运行，识别结果以结构化 JSON 交付。',
  display_meta = '{
    "tagline": "高精度、多场景的通用文字识别能力",
    "features": [
      "多场景支持：适用于文档、票据、证件、名片、书籍、表格等多类图像",
      "结构化输出：返回文本块坐标与置信度，便于程序化后处理",
      "双引擎调度：节点按能力自动选用 RapidOCR / PaddleOCR 执行",
      "本地优先：本机具备 OCR 能力层时离线运行，数据不出本机",
      "可借调：本机不满足时一键借调具备 GPU 的边缘节点",
      "API 可调：开放平台一把密钥即可程序化批量调用"
    ],
    "scenarios": [
      {"name": "票据识别", "desc": "发票、收据等票据信息提取"},
      {"name": "证件识别", "desc": "身份证、护照等证件信息识别"},
      {"name": "文档数字化", "desc": "纸质文档转可检索电子文档"},
      {"name": "表格识别", "desc": "表格结构与数据的批量提取"}
    ],
    "capability_tags": ["图像处理", "文字识别", "AI 能力"]
  }'::jsonb
WHERE slug = 'ocr-image';

UPDATE we_apps SET
  description = 'PDF 文档识别面向扫描件与图片型 PDF，逐页渲染后执行 OCR，输出带页码结构的全文识别结果。适合合同扫描件、档案卷宗、纸质报告的批量数字化。',
  display_meta = '{
    "tagline": "扫描件 PDF 逐页 OCR，输出带页码结构的全文",
    "features": [
      "整本处理：单次任务处理多页 PDF，逐页并行识别",
      "版面保留：按页组织识别结果，保留文档阅读顺序",
      "混合文档兼容：文本层与图片层混排的 PDF 均可处理",
      "结构化交付：JSON 按页输出，可直接入库或检索",
      "可借调：大体量卷宗建议借调边缘节点并行加速"
    ],
    "scenarios": [
      {"name": "合同扫描件", "desc": "纸质合同批量转电子文本"},
      {"name": "档案数字化", "desc": "历史档案卷宗建库检索"},
      {"name": "报告提取", "desc": "纸质报告关键数据提取"},
      {"name": "卷宗阅卷", "desc": "诉讼卷宗全文可检索化"}
    ],
    "capability_tags": ["PDF 处理", "文字识别", "批量数字化"]
  }'::jsonb
WHERE slug = 'pdf-ocr';

UPDATE we_apps SET
  description = '合同审查对合同文本做要点抽取与风险提示：识别当事人、标的、金额、期限、违约条款等关键要素，标注缺失条款与常见风险点，输出结构化审查报告。',
  display_meta = '{
    "tagline": "合同要点抽取与风险提示，输出结构化审查报告",
    "features": [
      "要素抽取：当事人、标的、金额、期限、管辖等关键要素定位",
      "风险提示：缺失条款、权责失衡等常见风险点标注",
      "结构化报告：JSON 报告可直接对接审批流或文档系统",
      "本地优先：敏感合同可在本机执行，文本不出本机",
      "免费试用：新用户享免费试用次数，先验证效果再付费"
    ],
    "scenarios": [
      {"name": "签约前审查", "desc": "合同定稿前的风险自查"},
      {"name": "批量合规", "desc": "存量合同的批量合规巡检"},
      {"name": "尽调支持", "desc": "并购尽调中的合同要素归档"},
      {"name": "法务提效", "desc": "初审报告自动化生成"}
    ],
    "capability_tags": ["法律", "文本分析", "风险识别"]
  }'::jsonb
WHERE slug = 'contract-review';

UPDATE we_apps SET
  description = '语音转写基于 Whisper 系列模型（faster-whisper / whisper.cpp），将音频转为带时间戳的文字稿。支持中英等多语言，节点按硬件自动选择推理后端。',
  display_meta = '{
    "tagline": "Whisper 引擎音频转文字，支持多语言与时间戳",
    "features": [
      "多语言：中、英等多语言语音识别与自动语种检测",
      "时间戳输出：分段带时间轴，可直接生成字幕",
      "后端自适应：节点按硬件选用 faster-whisper / whisper.cpp",
      "长音频友好：会议录音、庭审录音等长素材分段处理",
      "可借调：本机无语音能力层时借调具备加速的节点"
    ],
    "scenarios": [
      {"name": "会议纪要", "desc": "会议录音自动成稿"},
      {"name": "庭审记录", "desc": "庭审录音转写与要点提炼"},
      {"name": "字幕生成", "desc": "音视频内容配字幕"},
      {"name": "采访整理", "desc": "采访录音快速成文"}
    ],
    "capability_tags": ["语音识别", "AI 能力", "多语言"]
  }'::jsonb
WHERE slug = 'whisper-transcribe';

UPDATE we_apps SET
  description = '表格导出把结构化 JSON 数据渲染为规范的 Excel 文件：自动表头、列宽与样式，适合把任务产物、接口数据一键落成可交付的报表。',
  display_meta = '{
    "tagline": "结构化数据一键导出规范 Excel 报表",
    "features": [
      "零配置：传入 JSON 记录数组即可生成带表头的工作簿",
      "规范样式：标题、表头、列宽自动处理，开箱即用",
      "轻量快速：CPU 节点毫秒级完成，免费使用",
      "管道友好：常作为其他应用产物的落表环节",
      "API 可调：开放平台调用，程序化批量出表"
    ],
    "scenarios": [
      {"name": "任务产物落表", "desc": "OCR / 审查结果转报表"},
      {"name": "接口数据导出", "desc": "业务接口数据成 Excel"},
      {"name": "定期报表", "desc": "定时任务自动出周报月报"},
      {"name": "数据交付", "desc": "面向客户的标准化交付件"}
    ],
    "capability_tags": ["数据导出", "办公自动化", "免费"]
  }'::jsonb
WHERE slug = 'excel-export';

UPDATE we_apps SET
  description = '千手律所·智能阅卷是官方旗舰的法律专业应用：材料包阅卷、证据梳理与争议焦点辅助。深链唤起律所专业壳，案件材料本地优先处理，重计算环节可借调生态算力。',
  display_meta = '{
    "tagline": "AI 驱动的全流程法律服务中枢",
    "features": [
      "材料包阅卷：卷宗材料一键导入，自动分类与编目",
      "证据梳理：证据链时间轴与要素关联可视化",
      "争议焦点辅助：基于案情材料的焦点归纳建议",
      "本地优先：案件数据本地处理，敏感信息不出本机",
      "专业壳深链：从生态一键唤起律所专业工作台"
    ],
    "scenarios": [
      {"name": "诉讼阅卷", "desc": "大体量卷宗快速通读定位"},
      {"name": "证据整理", "desc": "证据编目与质证准备"},
      {"name": "庭前准备", "desc": "争议焦点与应对要点梳理"},
      {"name": "团队协作", "desc": "案件材料库多人协同"}
    ],
    "capability_tags": ["法律", "行业方案", "本地优先"]
  }'::jsonb
WHERE slug = 'qianshou-law';
