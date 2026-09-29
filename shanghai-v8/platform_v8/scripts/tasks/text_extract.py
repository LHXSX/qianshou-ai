#!/usr/bin/env python3
"""text_extract — PII 提取 + 脱敏 (企业级 · 2026-06-07 S5 升级)

新增:
  - 更严正则(email TLD ≥ 2 字符 · 手机段更精 · IPv4 段校验)
  - 更多类型:wechat / qq / passport_cn / plate_cn / credit_card(Luhn 校验)/ ipv6
  - 脱敏(mask)文本输出:邮箱/手机/身份证/银行卡四段中间打 *
  - 每命中携带 location (start, end) · 行号
  - EC_PARAMS 统一参数

参数 (EC_PARAMS · 优先于 stdin.params):
  types          list   类型过滤(默认全选)
  mask_output    bool   返脱敏后文本 (默认 false)
  max_per_type   int    每类最多返多少匹配 (默认 1000)
"""
import json
import os
import re
import sys
import time


PATTERNS = {
    "email":       r"[\w.+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}",
    "phone":       r"(?<!\d)1[3-9]\d{9}(?!\d)",
    "url":         r"https?://[\w.-]+(?:\:\d+)?(?:/[\w/\-=&?%~+#@.,]*)?",
    "ipv4":        r"(?<!\d)(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(?:\.(?:25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}(?!\d)",
    "ipv6":        r"(?<![\w:])(?:[A-Fa-f0-9]{1,4}:){2,7}[A-Fa-f0-9]{1,4}(?![\w:])",
    "id_cn":       r"(?<!\d)\d{17}[\dxX](?!\w)",
    "credit_card": r"(?<!\d)(?:\d[ -]?){13,19}\d(?!\d)",  # 后续 Luhn 校验过滤
    "passport_cn": r"\b[EeKkGgDdSsPpHh]\d{8}\b",
    "wechat":      r"(?:wx|微信|VX|vx|wechat)[:\s]?[A-Za-z][A-Za-z0-9_-]{4,18}",
    "qq":          r"(?:QQ|qq)[:\s]?\d{5,11}",
    "plate_cn":    r"[\u4e00-\u9fa5][A-Z][A-Z0-9]{5,6}",
}


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _luhn_ok(s: str) -> bool:
    digits = [int(c) for c in re.sub(r"\D", "", s)]
    if len(digits) < 13:
        return False
    checksum = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        checksum += d
    return checksum % 10 == 0


def _line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def _mask(value: str, kind: str) -> str:
    if kind == "email":
        if "@" in value:
            user, domain = value.split("@", 1)
            if len(user) <= 2:
                return user[0] + "*@" + domain
            return user[0] + "*" * (len(user) - 2) + user[-1] + "@" + domain
        return "***"
    if kind == "phone":
        return value[:3] + "****" + value[-4:]
    if kind == "id_cn":
        return value[:6] + "*" * 8 + value[-4:]
    if kind == "credit_card":
        d = re.sub(r"\D", "", value)
        return d[:6] + "*" * (len(d) - 10) + d[-4:]
    if kind in ("wechat", "qq"):
        return value[:2] + "*" * max(0, len(value) - 4) + value[-2:]
    if kind == "plate_cn":
        return value[:2] + "*" * (len(value) - 4) + value[-2:]
    if kind == "passport_cn":
        return value[0] + "*" * (len(value) - 3) + value[-2:]
    if kind in ("ipv4", "ipv6", "url"):
        return re.sub(r"\d", "*", value)
    return "*" * len(value)


def main():
    t0 = time.time()
    try:
        p = _params()
        raw = sys.stdin.read()
        text = raw
        if raw.lstrip().startswith(("{", "[")):
            try:
                obj = json.loads(raw)
                if isinstance(obj, dict):
                    text = obj.get("text", raw)
                    merged = dict(obj.get("params") or {})
                    merged.update(p)
                    p = merged
            except Exception:
                pass

        types = p.get("types") or list(PATTERNS.keys())
        max_per = int(p.get("max_per_type") or 1000)
        mask_output = bool(p.get("mask_output", False))

        matches: dict = {}
        masked_text = text  # 累积脱敏
        # 收集所有 (start, end, kind, mask) 之后按位置倒序替换
        all_hits: list = []
        for k in types:
            if k not in PATTERNS:
                continue
            found = []
            seen_vals = set()
            for m in re.finditer(PATTERNS[k], text):
                val = m.group(0)
                # Luhn 校验银行卡
                if k == "credit_card" and not _luhn_ok(val):
                    continue
                if val in seen_vals:
                    continue
                seen_vals.add(val)
                found.append({
                    "value": val,
                    "start": m.start(),
                    "end": m.end(),
                    "line": _line_of(text, m.start()),
                    "masked": _mask(val, k),
                })
                all_hits.append((m.start(), m.end(), k, _mask(val, k)))
                if len(found) >= max_per:
                    break
            if found:
                matches[k] = found

        if mask_output and all_hits:
            # 倒序替换防偏移
            all_hits.sort(key=lambda x: x[0], reverse=True)
            buf = list(text)
            for start, end, _kind, masked in all_hits:
                buf[start:end] = list(masked)
            masked_text = "".join(buf)

        total = sum(len(v) for v in matches.values())
        elapsed = int((time.time() - t0) * 1000)
        out = {
            "status": "ok", "schema_version": "v1", "task_type": "text_extract",
            "elapsed_ms": elapsed,
            "summary": {
                "input_bytes": len(text.encode("utf-8")),
                "input_chars": len(text),
                "total_matches": total,
                "counts": {k: len(v) for k, v in matches.items()},
                "types_scanned": [k for k in types if k in PATTERNS],
                "mask_output": mask_output,
            },
            "result": matches,
            "summary_text": (
                f"✅ PII 提取 · {len(text):,} 字符 · {elapsed}ms\n"
                f"🎯 总 {total} 处\n" +
                "\n".join(f"  {k}: {len(v)}" for k, v in matches.items() if v)
            ),
        }
        if mask_output:
            out["masked_text"] = masked_text
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "text_extract",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
