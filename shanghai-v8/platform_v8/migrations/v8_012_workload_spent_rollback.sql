-- v8_012 rollback
DROP INDEX IF EXISTS idx_workloads_spent;
ALTER TABLE we_workloads DROP COLUMN IF EXISTS spent;
