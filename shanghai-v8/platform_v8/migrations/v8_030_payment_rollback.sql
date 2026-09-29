-- v8_030_payment_rollback.sql
-- 回滚 S3-T1 · 新增的 4 张表

BEGIN;

DROP TABLE IF EXISTS we_tax_invoices CASCADE;
DROP TABLE IF EXISTS we_invoice_titles CASCADE;
DROP TABLE IF EXISTS we_withdraw_requests CASCADE;
DROP TABLE IF EXISTS we_payment_orders CASCADE;

COMMIT;
