#!/usr/bin/env python3
"""statistics_summary — 数值统计 (企业级 · 2026-06-07 S5 升级)

输入形态:
  - stdin 纯数字 (空格/换行分隔)
  - JSON {"data":[1,2,3], "params":{...}}
  - JSON list of dict (按数值列自动汇总)  · 多列模式
  - JSON list of number

输出:
  - count / mean / median / stdev / variance / min / max / range
  - 分位 p10/p25/p50/p75/p95/p99
  - skewness (偏度) / kurtosis (峰度)
  - 异常值检测 (IQR 1.5 倍外)
  - 直方图 buckets
  - 多列模式: 按 column 分组

参数 (EC_PARAMS):
  columns        list   多列模式 · 指定要统计的列(默认自动选所有数值列)
  histogram_bins int    直方图分桶数 (默认 10 · 0 = 不算)
  outlier_method str    iqr / zscore (默认 iqr)
  outlier_limit  int    最多返回多少异常值样本 (默认 20)
"""
import json
import math
import statistics
import sys
import time
import os


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _coerce_numeric_list(values: list) -> list:
    out = []
    for v in values:
        if v is None or v == "":
            continue
        try:
            f = float(v)
            if math.isnan(f) or math.isinf(f):
                continue
            out.append(f)
        except (ValueError, TypeError):
            continue
    return out


def _stats_one_column(values: list, p: dict) -> dict:
    data = _coerce_numeric_list(values)
    n = len(data)
    if n == 0:
        return {"count": 0, "error": "无有效数值"}
    srt = sorted(data)

    def pct(perc: float) -> float:
        if n == 1:
            return srt[0]
        idx = (n - 1) * perc / 100
        lo = int(idx)
        hi = min(lo + 1, n - 1)
        return srt[lo] + (srt[hi] - srt[lo]) * (idx - lo)

    mean_v = statistics.mean(data)
    median_v = statistics.median(data)
    stdev_v = statistics.stdev(data) if n > 1 else 0.0
    variance_v = statistics.variance(data) if n > 1 else 0.0
    min_v = srt[0]
    max_v = srt[-1]

    # 偏度 / 峰度 (无 numpy · 手算)
    if n > 2 and stdev_v > 0:
        skew = sum(((x - mean_v) / stdev_v) ** 3 for x in data) * n / ((n - 1) * (n - 2))
        kurt = (sum(((x - mean_v) / stdev_v) ** 4 for x in data)
                * n * (n + 1) / ((n - 1) * (n - 2) * (n - 3))
                - 3 * (n - 1) ** 2 / ((n - 2) * (n - 3))) if n > 3 else 0
    else:
        skew, kurt = 0.0, 0.0

    # 异常值
    method = (p.get("outlier_method") or "iqr").lower()
    limit = max(0, min(100, int(p.get("outlier_limit") or 20)))
    outliers: list = []
    if n >= 4 and limit > 0:
        if method == "iqr":
            q1 = pct(25)
            q3 = pct(75)
            iqr = q3 - q1
            lo_b = q1 - 1.5 * iqr
            hi_b = q3 + 1.5 * iqr
            for x in data:
                if x < lo_b or x > hi_b:
                    outliers.append(x)
                    if len(outliers) >= limit:
                        break
        elif method == "zscore" and stdev_v > 0:
            for x in data:
                if abs((x - mean_v) / stdev_v) > 3:
                    outliers.append(x)
                    if len(outliers) >= limit:
                        break

    # 直方图
    histogram = None
    bins_n = max(0, min(100, int(p.get("histogram_bins") if p.get("histogram_bins") is not None else 10)))
    if bins_n > 0 and max_v > min_v:
        step = (max_v - min_v) / bins_n
        edges = [min_v + i * step for i in range(bins_n + 1)]
        counts = [0] * bins_n
        for x in data:
            idx = min(int((x - min_v) / step), bins_n - 1)
            counts[idx] += 1
        histogram = {
            "bins": bins_n,
            "edges": [round(e, 6) for e in edges],
            "counts": counts,
        }

    return {
        "count": n,
        "sum": round(sum(data), 6),
        "mean": round(mean_v, 6),
        "median": round(median_v, 6),
        "stdev": round(stdev_v, 6),
        "variance": round(variance_v, 6),
        "min": min_v, "max": max_v, "range": max_v - min_v,
        "p10": round(pct(10), 6), "p25": round(pct(25), 6),
        "p50": round(median_v, 6), "p75": round(pct(75), 6),
        "p95": round(pct(95), 6), "p99": round(pct(99), 6),
        "skewness": round(skew, 6),
        "kurtosis": round(kurt, 6),
        "outliers_count": len([x for x in data if (
            (method == "iqr" and n >= 4 and (x < pct(25) - 1.5 * (pct(75) - pct(25))
                                              or x > pct(75) + 1.5 * (pct(75) - pct(25))))
            or (method == "zscore" and stdev_v > 0 and abs((x - mean_v) / stdev_v) > 3)
        )]),
        "outliers_sample": outliers,
        "outlier_method": method,
        "histogram": histogram,
    }


