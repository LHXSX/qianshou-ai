#!/usr/bin/env python3
"""case_digest — 智能阅卷 / 案卷提炼(律所垂直 · 企业级 · 2026-06-10)

律师真实痛点:打官司前要啃几百上千页卷宗(证据/笔录/书证),手工梳理成
"阅卷笔记"。本脚本:卷宗文字(上游 ocr_image/pdf_ocr 转好)→ AI 提炼 →
结构化阅卷报告(自定义标签 + 时间线 + 证据清单 + 争议焦点 + 各方主张)。

核心特性:
  · 自定义标签(tags):律师定要抽什么,AI 照抽(案件类型千差万别,不用固定模板)
  · 大体量 map-reduce:卷宗超 LLM 上下文 → 分块抽取 → 汇总(几百页也能跑)
  · 页码定位:保留【第N页】标记,提炼结果带页码来源(律师要追溯原件)
  · 手写黄标:低置信度/手写段落标"待人工复核"(不瞎编)
  · 模块可选:summary/timeline/evidence/disputes/claims

输入(优先级 EC_PARAMS > EC_INPUT_DIR > stdin):
  EC_PARAMS.documents = [{"name":"卷一.pdf","text":"...","pages":N}, ...]
  EC_PARAMS.text / stdin 纯文本(单卷)
  EC_INPUT_DIR 下 .txt(上游 OCR 输出,文件名即卷名)
  · 文本里若含【第N页】/===PAGE N=== 标记,自动用于页码定位

参数 (EC_PARAMS):
  tags          list   自定义抽取标签:["借款金额","担保方式",...] 或 [{"name","desc"}]
  case_type     str    预设案由(借贷纠纷/劳动争议/合同纠纷/侵权/通用)· 缺 tags 时给默认
  modules       list   输出模块(默认 ["summary","timeline","evidence","disputes","claims"])
  chunk_chars   int    分块字符数(默认 6000)
  max_chunks    int    最多处理块数(默认 60 · 防超大卷)
  endpoint(s)/model/api_key/timeout/retry
  emit_excel    bool   直接出 Excel(默认 true)
"""
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request


_CASE_TYPE_TAGS = {
    "借贷纠纷": ["出借人", "借款人", "借款金额", "借款日期", "约定利息", "约定还款日", "已还金额", "逾期情况", "担保方式"],
    "劳动争议": ["劳动者", "用人单位", "入职日期", "离职日期", "工资标准", "欠付工资", "社保缴纳", "解除原因", "经济补偿"],
    "合同纠纷": ["合同名称", "甲方", "乙方", "合同标的", "合同金额", "履行情况", "违约事实", "损失金额"],
    "侵权纠纷": ["侵权人", "受害人", "侵权行为", "损害后果", "因果关系", "过错程度", "损失金额"],
    "通用": ["当事人", "案由", "争议金额", "关键事实", "诉讼请求"],
}

_PAGE_RE = re.compile(
    r"(?:【第\s*(\d+)\s*页(?:[:：][^】]*)?】|===\s*PAGE\s*(\d+)\s*===|\[\s*P(\d+)\s*\])",
    re.IGNORECASE,
)
_DEFAULT_MODULES = ["summary", "timeline", "evidence", "disputes", "claims"]


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


def _normalize_tags(tags) -> list:
    """统一成 [{"name","desc"}] · 容忍 list / 逗号分隔字符串(前端表单)"""
    # 前端 text 输入:逗号/、/分号/空格分隔
    if isinstance(tags, str):
        tags = [t for t in re.split(r"[,,、;;\s]+", tags) if t.strip()]
    out = []
    for t in (tags or []):
        if isinstance(t, dict) and t.get("name"):
            out.append({"name": str(t["name"]), "desc": str(t.get("desc") or "")})
        elif isinstance(t, str) and t.strip():
            out.append({"name": t.strip(), "desc": ""})
    return out


def _normalize_modules(modules) -> list:
    """容忍单选字符串(all/timeline/...)→ 模块列表"""
    if isinstance(modules, str):
        m = modules.strip().lower()
        if not m or m == "all":
            return list(_DEFAULT_MODULES)
        # 单模块预设:始终带 summary 便于阅读
        return list({m, "summary"} & set(_DEFAULT_MODULES) or {m})
    if isinstance(modules, list) and modules:
        return modules
    return list(_DEFAULT_MODULES)


def _combine_documents(docs: list) -> str:
    """多卷合并,插入卷名 + 保留页码标记"""
    parts = []
    for name, text in docs:
        parts.append(f"\n【卷宗:{name}】\n{text}")
    return "\n".join(parts)


