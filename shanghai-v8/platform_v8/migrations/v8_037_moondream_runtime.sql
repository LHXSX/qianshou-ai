-- v8_037 · 2026-08-05 · 独立 Moondream2 图片描述运行时
--
-- 注册独立 moondream tier；模型制品由 bundles.py vision_models 协议下发并做 SHA256 门控。

INSERT INTO v8_runtime_tiers (
    tier_name, display_name, icon, platform, display_order,
    description, required, auto_install, enabled,
    packages, software, task_types, skills, depends_on,
    verify_cmd, verify_timeout_secs, source_type,
    prebuilt_url, prebuilt_sha256, prebuilt_size_mb, prebuilt_version,
    requires_gpu, min_vram_gb, min_ram_gb
) VALUES (
    'moondream', 'Moondream 图片描述', '🌙', 'any', 6,
    'Moondream2 本地图片描述运行时（CPU 可运行 · 需 8GB+ 内存；模型经 vision_models SHA256 校验后可安装）',
    FALSE, FALSE, TRUE,
            ARRAY['moondream','pillow','torch','transformers==4.52.4','accelerate','safetensors']::text[],
    ARRAY['moondream2','pillow']::text[],
    ARRAY['image_caption']::text[],
    '{}'::text[],
    '{}'::text[],
    'import moondream, PIL, torch, transformers; print(''moondream ok'')',
    300, 'self_mirror',
    '', '', 0, '',
    FALSE, 0, 8
)
ON CONFLICT (tier_name, platform) DO UPDATE SET
    display_name = EXCLUDED.display_name,
    icon = EXCLUDED.icon,
    display_order = EXCLUDED.display_order,
    description = EXCLUDED.description,
    required = EXCLUDED.required,
    auto_install = EXCLUDED.auto_install,
    enabled = EXCLUDED.enabled,
    packages = EXCLUDED.packages,
    software = EXCLUDED.software,
    task_types = EXCLUDED.task_types,
    skills = EXCLUDED.skills,
    depends_on = EXCLUDED.depends_on,
    verify_cmd = EXCLUDED.verify_cmd,
    verify_timeout_secs = EXCLUDED.verify_timeout_secs,
    source_type = EXCLUDED.source_type,
    prebuilt_url = EXCLUDED.prebuilt_url,
    prebuilt_sha256 = EXCLUDED.prebuilt_sha256,
    prebuilt_size_mb = EXCLUDED.prebuilt_size_mb,
    prebuilt_version = EXCLUDED.prebuilt_version,
    requires_gpu = EXCLUDED.requires_gpu,
    min_vram_gb = EXCLUDED.min_vram_gb,
    min_ram_gb = EXCLUDED.min_ram_gb,
    updated_at = NOW();

-- image_caption 由独立 moondream tier 接管，不再归入通用 vision-ai。
UPDATE v8_runtime_tiers
SET task_types = array_remove(task_types, 'image_caption'),
    updated_at = NOW()
WHERE tier_name = 'vision-ai'
  AND 'image_caption' = ANY(task_types);
