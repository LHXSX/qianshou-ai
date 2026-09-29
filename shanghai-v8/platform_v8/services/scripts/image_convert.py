#!/usr/bin/env python3
"""批量图片格式转换 — 适配千手引擎 run_script 协议"""
import os, json
from PIL import Image

input_dir = os.environ.get("EC_INPUT_DIR", ".")
params = json.loads(os.environ.get("EC_PARAMS", "{}"))
target_fmt = params.get("format", "png").lower()
output_dir = os.environ.get("EC_OUTPUT_DIR", input_dir)
os.makedirs(output_dir, exist_ok=True)

files = [f for f in os.listdir(input_dir) if f.lower().endswith(('.jpg','.jpeg','.png','.webp','.bmp','.gif','.tiff','.heic'))]
results = []
for f in files:
    path = os.path.join(input_dir, f)
    try:
        img = Image.open(path)
        out_name = f"{os.path.splitext(f)[0]}.{target_fmt}"
        out_path = os.path.join(output_dir, out_name)
        img.save(out_path)
        results.append({"input": f, "output": out_name, "format": target_fmt})
    except Exception as e:
        results.append({"input": f, "error": str(e)})

print(json.dumps({"results": results, "total": len(results)}, ensure_ascii=False))
