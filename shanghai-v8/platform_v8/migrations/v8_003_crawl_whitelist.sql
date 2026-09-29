-- ════════════════════════════════════════════════════════════════════════════
-- v8_003_crawl_whitelist.sql
-- 2026-05-24 · crawl 任务 URL 白名单管控
--
-- 设计:
--   - 仅在白名单内的 domain + path_pattern 允许被节点抓取
--   - submit_workload 时 services/crawl/whitelist.py 校验
--   - 节点脚本 (crawl_url_fetch.py) 内部还有 hardcode 白名单兜底 · 双层防御
--   - admin 通过 /api/v8/admin/crawl/whitelist CRUD 维护
--
-- 列说明:
--   domain       · 主机名 (精确匹配 · 不支持通配符 · 子域单条加)
--                  特殊: domain='*' 是禁用值 · 任何 URL 都过不了
--   path_pattern · 路径 glob 模式 (/* 表示该域全允许 · /wiki/* 表示限定路径)
--   added_by     · admin account_id (溯源)
--   status       · active / disabled (软删除 · 不真物理删 · 保留审计链)
--   max_qps      · 每节点每秒最多请求数 (节点端 rate_limit 用 · 0=平台默认 1)
--   notes        · admin 备注 · 例: "学术资源 · 已与发布方沟通"
--   approval_ref · 法务/合规审批单 ID (可选)
-- ════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS we_crawl_url_whitelist (
    id              BIGSERIAL    PRIMARY KEY,
    domain          VARCHAR(255) NOT NULL,
    path_pattern    VARCHAR(500) NOT NULL DEFAULT '/*',
    status          VARCHAR(20)  NOT NULL DEFAULT 'active',  -- active | disabled
    max_qps         INTEGER      NOT NULL DEFAULT 1,
    added_by        BIGINT       REFERENCES we_accounts(id) ON DELETE SET NULL,
    added_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    disabled_at     TIMESTAMPTZ,
    notes           TEXT,
    approval_ref    VARCHAR(120),
    CONSTRAINT we_crawl_url_whitelist_uk UNIQUE (domain, path_pattern)
);

CREATE INDEX IF NOT EXISTS we_crawl_url_whitelist_domain_idx
    ON we_crawl_url_whitelist(domain) WHERE status = 'active';

CREATE INDEX IF NOT EXISTS we_crawl_url_whitelist_status_idx
    ON we_crawl_url_whitelist(status);

-- ════════════════════════════════════════════════════════════════════════════
-- 初始种子数据 · 与节点端硬编码白名单对齐 (crawl_url_fetch.py)
-- 仅公开学术/百科/官方数据/开源站
-- ════════════════════════════════════════════════════════════════════════════
INSERT INTO we_crawl_url_whitelist (domain, path_pattern, status, max_qps, notes) VALUES
    ('en.wikipedia.org',         '/wiki/*',  'active', 2, '英文维基 · 公开百科'),
    ('zh.wikipedia.org',         '/wiki/*',  'active', 2, '中文维基 · 公开百科'),
    ('arxiv.org',                '/abs/*',   'active', 1, 'arXiv 论文摘要页'),
    ('arxiv.org',                '/pdf/*',   'active', 1, 'arXiv 论文 PDF'),
    ('github.com',               '/*',       'active', 2, 'GitHub 公开仓库页'),
    ('raw.githubusercontent.com','/*',       'active', 2, 'GitHub raw 文件'),
    ('wikidata.org',             '/*',       'active', 1, 'Wikidata 公开数据'),
    ('openalex.org',             '/*',       'active', 1, 'OpenAlex 学术索引'),
    ('doi.org',                  '/*',       'active', 1, 'DOI 解析器'),
    ('ncbi.nlm.nih.gov',         '/*',       'active', 1, 'NCBI 生物医学'),
    ('pubmed.ncbi.nlm.nih.gov',  '/*',       'active', 1, 'PubMed 论文索引'),
    ('nature.com',               '/*',       'active', 1, 'Nature 摘要页'),
    ('science.org',              '/*',       'active', 1, 'Science 摘要页')
ON CONFLICT (domain, path_pattern) DO NOTHING;

COMMENT ON TABLE we_crawl_url_whitelist IS '2026-05-24 · crawl 任务 URL 白名单 · 双层防御 (后端 submit + 节点脚本)';
