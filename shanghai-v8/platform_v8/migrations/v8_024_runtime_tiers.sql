-- v8_024 · 2026-05-30 · 运行时环境动态管理 · 硬件门控 + 多下载源
--
-- 设计:
--   1. 替代 bundles.py 中的 PREBUILT_VENVS 静态字典，改为数据库动态管理
--   2. 每个 tier 支持多下载源 (自家镜像 + 国内公共镜像)
--   3. 硬件门控: 根据 GPU/显存/内存 过滤可安装 tier
--   4. Admin 后台热增删改查，无需重启后端
--   5. source_type: self_mirror (自家 qianshousuanli.com/by) / public_mirror (清华/阿里等)
--   6. 安装方式: 纯 tarball 下载 → SHA256 校验 → 解压，不走 pip/brew/shell

CREATE TABLE IF NOT EXISTS v8_runtime_tiers (
    id              BIGSERIAL PRIMARY KEY,

    -- 标识
    tier_name       TEXT        NOT NULL,               -- lite / crawl / ffmpeg / ocr / speech / vision-ai / render
    display_name    TEXT        NOT NULL DEFAULT '',    -- 显示名
    icon            TEXT        NOT NULL DEFAULT '',    -- emoji 图标

    -- 描述
    description     TEXT        NOT NULL DEFAULT '',
    task_types      TEXT[]      NOT NULL DEFAULT '{}',  -- 支持的任务类型
    skills          TEXT[]      NOT NULL DEFAULT '{}',  -- 关联的 skill ID

    -- 平台
    platform        TEXT        NOT NULL DEFAULT 'any',  -- macos-arm64 / macos-x86_64 / linux-x86_64 / windows-x86_64 / any

    -- 安装策略
    required        BOOLEAN     NOT NULL DEFAULT FALSE,  -- 是否必装
    auto_install    BOOLEAN     NOT NULL DEFAULT FALSE,  -- 首启自动装
    enabled         BOOLEAN     NOT NULL DEFAULT TRUE,   -- 是否启用 (软删除)
    display_order   INTEGER     NOT NULL DEFAULT 0,     -- 前端展示排序

    -- 下载源类型
    source_type     TEXT        NOT NULL DEFAULT 'self_mirror'
                    CHECK (source_type IN ('self_mirror', 'public_mirror')),
    -- self_mirror: 自家 qianshousuanli.com/by (小 tier: lite/crawl/ffmpeg/ocr/speech)
    -- public_mirror: 国内公共镜像 (大 tier: vision-ai/render，走清华/阿里)

    -- 预打包 tarball (自家镜像 · 默认首选)
    prebuilt_url        TEXT        NOT NULL DEFAULT '',
    prebuilt_sha256     TEXT        NOT NULL DEFAULT '',
    prebuilt_size_mb    FLOAT       NOT NULL DEFAULT 0,
    prebuilt_version    TEXT        NOT NULL DEFAULT '',

    -- 多镜像源 (JSONB)
    -- [{ "label": "清华镜像", "url": "https://...", "sha256": "...", "size_mb": 0 }]
    -- 下载时按顺序尝试，任一成功即停止
    mirror_sources      JSONB       NOT NULL DEFAULT '[]',

    -- 安装后验证
    verify_cmd          TEXT        NOT NULL DEFAULT '',
    verify_timeout_secs INTEGER     NOT NULL DEFAULT 60,

    -- 依赖
    packages            TEXT[]      NOT NULL DEFAULT '{}',  -- Python 包列表
    depends_on          TEXT[]      NOT NULL DEFAULT '{}',  -- 依赖的其他 tier

    -- 硬件门控 · 全部为 NULL 或 0 表示无限制
    requires_gpu        BOOLEAN     NOT NULL DEFAULT FALSE,  -- 需要 GPU
    requires_cuda       BOOLEAN     NOT NULL DEFAULT FALSE,  -- 需要 CUDA
    requires_metal      BOOLEAN     NOT NULL DEFAULT FALSE,  -- 需要 Apple Metal
    min_vram_gb         FLOAT       NOT NULL DEFAULT 0,     -- 最小显存 (GB)
    min_ram_gb          FLOAT       NOT NULL DEFAULT 0,     -- 最小内存 (GB)

    -- 时间戳
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- 唯一约束: 同一 tier 名 + platform 组合唯一
    UNIQUE (tier_name, platform)
);

