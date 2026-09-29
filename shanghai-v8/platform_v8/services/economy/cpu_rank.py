"""
可替换 YAML CPU 排行 → cpu_coeff

默认读包内 data/cpu_rank.yaml；可用环境变量 V8_CPU_RANK_PATH 覆盖。
解析失败不阻断调度：回退空表，由 hw_scoring 走旧核心数曲线。
"""
from __future__ import annotations

import logging
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_ENV_PATH = "V8_CPU_RANK_PATH"
_DEFAULT_PATH = Path(__file__).resolve().parent / "data" / "cpu_rank.yaml"

_DEFAULT_GRADE_COEFFS: dict[str, float] = {
    "S": 1.0,
    "A": 0.80,
    "B": 0.60,
    "C": 0.40,
}

# 同档内排名微调幅度 · coeff *= 1 - 0.08 * (rank_in_grade / grade_size)
_WITHIN_GRADE_SPREAD = 0.08

# 未入榜/未上报的兜底上限。0.55 → 0.35（2026-09-17 用户批准）：
#   0.55 高于表内最弱档 C（0.373~0.400）⇒ 让"不知道这台机器的 CPU"反而压过"已知最弱硬件"，
#   造成"诚实上报吃亏"。降到 0.35（低于 C 档最低值）后，不变量 coeff>=兜底上限 在全表成立。
#   ⚠️ 该值同时作用于"上报了但表内匹配不上"的机型 ⇒ 必须与覆盖率补全同批上线。
_FALLBACK_COEFF_CAP = 0.35


@dataclass(frozen=True)
class CpuRankHit:
    match: str
    grade: str
    rank: int
    coeff: float
    source: str = "yaml"


@dataclass
class _CpuRankTable:
    version: int
    grade_coeffs: dict[str, float]
    # match_lower → (grade, overall_rank, coeff)
    entries: list[tuple[str, str, int, float]]
    path: str


_lock = threading.RLock()
_table: _CpuRankTable | None = None


def default_cpu_rank_path() -> Path:
    raw = (os.environ.get(_ENV_PATH) or "").strip()
    if raw:
        return Path(raw)
    return _DEFAULT_PATH


def reload_cpu_rank(path: str | Path | None = None) -> _CpuRankTable:
    """强制从磁盘重载（换文件后调用，或测试注入临时表）。"""
    global _table
    p = Path(path) if path is not None else default_cpu_rank_path()
    loaded = _load_from_path(p)
    with _lock:
        _table = loaded
    return loaded


def _ensure_table() -> _CpuRankTable:
    global _table
    with _lock:
        if _table is None:
            _table = _load_from_path(default_cpu_rank_path())
        return _table


def _empty_table(path: str, reason: str) -> _CpuRankTable:
    logger.error("cpu_rank · 加载失败 path=%s · %s · 回退空表", path, reason)
    return _CpuRankTable(
        version=0,
        grade_coeffs=dict(_DEFAULT_GRADE_COEFFS),
        entries=[],
        path=path,
    )


def _load_from_path(path: Path) -> _CpuRankTable:
    path_s = str(path)
    try:
        import yaml
    except Exception as e:
        return _empty_table(path_s, f"PyYAML 不可用: {e}")

    if not path.is_file():
        return _empty_table(path_s, "文件不存在")

    try:
        raw = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as e:
        return _empty_table(path_s, f"YAML 解析失败: {e}")

    if not isinstance(raw, dict):
        return _empty_table(path_s, "根节点不是 mapping")

    try:
        return _parse_table(raw, path_s)
    except Exception as e:
        return _empty_table(path_s, f"结构无效: {e}")


