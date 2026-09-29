#!/usr/bin/env python3
"""
ai_image_gen.py — AI 文生图脚本
根据文字描述生成图片（Stable Diffusion）

参数：
  prompt: str         — 图片描述词
  negative_prompt: str— 负面描述词（不想出现什么）
  width: int          — 图片宽度，默认 1024
  height: int         — 图片高度，默认 1024
  steps: int          — 采样步数，默认 20
  style: str          — 风格（realistic/anime/3d/painting）

输出：
  { output_url, prompt, style, size_bytes }
"""
import os, json, time, base64
from urllib.request import Request, urlopen

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
prompt = params.get("prompt", "")
negative_prompt = params.get("negative_prompt", "低质量,模糊,畸形")
width = params.get("width", 1024)
height = params.get("height", 1024)
steps = params.get("steps", 20)

WORK_DIR = os.environ.get("EC_OUTPUT_DIR", "/tmp")
os.makedirs(WORK_DIR, exist_ok=True)

def generate_with_api(p: str, np: str, w: int, h: int, s: int) -> str:
    """调 Stable Diffusion API 生成图片"""
    api_key = os.environ.get("SD_API_KEY", os.environ.get("REPLICATE_API_KEY", ""))
    if not api_key:
        raise ValueError("需要配置 SD_API_KEY 或 REPLICATE_API_KEY")
    
    data = json.dumps({
        "version": "stability-ai/sdxl:39ed52f2a78e934b3ba6e2a89f5b1c712de7dfea535525255b1aa35c5565e08b",
        "input": {
            "prompt": p,
            "negative_prompt": np,
            "width": w,
            "height": h,
            "num_inference_steps": s,
        }
    }).encode()
    
    req = Request(
        "https://api.replicate.com/v1/predictions",
        data=data,
        headers={
            "Authorization": f"Token {api_key}",
            "Content-Type": "application/json",
        }
    )
    resp = urlopen(req, timeout=30)
    result = json.loads(resp.read())
    prediction_id = result.get("id", "")
    
    # 轮询等待生成完成
    for _ in range(30):
        time.sleep(3)
        req = Request(
            f"https://api.replicate.com/v1/predictions/{prediction_id}",
            headers={"Authorization": f"Token {api_key}"}
        )
        resp = urlopen(req, timeout=10)
        status = json.loads(resp.read())
        if status.get("status") == "succeeded":
            output = status.get("output", "")
            if isinstance(output, list):
                return output[0]
            return output
        elif status.get("status") == "failed":
            raise ValueError(f"生成失败: {status.get('error', '')}")
    
    raise TimeoutError("生成超时")

try:
    out_url = generate_with_api(prompt, negative_prompt, width, height, steps)
    
    # 下载结果
    out_path = os.path.join(WORK_DIR, "generated.png")
    req = Request(out_url, headers={"User-Agent": "Mozilla/5.0"})
    resp = urlopen(req, timeout=30)
    with open(out_path, "wb") as f:
        f.write(resp.read())
    
    result = {
        "status": "ok",
        "output_path": out_path,
        "prompt": prompt[:100],
        "width": width,
        "height": height,
        "size_bytes": os.path.getsize(out_path),
        "time": time.time(),
    }
except Exception as e:
    result = {"status": "error", "error": str(e)[:200], "time": time.time()}

print(json.dumps(result, ensure_ascii=False))
