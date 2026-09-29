-- v8_028 · 2026-06-06 · 任务级技能包 (skill-pack · fork 定制 runner)
--
-- 补全客户端 skill_pack.rs 已就绪的链路:
--   任务帧带 skill_pack_id → 节点 GET /api/v8/skill-packs/{id} → 拉 runner_code + sha256 校验 → 跑定制 runner
-- 用途: B 端针对某次任务 fork 官方 skill 的 runner 做定制 · 不改全局 skill
-- 安全: runner_code 由 admin 创建 · code_sha256 防中间人篡改(客户端校验)

CREATE TABLE IF NOT EXISTS we_skill_packs (
    pack_id      TEXT         PRIMARY KEY,           -- 唯一标识(uuid/自定义)
    forked_from  TEXT         NOT NULL DEFAULT '',   -- 源 skill/tool id
    name         TEXT         NOT NULL DEFAULT '',
    description  TEXT         NOT NULL DEFAULT '',
    runner_code  TEXT         NOT NULL,              -- 定制 runner.py 全文
    code_sha256  TEXT         NOT NULL,              -- sha256(runner_code) · 客户端校验完整性
    revision     INTEGER      NOT NULL DEFAULT 1,
    expires_at   DOUBLE PRECISION NOT NULL DEFAULT 0,  -- epoch 秒 · 0=不过期 · 客户端缓存失效用
    enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_by   TEXT         NOT NULL DEFAULT '',
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE we_skill_packs IS '任务级 fork 定制 runner · 客户端 skill_pack.rs 拉取 · admin 创建';
