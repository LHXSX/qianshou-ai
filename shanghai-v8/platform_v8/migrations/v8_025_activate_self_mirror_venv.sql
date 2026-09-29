-- v8_025 · 2026-05-30 · 激活自家镜像预打包 venv (按平台门控)
--
-- 背景:
--   v8_024 用 ON CONFLICT DO NOTHING 灌种子 · 若线上 v8_runtime_tiers 已有
--   (prebuilt_url 为空 / source_type 为空) 的旧行 · 种子不会覆盖 ·
--   导致 /api/v8/runtime/manifest 不下发 prebuilt_venv → 客户端只能走公共源 pip。
--   线上实测 (2026-05-30): install_mode=public_mirror_venv · 所有 tier prebuilt_venv=no。
--
-- 本迁移:
--   把"自家镜像确实已构建 tarball"的平台 (macos-arm64 + linux-x86_64) 的 5 个 tier
--   回填 prebuilt_url / prebuilt_sha256 / prebuilt_size_mb / source_type=self_mirror。
--   → manifest 开始下发 prebuilt_venv → 客户端走 tarball 快路 (失败自动降级公共源 pip)。
--
-- 不动的平台 (仍走公共源 pip · 安全):
--   macos-x86_64 (Intel) / windows-x86_64 — 镜像上 venv tarball 仍 404 (sha=TBD)。
--   等 prebake-venv.sh 产出并上传后 · 再补一条 v8_026 激活。
--
-- sha256 来源: 已对 macos-arm64 lite/crawl 实际下载校验通过 (2026-05-30) ·
--              linux 五个 tarball HTTP 200 存在 · 值取自 v8_024 构建批次。
--
-- 幂等: 全部 UPDATE ... WHERE 主键命中 · 可重复执行。
-- 回滚: v8_025_activate_self_mirror_venv_rollback.sql

BEGIN;

-- ─────────────────────────── macOS arm64 ───────────────────────────
UPDATE v8_runtime_tiers SET
    source_type='self_mirror', prebuilt_version='2026.05.30',
    prebuilt_url='https://qianshousuanli.com/by/v1/macos-arm64/lite.tar.gz',
    prebuilt_sha256='43b8dd9246840adb1ca6eb12d98528e77abbb3123c315052a2ed6fdc79f35b9e',
    prebuilt_size_mb=97, updated_at=NOW()
WHERE tier_name='lite' AND platform='macos-arm64';

UPDATE v8_runtime_tiers SET
    source_type='self_mirror', prebuilt_version='2026.05.30',
    prebuilt_url='https://qianshousuanli.com/by/v1/macos-arm64/crawl.tar.gz',
    prebuilt_sha256='c088d09d7a5cf3c1cf9b99dea11cdf49aad11fc826aafd3d29ca002b4b5bef81',
    prebuilt_size_mb=20, updated_at=NOW()
WHERE tier_name='crawl' AND platform='macos-arm64';

UPDATE v8_runtime_tiers SET
    source_type='self_mirror', prebuilt_version='2026.05.30',
    prebuilt_url='https://qianshousuanli.com/by/v1/macos-arm64/ffmpeg.tar.gz',
    prebuilt_sha256='4182fe1afb4f7f9b744bd9e426180fcdef58b8b638a4a80c5998459b14b19455',
    prebuilt_size_mb=27, updated_at=NOW()
WHERE tier_name='ffmpeg' AND platform='macos-arm64';

UPDATE v8_runtime_tiers SET
    source_type='self_mirror', prebuilt_version='2026.05.30',
    prebuilt_url='https://qianshousuanli.com/by/v1/macos-arm64/ocr.tar.gz',
    prebuilt_sha256='78692f8e620f3c0a1e48bd9d7d0eb3dcf1f2787af816c6dc2dc2395c7962835d',
    prebuilt_size_mb=229, updated_at=NOW()
WHERE tier_name='ocr' AND platform='macos-arm64';

UPDATE v8_runtime_tiers SET
    source_type='self_mirror', prebuilt_version='2026.05.30',
    prebuilt_url='https://qianshousuanli.com/by/v1/macos-arm64/speech.tar.gz',
    prebuilt_sha256='e8e21b0cc8feac6cc2a0bc99c60701673cec6e95756f43fbc430eaa5e02cfde4',
    prebuilt_size_mb=60, updated_at=NOW()
WHERE tier_name='speech' AND platform='macos-arm64';

-- ─────────────────────────── Linux x86_64 ──────────────────────────
UPDATE v8_runtime_tiers SET
    source_type='self_mirror', prebuilt_version='2026.05.30',
    prebuilt_url='https://qianshousuanli.com/by/v1/linux-x86_64/lite.tar.gz',
    prebuilt_sha256='3134924550466d82ac9b268241fcc68f8f8e249f5447d14cd5140dc73ba8ecde',
    prebuilt_size_mb=88, updated_at=NOW()
WHERE tier_name='lite' AND platform='linux-x86_64';

UPDATE v8_runtime_tiers SET
    source_type='self_mirror', prebuilt_version='2026.05.30',
    prebuilt_url='https://qianshousuanli.com/by/v1/linux-x86_64/crawl.tar.gz',
    prebuilt_sha256='dbcd1bde6150af770c307b6193626de8e9bb15cdd46b0214cad34ec2e0634a25',
    prebuilt_size_mb=17, updated_at=NOW()
WHERE tier_name='crawl' AND platform='linux-x86_64';

UPDATE v8_runtime_tiers SET
    source_type='self_mirror', prebuilt_version='2026.05.30',
    prebuilt_url='https://qianshousuanli.com/by/v1/linux-x86_64/ffmpeg.tar.gz',
    prebuilt_sha256='718e98b673ae44c1adb5367822550b986a5ad92b1a6634c92e78c0ed240bc853',
    prebuilt_size_mb=36, updated_at=NOW()
WHERE tier_name='ffmpeg' AND platform='linux-x86_64';

UPDATE v8_runtime_tiers SET
    source_type='self_mirror', prebuilt_version='2026.05.30',
    prebuilt_url='https://qianshousuanli.com/by/v1/linux-x86_64/ocr.tar.gz',
    prebuilt_sha256='d6e994eb7919ad1e85c8353f2c6b0d9ace0a8e373c9bfb470603e72c10d260e0',
    prebuilt_size_mb=338, updated_at=NOW()
WHERE tier_name='ocr' AND platform='linux-x86_64';

UPDATE v8_runtime_tiers SET
    source_type='self_mirror', prebuilt_version='2026.05.30',
    prebuilt_url='https://qianshousuanli.com/by/v1/linux-x86_64/speech.tar.gz',
    prebuilt_sha256='65f259f0badaaeb2c0ec1a9ac060b1c274817ba4deb2a8a28482c87b45b35360',
    prebuilt_size_mb=126, updated_at=NOW()
WHERE tier_name='speech' AND platform='linux-x86_64';

COMMIT;

-- 验证 (执行后手动跑 · 应看到 10 行 source_type=self_mirror 且 sha 非空非 TBD):
--   SELECT tier_name, platform, source_type, prebuilt_size_mb,
--          left(prebuilt_sha256,12) AS sha
--   FROM v8_runtime_tiers
--   WHERE platform IN ('macos-arm64','linux-x86_64') AND prebuilt_url <> ''
--   ORDER BY platform, display_order;
