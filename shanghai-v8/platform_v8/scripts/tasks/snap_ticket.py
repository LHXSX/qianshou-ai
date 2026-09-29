#!/usr/bin/env python3
"""
snap_ticket.py — 大麦网抢票脚本
适配千手引擎 run_script 协议

参数：
  show_id: str       — 演出 ID
  session_id: str    — 场次 ID
  price_level: str   — 票价档位
  count: int         — 抢几张，默认 1
  user_token: str    — 用户登录 token

输出：
  { status, order_id, error }
"""
import os, json, time, random
from urllib.request import Request, urlopen

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
show_id = params.get("show_id", "")
count = params.get("count", 1)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/537.36",
    "Referer": "https://m.damai.cn/",
    "Cookie": params.get("cookie", ""),
}

def grab() -> dict:
    try:
        req = Request(
            "https://mtop.damai.cn/h5/mtop.trade.order.create/4.0/",
            data=json.dumps({
                "itemId": show_id,
                "quantity": count,
                "exParams": {"channel": "damai_app"},
            }).encode(),
            headers=HEADERS,
        )
        resp = urlopen(req, timeout=10)
        data = json.loads(resp.read())
        if data.get("ret", [""])[0].startswith("SUCCESS"):
            return {"status": "抢到了", "order_id": data.get("data", {}).get("orderId", ""), "time": time.time()}
        return {"status": "没抢到", "error": data.get("ret", [""])[0][:80], "time": time.time()}
    except Exception as e:
        return {"status": "失败", "error": str(e)[:100], "time": time.time()}

result = grab()
if result["status"] != "抢到了":
    for i in range(3):
        time.sleep(0.2)
        result = grab()
        if result["status"] == "抢到了":
            break
print(json.dumps(result, ensure_ascii=False))
