"""
B2B 客户业务管理 (W7 · 2026-05-26)

模块:
  - contracts.py: 合约 CRUD + 状态机 + 配额查询
  - (future) billing.py: 月度账单生成 (从 we_ledger 聚合)
  - (future) sla.py: SLA 可用性计算

用户原话:
  "ip池 的作用是承包给其他大厂 吊用我们的 这个也要知道"
  = 我们做基础设施 · 批发给 B2B 大客户 (GEO 服务商 / 爬虫 SaaS / AI 数据公司)
  不做散户 B2C
"""
