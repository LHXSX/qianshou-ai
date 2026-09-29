BEGIN;

ALTER TABLE we_api_keys
    ALTER COLUMN scopes
    SET DEFAULT '[]'::jsonb;

COMMENT ON COLUMN we_api_keys.scopes IS NULL;

COMMIT;