def _chunk_with_pages(text: str, chunk_chars: int, max_chunks: int) -> list:
    """按字符分块,记录每块起始页(从最近的页码标记推断)· 返 [(chunk_text, page_hint)]"""
    chunks = []
    i = 0
    n = len(text)
    cur_page = "?"
    while i < n and len(chunks) < max_chunks:
        seg = text[i:i + chunk_chars]
        # 该块内最后一个页码标记 → 作为下一块的 page_hint 起点;本块用进入时的 cur_page
        page_hint = cur_page
        for m in _PAGE_RE.finditer(seg):
            cur_page = next(g for g in m.groups() if g)
        # 块内第一个页码标记若存在,作为本块更准的 page_hint
        first = _PAGE_RE.search(seg)
        if first:
            page_hint = next(g for g in first.groups() if g)
        chunks.append((seg, page_hint))
        i += chunk_chars
    return chunks


def _build_map_system(tags: list, modules: list) -> str:
    tag_lines = "\n".join(f"  - {t['name']}" + (f"({t['desc']})" if t["desc"] else "") for t in tags)
    want = []
    if "timeline" in modules:
        want.append('"events": [{"date":"时间","desc":"事件","page":"页码"}]')
    if "evidence" in modules:
        want.append('"evidence": [{"name":"证据名","proves":"证明什么","page":"页码"}]')
    want_str = ",\n  ".join(want)
    return (
        "你是资深诉讼律师助理,正在阅卷。对给到的这段卷宗内容,做两件事:\n"
        "1. 抽取下列自定义标签的值(找不到留空,绝不编造):\n" + (tag_lines or "  - 关键事实") + "\n"
        "2. 提取本段出现的关键事件(带时间)和证据(带证明目的),并尽量标注页码。\n"
        "重要:只依据原文,拿不准/疑似手写模糊的内容在值后加标记「(待核)」。\n"
        "严格输出 JSON,无解释无 markdown:\n"
        "{\n"
        '  "tags": { 上述每个标签名: "值或空" }'
        + (",\n  " + want_str if want_str else "") + "\n}"
    )


def _build_reduce_system(modules: list) -> str:
    fields = ['"case_summary": "300字内案情摘要"']
    if "disputes" in modules:
        fields.append('"disputes": ["争议焦点1", "争议焦点2"]')
    if "claims" in modules:
        fields.append('"plaintiff_claims": ["原告主张"], "defendant_claims": ["被告主张"]')
    fields.append('"risk_notes": ["举证缺口/风险提示"]')
    return (
        "你是资深诉讼律师。下面是从一宗案件卷宗各段提炼出的标签、事件、证据汇总。\n"
        "请综合全局,输出诉讼可用的阅卷结论。严格 JSON,无解释:\n"
        "{\n  " + ",\n  ".join(fields) + "\n}"
    )


def _merge_tag_value(existing: str, new: str) -> str:
    new = (new or "").strip()
    if not new:
        return existing
    if not existing:
        return new
    if new in existing:
        return existing
    return existing + " / " + new