-- 索引
CREATE INDEX IF NOT EXISTS v8_runtime_tiers_enabled_idx
    ON v8_runtime_tiers (enabled, display_order);
CREATE INDEX IF NOT EXISTS v8_runtime_tiers_platform_idx
    ON v8_runtime_tiers (platform);
CREATE INDEX IF NOT EXISTS v8_runtime_tiers_tier_name_idx
    ON v8_runtime_tiers (tier_name);

COMMENT ON TABLE v8_runtime_tiers IS '运行时环境动态管理 · 替代静态字典 · 支持硬件门控和多下载源';
COMMENT ON COLUMN v8_runtime_tiers.source_type IS '下载源类型: self_mirror=自家服务器 / public_mirror=国内公共镜像';
COMMENT ON COLUMN v8_runtime_tiers.mirror_sources IS '多镜像源列表 · 下载时按序尝试 · [{label, url, sha256, size_mb}]';

-- ════════════════════════════════════════════════════════════════════
-- 初始数据: 将现有 PREBUILT_VENVS 静态字典迁移入库
-- ════════════════════════════════════════════════════════════════════

-- lite tier (所有平台)
INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('lite', '轻量运行环境', '🧩', '图片/PDF/ONNX 推理基础环境 (必装 · 首启自动)', TRUE, TRUE, TRUE, 1,
 'self_mirror', '2026.05.30', 'import PIL, numpy, onnxruntime, fitz, pdfplumber; print(''lite ok'')', 120,
 ARRAY['pillow','numpy','onnxruntime','PyMuPDF','pdfplumber'],
 ARRAY['image_resize','image_compress','image_convert','image_thumbnail','image_info','onnx_infer','fft_compute','pdf_info','pdf_to_text'],
 ARRAY['image-tools-v1','data-tools-v1','file-tools-v1','text-tools-v1','llm-tools-v1'],
 'macos-arm64', 'https://qianshousuanli.com/by/v1/macos-arm64/lite.tar.gz',
 '43b8dd9246840adb1ca6eb12d98528e77abbb3123c315052a2ed6fdc79f35b9e', 97)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('lite', '轻量运行环境', '🧩', '图片/PDF/ONNX 推理基础环境 (必装 · 首启自动)', TRUE, TRUE, TRUE, 1,
 'self_mirror', '2026.05.30', 'import PIL, numpy, onnxruntime, fitz, pdfplumber; print(''lite ok'')', 120,
 ARRAY['pillow','numpy','onnxruntime','PyMuPDF','pdfplumber'],
 ARRAY['image_resize','image_compress','image_convert','image_thumbnail','image_info','onnx_infer','fft_compute','pdf_info','pdf_to_text'],
 ARRAY['image-tools-v1','data-tools-v1','file-tools-v1','text-tools-v1','llm-tools-v1'],
 'linux-x86_64', 'https://qianshousuanli.com/by/v1/linux-x86_64/lite.tar.gz',
 '3134924550466d82ac9b268241fcc68f8f8e249f5447d14cd5140dc73ba8ecde', 88)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('lite', '轻量运行环境', '🧩', '图片/PDF/ONNX 推理基础环境 (必装 · 首启自动)', TRUE, TRUE, TRUE, 1,
 'self_mirror', '2026.05.30', 'import PIL, numpy, onnxruntime, fitz, pdfplumber; print(''lite ok'')', 120,
 ARRAY['pillow','numpy','onnxruntime','PyMuPDF','pdfplumber'],
 ARRAY['image_resize','image_compress','image_convert','image_thumbnail','image_info','onnx_infer','fft_compute','pdf_info','pdf_to_text'],
 ARRAY['image-tools-v1','data-tools-v1','file-tools-v1','text-tools-v1','llm-tools-v1'],
 'macos-x86_64', 'https://qianshousuanli.com/by/v1/macos-x86_64/lite.tar.gz', 'TBD', 0)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('lite', '轻量运行环境', '🧩', '图片/PDF/ONNX 推理基础环境 (必装 · 首启自动)', TRUE, TRUE, TRUE, 1,
 'self_mirror', '2026.05.30', 'import PIL, numpy, onnxruntime, fitz, pdfplumber; print(''lite ok'')', 120,
 ARRAY['pillow','numpy','onnxruntime','PyMuPDF','pdfplumber'],
 ARRAY['image_resize','image_compress','image_convert','image_thumbnail','image_info','onnx_infer','fft_compute','pdf_info','pdf_to_text'],
 ARRAY['image-tools-v1','data-tools-v1','file-tools-v1','text-tools-v1','llm-tools-v1'],
 'windows-x86_64', 'https://qianshousuanli.com/by/v1/windows-x86_64/lite.tar.gz', 'TBD', 0)
