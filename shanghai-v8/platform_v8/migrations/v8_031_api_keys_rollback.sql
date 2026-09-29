-- v8_031_api_keys_rollback.sql
BEGIN;
DROP TABLE IF EXISTS we_api_keys CASCADE;
COMMIT;
