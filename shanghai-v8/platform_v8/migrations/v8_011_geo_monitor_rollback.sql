-- v8_011_geo_monitor_rollback.sql · 回滚
-- 用途: GEO 监测出问题 · 干净拔掉
-- 注意: 不会删 we_workloads / we_shards (因为它们是统一引擎)
-- 只删 GEO 专属辅助表

BEGIN;

-- 删观察数据 (大表 · 先 truncate 再 drop · 释放空间快)
TRUNCATE TABLE we_geo_observations CASCADE;
DROP TABLE IF EXISTS we_geo_observations;

DROP TABLE IF EXISTS we_geo_brands;
DROP TABLE IF EXISTS we_geo_llm_configs;

COMMIT;

-- 提示: 跑完 rollback 后:
--   1. 重启 backend (重新加载 import)
--   2. 删 task_registry 里 geo_query 注册 (services/geo/registry.py 的 install 不调即可)
--   3. 已存在的 GEO workload 还在 we_workloads · 不影响 (但状态会卡住 · 需手动 cancel)
