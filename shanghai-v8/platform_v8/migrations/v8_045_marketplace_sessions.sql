-- v8_045 · RunSession + 出借收益幂等键
-- 产品层表，引擎零改

CREATE TABLE IF NOT EXISTS we_app_sessions (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    app_id BIGINT NOT NULL REFERENCES we_apps(id) ON DELETE CASCADE,
    user_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    workload_id UUID,
    exec_mode VARCHAR(16) NOT NULL DEFAULT 'local'
        CHECK (exec_mode IN ('local', 'edge', 'deep_link')),
    status VARCHAR(32) NOT NULL DEFAULT 'created'
        CHECK (status IN ('created', 'running', 'done', 'failed', 'canceled', 'settled')),
    input_ref TEXT,
    name VARCHAR(255),
    budget NUMERIC(12, 4) DEFAULT 0,
    app_charged NUMERIC(12, 4) NOT NULL DEFAULT 0,
    edge_charged NUMERIC(12, 4) NOT NULL DEFAULT 0,
    meta JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    settled_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS we_app_sessions_user_idx
    ON we_app_sessions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS we_app_sessions_app_idx
    ON we_app_sessions (app_id, created_at DESC);
CREATE INDEX IF NOT EXISTS we_app_sessions_workload_idx
    ON we_app_sessions (workload_id)
    WHERE workload_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS we_app_sessions_status_idx
    ON we_app_sessions (status, created_at DESC);

-- 同一节点同一 shard/task 只记一笔出借收益（防重复 settle）
CREATE UNIQUE INDEX IF NOT EXISTS we_lending_earnings_node_task_uq
    ON we_lending_earnings (node_id, task_id)
    WHERE task_id IS NOT NULL;
