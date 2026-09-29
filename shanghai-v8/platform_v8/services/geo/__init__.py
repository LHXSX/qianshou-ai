"""GEO 监测 · 平台自营业务 (2026-05-26 W2 · 用统一引擎)

商业模式:
  - 客户: GEO 服务商 / 品牌方 (监测自己品牌在主流 LLM 里的曝光)
  - 收费: 按"监测查询数 × 单价" · 走 ledger 标准协议
  - 节点: 跑 LLM API 调用 (用节点 IP 池反封号) · 拿 70% (跟算力一样)
  - 平台: 抽 30% + 转售给 IP 池大客户

技术架构 (统一引擎):
  - 监测订单 = 1 个 workload (task_type=geo_query · mode=PULL)
  - 一次具体查询 = 1 个 shard (一个 brand × keyword × llm)
  - 节点 PullRequest 抢 shard · 跑 LLM API · 返响应
  - aggregator hook · 跑 NLP 分析 · 写 we_geo_observations
  - workload DONE · ledger reward (70/30/0 协议)

辅助表 (跟 we_workloads/we_shards 平行):
  - we_geo_llm_configs · 6 LLM 端点配置 (admin 维护)
  - we_geo_brands · 客户品牌库
  - we_geo_observations · NLP 分析后的观察数据 (时序大表 · 客户报表数据源)

模块入口:
  - install() · 启动时调一次 · 注册 task_type=geo_query + aggregator hook
"""
from .registry import install, uninstall  # noqa: F401

__all__ = ["install", "uninstall"]
