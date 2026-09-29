-- rollback v8_045
DROP INDEX IF EXISTS we_lending_earnings_node_task_uq;
DROP TABLE IF EXISTS we_app_sessions;