def _parse_table(raw: dict[str, Any], path_s: str) -> _CpuRankTable:
    version = int(raw.get("version") or 1)
    grade_coeffs = dict(_DEFAULT_GRADE_COEFFS)
    gc = raw.get("grade_coeffs") or {}
    if isinstance(gc, dict):
        for k, v in gc.items():
            grade_coeffs[str(k).upper()] = float(v)

    entries_raw = raw.get("entries") or []
    if not isinstance(entries_raw, list):
        raise ValueError("entries 必须是 list")

    # 先收集 (match, grade, rank, 显式 coeff)，再按档位算微调 coeff
    # 2026-09-17 · 可选 coeff 字段：写了就用写死的值；未写则维持档内公式。
    #   规范：改这张表时**优先给新条目写显式 coeff** —— 因为档内公式的 n 是"该档条数"，
    #   纯公式新增一条会重排同档所有既有条目（实测 A 档 13 条 / B 档 10 条被移动）。
    #   显式条目不进入档内公式的 i/n 统计 ⇒ 新增显式条目对既有条目**零影响**。
    staged: list[tuple[str, str, int, float | None]] = []
    for item in entries_raw:
        if not isinstance(item, dict):
            continue
        match = str(item.get("match") or "").strip().lower()
        grade = str(item.get("grade") or "").strip().upper()
        if not match or grade not in grade_coeffs:
            continue
        try:
            rank = int(item.get("rank") or 0)
        except (TypeError, ValueError):
            rank = 0
        explicit_raw = item.get("coeff")
        explicit: float | None = None
        if explicit_raw is not None:
            # 非法值必须显式报错，绝不静默吞掉/当 0/夹取
            if isinstance(explicit_raw, bool) or not isinstance(explicit_raw, (int, float)):
                raise ValueError(
                    f"cpu_rank entry match={match!r} 的 coeff 必须是数字，得到 {explicit_raw!r}"
                )
            explicit = float(explicit_raw)
            if not (0.0 <= explicit <= 1.0):
                raise ValueError(
                    f"cpu_rank entry match={match!r} 的 coeff 必须在 [0,1]，得到 {explicit}"
                )
        staged.append((match, grade, rank, explicit))

    by_grade: dict[str, list[tuple[str, str, int, float | None]]] = {}
    for m, g, r, e in staged:
        by_grade.setdefault(g, []).append((m, g, r, e))
    for g in by_grade:
        by_grade[g].sort(key=lambda t: (t[2], t[0]))

    entries: list[tuple[str, str, int, float]] = []
    for g, items in by_grade.items():
        base = float(grade_coeffs[g])
        # 档内公式只统计"未显式 coeff"的条目 ⇒ 新增显式条目不会重排同档既有条目
        auto = [t for t in items if t[3] is None]
        n = max(1, len(auto))
        for j, (m, _g, r, _e) in enumerate(auto):
            fine = 1.0 - _WITHIN_GRADE_SPREAD * (j / n)
            entries.append((m, g, r, round(base * fine, 6)))
        for m, _g, r, explicit in items:
            if explicit is not None:
                entries.append((m, g, r, round(float(explicit), 6)))

    # 稳定：按 match 长度降序，查找时优先最长子串
    entries.sort(key=lambda t: (-len(t[0]), t[2], t[0]))

    logger.info(
        "cpu_rank · loaded path=%s version=%s entries=%d",
        path_s, version, len(entries),
    )
    return _CpuRankTable(
        version=version,
        grade_coeffs=grade_coeffs,
        entries=entries,
        path=path_s,
    )


# ── 品牌串归一化（2026-09-17 · 匹配前置层）──────────────────────────────
# 设计原则（防"归一化过宽张冠李戴"）:
#   1. 只做「去修饰 + 空白收敛」；绝不截断型号数字、绝不丢后缀（K/KF/KS/H/HX/U…）
#   2. 归一化只用于**追加**匹配: 原有"最长子串匹配"完全不动(零回归);
#      仅当子串未命中时, 才用规范型号 token 做**等值**比对 —— 只可能多命中, 不可能改判既有结果。
#   3. 抽不出已知型号族就返回 "" · 绝不猜。
_DECOR_RE = re.compile(
    r"(?:\b\d{1,2}(?:st|nd|rd|th)\s+gen\b|\(r\)|\(tm\)|\bcore\b|\bcpu\b|"
    r"\bprocessor\b|@\s*\d+(?:\.\d+)?\s*ghz|\b\d+\s*-\s*core\b|"
    r"\bwith\s+radeon\s+graphics\b|\bseries\b)"
)

