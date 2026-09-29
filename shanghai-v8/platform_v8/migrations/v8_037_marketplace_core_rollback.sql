-- Rollback for v8_037_marketplace_core.sql
-- 注意：仅用于全新/可丢数据环境；生产有 we_apps 数据时禁止执行。

DROP TABLE IF EXISTS we_lending_earnings;
DROP TABLE IF EXISTS we_lending_nodes;
DROP TABLE IF EXISTS we_installs;
DROP TABLE IF EXISTS we_reviews;
DROP TABLE IF EXISTS we_app_versions;
DROP TABLE IF EXISTS we_apps;