ON CONFLICT (tier_name, platform) DO NOTHING;

-- crawl tier (所有平台)
INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('crawl', '数据采集环境', '🕷', '公开数据采集 + GEO 监测 (首启自动装)', FALSE, TRUE, TRUE, 2,
 'self_mirror', '2026.05.30', 'import requests, selectolax, tldextract; from readability import Document; print(''crawl ok'')', 60,
 ARRAY['requests','selectolax','tldextract','readability-lxml','lxml'],
 ARRAY['crawl_url_fetch','crawl_url_extract','crawl_batch_fetch'],
 ARRAY[]::TEXT[],
 'macos-arm64', 'https://qianshousuanli.com/by/v1/macos-arm64/crawl.tar.gz',
 'c088d09d7a5cf3c1cf9b99dea11cdf49aad11fc826aafd3d29ca002b4b5bef81', 20)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('crawl', '数据采集环境', '🕷', '公开数据采集 + GEO 监测 (首启自动装)', FALSE, TRUE, TRUE, 2,
 'self_mirror', '2026.05.30', 'import requests, selectolax, tldextract; from readability import Document; print(''crawl ok'')', 60,
 ARRAY['requests','selectolax','tldextract','readability-lxml','lxml'],
 ARRAY['crawl_url_fetch','crawl_url_extract','crawl_batch_fetch'],
 ARRAY[]::TEXT[],
 'linux-x86_64', 'https://qianshousuanli.com/by/v1/linux-x86_64/crawl.tar.gz',
 'dbcd1bde6150af770c307b6193626de8e9bb15cdd46b0214cad34ec2e0634a25', 17)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('crawl', '数据采集环境', '🕷', '公开数据采集 + GEO 监测 (首启自动装)', FALSE, TRUE, TRUE, 2,
 'self_mirror', '2026.05.30', 'import requests, selectolax, tldextract; from readability import Document; print(''crawl ok'')', 60,
 ARRAY['requests','selectolax','tldextract','readability-lxml','lxml'],
 ARRAY['crawl_url_fetch','crawl_url_extract','crawl_batch_fetch'],
 ARRAY[]::TEXT[],
 'macos-x86_64', 'https://qianshousuanli.com/by/v1/macos-x86_64/crawl.tar.gz', 'TBD', 0)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('crawl', '数据采集环境', '🕷', '公开数据采集 + GEO 监测 (首启自动装)', FALSE, TRUE, TRUE, 2,
 'self_mirror', '2026.05.30', 'import requests, selectolax, tldextract; from readability import Document; print(''crawl ok'')', 60,
 ARRAY['requests','selectolax','tldextract','readability-lxml','lxml'],
 ARRAY['crawl_url_fetch','crawl_url_extract','crawl_batch_fetch'],
 ARRAY[]::TEXT[],
 'windows-x86_64', 'https://qianshousuanli.com/by/v1/windows-x86_64/crawl.tar.gz', 'TBD', 0)
ON CONFLICT (tier_name, platform) DO NOTHING;

