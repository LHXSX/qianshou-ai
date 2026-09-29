-- ════════════════════════════════════════════════════════════════════════════
-- Platform v8 · 初始 Schema · 7 张 we_* 表
--
-- 版本: v8.0.0
-- 替代: sv_users / sv_v2_jobs / sv_v2_subtasks / sv_nodes /
--       sv_escrow / sv_transactions / sv_settlements / sv_node_reward /
--       sv_audit_log / sv_node_events / sv_kv / ... (19 张 → 7 张)
--
-- 使用方法 (生产环境 · 没数据要保留):
--   psql -U admin -d edge_compute -f platform_v8/migrations/v8_001_initial.sql
--
-- ⚠️ 此脚本会 DROP 所有 sv_* 表 · 没数据迁移
-- ════════════════════════════════════════════════════════════════════════════

BEGIN;

-- ── 0. 清理 v1/v2/v3 老表 ────────────────────────────────────────────────
DROP TABLE IF EXISTS sv_users           CASCADE;
DROP TABLE IF EXISTS sv_tasks           CASCADE;
DROP TABLE IF EXISTS sv_subtasks        CASCADE;
DROP TABLE IF EXISTS sv_task_jobs       CASCADE;
DROP TABLE IF EXISTS sv_v2_jobs         CASCADE;
DROP TABLE IF EXISTS sv_v2_subtasks     CASCADE;
DROP TABLE IF EXISTS sv_v3_pending_tasks CASCADE;
DROP TABLE IF EXISTS sv_nodes           CASCADE;
DROP TABLE IF EXISTS sv_agent_node_map  CASCADE;
DROP TABLE IF EXISTS sv_node_events     CASCADE;
DROP TABLE IF EXISTS sv_node_reward     CASCADE;
DROP TABLE IF EXISTS sv_escrow          CASCADE;
DROP TABLE IF EXISTS sv_transactions    CASCADE;
DROP TABLE IF EXISTS sv_settlements     CASCADE;
DROP TABLE IF EXISTS sv_audit_log       CASCADE;
DROP TABLE IF EXISTS sv_ai_audit        CASCADE;
DROP TABLE IF EXISTS sv_ai_scripts      CASCADE;
DROP TABLE IF EXISTS sv_kv              CASCADE;
DROP TABLE IF EXISTS sv_task_progress   CASCADE;

-- ════════════════════════════════════════════════════════════════════════════
-- 1. we_accounts · 用户账号
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE we_accounts (
    id              BIGSERIAL PRIMARY KEY,
    username        VARCHAR(64)  NOT NULL UNIQUE,
    email           VARCHAR(255) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    role            VARCHAR(20)  NOT NULL DEFAULT 'personal',
    status          VARCHAR(20)  NOT NULL DEFAULT 'active',
    balance         NUMERIC(18,4) NOT NULL DEFAULT 0,
    profile         JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    last_login_at   TIMESTAMPTZ,
    CONSTRAINT we_accounts_role_chk
        CHECK (role IN ('personal','enterprise','channel','admin')),
    CONSTRAINT we_accounts_status_chk
        CHECK (status IN ('active','suspended','deleted'))
);
CREATE INDEX we_accounts_email_idx       ON we_accounts (LOWER(email));
CREATE INDEX we_accounts_role_status_idx ON we_accounts (role, status);

-- ════════════════════════════════════════════════════════════════════════════
-- 2. we_workers · 工作节点
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE we_workers (
    id                 UUID PRIMARY KEY,
    owner_id           BIGINT       NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    name               VARCHAR(120) NOT NULL,
    status             VARCHAR(20)  NOT NULL DEFAULT 'OFFLINE',
    capabilities       JSONB        NOT NULL DEFAULT '{}'::jsonb,
    load               REAL         NOT NULL DEFAULT 0.0,
    active_shards      INTEGER      NOT NULL DEFAULT 0,
    reputation         REAL         NOT NULL DEFAULT 0.5,
    capability_score   REAL         NOT NULL DEFAULT 0.0,
    last_seen          TIMESTAMPTZ,
    registered_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    client_version     VARCHAR(40)  NOT NULL DEFAULT '',
    CONSTRAINT we_workers_status_chk
        CHECK (status IN ('ONLINE','BUSY','OFFLINE','MAINTENANCE'))
);
CREATE INDEX we_workers_owner_idx    ON we_workers (owner_id);
CREATE INDEX we_workers_online_idx   ON we_workers (status, last_seen) WHERE status IN ('ONLINE','BUSY');

