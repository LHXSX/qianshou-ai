-- ════════════════════════════════════════════════════════════════════════════
-- Platform v8 · Model Catalog Schema
--
-- 版本: v8.2.0
-- 功能: 自建模型 OSS 分发框架
--   - we_models: 模型注册表 (catalog)
--   - we_worker_models: 节点模型安装状态追踪
--
-- 使用方法:
--   psql -U admin -d edge_compute -f platform_v8/migrations/v8_002_model_catalog.sql
-- ════════════════════════════════════════════════════════════════════════════

-- ── 模型注册表 ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS we_models (
    id              TEXT PRIMARY KEY,                    -- 唯一标识 e.g. sam-vit-b
    name            TEXT NOT NULL,                       -- 显示名
    version         TEXT NOT NULL DEFAULT '1.0',
    description     TEXT DEFAULT '',
    size_mb         REAL DEFAULT 0,                      -- 文件大小 MB
    sha256          TEXT DEFAULT '',                     -- 文件校验哈希
    filename        TEXT DEFAULT '',                     -- 实际文件名
    download_path   TEXT DEFAULT '',                     -- 服务器上的路径 /models/{id}/{filename}
    mirrors         JSONB DEFAULT '[]'::jsonb,           -- 备用镜像 URL 列表
    runtime         TEXT DEFAULT 'python',               -- python | onnx | ollama | mlx
    serve_cmd       TEXT DEFAULT '',                     -- 启动命令模板 (含 {port} 占位)
    health_endpoint TEXT DEFAULT '',                     -- 健康检查 http://127.0.0.1:{port}/health
    stop_cmd        TEXT DEFAULT '',                     -- 停止命令
    requirements    JSONB DEFAULT '{}'::jsonb,           -- {"min_ram_gb":4,"min_disk_mb":500,"gpu":false}
    industry        TEXT[] DEFAULT '{}',                 -- {photography,ecommerce,medical}
    tags            TEXT[] DEFAULT '{}',                 -- {segmentation,inpainting}
    status          TEXT DEFAULT 'active',               -- active | deprecated | testing
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS we_models_industry_idx ON we_models USING GIN(industry);
CREATE INDEX IF NOT EXISTS we_models_tags_idx ON we_models USING GIN(tags);
CREATE INDEX IF NOT EXISTS we_models_status_idx ON we_models(status);

-- ── 节点模型安装记录 ────────────────────────────────
CREATE TABLE IF NOT EXISTS we_worker_models (
    worker_id       UUID NOT NULL REFERENCES we_workers(id) ON DELETE CASCADE,
    model_id        TEXT NOT NULL REFERENCES we_models(id) ON DELETE CASCADE,
    status          TEXT NOT NULL DEFAULT 'pending',     -- pending | downloading | ready | failed | removed
    progress_pct    REAL DEFAULT 0,
    local_path      TEXT DEFAULT '',
    installed_at    TIMESTAMPTZ,
    last_health     TIMESTAMPTZ,
    error           TEXT DEFAULT '',
    PRIMARY KEY (worker_id, model_id)
);

CREATE INDEX IF NOT EXISTS we_wm_worker_idx ON we_worker_models(worker_id);
CREATE INDEX IF NOT EXISTS we_wm_model_idx ON we_worker_models(model_id);
CREATE INDEX IF NOT EXISTS we_wm_status_idx ON we_worker_models(status);

-- ── 种子数据: 摄影修图 + 通用模型 ──────────────────
INSERT INTO we_models (id, name, version, description, size_mb, sha256, filename, download_path, mirrors, runtime, requirements, industry, tags) VALUES

('sam-vit-b', 'Segment Anything (ViT-B)', '1.0',
 'Meta 开源通用分割模型 · 一键抠图/智能选区/实例分割',
 375, '', 'sam_vit_b_01ec64.pth', '/models/sam-vit-b/sam_vit_b_01ec64.pth',
 '["https://hf-mirror.com/facebook/sam-vit-base/resolve/main/sam_vit_b_01ec64.pth","https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth"]',
 'python', '{"min_ram_gb":2,"min_disk_mb":500,"gpu":false}'::jsonb,
 '{photography,ecommerce}', '{segmentation,matting}'),

('lama', 'LaMa (Large Mask Inpainting)', '1.0',
 '三星开源大遮罩修复模型 · 物体擦除/背景修复/瑕疵去除',
 200, '', 'big-lama.pt', '/models/lama/big-lama.pt',
 '["https://hf-mirror.com/smartywu/big-lama/resolve/main/big-lama.pt"]',
 'python', '{"min_ram_gb":1,"min_disk_mb":300,"gpu":false}'::jsonb,
 '{photography,ecommerce}', '{inpainting,restoration}'),

('gfpgan-v1.4', 'GFPGAN v1.4', '1.4',
 '腾讯开源人脸修复模型 · 老照片修复/人脸超分/五官增强',
 350, '', 'GFPGANv1.4.pth', '/models/gfpgan-v1.4/GFPGANv1.4.pth',
 '["https://hf-mirror.com/TencentARC/GFPGAN/resolve/main/GFPGANv1.4.pth","https://github.com/TencentARC/GFPGAN/releases/download/v1.3.0/GFPGANv1.4.pth"]',
 'python', '{"min_ram_gb":2,"min_disk_mb":500,"gpu":false}'::jsonb,
 '{photography}', '{face_restoration,super_resolution}'),

('realesrgan-x4', 'Real-ESRGAN x4plus', '0.1.0',
 '腾讯开源通用超分模型 · 4倍放大/老照片修复/画质增强',
 65, '', 'RealESRGAN_x4plus.pth', '/models/realesrgan-x4/RealESRGAN_x4plus.pth',
 '["https://hf-mirror.com/ai-forever/Real-ESRGAN/resolve/main/RealESRGAN_x4plus.pth","https://github.com/xinntao/Real-ESRGAN/releases/download/v0.1.0/RealESRGAN_x4plus.pth"]',
 'python', '{"min_ram_gb":1,"min_disk_mb":100,"gpu":false}'::jsonb,
 '{photography,ecommerce}', '{super_resolution,enhancement}'),

('birefnet', 'BiRefNet (背景去除)', '1.0',
 '新一代高精度背景去除/抠图模型 · 透明PNG输出',
 220, '', 'BiRefNet-general-epoch_244.pth', '/models/birefnet/BiRefNet-general-epoch_244.pth',
 '["https://hf-mirror.com/ZhengPeng7/BiRefNet/resolve/main/BiRefNet-general-epoch_244.pth"]',
 'python', '{"min_ram_gb":1,"min_disk_mb":300,"gpu":false}'::jsonb,
 '{photography,ecommerce}', '{matting,background_removal}'),

('nafnet-denoise', 'NAFNet (去噪去模糊)', '1.0',
 '高效去噪/去模糊模型 · 清晰度恢复',
 70, '', 'NAFNet-SIDD-width64.pth', '/models/nafnet-denoise/NAFNet-SIDD-width64.pth',
 '["https://hf-mirror.com/megvii-research/NAFNet/resolve/main/NAFNet-SIDD-width64.pth"]',
 'python', '{"min_ram_gb":1,"min_disk_mb":100,"gpu":false}'::jsonb,
 '{photography}', '{denoising,deblurring}')

ON CONFLICT (id) DO NOTHING;