-- ffmpeg tier (所有平台)
INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('ffmpeg', '音视频环境', '🎬', '音视频处理: imageio-ffmpeg (必装)', TRUE, FALSE, TRUE, 3,
 'self_mirror', '2026.05.30', 'import imageio_ffmpeg; p=imageio_ffmpeg.get_ffmpeg_exe(); print(''ffmpeg ok:'', p)', 60,
 ARRAY['imageio-ffmpeg'],
 ARRAY['audio_extract','audio_transcode','video_thumbnail','video_compress','video_info','video_trim'],
 ARRAY[]::TEXT[],
 'macos-arm64', 'https://qianshousuanli.com/by/v1/macos-arm64/ffmpeg.tar.gz',
 '4182fe1afb4f7f9b744bd9e426180fcdef58b8b638a4a80c5998459b14b19455', 27)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('ffmpeg', '音视频环境', '🎬', '音视频处理: imageio-ffmpeg (必装)', TRUE, FALSE, TRUE, 3,
 'self_mirror', '2026.05.30', 'import imageio_ffmpeg; p=imageio_ffmpeg.get_ffmpeg_exe(); print(''ffmpeg ok:'', p)', 60,
 ARRAY['imageio-ffmpeg'],
 ARRAY['audio_extract','audio_transcode','video_thumbnail','video_compress','video_info','video_trim'],
 ARRAY[]::TEXT[],
 'linux-x86_64', 'https://qianshousuanli.com/by/v1/linux-x86_64/ffmpeg.tar.gz',
 '718e98b673ae44c1adb5367822550b986a5ad92b1a6634c92e78c0ed240bc853', 36)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('ffmpeg', '音视频环境', '🎬', '音视频处理: imageio-ffmpeg (必装)', TRUE, FALSE, TRUE, 3,
 'self_mirror', '2026.05.30', 'import imageio_ffmpeg; p=imageio_ffmpeg.get_ffmpeg_exe(); print(''ffmpeg ok:'', p)', 60,
 ARRAY['imageio-ffmpeg'],
 ARRAY['audio_extract','audio_transcode','video_thumbnail','video_compress','video_info','video_trim'],
 ARRAY[]::TEXT[],
 'macos-x86_64', 'https://qianshousuanli.com/by/v1/macos-x86_64/ffmpeg.tar.gz', 'TBD', 0)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('ffmpeg', '音视频环境', '🎬', '音视频处理: imageio-ffmpeg (必装)', TRUE, FALSE, TRUE, 3,
 'self_mirror', '2026.05.30', 'import imageio_ffmpeg; p=imageio_ffmpeg.get_ffmpeg_exe(); print(''ffmpeg ok:'', p)', 60,
 ARRAY['imageio-ffmpeg'],
 ARRAY['audio_extract','audio_transcode','video_thumbnail','video_compress','video_info','video_trim'],
 ARRAY[]::TEXT[],
 'windows-x86_64', 'https://qianshousuanli.com/by/v1/windows-x86_64/ffmpeg.tar.gz', 'TBD', 0)
ON CONFLICT (tier_name, platform) DO NOTHING;

-- ocr tier (macOS ARM + Linux x64 已构建)
INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb,
    min_ram_gb)
VALUES
('ocr', 'OCR 识别环境', '🔍', 'PaddleOCR 文字识别 (需 4GB+ 内存)', FALSE, FALSE, TRUE, 4,
 'self_mirror', '2026.05.30', 'import paddle, paddleocr; print(''ocr ok:'', paddle.__version__)', 300,
 ARRAY['paddleocr','paddlepaddle'],
 ARRAY['ocr_image','pdf_ocr'],
 ARRAY['ocr-tools-v1'],
 'macos-arm64', 'https://qianshousuanli.com/by/v1/macos-arm64/ocr.tar.gz',
 '78692f8e620f3c0a1e48bd9d7d0eb3dcf1f2787af816c6dc2dc2395c7962835d', 229,
 4.0)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb,
    min_ram_gb)