# 型号族（按优先级）。每族只认已知形态；抽不出 → ""。
_MODEL_PATTERNS = (
    ("intel-core", re.compile(r"\b(i[3579])[\s-]?(\d{4,5})([a-z]{0,3})\b")),
    ("intel-ultra", re.compile(r"\bultra[\s-]?([3579])[\s-]?(\d{3})([a-z]{0,3})\b")),
    ("apple-m", re.compile(r"\bm([1-9])(?:\s+(pro|max|ultra))?\b")),
    ("ryzen", re.compile(r"\bryzen[\s-]?([3579])[\s-]?(\d{4})([a-z0-9]{0,4})\b")),
    ("xeon", re.compile(r"\bxeon\b.*?\b(e[357])[\s-]?(\d{4})\s*(v\d)\b")),
)
_KEYWORD_TOKENS = ("pentium", "celeron")


def normalize_brand(value: str) -> str:
    """品牌串 → 规范形: 小写 + 去修饰 + 空白/连字符收敛。不做任何数字或后缀截断。"""
    s = str(value or "").lower()
    s = _DECOR_RE.sub(" ", s)
    s = re.sub(r"\s*-\s*", "-", s)   # 连字符两侧空白收敛(不新增也不删除连字符)
    s = re.sub(r"[\s_]+", " ", s).strip()
    return s


def model_token(value: str) -> str:
    """抽取规范型号 token(如 i7-14700k / ultra 9 185h / m4 pro / ryzen 9 5950x)。

    抽不出已知族 → 返回 ""(绝不猜、绝不截断数字)。
    例: `12th Gen Intel(R) Core(TM) i7-12800HX` → `i7-12800hx`(不是 i7-1280)。
    """
    s = normalize_brand(value)
    if not s:
        return ""
    for fam, rx in _MODEL_PATTERNS:
        m = rx.search(s)
        if not m:
            continue
        if fam == "intel-core":
            return f"{m.group(1)}-{m.group(2)}{m.group(3) or ''}"
        if fam == "intel-ultra":
            return f"ultra {m.group(1)} {m.group(2)}{m.group(3) or ''}"
        if fam == "apple-m":
            return f"m{m.group(1)}" + (f" {m.group(2)}" if m.group(2) else "")
        if fam == "ryzen":
            return f"ryzen {m.group(1)} {m.group(2)}{m.group(3) or ''}"
        if fam == "xeon":
            return f"{m.group(1)}-{m.group(2)} {m.group(3)}"
    for kw in _KEYWORD_TOKENS:
        if kw in s:
            return kw
    return ""


def lookup(cpu_brand: str) -> CpuRankHit | None:
    """对 cpu_brand 做最长子串匹配；未命中返 None。"""
    brand = (cpu_brand or "").strip().lower()
    if not brand:
        return None
    table = _ensure_table()
    best: tuple[str, str, int, float] | None = None
    for match, grade, rank, coeff in table.entries:
        if match and match in brand:
            if best is None or len(match) > len(best[0]):
                best = (match, grade, rank, coeff)
            elif len(match) == len(best[0]) and rank < best[2]:
                best = (match, grade, rank, coeff)
    if best is None:
        # ② 归一化追加匹配(仅等值) —— 只可能多命中, 不会改变上面任何既有结果
        tok = model_token(cpu_brand)
        if tok:
            for match, grade, rank, coeff in table.entries:
                if model_token(match) == tok:
                    logger.debug("cpu_rank · normalize hit brand=%s token=%s entry=%s",
                                 cpu_brand, tok, match)
                    return CpuRankHit(match=match, grade=grade, rank=rank,
                                      coeff=coeff, source="yaml-normalized")
        return None
    match, grade, rank, coeff = best
    return CpuRankHit(match=match, grade=grade, rank=rank, coeff=coeff)


def cpu_coeff_for_brand(cpu_brand: str, *, fallback_score_0_100: float | None = None) -> float:
    """
    返回调度用 cpu_coeff (0–1)。
    YAML 命中用表内系数；未命中用 fallback_score/100 且上限 0.55。
    """
    hit = lookup(cpu_brand)
    if hit is not None:
        return float(hit.coeff)
    if fallback_score_0_100 is None:
        return 0.0
    return min(_FALLBACK_COEFF_CAP, max(0.0, float(fallback_score_0_100) / 100.0))


def reset_for_tests() -> None:
    """测试用 · 清缓存，下次按当前 env/默认路径重载。"""
    global _table
    with _lock:
        _table = None
