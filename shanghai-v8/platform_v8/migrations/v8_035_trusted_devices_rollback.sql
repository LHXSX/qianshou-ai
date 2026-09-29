DROP INDEX IF EXISTS we_auth_sessions_device_idx;

ALTER TABLE we_auth_sessions
    DROP COLUMN IF EXISTS device_id;

DROP TABLE IF EXISTS we_auth_devices;
