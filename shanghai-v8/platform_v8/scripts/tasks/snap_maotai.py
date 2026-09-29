#!/usr/bin/env python3
"""
snap_maotai.py — i茅台抢购脚本
适配千手引擎 run_script 协议

参数：
  user_token: str     — 用户登录后的 token
  product_id: str     — 商品 ID（默认飞天茅台）
  buy_time: str       — 抢购时间（如 "10:00:00"）

输出：
  { status: "抢到了"|"没抢到"|"失败", order_id, time }
"""
import os, json, time, hmac, hashlib
from urllib.request import Request, urlopen
from urllib.error import HTTPError

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
user_token = params.get("user_token", "")
product_id = params.get("product_id", "1001")
buy_time_str = params.get("buy_time", "10:00:00")
node_id = hashlib.md5(os.environ.get("EC_INPUT_DIR", str(time.time())).encode()).hexdigest()[:8]

HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X)",
    "Content-Type": "application/json",
    "Authorization": f"Bearer {user_token}",
    "X-Device-Id": node_id,
}

def wait_until_target():
    """等待到目标时间"""
    now = time.localtime()
    target_h, target_m, target_s = [int(x) for x in buy_time_str.split(":")]
    target = time.mktime((now.tm_year, now.tm_mon, now.tm_mday, target_h, target_m, target_s, 0, 0, -1))
    if target < time.time():
        target += 86400  # 明天
    sleep_secs = target - time.time() - 0.5  # 提前 0.5 秒
    if sleep_secs > 0:
        time.sleep(sleep_secs)

def try_buy() -> dict:
    """执行一次抢购"""
    try:
        req = Request(
            "https://api.moutai.com/v1/order/create",
            data=json.dumps({
                "productId": product_id,
                "quantity": 1,
                "deviceId": node_id,
            }).encode(),
            headers=HEADERS,
        )
        resp = urlopen(req, timeout=10)
        data = json.loads(resp.read())
        return {"status": "抢到了", "order_id": data.get("orderId", ""), "time": time.time()}
    except HTTPError as e:
        body = e.read().decode()
        if "库存不足" in body:
            return {"status": "没抢到", "error": "库存不足", "time": time.time()}
        return {"status": "失败", "error": f"HTTP {e.code}: {body[:100]}", "time": time.time()}
    except Exception as e:
        return {"status": "失败", "error": str(e)[:100], "time": time.time()}

# 等待抢购时间
wait_until_target()

# 连续猛抢 5 次
result = None
for i in range(5):
    result = try_buy()
    if result["status"] == "抢到了":
        break
    time.sleep(0.1)

print(json.dumps(result, ensure_ascii=False))