VALUES
('ocr', 'OCR 识别环境', '🔍', 'PaddleOCR 文字识别 (需 4GB+ 内存)', FALSE, FALSE, TRUE, 4,
 'self_mirror', '2026.05.30', 'import paddle, paddleocr; print(''ocr ok:'', paddle.__version__)', 300,
 ARRAY['paddleocr','paddlepaddle'],
 ARRAY['ocr_image','pdf_ocr'],
 ARRAY['ocr-tools-v1'],
 'linux-x86_64', 'https://qianshousuanli.com/by/v1/linux-x86_64/ocr.tar.gz',
 'd6e994eb7919ad1e85c8353f2c6b0d9ace0a8e373c9bfb470603e72c10d260e0', 338,
 4.0)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb,
    min_ram_gb)
VALUES
('ocr', 'OCR 识别环境', '🔍', 'PaddleOCR 文字识别 (需 4GB+ 内存)', FALSE, FALSE, TRUE, 4,
 'self_mirror', '2026.05.30', 'import paddle, paddleocr; print(''ocr ok:'', paddle.__version__)', 300,
 ARRAY['paddleocr','paddlepaddle'],
 ARRAY['ocr_image','pdf_ocr'],
 ARRAY['ocr-tools-v1'],
 'macos-x86_64', 'https://qianshousuanli.com/by/v1/macos-x86_64/ocr.tar.gz', 'TBD', 0, 4.0)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb,
    min_ram_gb)
VALUES
('ocr', 'OCR 识别环境', '🔍', 'PaddleOCR 文字识别 (需 4GB+ 内存)', FALSE, FALSE, TRUE, 4,
 'self_mirror', '2026.05.30', 'import paddle, paddleocr; print(''ocr ok:'', paddle.__version__)', 300,
 ARRAY['paddleocr','paddlepaddle'],
 ARRAY['ocr_image','pdf_ocr'],
 ARRAY['ocr-tools-v1'],
 'windows-x86_64', 'https://qianshousuanli.com/by/v1/windows-x86_64/ocr.tar.gz', 'TBD', 0, 4.0)
ON CONFLICT (tier_name, platform) DO NOTHING;

-- speech tier (macOS ARM + Linux x64 已构建)
INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    depends_on,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('speech', '语音转文字环境', '🎙', 'faster-whisper 语音识别 (依赖 ffmpeg)', FALSE, FALSE, TRUE, 5,
 'self_mirror', '2026.05.30', 'import faster_whisper; print(''speech ok'')', 180,
 ARRAY['faster-whisper'],
 ARRAY['whisper_transcribe'],
 ARRAY[]::TEXT[],
 ARRAY['ffmpeg'],
 'macos-arm64', 'https://qianshousuanli.com/by/v1/macos-arm64/speech.tar.gz',
 'e8e21b0cc8feac6cc2a0bc99c60701673cec6e95756f43fbc430eaa5e02cfde4', 60)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    depends_on,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('speech', '语音转文字环境', '🎙', 'faster-whisper 语音识别 (依赖 ffmpeg)', FALSE, FALSE, TRUE, 5,
 'self_mirror', '2026.05.30', 'import faster_whisper; print(''speech ok'')', 180,
 ARRAY['faster-whisper'],
 ARRAY['whisper_transcribe'],
 ARRAY[]::TEXT[],
 ARRAY['ffmpeg'],
 'linux-x86_64', 'https://qianshousuanli.com/by/v1/linux-x86_64/speech.tar.gz',
 '65f259f0badaaeb2c0ec1a9ac060b1c274817ba4deb2a8a28482c87b45b35360', 126)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    depends_on,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('speech', '语音转文字环境', '🎙', 'faster-whisper 语音识别 (依赖 ffmpeg)', FALSE, FALSE, TRUE, 5,
 'self_mirror', '2026.05.30', 'import faster_whisper; print(''speech ok'')', 180,
 ARRAY['faster-whisper'],
 ARRAY['whisper_transcribe'],
 ARRAY[]::TEXT[],
 ARRAY['ffmpeg'],
 'macos-x86_64', 'https://qianshousuanli.com/by/v1/macos-x86_64/speech.tar.gz', 'TBD', 0)
