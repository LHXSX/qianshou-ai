#!/usr/bin/env python3
"""
app_register.py — APP 拉新注册脚本
适配千手引擎 run_script 协议

参数：
  app_url: str        — APP 下载链接
  phone_prefix: str   — 手机号前缀（如 138）
  task_list: [str]    — 需要完成的任务列表（如 ["register","bind","first_order"]）

输出：
  { phone, tasks_completed, status }
"""
import json

print(json.dumps({
    "status": "failed",
    "task_type": "app_register",
    "contract_version": "1",
    "failure_class": "feature_unavailable",
    "error": "app_register 未接入合法的授权注册服务，禁止生成虚假注册结果",
    "summary_text": "功能未接入生产供应商",
}, ensure_ascii=False))
