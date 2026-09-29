#!/usr/bin/env python3
"""批量生成缩略图 — 适配千手引擎 run_script 协议"""
import os, json
from PIL import Image

input_dir = os.environ.get("EC_INPUT_DIR", ".")
params = json.loads(os.environ.get("EC_PARAMS", "{}"))
thumb_size = params.get("size", 200)
output_dir = os.environ.get("EC_OUTPUT_DIR", input_dir)
os.makedirs(output_dir, exist_ok=True)

files = [f for f in os.listdir(input_dir) if f.lower().endswith(('.jpg','.jpeg','.png','.webp','.bmp','.gif','.tiff','.heic'))]
results = []
for f in files:
    path = os.path.join(input_dir, f)
    try:
        img = Image.open(path)
        out_name = f"thumb_{f}"
        out_path = os.path.join(output_dir, out_name)
        img.thumbnail((thumb_size, thumb_size), Image.LANCZOS)
        img.save(out_path)
        results.append({"input": f, "output": out_name, "width": img.width, "height": img.height})
    except Exception as e:
        results.append({"input": f, "error": str(e)})

print(json.dumps({"results": results, "total": len(results)}, ensure_ascii=False))
