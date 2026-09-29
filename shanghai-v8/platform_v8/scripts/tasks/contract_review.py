#!/usr/bin/env python3
"""contract_review — 合同智能审查(律所垂直 · 企业级 · 2026-06-10)

律所核心场景:扫描件/PDF → 文字(上游 pdf_ocr/pdf_to_text)→ 本脚本做
「合同要素抽取 + 风险标记 + 汇总」→ 下游 excel_export 出 Excel 报告。

本脚本 = 法律分析层(可组合流水线的中间环节,也可单独跑)。

输入(优先级:EC_PARAMS > stdin):
  EC_PARAMS.contracts = [{"name":"甲方合同.pdf","text":"...全文..."}, ...]   # 推荐
  EC_PARAMS.text / stdin 纯文本                                              # 单份
  EC_INPUT_DIR 下的 .txt 文件                                               # 批量(上游已转文字)
  stdin JSON {"contracts":[...]} / {"text":"..."}

参数 (EC_PARAMS):
  endpoint(s)     str/list  LLM API(默认平台 /api/v1/chat/completions)
  model           str       默认 ec-master
  api_key         str       Bearer(可选)
  party_side      str       审查立场:"甲方"/"乙方"/"中立"(默认 中立,影响风险视角)
  timeout/retry   int       默认 60 / 2
  emit_excel      bool      直接写 Excel 到 EC_OUTPUT_DIR(默认 true,需 openpyxl)
  concurrency     int       多份并发(默认 3)

输出:每份合同的要素 + 风险清单 + 整批汇总;result_rows 可直接喂 excel_export;
      emit_excel=true 时直接产出 EC_OUTPUT_DIR/合同审查报告.xlsx
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed


# ── 合同要素 schema(律师关心的关键字段)──────────────────────
LEGAL_SCHEMA = {
    "contract_title": "合同名称",
    "party_a": "甲方(全称)",
    "party_b": "乙方(全称)",
    "subject_matter": "合同标的/服务内容",
    "amount": "合同金额(含币种)",
    "payment_terms": "付款方式与节点",
    "performance_period": "履行期限/起止时间",
    "liability_breach": "违约责任条款",
    "dispute_resolution": "争议解决方式(诉讼/仲裁/管辖)",
    "termination": "解除/终止条款",
    "confidentiality": "保密条款",
    "effective_condition": "生效条件",
    "sign_date": "签署日期",
}

# ── 必备条款(缺失即风险)──────────────────────────────────────
REQUIRED_CLAUSES = [
    ("party_a", "甲方主体", "high"),
    ("party_b", "乙方主体", "high"),
    ("amount", "合同金额", "high"),
    ("payment_terms", "付款条款", "high"),
    ("liability_breach", "违约责任", "high"),
    ("dispute_resolution", "争议解决", "high"),
    ("performance_period", "履行期限", "medium"),
    ("termination", "解除/终止", "medium"),
    ("confidentiality", "保密条款", "low"),
    ("sign_date", "签署日期", "medium"),
]

_EMPTY_HINTS = {"", "无", "未约定", "未提及", "未明确", "未注明", "/", "n/a", "na", "none", "null", "未知"}


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _post(url, body, headers, timeout):
    data = json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(url, data=data,
                                 headers={"Content-Type": "application/json", **headers})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _call_llm(endpoints, body, headers, timeout, retry):
    last = None
    for ep in endpoints:
        for attempt in range(retry + 1):
            try:
                return _post(ep, body, headers, timeout)
            except urllib.error.HTTPError as he:
                last = f"HTTP {he.code}@{ep}"
                if 400 <= he.code < 500 and he.code != 429:
                    break
            except Exception as exc:
                last = f"{exc}@{ep}"
            if attempt < retry:
                time.sleep(1.5 ** attempt)
    raise RuntimeError(last or "all endpoints failed")


def _extract_json(text: str):
    s = (text or "").strip()
    if s.startswith("```"):
        s = re.sub(r"^```\w*\n?", "", s)
        s = re.sub(r"\n?```$", "", s).strip()
    try:
        return json.loads(s)
    except Exception:
        pass
    a, b = s.find("{"), s.rfind("}")
    if a >= 0 and b > a:
        try:
            return json.loads(s[a:b + 1])
        except Exception:
            return None
    return None


def _is_empty(v) -> bool:
    if v is None:
        return True
    s = str(v).strip().lower()
    return s in _EMPTY_HINTS or len(s) == 0


def _build_system(party_side: str) -> str:
    fields = "\n".join(f"  {k}: {v}" for k, v in LEGAL_SCHEMA.items())
    stance = {
        "甲方": "你代表【甲方】利益审查,重点识别对甲方不利的条款。",
        "乙方": "你代表【乙方】利益审查,重点识别对乙方不利的条款。",
    }.get(party_side, "你以中立第三方立场审查,客观识别双方风险。")
    return (
        "你是资深合同审查律师。" + stance + "\n"
        "从合同全文中抽取以下要素(找不到填\"未约定\"),并识别风险点。\n"
        "要素字段:\n" + fields + "\n\n"
        "风险等级:high(重大/缺失必备条款/明显不利)、medium(需关注)、low(轻微)。\n"
        "严格输出 JSON,不要解释、不要 markdown:\n"
        "{\n"
        '  "elements": { 上述每个字段: "抽取值或未约定" },\n'
        '  "risks": [ {"clause":"条款名","level":"high|medium|low","issue":"问题描述","suggestion":"修改建议"} ]\n'
        "}"
    )


def _rule_based_risks(elements: dict) -> list:
    """规则补充:必备条款缺失(LLM 可能漏报)"""
    risks = []
    for field, cn, level in REQUIRED_CLAUSES:
        if _is_empty(elements.get(field)):
            risks.append({
                "clause": cn, "level": level,
                "issue": f"未识别到「{cn}」条款,可能缺失或表述不清",
                "suggestion": f"建议补充明确的「{cn}」约定",
                "source": "规则",
            })
    return risks


def _merge_risks(llm_risks: list, rule_risks: list) -> list:
    """合并去重(同 clause 取更高等级)· LLM 风险标 source=AI"""
    order = {"high": 3, "medium": 2, "low": 1}
    by_clause: dict = {}
    for r in (llm_risks or []):
        if not isinstance(r, dict):
            continue
        r = {**r, "source": r.get("source") or "AI"}
        c = str(r.get("clause") or "其他")
        if c not in by_clause or order.get(r.get("level"), 0) > order.get(by_clause[c].get("level"), 0):
            by_clause[c] = r
    for r in rule_risks:
        c = r["clause"]
        if c not in by_clause:
            by_clause[c] = r
        elif order.get(r["level"], 0) > order.get(by_clause[c].get("level"), 0):
            by_clause[c] = r
    risks = list(by_clause.values())
    risks.sort(key=lambda x: order.get(x.get("level"), 0), reverse=True)
    return risks


def _review_one(name: str, text: str, endpoints, model, headers, timeout, retry,
                party_side: str) -> dict:
    text = (text or "").strip()
    if len(text) < 20:
        return {"name": name, "error": "合同文本过短或为空", "elements": {}, "risks": []}
    # 控制长度(超长截断,合同一般几千字)
    snippet = text[:18000]
    body = {
        "model": model, "temperature": 0,
        "messages": [
            {"role": "system", "content": _build_system(party_side)},
            {"role": "user", "content": snippet},
        ],
    }
    try:
        r = _call_llm(endpoints, body, headers, timeout, retry)
        answer = (r.get("choices", [{}])[0].get("message", {}).get("content", "") or "")
        usage = r.get("usage") or {}
    except Exception as exc:
        return {"name": name, "error": str(exc)[:200], "elements": {}, "risks": []}

    parsed = _extract_json(answer) or {}
    elements = parsed.get("elements") or {}
    # schema 对齐(缺字段补未约定)
    elements = {k: elements.get(k, "未约定") for k in LEGAL_SCHEMA}
    llm_risks = parsed.get("risks") or []
    risks = _merge_risks(llm_risks, _rule_based_risks(elements))

    high = sum(1 for x in risks if x.get("level") == "high")
    medium = sum(1 for x in risks if x.get("level") == "medium")
    low = sum(1 for x in risks if x.get("level") == "low")
    # 简单评分:100 - high*20 - medium*8 - low*3,下限 0
    score = max(0, 100 - high * 20 - medium * 8 - low * 3)
    return {
        "name": name,
        "elements": elements,
        "risks": risks,
        "risk_summary": {"high": high, "medium": medium, "low": low},
        "review_score": score,
        "in_tokens": int(usage.get("prompt_tokens") or 0),
        "out_tokens": int(usage.get("completion_tokens") or 0),
    }


def _read_contracts(p: dict) -> list:
    """返 [(name, text), ...]"""
    # 1. EC_PARAMS.contracts
    if isinstance(p.get("contracts"), list) and p["contracts"]:
        out = []
        for i, c in enumerate(p["contracts"]):
            if isinstance(c, dict):
                out.append((c.get("name") or f"合同{i+1}", c.get("text") or ""))
            else:
                out.append((f"合同{i+1}", str(c)))
        return out
    # 2. EC_INPUT_DIR
    d = os.environ.get("EC_INPUT_DIR", "")
    if d and os.path.isdir(d):
        out = []
        for fn in sorted(os.listdir(d)):
            fp = os.path.join(d, fn)
            if os.path.isfile(fp) and fn.lower().endswith((".txt", ".md")):
                try:
                    with open(fp, encoding="utf-8", errors="replace") as fh:
                        out.append((fn, fh.read()))
                except Exception:
                    continue
        if out:
            return out
    # 3. EC_PARAMS.text
    if p.get("text"):
        return [("合同", p["text"])]
    # 4. stdin
    try:
        raw = sys.stdin.read()
    except Exception:
        raw = ""
    if raw.lstrip().startswith(("{", "[")):
        try:
            obj = json.loads(raw)
            if isinstance(obj, dict):
                if isinstance(obj.get("contracts"), list):
                    return [(c.get("name") or f"合同{i+1}", c.get("text") or "")
                            for i, c in enumerate(obj["contracts"]) if isinstance(c, dict)]
                if obj.get("text"):
                    return [("合同", obj["text"])]
        except Exception:
            pass
    if raw.strip():
        return [("合同", raw)]
    return []


def _build_excel_payload(results: list) -> dict:
    """组装 excel_export 可消费的多 sheet 结构"""
    # sheet1 · 合同要素
    elem_cols = ["合同"] + list(LEGAL_SCHEMA.values())
    elem_rows = []
    for r in results:
        if "elements" not in r:
            continue
        row = [r["name"]] + [r["elements"].get(k, "") for k in LEGAL_SCHEMA]
        elem_rows.append(row)
    # sheet2 · 风险清单
    risk_cols = ["合同", "风险等级", "条款", "问题", "修改建议", "来源"]
    risk_rows = []
    for r in results:
        for rk in r.get("risks", []):
            risk_rows.append([r["name"], rk.get("level", ""), rk.get("clause", ""),
                              rk.get("issue", ""), rk.get("suggestion", ""), rk.get("source", "")])
    # sheet3 · 汇总
    sum_cols = ["合同", "审查得分", "高风险", "中风险", "低风险", "状态"]
    sum_rows = []
    for r in results:
        rs = r.get("risk_summary", {})
        status = "需重点关注" if rs.get("high", 0) > 0 else ("待复核" if rs.get("medium", 0) > 0 else "基本合规")
        sum_rows.append([r["name"], r.get("review_score", ""), rs.get("high", 0),
                         rs.get("medium", 0), rs.get("low", 0),
                         r.get("error") and "解析失败" or status])
    return {
        "filename": "合同审查报告.xlsx",
        "title": "合同智能审查报告 · 千手算力",
        "sheets": [
            {"name": "审查汇总", "columns": sum_cols, "rows": sum_rows},
            {"name": "风险清单", "columns": risk_cols, "rows": risk_rows},
            {"name": "合同要素", "columns": elem_cols, "rows": elem_rows},
        ],
    }


def _maybe_emit_excel(payload: dict) -> str:
    out_dir = os.environ.get("EC_OUTPUT_DIR", "")
    if not (out_dir and os.path.isdir(out_dir)):
        return ""
    try:
        import openpyxl
        from openpyxl.styles import Font, PatternFill, Alignment
        from openpyxl.utils import get_column_letter
    except ImportError:
        return ""
    wb = openpyxl.Workbook()
    wb.remove(wb.active)
    hf = PatternFill("solid", fgColor="1F4E78")
    hfont = Font(bold=True, color="FFFFFF")
    for sh in payload["sheets"]:
        ws = wb.create_sheet(title=sh["name"][:31])
        cols = sh["columns"]
        for ci, c in enumerate(cols, 1):
            cell = ws.cell(row=1, column=ci, value=c)
            cell.fill = hf
            cell.font = hfont
            cell.alignment = Alignment(wrap_text=True, vertical="center")
        for ri, row in enumerate(sh["rows"], 2):
            for ci in range(1, len(cols) + 1):
                v = row[ci - 1] if ci - 1 < len(row) else ""
                ws.cell(row=ri, column=ci, value=v if isinstance(v, (str, int, float, bool)) else str(v)).alignment = Alignment(wrap_text=True, vertical="top")
        for ci, c in enumerate(cols, 1):
            maxlen = max([len(str(c))] + [len(str(r[ci - 1])) for r in sh["rows"][:300] if ci - 1 < len(r)] or [10])
            ws.column_dimensions[get_column_letter(ci)].width = min(max(10, maxlen + 2), 50)
        ws.freeze_panes = "A2"
    path = os.path.join(out_dir, payload["filename"])
    wb.save(path)
    return path


def main() -> int:
    t0 = time.time()
    try:
        p = _params()
        contracts = _read_contracts(p)
        if not contracts:
            print(json.dumps({
                "status": "failed", "task_type": "contract_review",
                "error": "无合同输入(EC_PARAMS.contracts / EC_INPUT_DIR / stdin)",
                "summary_text": "❌ 无合同",
            }, ensure_ascii=False))
            return 1

        endpoints = p.get("endpoints") or ([p["endpoint"]] if p.get("endpoint") else [])
        if not endpoints:
            base = os.environ.get("AI_SCRIPT_BASE_URL", "https://www.qianshousuanli.com")
            endpoints = [f"{base.rstrip('/').rstrip('/v1')}/api/v1/chat/completions"]
        model = p.get("model") or "ec-master"
        timeout = int(p.get("timeout") or 60)
        retry = int(p.get("retry") if p.get("retry") is not None else 2)
        party_side = p.get("party_side") or "中立"
        concurrency = max(1, min(8, int(p.get("concurrency") or 3)))
        headers = {}
        if p.get("api_key"):
            headers["Authorization"] = f"Bearer {p['api_key']}"

        results = [None] * len(contracts)
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            futs = {ex.submit(_review_one, name, text, endpoints, model, headers,
                              timeout, retry, party_side): i
                    for i, (name, text) in enumerate(contracts)}
            for fu in as_completed(futs):
                i = futs[fu]
                results[i] = fu.result()

        ok = [r for r in results if r and "elements" in r and not r.get("error")]
        total_high = sum(r.get("risk_summary", {}).get("high", 0) for r in ok)
        total_medium = sum(r.get("risk_summary", {}).get("medium", 0) for r in ok)
        total_in = sum(r.get("in_tokens", 0) for r in results if r)
        total_out = sum(r.get("out_tokens", 0) for r in results if r)

        excel_payload = _build_excel_payload(results)
        excel_path = ""
        if p.get("emit_excel", True):
            try:
                excel_path = _maybe_emit_excel(excel_payload)
            except Exception:
                excel_path = ""

        elapsed = int((time.time() - t0) * 1000)
        out = {
            "status": "ok", "schema_version": "v1", "task_type": "contract_review",
            "elapsed_ms": elapsed,
            "summary": {
                "contracts_total": len(contracts),
                "contracts_ok": len(ok),
                "contracts_failed": len(contracts) - len(ok),
                "total_high_risks": total_high,
                "total_medium_risks": total_medium,
                "party_side": party_side,
                "model": model,
                "input_tokens": total_in,
                "output_tokens": total_out,
                "excel_path": excel_path,
            },
            "results": results,
            # 供下游 excel_export 直接消费(若节点未装 openpyxl,中央可二次出表)
            "excel_payload": excel_payload,
            "summary_text": (
                f"✅ 合同审查 {len(ok)}/{len(contracts)} 份 · 立场:{party_side}\n"
                f"⚠️ 高风险 {total_high} · 中风险 {total_medium}\n"
                f"⏱ {elapsed}ms · Token in {total_in}/out {total_out}"
                + (f"\n📁 报告: {excel_path}" if excel_path else "")
            ),
        }
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "contract_review",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
