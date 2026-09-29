#!/usr/bin/env python3
"""批量图片压缩为JPEG — 适配千手引擎 run_script 协议"""
import os, json
from PIL import Image

input_dir = os.environ.get("EC_INPUT_DIR", ".")
params = json.loads(os.environ.get("EC_PARAMS", "{}"))
quality = params.get("quality", 85)
output_dir = os.environ.get("EC_OUTPUT_DIR", input_dir)
os.makedirs(output_dir, exist_ok=True)

files = [f for f in os.listdir(input_dir) if f.lower().endswith(('.jpg','.jpeg','.png','.webp','.bmp','.gif','.tiff','.heic'))]
results = []
for f in files:
    path = os.path.join(input_dir, f)
    try:
        img = Image.open(path)
        if img.mode in ("RGBA", "P"):
            img = img.convert("RGB")
        out_name = f"{os.path.splitext(f)[0]}.jpg"
        out_path = os.path.join(output_dir, out_name)
        img.save(out_path, "JPEG", quality=quality)
        results.append({"input": f, "output": out_name, "size_bytes": os.path.getsize(out_path)})
    except Exception as e:
        results.append({"input": f, "error": str(e)})

print(json.dumps({"results": results, "total": len(results)}, ensure_ascii=False))
