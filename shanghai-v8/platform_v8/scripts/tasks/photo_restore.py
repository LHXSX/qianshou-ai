#!/usr/bin/env python3
"""
photo_restore.py — 老照片修复脚本
模糊变清晰、黑白上色、去噪、去划痕

参数：
  image_url: str      — 待修复图片链接
  mode: str           — enhance / colorize / denoise / all
  strength: float     — 修复强度 0-1，默认 0.7

输出：
  { output_url, mode, size_bytes }
"""
import os, json, time, base64
from urllib.request import Request, urlopen

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
image_url = params.get("image_url", "")
mode = params.get("mode", "all")

WORK_DIR = os.environ.get("EC_OUTPUT_DIR", "/tmp")
os.makedirs(WORK_DIR, exist_ok=True)

def enhance_with_api(img_b64: str, mode: str) -> str:
    """调第三方修复 API"""
    # 默认用 replicate / huggingface 等 API
    api_key = os.environ.get("RESTORE_API_KEY", "")
    if not api_key:
        raise ValueError("需要配置 RESTORE_API_KEY")
    
    data = json.dumps({
        "image": img_b64,
        "mode": mode,
        "strength": params.get("strength", 0.7),
    }).encode()
    
    req = Request(
        "https://api.replicate.com/v1/predictions",
        data=data,
        headers={
            "Authorization": f"Token {api_key}",
            "Content-Type": "application/json",
        }
    )
    resp = urlopen(req, timeout=60)
    result = json.loads(resp.read())
    return result.get("output", "")

try:
    # 下载图片
    req = Request(image_url, headers={"User-Agent": "Mozilla/5.0"})
    resp = urlopen(req, timeout=30)
    img_data = resp.read()
    img_b64 = base64.b64encode(img_data).decode()
    
    # 修复
    out_url = enhance_with_api(img_b64, mode)
    
    # 下载修复结果
    out_path = os.path.join(WORK_DIR, "restored.jpg")
    req = Request(out_url, headers={"User-Agent": "Mozilla/5.0"})
    resp = urlopen(req, timeout=30)
    with open(out_path, "wb") as f:
        f.write(resp.read())
    
    result = {
        "status": "ok",
        "output_path": out_path,
        "size_bytes": os.path.getsize(out_path),
        "mode": mode,
        "time": time.time(),
    }
except Exception as e:
    result = {"status": "error", "error": str(e)[:200], "time": time.time()}

print(json.dumps(result, ensure_ascii=False))
