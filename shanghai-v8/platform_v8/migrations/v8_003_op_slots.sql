-- ════════════════════════════════════════════════════════════════════════════
-- Platform v8 · 运营位 (Op Slot) Schema
--
-- 版本: v8.3.0
-- 功能: 通用运营位系统 · 一套 schema 支撑所有运营展示位
--   - we_op_slots: 运营位主表 (开屏广告 / 首页 banner / 通知公告 / 富文本 / 短视频)
--
-- 使用方法:
--   psql -U admin -d edge_compute -f platform_v8/migrations/v8_003_op_slots.sql
--
-- 设计要点:
--   1. slot_key 决定展示位置 (splash/banner/notice/...) · 客户端按 key 拉取
--   2. 4 种内容载体共表存储 · image_url / video_url / rich_html / 文字标题
--   3. priority 高的先显示 · 同 key 多条按优先级排序
--   4. start_at / end_at 控制生效时段 · NULL 表示无限制
--   5. target_audience JSONB 受众过滤 (min_version / os / role / ...)
--   6. cooldown_hours + show_once 给 splash 类频次控制 (前端处理)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS we_op_slots (
    id              BIGSERIAL PRIMARY KEY,
    slot_key        TEXT        NOT NULL,                        -- 'splash' / 'banner' / 'notice' / 'activity' / ...
    title           TEXT        NOT NULL DEFAULT '',             -- 显示标题 / 公告内容
    subtitle        TEXT        NOT NULL DEFAULT '',             -- 副标题 / 简介
    -- ── 内容载体 (任选其一) ──
    image_url       TEXT        DEFAULT NULL,                    -- 图片 URL (主流形态)
    video_url       TEXT        DEFAULT NULL,                    -- 短视频 URL (mp4)
    rich_html       TEXT        DEFAULT NULL,                    -- 富文本 HTML / markdown
    -- ── 跳转动作 ──
    action_type     TEXT        NOT NULL DEFAULT 'none',         -- 'none'/'external'/'internal'/'download'/'qr'
    action_target   TEXT        DEFAULT NULL,                    -- URL / 内部路由 / 下载链接 / 二维码内容
    action_label    TEXT        DEFAULT NULL,                    -- 按钮文案 (e.g. '立即查看')
    -- ── 投放规则 ──
    priority        INTEGER     NOT NULL DEFAULT 0,              -- 高的先显示
    start_at        TIMESTAMPTZ DEFAULT NULL,                    -- NULL = 立即生效
    end_at          TIMESTAMPTZ DEFAULT NULL,                    -- NULL = 永不过期
    -- ── 频次控制 (splash 类用 · 前端实现) ──
    cooldown_hours  INTEGER     NOT NULL DEFAULT 0,              -- 0 = 每次启动都弹
    show_once       BOOLEAN     NOT NULL DEFAULT FALSE,          -- TRUE = 用户看过永不再弹
    closable        BOOLEAN     NOT NULL DEFAULT TRUE,           -- 用户能否手动关闭
    -- ── 受众 (可选 · 空表示全部用户) ──
    target_audience JSONB       NOT NULL DEFAULT '{}'::jsonb,    -- {min_version,max_version,os,role,user_ids,...}
    -- ── 状态 ──
    is_active       BOOLEAN     NOT NULL DEFAULT TRUE,           -- 开关 · 关掉立即下线
    -- ── 审计 ──
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_by      BIGINT      REFERENCES we_accounts(id) ON DELETE SET NULL,

    CONSTRAINT we_op_slots_action_chk
        CHECK (action_type IN ('none','external','internal','download','qr'))
);

-- ── 索引 ──
-- 客户端高频查 (slot_key + is_active + 时间窗) · 覆盖 90% 查询
CREATE INDEX IF NOT EXISTS we_op_slots_key_active_idx
    ON we_op_slots (slot_key, is_active, priority DESC)
    WHERE is_active = TRUE;

CREATE INDEX IF NOT EXISTS we_op_slots_window_idx
    ON we_op_slots (start_at, end_at)
    WHERE is_active = TRUE;

-- ── 自动更新 updated_at 触发器 ──
CREATE OR REPLACE FUNCTION we_op_slots_set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS we_op_slots_updated_at_trg ON we_op_slots;
CREATE TRIGGER we_op_slots_updated_at_trg
    BEFORE UPDATE ON we_op_slots
    FOR EACH ROW EXECUTE FUNCTION we_op_slots_set_updated_at();

-- ── 种子数据 (示例 · 上线后由运营自行替换 · 注释掉默认不插) ──
-- INSERT INTO we_op_slots (slot_key, title, image_url, action_type, action_target, priority)
-- VALUES
--   ('splash', '欢迎来到千手节点', 'https://oss.example.com/splash/welcome.png',
--    'internal', '/dashboard/capabilities', 100),
--   ('notice', '今晚 23:00 系统维护 30 分钟', NULL, 'none', NULL, 50);

COMMENT ON TABLE we_op_slots IS '运营位主表 · 通用 slot 系统 · 支撑开屏/banner/公告/富文本/视频';
COMMENT ON COLUMN we_op_slots.slot_key IS '运营位 key · 客户端按 key 拉对应内容 · 常见 splash/banner/notice/activity';
COMMENT ON COLUMN we_op_slots.action_type IS '跳转动作类型 · none=不跳转 / external=外链 / internal=内部路由 / download=下载 / qr=显示二维码';
COMMENT ON COLUMN we_op_slots.target_audience IS 'JSONB 受众过滤 · {min_version:"8.0.0", os:["macos","windows"], role:["personal"]}';
