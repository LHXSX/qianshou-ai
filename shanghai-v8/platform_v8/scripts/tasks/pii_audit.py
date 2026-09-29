#!/usr/bin/env python3
"""pii_audit — 高级 PII 审计 (合规级 · 含上下文 + 风险评级)"""
import json, re, sys, time

# 比 text_extract 更严格的正则 + 风险评分
PATTERNS = {
    "phone_cn":  (r"(?<!\d)(1[3-9]\d{9})(?!\d)", "高", "中国手机号"),
    "email":     (r"[\w.+-]+@[\w-]+\.[\w.-]+", "中", "邮箱"),
    "id_cn":     (r"(?<!\d)(\d{17}[\dxX])(?!\w)", "高", "中国身份证"),
    "bank_card": (r"(?<!\d)(\d{16,19})(?!\d)", "高", "银行卡号"),
    "ip_v4":     (r"(?<!\d)((?:\d{1,3}\.){3}\d{1,3})(?!\d)", "低", "IPv4 地址"),
    "ipv6":      (r"(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}", "低", "IPv6 地址"),
    "url":       (r"https?://[\w.-]+[\w/\-=&?%~+#@]*", "低", "URL"),
    "password":  (r"(?:password|pwd|passwd|密码)[\s'\u0027=:]+([\w!@#$%^&*()]{6,})", "极高", "密码字段"),
    "api_key":   (r"(?:api[_-]?key|token|secret)[\s'\u0027=:]+([\w\-]{20,})", "极高", "API Key/Token"),
    "ssh_key":   (r"-----BEGIN [A-Z ]+ KEY-----", "极高", "SSH/PGP 私钥"),
    "credit_cvv":(r"(?<!\d)(\d{3,4})(?!\d)\s*(?:cvv|cvc|cvc2)", "极高", "信用卡 CVV"),
    "mac_addr":  (r"(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}", "低", "MAC 地址"),
    "license_plate_cn": (r"[京沪津渝粤鲁苏浙赣闽蒙湘鄂皖川晋黔滇桂藏冀豫陕甘青宁新][A-Z][\dA-Z]{5}", "中", "中国车牌"),
}

def main():
    t0 = time.time()
    try:
        raw = sys.stdin.read()
        text = json.loads(raw).get("text", raw) if raw.lstrip().startswith(("{","[")) else raw
        findings = []
        counts = {}
        risk_score = 0
        for key, (pattern, risk, name) in PATTERNS.items():
            for m in re.finditer(pattern, text):
                ctx_start = max(0, m.start() - 30)
                ctx_end = min(len(text), m.end() + 30)
                findings.append({
                    "type": key, "name": name, "risk": risk,
                    "match": m.group(0)[:50],
                    "context": text[ctx_start:ctx_end].replace("\n"," "),
                    "position": m.start(),
                })
                counts[key] = counts.get(key, 0) + 1
                risk_score += {"低":1, "中":3, "高":10, "极高":50}[risk]
        elapsed = int((time.time()-t0)*1000)
        risk_level = "无风险" if risk_score==0 else "低" if risk_score<10 else "中" if risk_score<50 else "高" if risk_score<200 else "极高"
        print(json.dumps({
            "status":"ok","schema_version":"v1","task_type":"pii_audit",
            "elapsed_ms":elapsed,
            "summary":{"input_chars":len(text),"total_findings":len(findings),
                       "risk_score":risk_score,"risk_level":risk_level,"counts":counts},
            "findings":findings[:200],  # 最多 200 条
            "summary_text":f"✅ PII 审计完成\n📥 扫描 {len(text)} 字符\n🚨 发现 {len(findings)} 处敏感信息\n⚠ 风险评分: {risk_score} ({risk_level})\n\n📊 分布:\n" + "\n".join(f"   {PATTERNS[k][2]} ({PATTERNS[k][1]}危险): {v}" for k,v in counts.items()),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"status":"failed","task_type":"pii_audit","error":str(e)})); return 1

if __name__ == "__main__": sys.exit(main())
