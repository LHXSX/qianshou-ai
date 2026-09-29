-- v8_044 · P0-5 体验包 once_per_account 并发防刷
-- Postgres 部分索引谓词不能含子查询，故按 pack_id 动态建唯一索引。

DO $$
DECLARE
    r RECORD;
BEGIN
    FOR r IN
        SELECT id
          FROM we_api_packs
         WHERE once_per_account IS TRUE
    LOOP
        EXECUTE format(
            'CREATE UNIQUE INDEX IF NOT EXISTS we_api_pack_orders_once_acct_uq_%s
               ON we_api_pack_orders (account_id)
             WHERE pack_id = %s',
            r.id,
            r.id
        );
    END LOOP;
END $$;
