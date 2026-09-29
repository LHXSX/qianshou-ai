-- ════════════════════════════════════════════════════════════════════
-- v8_008 · 客户端崩溃上报表 (P0 NCE 配套)
-- 2026-05-26
--
-- 目标:
--   客户端 panic 时落盘 last_panic.json → 下次启动 POST /api/v8/client/crash-report
--   → 入这个表 · admin 可查 SELECT * FROM we_client_crashes ORDER BY received_at DESC LIMIT 50
--
-- 安全:
--   全部 ALTER ADD COLUMN IF NOT EXISTS · 重复跑不破坏
-- ════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS we_client_crashes (
    id              BIGSERIAL PRIMARY KEY,
    ip              VARCHAR(64)  NOT NULL DEFAULT '',
    ua              VARCHAR(256) NOT NULL DEFAULT '',
    client_version  VARCHAR(64)  NOT NULL DEFAULT '',
    os              VARCHAR(32)  NOT NULL DEFAULT '',
    arch            VARCHAR(32)  NOT NULL DEFAULT '',
    location        VARCHAR(512) NOT NULL DEFAULT '',
    payload         TEXT         NOT NULL DEFAULT '',
    captured_at_ms  BIGINT       NOT NULL DEFAULT 0,
    backtrace       TEXT         NOT NULL DEFAULT '',
    received_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- 常用查询索引: admin 按时间倒序查
CREATE INDEX IF NOT EXISTS we_client_crashes_received_at_idx
    ON we_client_crashes (received_at DESC);

-- 按版本聚合 (admin 看哪个版本崩得多)
CREATE INDEX IF NOT EXISTS we_client_crashes_version_idx
    ON we_client_crashes (client_version, received_at DESC);

-- 按 location 聚合 (admin 看哪个文件崩得多)
CREATE INDEX IF NOT EXISTS we_client_crashes_location_idx
    ON we_client_crashes (location);

COMMENT ON TABLE we_client_crashes IS '客户端 panic 崩溃上报 · 2026-05-26 P0 NCE';
COMMENT ON COLUMN we_client_crashes.location IS '源码位置 · src/comm/v8_ws.rs:123';
COMMENT ON COLUMN we_client_crashes.payload IS 'panic message · 最长 4 KiB';
COMMENT ON COLUMN we_client_crashes.captured_at_ms IS '客户端本地时钟 · 上报与发生可能差 N 天 (用户重启慢)';
