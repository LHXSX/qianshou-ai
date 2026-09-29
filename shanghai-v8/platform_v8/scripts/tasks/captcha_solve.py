#!/usr/bin/env python3
"""
captcha_solve.py — 验证码识别脚本
接 2captcha 等第三方验证码识别 API

参数：
  image_url: str     — 验证码图片链接
  api_key: str       — 验证码平台 API Key
  method: str        — 识别方式（普通/滑块/点选）

输出：
  { code, status, cost_time }
"""
import os, json, time, base64
from urllib.request import Request, urlopen
from urllib.parse import urlencode

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
image_url = params.get("image_url", "")
api_key = params.get("api_key", os.environ.get("CAPTCHA_API_KEY", ""))

def solve_image() -> str:
    """图片验证码识别"""
    import subprocess
    # 下载图片
    req = Request(image_url, headers={"User-Agent": "Mozilla/5.0"})
    resp = urlopen(req, timeout=10)
    img_data = resp.read()
    b64 = base64.b64encode(img_data).decode()

    # 调第三方 API
    data = urlencode({
        "key": api_key,
        "method": "base64",
        "body": b64,
        "json": 1,
    }).encode()
    req = Request("https://2captcha.com/in.php", data=data)
    resp = urlopen(req, timeout=15)
    rid = json.loads(resp.read()).get("request", "")

    # 等结果
    for _ in range(20):
        time.sleep(3)
        req = Request(f"https://2captcha.com/res.php?key={api_key}&action=get&id={rid}&json=1")
        resp = urlopen(req, timeout=10)
        result = json.loads(resp.read())
        if result.get("status") == 1:
            return result.get("request", "")
    return ""

code = solve_image() if image_url and api_key else "需要 image_url 和 api_key"
print(json.dumps({"code": code, "solved": bool(code and len(code) > 1), "time": time.time()}, ensure_ascii=False))
