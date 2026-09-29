-- v8_048 rollback · remove assignment delivery evidence

BEGIN;

DROP TABLE IF EXISTS we_assignment_deliveries;

COMMIT;