def main() -> int:
    t0 = time.time()
    try:
        p = _params()

        # ── 读卷宗 ──
        docs = []
        if isinstance(p.get("documents"), list) and p["documents"]:
            for i, d in enumerate(p["documents"]):
                if isinstance(d, dict):
                    docs.append((d.get("name") or f"卷{i+1}", d.get("text") or ""))
        if not docs:
            d = os.environ.get("EC_INPUT_DIR", "")
            if d and os.path.isdir(d):
                for fn in sorted(os.listdir(d)):
                    fp = os.path.join(d, fn)
                    if os.path.isfile(fp) and fn.lower().endswith((".txt", ".md")):
                        try:
                            with open(fp, encoding="utf-8", errors="replace") as fh:
                                docs.append((fn, fh.read()))
                        except Exception:
                            continue
        if not docs and p.get("text"):
            docs = [("卷宗", p["text"])]
        if not docs:
            try:
                raw = sys.stdin.read()
            except Exception:
                raw = ""
            if raw.lstrip().startswith("{"):
                try:
                    obj = json.loads(raw)
                    if obj.get("text"):
                        docs = [("卷宗", obj["text"])]
                    elif isinstance(obj.get("documents"), list):
                        docs = [(d.get("name") or f"卷{i+1}", d.get("text") or "")
                                for i, d in enumerate(obj["documents"]) if isinstance(d, dict)]
                except Exception:
                    pass
            elif raw.strip():
                docs = [("卷宗", raw)]
        if not docs:
            print(json.dumps({"status": "failed", "task_type": "case_digest",
                              "error": "无卷宗输入", "summary_text": "❌ 无卷宗"}, ensure_ascii=False))
            return 1

        # ── 标签 ──
        case_type = p.get("case_type") or "通用"
        tags = _normalize_tags(p.get("tags"))
        if not tags:
            tags = _normalize_tags(_CASE_TYPE_TAGS.get(case_type, _CASE_TYPE_TAGS["通用"]))
        modules = _normalize_modules(p.get("modules"))

        endpoints = p.get("endpoints") or ([p["endpoint"]] if p.get("endpoint") else [])
        if not endpoints:
            base = os.environ.get("AI_SCRIPT_BASE_URL", "https://www.qianshousuanli.com")
            endpoints = [f"{base.rstrip('/').rstrip('/v1')}/api/v1/chat/completions"]
        model = p.get("model") or "ec-master"
        timeout = int(p.get("timeout") or 60)
        retry = int(p.get("retry") if p.get("retry") is not None else 2)
        chunk_chars = max(1500, min(20000, int(p.get("chunk_chars") or 6000)))
        max_chunks = max(1, min(200, int(p.get("max_chunks") or 60)))
        headers = {}
        if p.get("api_key"):
            headers["Authorization"] = f"Bearer {p['api_key']}"

        combined = _combine_documents(docs)
        chunks = _chunk_with_pages(combined, chunk_chars, max_chunks)
        total_chars = len(combined)
        truncated = total_chars > chunk_chars * max_chunks

        # ── MAP:逐块抽取 ──
        map_system = _build_map_system(tags, modules)
        merged_tags = {t["name"]: "" for t in tags}
        events = []
        evidence = []
        total_in = total_out = 0
        map_errors = 0
        for chunk_text, page_hint in chunks:
            body = {"model": model, "temperature": 0, "messages": [
                {"role": "system", "content": map_system},
                {"role": "user", "content": f"(本段约在第 {page_hint} 页附近)\n{chunk_text}"},
            ]}
            try:
                r = _call_llm(endpoints, body, headers, timeout, retry)
                ans = r.get("choices", [{}])[0].get("message", {}).get("content", "") or ""
                u = r.get("usage") or {}
                total_in += int(u.get("prompt_tokens") or 0)
                total_out += int(u.get("completion_tokens") or 0)
            except Exception:
                map_errors += 1
                continue
            parsed = _extract_json(ans) or {}
            for k, v in (parsed.get("tags") or {}).items():
                if k in merged_tags:
                    merged_tags[k] = _merge_tag_value(merged_tags[k], str(v))
            for ev in (parsed.get("events") or []):
                if isinstance(ev, dict) and (ev.get("desc") or ev.get("date")):
                    ev.setdefault("page", page_hint)
                    events.append(ev)
            for evd in (parsed.get("evidence") or []):
                if isinstance(evd, dict) and evd.get("name"):
                    evd.setdefault("page", page_hint)
                    evidence.append(evd)

        # 时间线排序(能解析日期的在前,按字符串)
        def _date_key(e):
            d = str(e.get("date") or "")
            m = re.search(r"\d{4}[-/.年]?\d{0,2}[-/.月]?\d{0,2}", d)
            return (0, m.group(0)) if m else (1, d)
        events.sort(key=_date_key)

        # ── REDUCE:全局结论 ──
        reduce_out = {}
        if any(m in modules for m in ("summary", "disputes", "claims")):
            digest_material = {
                "tags": merged_tags,
                "events": events[:80],
                "evidence": evidence[:80],
            }
            body = {"model": model, "temperature": 0.1, "messages": [
                {"role": "system", "content": _build_reduce_system(modules)},
                {"role": "user", "content": json.dumps(digest_material, ensure_ascii=False)[:16000]},
            ]}
            try:
                r = _call_llm(endpoints, body, headers, timeout, retry)
                ans = r.get("choices", [{}])[0].get("message", {}).get("content", "") or ""
                u = r.get("usage") or {}
                total_in += int(u.get("prompt_tokens") or 0)
                total_out += int(u.get("completion_tokens") or 0)
                reduce_out = _extract_json(ans) or {}
            except Exception:
                reduce_out = {}

        # 手写/待核计数
        review_flags = sum(1 for v in merged_tags.values() if "待核" in str(v))

        digest = {
            "case_type": case_type,
            "tags": merged_tags,
            "case_summary": reduce_out.get("case_summary", ""),
            "timeline": events if "timeline" in modules else [],
            "evidence": evidence if "evidence" in modules else [],
            "disputes": reduce_out.get("disputes", []) if "disputes" in modules else [],
            "plaintiff_claims": reduce_out.get("plaintiff_claims", []) if "claims" in modules else [],
            "defendant_claims": reduce_out.get("defendant_claims", []) if "claims" in modules else [],
            "risk_notes": reduce_out.get("risk_notes", []),
        }

        # ── Excel ──
        excel_payload = _build_excel_payload(digest, tags)
        excel_path = ""
        if p.get("emit_excel", True):
            try:
                excel_path = _maybe_emit_excel(excel_payload)
            except Exception:
                excel_path = ""

        elapsed = int((time.time() - t0) * 1000)
        out = {
            "status": "ok", "schema_version": "v1", "task_type": "case_digest",
            "elapsed_ms": elapsed,
            "summary": {
                "documents": len(docs),
                "total_chars": total_chars,
                "chunks_processed": len(chunks),
                "chunks_failed": map_errors,
                "truncated": truncated,
                "case_type": case_type,
                "tags": [t["name"] for t in tags],
                "events_found": len(events),
                "evidence_found": len(evidence),
                "review_flags": review_flags,
                "model": model,
                "input_tokens": total_in,
                "output_tokens": total_out,
                "excel_path": excel_path,
            },
            "digest": digest,
            "excel_payload": excel_payload,
            "summary_text": (
                f"✅ 阅卷完成 · {len(docs)} 卷 / {total_chars:,} 字 / {len(chunks)} 块\n"
                f"🏷 标签 {len(tags)} 项 · 时间线 {len(events)} 条 · 证据 {len(evidence)} 项\n"
                + (f"⚠️ {review_flags} 处待人工复核(疑似手写)\n" if review_flags else "")
                + f"⏱ {elapsed}ms · Token in {total_in}/out {total_out}"
                + (f"\n📁 报告: {excel_path}" if excel_path else "")
            ),
        }
        print(json.dumps(out, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({"status": "failed", "task_type": "case_digest",
                          "error": str(e), "summary_text": "❌ " + str(e)}, ensure_ascii=False))
        return 1


def _build_excel_payload(digest: dict, tags: list) -> dict:
    sheets = []
    # 案件概要 + 自定义标签
    info_rows = [["案由", digest.get("case_type", "")], ["案情摘要", digest.get("case_summary", "")]]
    for t in tags:
        info_rows.append([t["name"], digest["tags"].get(t["name"], "")])
    for i, d in enumerate(digest.get("disputes", []), 1):
        info_rows.append([f"争议焦点{i}", d])
    sheets.append({"name": "案件概要", "columns": ["项目", "内容"], "rows": info_rows})
    # 时间线
    if digest.get("timeline"):
        sheets.append({"name": "事实时间线", "columns": ["时间", "事件", "页码"],
                       "rows": [[e.get("date", ""), e.get("desc", ""), e.get("page", "")]
                                for e in digest["timeline"]]})
    # 证据清单
    if digest.get("evidence"):
        sheets.append({"name": "证据清单", "columns": ["证据名称", "证明内容", "页码"],
                       "rows": [[e.get("name", ""), e.get("proves", ""), e.get("page", "")]
                                for e in digest["evidence"]]})
    # 主张
    claims_rows = [["原告主张", "；".join(digest.get("plaintiff_claims", []))],
                   ["被告主张", "；".join(digest.get("defendant_claims", []))],
                   ["风险/举证缺口", "；".join(digest.get("risk_notes", []))]]
    sheets.append({"name": "主张与风险", "columns": ["项目", "内容"], "rows": claims_rows})
    return {"filename": "阅卷报告.xlsx", "title": "智能阅卷报告 · 千手算力", "sheets": sheets}


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
                ws.cell(row=ri, column=ci,
                        value=v if isinstance(v, (str, int, float, bool)) else str(v)).alignment = Alignment(wrap_text=True, vertical="top")
        for ci, c in enumerate(cols, 1):
            maxlen = max([len(str(c))] + [len(str(r[ci - 1])) for r in sh["rows"][:300] if ci - 1 < len(r)] or [10])
            ws.column_dimensions[get_column_letter(ci)].width = min(max(12, maxlen + 2), 60)
        ws.freeze_panes = "A2"
    path = os.path.join(out_dir, payload["filename"])
    wb.save(path)
    return path


if __name__ == "__main__":
    sys.exit(main())