-- ════════════════════════════════════════════════════════════════════════════
-- 3. we_workloads · 任务主表
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE we_workloads (
    id                 UUID PRIMARY KEY,
    owner_id           BIGINT       NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    name               VARCHAR(255) NOT NULL,
    spec               JSONB        NOT NULL,
    status             VARCHAR(30)  NOT NULL DEFAULT 'CREATED',
    progress           REAL         NOT NULL DEFAULT 0.0,
    total_shards       INTEGER      NOT NULL DEFAULT 0,
    completed_shards   INTEGER      NOT NULL DEFAULT 0,
    failed_shards      INTEGER      NOT NULL DEFAULT 0,
    result             JSONB,
    budget             NUMERIC(18,4) NOT NULL DEFAULT 0,
    error              TEXT         NOT NULL DEFAULT '',
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    started_at         TIMESTAMPTZ,
    completed_at       TIMESTAMPTZ,
    CONSTRAINT we_workloads_status_chk
        CHECK (status IN ('CREATED','PLANNED','RUNNING','AGGREGATING','DONE','FAILED','CANCELLED','WAITING_FOR_WORKERS'))
);
CREATE INDEX we_workloads_owner_status_idx ON we_workloads (owner_id, status);
CREATE INDEX we_workloads_created_idx      ON we_workloads (created_at DESC);
CREATE INDEX we_workloads_waiting_idx      ON we_workloads (status) WHERE status = 'WAITING_FOR_WORKERS';

-- ════════════════════════════════════════════════════════════════════════════
-- 4. we_shards · 分片
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE we_shards (
    id                       UUID PRIMARY KEY,
    workload_id              UUID         NOT NULL REFERENCES we_workloads(id) ON DELETE CASCADE,
    index                    INTEGER      NOT NULL DEFAULT 0,
    total                    INTEGER      NOT NULL DEFAULT 1,
    status                   VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    worker_id                UUID REFERENCES we_workers(id) ON DELETE SET NULL,
    input_ref                TEXT         NOT NULL DEFAULT '',
    output_ref               TEXT,
    attempts                 INTEGER      NOT NULL DEFAULT 0,
    max_attempts             INTEGER      NOT NULL DEFAULT 3,
    score                    REAL         NOT NULL DEFAULT 0.0,
    predicted_latency_ms     REAL,
    predicted_cost           REAL,
    error                    TEXT         NOT NULL DEFAULT '',
    dispatched_at            TIMESTAMPTZ,
    started_at               TIMESTAMPTZ,
    completed_at             TIMESTAMPTZ,
    elapsed_ms               INTEGER,
    metadata                 JSONB        NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT we_shards_status_chk
        CHECK (status IN ('PENDING','DISPATCHED','RUNNING','DONE','FAILED','CANCELLED')),
    CONSTRAINT we_shards_workload_index_uq
        UNIQUE (workload_id, index)
);
CREATE INDEX we_shards_workload_idx     ON we_shards (workload_id);
CREATE INDEX we_shards_worker_status_idx ON we_shards (worker_id, status);
CREATE INDEX we_shards_pending_idx       ON we_shards (status) WHERE status = 'PENDING';

