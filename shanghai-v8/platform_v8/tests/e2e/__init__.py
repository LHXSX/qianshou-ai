"""e2e 集成测试 · 用 sqlite in-memory + 真实 service code (绕 HTTP 层)

W6 · 2026-05-26 · 建立 e2e 框架 · 后续每改动自动回归

跑法:
  pytest platform_v8/tests/e2e/ -v          # 全套 e2e
  pytest platform_v8/tests/e2e/ -m e2e -v   # 只跑标 @pytest.mark.e2e 的
  make test:e2e                              # 一键 (含 ci)
"""
