-- v8_014 rollback · 删 we_business_invoices (W7-phase2 · 2026-05-26)
DROP INDEX IF EXISTS idx_invoices_status;
DROP INDEX IF EXISTS idx_invoices_account_period;
DROP TABLE IF EXISTS we_business_invoices;