-- ════════════════════════════════════════════════════════════════════════════
-- 5. we_ledger · 账本 (append-only)
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE we_ledger (
    id                 UUID PRIMARY KEY,
    account_id         BIGINT       NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    type               VARCHAR(40)  NOT NULL,
    amount             NUMERIC(18,4) NOT NULL,
    currency           VARCHAR(10)  NOT NULL DEFAULT 'CNY',
    workload_id        UUID REFERENCES we_workloads(id) ON DELETE SET NULL,
    shard_id           UUID REFERENCES we_shards(id) ON DELETE SET NULL,
    idempotent_key     VARCHAR(128) NOT NULL UNIQUE,
    note               TEXT         NOT NULL DEFAULT '',
    metadata           JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT we_ledger_type_chk
        CHECK (type IN ('ESCROW_HOLD','ESCROW_RELEASE','REWARD','REFUND',
                        'WITHDRAW','DEPOSIT','PLATFORM_FEE','RISK_POOL'))
);
CREATE INDEX we_ledger_account_time_idx ON we_ledger (account_id, created_at DESC);
CREATE INDEX we_ledger_workload_idx     ON we_ledger (workload_id) WHERE workload_id IS NOT NULL;
CREATE INDEX we_ledger_type_time_idx    ON we_ledger (type, created_at DESC);

-- ════════════════════════════════════════════════════════════════════════════
-- 6. we_audit · 审计日志
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE we_audit (
    id                 UUID PRIMARY KEY,
    actor_account_id   BIGINT REFERENCES we_accounts(id) ON DELETE SET NULL,
    actor_kind         VARCHAR(20)  NOT NULL DEFAULT 'user',  -- 'user' / 'worker' / 'system'
    action             VARCHAR(60)  NOT NULL,
    target_kind        VARCHAR(20),                            -- 'workload' / 'worker' / 'account'
    target_id          TEXT,
    trace_id           VARCHAR(36),
    ip                 INET,
    user_agent         TEXT,
    detail             JSONB        NOT NULL DEFAULT '{}'::jsonb,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT we_audit_actor_kind_chk
        CHECK (actor_kind IN ('user','worker','system','admin'))
);
CREATE INDEX we_audit_actor_time_idx   ON we_audit (actor_account_id, created_at DESC);
CREATE INDEX we_audit_action_time_idx  ON we_audit (action, created_at DESC);
CREATE INDEX we_audit_target_idx       ON we_audit (target_kind, target_id);

-- ════════════════════════════════════════════════════════════════════════════
-- 7. we_kv · 系统配置 / 计数器 / 临时 KV
-- ════════════════════════════════════════════════════════════════════════════
CREATE TABLE we_kv (
    k          VARCHAR(120) PRIMARY KEY,
    v          JSONB        NOT NULL,
    expires_at TIMESTAMPTZ,                       -- NULL = 永久
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX we_kv_expires_idx ON we_kv (expires_at) WHERE expires_at IS NOT NULL;

-- ════════════════════════════════════════════════════════════════════════════
-- 8. 触发器: updated_at 自动更新
-- ════════════════════════════════════════════════════════════════════════════
CREATE OR REPLACE FUNCTION we_touch_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER we_accounts_touch  BEFORE UPDATE ON we_accounts  FOR EACH ROW EXECUTE FUNCTION we_touch_updated_at();
CREATE TRIGGER we_workloads_touch BEFORE UPDATE ON we_workloads FOR EACH ROW EXECUTE FUNCTION we_touch_updated_at();
CREATE TRIGGER we_kv_touch        BEFORE UPDATE ON we_kv        FOR EACH ROW EXECUTE FUNCTION we_touch_updated_at();

-- ════════════════════════════════════════════════════════════════════════════
-- 9. 内置 admin 账号 (env 变量覆盖 · 这是后备)
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO we_accounts (username, email, password_hash, role, status, balance)
VALUES (
    'admin',
    'admin@local',
    -- bcrypt('admin') · 仅初始化用 · 生产用 env 覆盖
    '$2b$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewKvSnQOzNTvCBuq',
    'admin',
    'active',
    0
) ON CONFLICT (username) DO NOTHING;

COMMIT;

-- ════════════════════════════════════════════════════════════════════════════
-- 完成提示
-- ════════════════════════════════════════════════════════════════════════════
\echo '✅ Platform v8 schema 初始化完成'
\echo '   7 张 we_* 表已建好 · 19 张 sv_* 表已 DROP'
\echo '   默认账号: admin / admin (生产请改 env 变量)'
\echo ''
\echo '   下一步: 启动 backend · uvicorn platform_v8.api.app:app'
