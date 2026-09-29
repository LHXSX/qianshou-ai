-- v8_027 · 2026-06-05 · 后端主导自愈 · control 下发/回报审计表
--
-- 记录决策器下发的 control 指令 + 节点回报的执行结果。
-- 用途: ① admin 观测节点自愈历史 ② decider 去重/决策参考
-- 幂等: control_id UNIQUE · 下发时插入(ok=NULL) · 回报时 UPSERT 更新 ok/detail

CREATE TABLE IF NOT EXISTS we_node_repairs (
    id          BIGSERIAL    PRIMARY KEY,
    worker_id   UUID         NOT NULL,
    control_id  TEXT         NOT NULL UNIQUE,        -- 幂等键 · 关联下发与回报
    action      TEXT         NOT NULL,              -- 白名单: reinstall_tier/fix_venv_cfg/...
    ok          BOOLEAN,                            -- NULL=已下发未回报 · TRUE/FALSE=执行结果
    detail      TEXT         NOT NULL DEFAULT '',   -- 下发原因 / 执行消息 / 失败原因
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS we_node_repairs_worker_idx
    ON we_node_repairs (worker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS we_node_repairs_action_idx
    ON we_node_repairs (action, created_at DESC);

COMMENT ON TABLE we_node_repairs IS '后端自愈 control 下发/回报审计 · decider 去重 + admin 观测';
