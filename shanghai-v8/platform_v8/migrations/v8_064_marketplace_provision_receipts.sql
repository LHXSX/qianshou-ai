-- v8_064 · 市场远程安装/卸载设备回执。
-- 本地未发布候选曾误占 v8_059；现网 v8_059 属于支付幂等迁移。
-- 账户 we_installs 仅表示购买/使用权，
-- 设备实际状态必须由匹配 control_id 的节点 control_result 确认。
CREATE TABLE IF NOT EXISTS we_app_provisions (
    control_id VARCHAR(32) PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES we_accounts(id) ON DELETE CASCADE,
    worker_id UUID NOT NULL,
    slug VARCHAR(100) NOT NULL,
    version VARCHAR(20),
    action VARCHAR(20) NOT NULL CHECK (action IN ('install_app', 'uninstall_app')),
    status VARCHAR(24) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'delivered', 'delivery_failed', 'installed', 'removed', 'failed')),
    delivered BOOLEAN,
    result_ok BOOLEAN,
    detail TEXT NOT NULL DEFAULT '',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS we_app_provisions_user_created_idx
    ON we_app_provisions (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS we_app_provisions_worker_created_idx
    ON we_app_provisions (worker_id, created_at DESC);

COMMENT ON TABLE we_app_provisions IS 'Marketplace control dispatch and node install result; delivered is not installed';
