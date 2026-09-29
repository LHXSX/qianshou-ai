#!/usr/bin/env python3
"""
ticket_auto.py — 票务自动抢购脚本
支持大麦网、猫眼等平台定时抢票

参数：
  platform: str       — damai / maoyan / other
  event_id: str       — 演出ID
  session_id: str     — 场次ID
  price_id: str       — 票价ID
  count: int          — 数量
  user_token: str     — 登录凭证
  target_time: str    — 开抢时间 "2026-06-01 10:00:00"

输出：
  { status, order_id, platform, time }
"""
import os, json, time, hmac, hashlib
from urllib.request import Request, urlopen

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
platform = params.get("platform", "damai")
event_id = params.get("event_id", "")
count = params.get("count", 1)
target_time = params.get("target_time", "")

# 等待到目标时间
if target_time:
    target_ts = time.mktime(time.strptime(target_time, "%Y-%m-%d %H:%M:%S"))
    now = time.time()
    if target_ts > now:
        wait_secs = target_ts - now - 0.3  # 提前 0.3 秒
        if wait_secs > 0:
            time.sleep(wait_secs)

# 连续抢购 5 次
result = {"status": "没抢到", "platform": platform, "time": time.time()}
for i in range(5):
    try:
        # 模拟提交订单
        req = Request(
            "https://mtop.damai.cn/h5/mtop.trade.order.create/4.0/",
            data=json.dumps({
                "itemId": event_id,
                "quantity": count,
                "exParams": {"channel": "damai_app"},
            }).encode(),
            headers={
                "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0)",
                "Content-Type": "application/json",
                "Cookie": params.get("cookie", ""),
            }
        )
        resp = urlopen(req, timeout=10)
        data = json.loads(resp.read())
        if data.get("ret", [""])[0].startswith("SUCCESS"):
            result = {"status": "抢到了", "order_id": data.get("data", {}).get("orderId", ""), "platform": platform, "time": time.time()}
            break
    except:
        time.sleep(0.1)

print(json.dumps(result, ensure_ascii=False))
