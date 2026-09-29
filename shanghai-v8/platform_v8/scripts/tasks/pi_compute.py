#!/usr/bin/env python3
"""pi_compute — 高精度 π 计算 (Chudnovsky 算法 · 标准库)"""
import json, sys, time
from decimal import Decimal, getcontext

def chudnovsky(digits: int) -> str:
    getcontext().prec = digits + 20
    C = 426880 * Decimal(10005).sqrt()
    M, L, X, K, S = 1, 13591409, 1, 6, Decimal(13591409)
    for i in range(1, digits // 14 + 1):
        M = (K**3 - 16*K) * M // (i**3)
        L += 545140134
        X *= -262537412640768000
        S += Decimal(M * L) / X
        K += 12
    pi = C / S
    return str(pi)[:digits + 2]

def main():
    t0 = time.time()
    try:
        raw = sys.stdin.read().strip()
        # 容错: 接受 JSON {"params":{"digits":N}} · 也接受裸数字 "100" · 也接受空 (默认 100)
        if not raw:
            digits = 100
        elif raw.startswith("{"):
            digits = int(json.loads(raw).get("params", {}).get("digits", 100))
        else:
            try:
                digits = int(raw.split()[0])
            except Exception:
                digits = 100
        digits = max(10, min(digits, 10000))
        pi_str = chudnovsky(digits)
        elapsed = int((time.time()-t0)*1000)
        print(json.dumps({
            "status":"ok","schema_version":"v1","task_type":"pi_compute",
            "elapsed_ms":elapsed,
            "contract_version":"1",
            "summary":{
                "digits":digits,
                "algorithm":"Chudnovsky",
                "sample":pi_str[:60]+"...",
                # 数值聚合器可消费的近似值；完整高精度值仍在 result_pi。
                "value":float(pi_str[:17]),
            },
            "result_pi":pi_str,
            "summary_text":f"✅ π 计算完成\n🧮 算法: Chudnovsky\n📏 精度: {digits} 位\n⚡ 用时: {elapsed}ms\n\n3.{pi_str[2:62]}...",
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"status":"failed","task_type":"pi_compute","error":str(e)})); return 1

if __name__ == "__main__": sys.exit(main())
