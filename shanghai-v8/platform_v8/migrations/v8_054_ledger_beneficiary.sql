-- v8_054 · QS-19 · we_ledger 加可空 beneficiary.basis / worker_id
-- 契约: contracts/v1/ledger.schema.json beneficiary.{basis,worker_id}
--        basis 枚举与 result.billing.basis 逐字相同。
-- 加法：20989 行旧账保持 NULL（缺 = 执行者/凭据未知，不回填、不猜）。
-- 不变量：idempotent_key 的 UNIQUE 约束与列定义一字不动；本文件不改任何索引名
--         we_ledger_idempotent_key_key。
-- 回滚：停写这两列（代码回滚）；列和约束可留——DROP COLUMN 会改表形，本单不做。

BEGIN;

ALTER TABLE we_ledger ADD COLUMN IF NOT EXISTS basis VARCHAR(32);
ALTER TABLE we_ledger ADD COLUMN IF NOT EXISTS worker_id VARCHAR(64);

ALTER TABLE we_ledger DROP CONSTRAINT IF EXISTS we_ledger_basis_chk;
ALTER TABLE we_ledger ADD CONSTRAINT we_ledger_basis_chk
    CHECK (basis IS NULL OR basis IN (
        'node_compute',
        'platform_llm_forward',
        'platform_relay',
        'none'
    ));

CREATE INDEX IF NOT EXISTS we_ledger_worker_id_idx
    ON we_ledger (worker_id)
    WHERE worker_id IS NOT NULL;

COMMIT;
