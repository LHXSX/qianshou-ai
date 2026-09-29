#!/usr/bin/env python3
"""图片元信息提取 — 适配千手引擎 run_script 协议"""
import os, json
from PIL import Image

input_dir = os.environ.get("EC_INPUT_DIR", ".")
params = json.loads(os.environ.get("EC_PARAMS", "{}"))
files = [f for f in os.listdir(input_dir) if f.lower().endswith(('.jpg','.jpeg','.png','.webp','.bmp','.gif','.tiff','.heic'))]

results = []
for f in files:
    path = os.path.join(input_dir, f)
    try:
        img = Image.open(path)
        results.append({
            "filename": f,
            "format": img.format,
            "mode": img.mode,
            "width": img.width,
            "height": img.height,
            "size_bytes": os.path.getsize(path),
        })
    except Exception as e:
        results.append({"filename": f, "error": str(e)})

print(json.dumps({"results": results, "total": len(results)}, ensure_ascii=False))
