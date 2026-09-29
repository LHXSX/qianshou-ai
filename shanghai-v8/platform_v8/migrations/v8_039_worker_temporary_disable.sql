BEGIN;

ALTER TABLE we_workers
    ADD COLUMN IF NOT EXISTS disabled_until TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS disabled_by BIGINT REFERENCES we_accounts(id) ON DELETE SET NULL,
    ADD COLUMN IF NOT EXISTS disabled_reason VARCHAR(255);

CREATE INDEX IF NOT EXISTS we_workers_disabled_until_idx
    ON we_workers(disabled_until)
    WHERE disabled_until IS NOT NULL;

COMMENT ON COLUMN we_workers.disabled_until IS
    '临时禁止节点上线的截止时间；为空或已过期则允许注册和心跳';

COMMIT;
