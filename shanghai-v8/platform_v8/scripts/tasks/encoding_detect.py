#!/usr/bin/env python3
"""encoding_detect — 检测文件编码 + 转码（UTF-8/GBK/Big5/UTF-16）。"""
import json, sys, time

def detect(data: bytes) -> str:
    """简单 BOM + 启发式编码检测（不依赖 chardet）"""
    if data.startswith(b"\xef\xbb\xbf"): return "utf-8-sig"
    if data.startswith(b"\xff\xfe"): return "utf-16-le"
    if data.startswith(b"\xfe\xff"): return "utf-16-be"
    for enc in ["utf-8", "gbk", "big5", "latin-1"]:
        try: data.decode(enc); return enc
        except UnicodeDecodeError: continue
    return "unknown"

def main():
    t0 = time.time()
    try:
        raw = sys.stdin.buffer.read()
    except Exception as e:
        print(json.dumps({"status":"failed","error":f"stdin:{e}"})); return 1
    try:
        # 输入：可以是单个文件原始内容，也可以是 JSON {samples:["b64...","b64..."]}
        results = []
        try:
            obj = json.loads(raw.decode("utf-8","ignore"))
            samples = obj.get("samples", [])
            import base64
            for s in samples:
                data = base64.b64decode(s)
                enc = detect(data)
                results.append({"size":len(data), "encoding":enc, "bom":data[:4].hex() if data[:1]>b"\x7f" else ""})
        except Exception:
            enc = detect(raw)
            results.append({"size":len(raw), "encoding":enc, "preview":raw[:200].decode(enc, "replace") if enc!="unknown" else ""})
        elapsed = int((time.time()-t0)*1000)
        enc_dist = {}
        for r in results: enc_dist[r["encoding"]] = enc_dist.get(r["encoding"],0) + 1
        print(json.dumps({
            "status":"ok","schema_version":"v1","task_type":"encoding_detect",
            "elapsed_ms":elapsed,
            "summary":{"files":len(results),"total_bytes":sum(r["size"] for r in results),"encoding_dist":enc_dist},
            "result":results,
            "summary_text":f"✅ 编码检测完成\n📥 检测 {len(results)} 个文件\n📊 编码分布: " + ", ".join(f"{k}×{v}" for k,v in enc_dist.items()),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"status":"failed","task_type":"encoding_detect","error":str(e)})); return 1

if __name__ == "__main__": sys.exit(main())