def main():
    t0 = time.time()
    try:
        p = _params()
        raw = sys.stdin.read()

        # 解析输入
        multi_column = False
        columns_data: dict = {}  # col → list[number]
        single_data: list = []

        if raw.lstrip().startswith(("{", "[")):
            obj = json.loads(raw)
            # JSON 形态 1: {"data":[...], "params":{...}}
            if isinstance(obj, dict):
                if obj.get("params"):
                    p.update(obj["params"])
                data = (obj.get("data") or obj.get("values") or obj.get("numbers") or [])
                if isinstance(data, list) and data and isinstance(data[0], dict):
                    # list of dict · 多列
                    requested = p.get("columns") or []
                    if requested:
                        keys = list(requested)
                    else:
                        # 自动检测所有数值列
                        keys = []
                        for k, v in data[0].items():
                            try:
                                float(v)
                                keys.append(k)
                            except (TypeError, ValueError):
                                continue
                    for k in keys:
                        columns_data[k] = [d.get(k) for d in data]
                    multi_column = True
                else:
                    single_data = list(data)
            elif isinstance(obj, list):
                if obj and isinstance(obj[0], dict):
                    requested = p.get("columns") or []
                    keys = list(requested) if requested else [
                        k for k, v in obj[0].items()
                        if isinstance(v, (int, float))
                    ]
                    for k in keys:
                        columns_data[k] = [d.get(k) for d in obj]
                    multi_column = True
                else:
                    single_data = obj
        else:
            # 空白分隔数字
            single_data = [x.strip() for x in raw.split() if x.strip()]

        # 计算
        if multi_column:
            results = {col: _stats_one_column(vals, p) for col, vals in columns_data.items()}
            elapsed = int((time.time() - t0) * 1000)
            # 主样本 = 第一列 · 给 summary_text 用
            first_col = next(iter(results.values())) if results else {}
            print(json.dumps({
                "status": "ok", "schema_version": "v1", "task_type": "statistics_summary",
                "elapsed_ms": elapsed,
                "mode": "multi_column",
                "columns": list(columns_data.keys()),
                "summary": results,
                "summary_text": "✅ 多列统计 · {n} 列 · {ms}ms".format(
                    n=len(results), ms=elapsed,
                ),
            }, ensure_ascii=False))
            return 0

        # 单列模式
        if not single_data:
            print(json.dumps({
                "status": "failed", "task_type": "statistics_summary",
                "error": "无数据",
                "summary_text": "❌ 无输入数据",
            }, ensure_ascii=False))
            return 1
        s = _stats_one_column(single_data, p)
        if s.get("count", 0) == 0:
            print(json.dumps({
                "status": "failed", "task_type": "statistics_summary",
                "error": "无有效数值(全部非数字 / NaN)",
                "summary_text": "❌ 无可用数值",
            }, ensure_ascii=False))
            return 1
        elapsed = int((time.time() - t0) * 1000)
        print(json.dumps({
            "status": "ok", "schema_version": "v1", "task_type": "statistics_summary",
            "elapsed_ms": elapsed,
            "mode": "single_column",
            "summary": s,
            "summary_text": (
                f"✅ 统计汇总\n"
                f"📊 样本: {s['count']:,} · 异常值: {s['outliers_count']} ({s['outlier_method']})\n"
                f"📈 mean={s['mean']:.4f} · median={s['median']:.4f} · stdev={s['stdev']:.4f}\n"
                f"📐 range=[{s['min']:.2f}, {s['max']:.2f}]\n"
                f"🎯 P25={s['p25']:.2f} · P50={s['p50']:.2f} · P75={s['p75']:.2f} · P95={s['p95']:.2f}\n"
                f"📊 偏度={s['skewness']:.3f} · 峰度={s['kurtosis']:.3f}"
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "statistics_summary",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
