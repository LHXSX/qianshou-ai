-- v8_025 回滚 · 2026-05-30
-- 把 macos-arm64 + linux-x86_64 的 5 个 tier 退回"不下发 prebuilt_venv"状态 ·
-- 即清空 prebuilt_url/sha256/size_mb · manifest 退回 public_mirror_venv (公共源 pip)。
-- source_type 退回 'self_mirror' 默认值 (不影响 · 无 prebuilt_url 时不会被当 tarball 源)。
--
-- 用途: 若激活后线上出现下载/解压异常且未按预期降级 · 一键回到纯公共源。

BEGIN;

UPDATE v8_runtime_tiers SET
    prebuilt_url='', prebuilt_sha256='', prebuilt_size_mb=0, prebuilt_version='',
    updated_at=NOW()
WHERE platform IN ('macos-arm64', 'linux-x86_64')
  AND tier_name IN ('lite', 'crawl', 'ffmpeg', 'ocr', 'speech');

COMMIT;
