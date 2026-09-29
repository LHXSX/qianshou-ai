DROP TABLE IF EXISTS we_order_adapter_device_installs;
DROP INDEX IF EXISTS we_order_adapter_entitlements_expiring_idx;
-- Preserve any changed entitlements and their ledger rather than rewriting
-- purchases or discarding refund history. Manual rollback is required.
