#!/usr/bin/env python3
"""批量图片缩放 — 适配千手引擎 run_script 协议"""
import os, json
from PIL import Image

input_dir = os.environ.get("EC_INPUT_DIR", ".")
params = json.loads(os.environ.get("EC_PARAMS", "{}"))
width = params.get("width", 800)
output_dir = os.environ.get("EC_OUTPUT_DIR", input_dir)
os.makedirs(output_dir, exist_ok=True)

files = [f for f in os.listdir(input_dir) if f.lower().endswith(('.jpg','.jpeg','.png','.webp','.bmp','.gif','.tiff','.heic'))]
results = []
for f in files:
    path = os.path.join(input_dir, f)
    try:
        img = Image.open(path)
        w, h = img.size
        ratio = width / w
        new_h = int(h * ratio)
        out_name = f"resized_{f}"
        out_path = os.path.join(output_dir, out_name)
        img.resize((width, new_h), Image.LANCZOS).save(out_path)
        results.append({"input": f, "output": out_name, "width": width, "height": new_h})
    except Exception as e:
        results.append({"input": f, "error": str(e)})

print(json.dumps({"results": results, "total": len(results)}, ensure_ascii=False))