ON CONFLICT (tier_name, platform) DO NOTHING;

INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    depends_on,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb)
VALUES
('speech', '语音转文字环境', '🎙', 'faster-whisper 语音识别 (依赖 ffmpeg)', FALSE, FALSE, TRUE, 5,
 'self_mirror', '2026.05.30', 'import faster_whisper; print(''speech ok'')', 180,
 ARRAY['faster-whisper'],
 ARRAY['whisper_transcribe'],
 ARRAY[]::TEXT[],
 ARRAY['ffmpeg'],
 'windows-x86_64', 'https://qianshousuanli.com/by/v1/windows-x86_64/speech.tar.gz', 'TBD', 0)
ON CONFLICT (tier_name, platform) DO NOTHING;

-- vision-ai tier (大 tier · 走国内公共镜像)
INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb,
    requires_gpu, min_vram_gb, min_ram_gb,
    mirror_sources)
VALUES
('vision-ai', '视觉 AI 环境', '🤖', '图片理解/生成: Transformers + Diffusers (需 GPU 4GB+ 显存 或 8GB+ 内存)', FALSE, FALSE, TRUE, 6,
 'public_mirror', '2026.05.30', 'import transformers, torch, diffusers; print(''vision-ai ok'')', 300,
 ARRAY['transformers','torch','torchvision','safetensors','diffusers','accelerate'],
 ARRAY['image_caption','sd_txt2img','sd_img2img','sd_inpaint'],
 ARRAY['photo-edit-v1'],
 'any', 'https://qianshousuanli.com/by/v1/{platform}/vision-ai.tar.gz', 'TBD', 0,
 TRUE, 4.0, 8.0,
 '[
   {"label": "清华镜像 (北京)", "url": "https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main/{platform}/vision-ai.tar.gz"},
   {"label": "阿里云镜像 (杭州)", "url": "https://mirrors.aliyun.com/pypi/simple/"}
 ]'::JSONB)
ON CONFLICT (tier_name, platform) DO NOTHING;

-- render tier (大 tier · 走国内公共镜像)
INSERT INTO v8_runtime_tiers (tier_name, display_name, icon, description, required, auto_install, enabled, display_order,
    source_type, prebuilt_version, verify_cmd, verify_timeout_secs,
    packages, task_types, skills,
    platform, prebuilt_url, prebuilt_sha256, prebuilt_size_mb,
    min_ram_gb,
    mirror_sources)
VALUES
('render', '3D 渲染环境', '🎨', 'Blender 3D 渲染 (~250MB · 走国内镜像)', FALSE, FALSE, TRUE, 7,
 'public_mirror', '2026.05.30', 'blender --version', 30,
 ARRAY[]::TEXT[],
 ARRAY['blender_render','blender_info','render_split','frame_compose'],
 ARRAY['render-tools-v1'],
 'any', 'https://mirrors.aliyun.com/blender/release/Blender4.2/blender-4.2.0-{platform}.tar.xz', 'TBD', 252,
 4.0,
 '[
   {"label": "清华镜像 (北京)", "url": "https://mirrors.tuna.tsinghua.edu.cn/blender/release/Blender4.2/blender-4.2.0-{platform}.tar.xz"},
   {"label": "阿里云镜像 (杭州)", "url": "https://mirrors.aliyun.com/blender/release/Blender4.2/blender-4.2.0-{platform}.tar.xz"},
   {"label": "华为云镜像", "url": "https://repo.huaweicloud.com/blender/release/Blender4.2/blender-4.2.0-{platform}.tar.xz"},
   {"label": "南京大学镜像", "url": "https://mirror.nju.edu.cn/blender/release/Blender4.2/blender-4.2.0-{platform}.tar.xz"},
   {"label": "Blender 官方 (兜底)", "url": "https://download.blender.org/release/Blender4.2/blender-4.2.0-{platform}.tar.xz"}
 ]'::JSONB)
ON CONFLICT (tier_name, platform) DO NOTHING;