-- v8_054 rollback · QS-19 · 只摘约束与索引。列保留（旧账 NULL、新账若已写也保留）。
-- 代码必须先回到不写这两列的版本，否则 INSERT 仍会带列名（列还在，只是无 CHECK）。

BEGIN;
DROP INDEX IF EXISTS we_ledger_worker_id_idx;
ALTER TABLE we_ledger DROP CONSTRAINT IF EXISTS we_ledger_basis_chk;
DELETE FROM we_schema_migrations WHERE version = 'v8_054_ledger_beneficiary.sql';
COMMIT;
