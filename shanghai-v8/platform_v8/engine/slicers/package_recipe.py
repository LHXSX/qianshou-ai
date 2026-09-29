"""package_recipe slicer · 混合包按 Recipe 拆成异构 shard.

每个可路由材料 → 1 个 shard, metadata.task_type = 原子技能.
archive: 落盘流式拆包并按文件 re-upload 为 single_file (复用 OSS presign PUT).
multi_file: 直接一对一映射 input_refs.
"""
from __future__ import annotations

import io
import logging
import os
import shutil
import tempfile
import zipfile
from typing import Any, Iterator

from platform_v8.core import Workload, Shard, ShardStatus
from platform_v8.engine import package_recipes as recipes
from platform_v8.engine.effective_task import default_code_url

logger = logging.getLogger(__name__)

# 默认 4GB · 环境变量 PACKAGE_DIGEST_MAX_ZIP_BYTES 可调
_DEFAULT_MAX_ZIP_BYTES = 4 * 1024 * 1024 * 1024
_DOWNLOAD_CHUNK = 8 * 1024 * 1024
_DOWNLOAD_TIMEOUT_BASE = 120

# 重 PDF 二次切 · 优先真页数 / 客户端 manifest · 无页数再退回体积启发
# 环境变量可调: PACKAGE_DIGEST_PDF_PARTS_MAX / PAGES_PER_PART_OCR / PAGES_PER_PART_TEXT
#               PACKAGE_DIGEST_PHYSICAL_MAX_BYTES / PACKAGE_DIGEST_PROBE_MAX_BYTES
_PDF_OCR_SPLIT_BYTES = 2 * 1024 * 1024
_PDF_TEXT_SPLIT_BYTES = 15 * 1024 * 1024
# 并行硬顶 100 台 · 实际切片预算 = min(100, 在线可跑台数, 用户 max_shards)
_PARALLEL_HARD_CAP = 100
_DEFAULT_PDF_PARTS_MAX = 100
# 粗粒度页切: 少片数 → 少上传/少排队; 节点 pdf_ocr.py 按 page_range 裁页
_DEFAULT_PAGES_PER_PART_OCR = 20
_DEFAULT_PAGES_PER_PART_TEXT = 40
_MIN_PAGES_TO_SPLIT_OCR = 8
_MIN_PAGES_TO_SPLIT_TEXT = 30
# 物理拆页: 仅「中等」扫描 PDF。超大文件走逻辑 page_range, 避免 API 整包下+拆+回传
_PHYSICAL_SPLIT_MIN_PAGES = 12
_PHYSICAL_SPLIT_MIN_BYTES = 8 * 1024 * 1024
_DEFAULT_PHYSICAL_SPLIT_MAX_BYTES = 32 * 1024 * 1024
_DEFAULT_PHYSICAL_SPLIT_MAX_PAGES = 80
# 超过此体积不再为 probe 整包下载(用 manifest / 体积估页)
_DEFAULT_PROBE_FULL_DOWNLOAD_MAX_BYTES = 24 * 1024 * 1024
# 扫描件估页启发: ~750KB/页
_EST_SCAN_BYTES_PER_PAGE = 750 * 1024
_PHYSICAL_SPLIT_PARALLEL = 4


def _pdf_parts_max() -> int:
    raw = os.environ.get("PACKAGE_DIGEST_PDF_PARTS_MAX", str(_DEFAULT_PDF_PARTS_MAX))
    try:
        return max(2, min(_PARALLEL_HARD_CAP, int(raw)))
    except ValueError:
        return _DEFAULT_PDF_PARTS_MAX


def _pages_per_part_ocr() -> int:
    raw = os.environ.get("PACKAGE_DIGEST_PAGES_PER_PART_OCR", str(_DEFAULT_PAGES_PER_PART_OCR))
    try:
        return max(1, min(80, int(raw)))
    except ValueError:
        return _DEFAULT_PAGES_PER_PART_OCR


def _pages_per_part_text() -> int:
    raw = os.environ.get("PACKAGE_DIGEST_PAGES_PER_PART_TEXT", str(_DEFAULT_PAGES_PER_PART_TEXT))
    try:
        return max(1, min(100, int(raw)))
    except ValueError:
        return _DEFAULT_PAGES_PER_PART_TEXT


def _physical_split_max_bytes() -> int:
    raw = os.environ.get(
        "PACKAGE_DIGEST_PHYSICAL_MAX_BYTES", str(_DEFAULT_PHYSICAL_SPLIT_MAX_BYTES),
    )
    try:
        return max(_PHYSICAL_SPLIT_MIN_BYTES, int(raw))
    except ValueError:
        return _DEFAULT_PHYSICAL_SPLIT_MAX_BYTES


def _physical_split_max_pages() -> int:
    raw = os.environ.get(
        "PACKAGE_DIGEST_PHYSICAL_MAX_PAGES", str(_DEFAULT_PHYSICAL_SPLIT_MAX_PAGES),
    )
    try:
        return max(_PHYSICAL_SPLIT_MIN_PAGES, int(raw))
    except ValueError:
        return _DEFAULT_PHYSICAL_SPLIT_MAX_PAGES


def _probe_full_download_max_bytes() -> int:
    raw = os.environ.get(
        "PACKAGE_DIGEST_PROBE_MAX_BYTES", str(_DEFAULT_PROBE_FULL_DOWNLOAD_MAX_BYTES),
    )
    try:
        return max(1 * 1024 * 1024, int(raw))
    except ValueError:
        return _DEFAULT_PROBE_FULL_DOWNLOAD_MAX_BYTES


def _estimate_scan_pages(size: int) -> int:
    """无页数时按扫描件体积粗估 · 宁多勿少(便于切够片)。"""
    size = max(0, int(size or 0))
    if size <= 0:
        return 0
    return max(1, size // _EST_SCAN_BYTES_PER_PAGE)


class PackageSliceError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


def slice_package_recipe(workload: Workload, n_workers: int) -> list[Shard]:
    """异构包按材料切。

    快路径(2026-08 深度优化):
      1. 优先用客户端 file_manifest 的 size/pdf_page_count · 跳过整包 probe
      2. 超大扫描 PDF 默认逻辑页切(page_start/end), API 不做物理拆
      3. 仅中等体积 pdf_ocr 才物理拆, 且多文件并行
      4. 页切粒度加粗(默认 20 页/片), 在线台数只约束并发不压片数保底
    """
    n_online = max(0, int(n_workers or 0))
    spec = workload.spec
    params = dict(spec.params or {})
    recipe_id = str(params.get("recipe") or "law_materials").strip()
    recipe = recipes.get_recipe(recipe_id)
    if recipe is None:
        raise PackageSliceError("unknown_recipe", f"未知 recipe: {recipe_id}")

    materials = _enumerate_materials(workload, recipe)
    if not materials:
        raise PackageSliceError("empty_package", "包内无文件")

    routed: list[tuple[dict[str, Any], recipes.FileRoute]] = []
    skipped: list[tuple[dict[str, Any], recipes.FileRoute]] = []
    for mat in materials:
        entry = recipes.FileEntry(
            name=mat["name"],
            ext=mat.get("ext") or recipes.ext_of(mat["name"]),
            size=int(mat.get("size") or 0),
            index=int(mat.get("index") or 0),
            pdf_has_text=mat.get("pdf_has_text"),
        )
        route = recipe.classify(entry)
        if route.skip or not route.task_type:
            skipped.append((mat, route))
        else:
            routed.append((mat, route))

    if not routed:
        raise PackageSliceError("no_routable_materials", "没有可识别的材料类型")

    # 切片预算:
    #   node_pack(默认): 目标由「整包页当量」估出，再用在线台数卡上下限
    #   page_first(旧): 按页切优先 · 常打出几十片(如 65) · 冷启动多次
    #   client_presliced: 客户端已本机切好 · 每材料 1 shard · 禁止服务端再拆页
    user_cap = _max_shards_budget(workload)
    slice_mode = _slice_mode(workload)
    n_eff = _effective_online_workers(workload, n_online)

    if slice_mode == "client_presliced":
        part_plan = [(mat, route, 1) for mat, route in routed]
        logger.info(
            "package_recipe · client_presliced materials=%d online=%d "
            "(skip server page/physical split)",
            len(part_plan), n_online,
        )
        client_shards: list[Shard] = []
        total = len(part_plan)
        for shard_index, (mat, route, _n) in enumerate(part_plan):
            client_shards.append(_mk_shard(
                workload,
                index=shard_index,
                total=total,
                material=mat,
                route=route,
                recipe_id=recipe_id,
                page_part_index=0,
                page_part_total=1,
                part_input_ref=None,
            ))
        if skipped and client_shards:
            meta = dict(client_shards[0].metadata or {})
            meta["skipped_materials"] = [
                {
                    "name": m["name"],
                    "index": m.get("index"),
                    "type": m.get("ext") or recipes.ext_of(m["name"]),
                    "task": "",
                    "reason": getattr(r, "skip_reason", None) or "skipped",
                }
                for m, r in skipped
            ]
            client_shards[0].metadata = meta
        return client_shards
    device_cap = max(1, min(_PARALLEL_HARD_CAP, n_eff))
    part_plan = [(mat, route, _page_parts_for(mat, route)) for mat, route in routed]
    desired_total = sum(max(1, int(n)) for _, _, n in part_plan)
    ocr_floor = sum(
        max(1, int(n))
        for _, r, n in part_plan
        if (r.task_type or "").strip() == "pdf_ocr"
    )
    target = _target_shard_count(
        n_eff, len(routed), workload=workload, part_plan=part_plan,
    )
    if slice_mode == "node_pack":
        # 预算贴着节点目标 · 不再被 desired/ocr_floor 抬到 65
        max_shards_budget = min(_PARALLEL_HARD_CAP, user_cap, max(1, target))
        part_plan = _fit_parts_to_budget(
            part_plan, max_shards_budget, mode="node_pack",
        )
    else:
        max_shards_budget = min(
            _PARALLEL_HARD_CAP,
            user_cap,
            max(device_cap, len(routed), desired_total, ocr_floor),
        )
        part_plan = _expand_parts_for_workers(
            part_plan, max_shards_budget, max_shards_budget,
        )
        part_plan = _fit_parts_to_budget(part_plan, max_shards_budget, mode="page_first")
    logger.info(
        "package_recipe · slice_budget mode=%s online=%d effective=%d device_cap=%d "
        "user_cap=%d materials=%d desired=%d ocr_floor=%d target=%d budget=%d",
        slice_mode, n_online, n_eff, device_cap, user_cap, len(routed), desired_total,
        ocr_floor, target, max_shards_budget,
    )

    # 中等 pdf_ocr 才物理拆; 超大走逻辑页切(page_range) · 多文件并行
    part_refs_map = _physical_split_parallel(workload, part_plan)

    shards: list[Shard] = []
    total = sum(n for _, _, n in part_plan)
    shard_index = 0
    for mat, route, n_parts in part_plan:
        mid = int(mat.get("index") or 0)
        part_refs = part_refs_map.get(mid)
        for part_i in range(n_parts):
            shards.append(_mk_shard(
                workload,
                index=shard_index,
                total=total,
                material=mat,
                route=route,
                recipe_id=recipe_id,
                page_part_index=part_i,
                page_part_total=n_parts,
                part_input_ref=(part_refs[part_i] if part_refs else None),
            ))
            shard_index += 1

    # 灵活同构组批: 轻材料合成 multi_file 一片 · 一次 Python 跑多个文件
    before_n = len(shards)
    if slice_mode == "node_pack" and len(shards) > target:
        # 片数仍高于节点目标 → 加压合批（更大 B/W）
        over = max(1, (len(shards) + target - 1) // max(1, target))
        shards = coalesce_light_shards(
            shards,
            n_online=n_eff,
            b_max=min(8, max(5, over + 2)),
            w_max=min(40, max(12, over * 6)),
            w_alone=min(30, max(10, over * 4)),
        )
    else:
        shards = coalesce_light_shards(shards, n_online=n_eff)
    batched_n = before_n - len(shards)

    if skipped and shards:
        meta = dict(shards[0].metadata or {})
        meta["skipped_materials"] = [
            {
                "name": m["name"],
                "index": m.get("index"),
                "type": m.get("ext") or recipes.ext_of(m["name"]),
                "task": "",
                "ok": False,
                "chars": 0,
                "text": "",
                "error": r.error or r.reason,
            }
            for m, r in skipped
        ]
        shards[0].metadata = meta

    heavy = sum(1 for _, _, n in part_plan if n > 1)
    logger.info(
        "slicer.package_recipe · workload=%s recipe=%s materials=%d shards=%d "
        "page_split_materials=%d physical_split=%d flex_batch_saved=%d "
        "workers=%d skipped=%d",
        workload.id, recipe_id, len(routed), len(shards), heavy,
        len(part_refs_map), batched_n, n_online, len(skipped),
    )
    return shards


# ── 灵活同构组批 (轻材料 → multi_file · 一次进程多文件) ──────────────
_BATCHABLE_TASKS = frozenset({"pdf_ocr", "pdf_to_text", "ocr_image"})


def _flex_batch_enabled() -> bool:
    raw = (os.environ.get("PACKAGE_DIGEST_FLEX_BATCH") or "1").strip().lower()
    return raw not in ("0", "false", "off", "no")


def _env_int(name: str, default: int, lo: int, hi: int) -> int:
    raw = os.environ.get(name, str(default))
    try:
        return max(lo, min(hi, int(raw)))
    except ValueError:
        return default


def _slice_mode(workload: Workload | None = None) -> str:
    """node_pack(默认) | page_first(旧) | client_presliced(客户端已切好)。"""
    params = {}
    try:
        if workload is not None:
            params = dict(getattr(getattr(workload, "spec", None), "params", None) or {})
    except Exception:
        params = {}
    if params.get("client_presliced") in (True, 1, "1", "true", "True"):
        return "client_presliced"
    raw = str(
        params.get("slice_mode")
        or os.environ.get("PACKAGE_DIGEST_SLICE_MODE")
        or "node_pack"
    ).strip().lower()
    if raw in ("page_first", "page", "legacy", "fine"):
        return "page_first"
    if raw in ("client_presliced", "client", "presliced", "local_slice"):
        return "client_presliced"
    return "node_pack"


def _workload_params(workload: Workload | None) -> dict[str, Any]:
    try:
        if workload is None:
            return {}
        return dict(getattr(getattr(workload, "spec", None), "params", None) or {})
    except Exception:
        return {}


def _effective_online_workers(workload: Workload | None, n_online: int) -> int:
    """切片用在线台数：实时 > 提交快照 > App 探测 > 1。"""
    live = max(0, int(n_online or 0))
    if live > 0:
        return live
    params = _workload_params(workload)
    for key in ("submit_online_workers", "client_online_workers"):
        try:
            n = int(params.get(key) or 0)
        except (TypeError, ValueError):
            n = 0
        if n > 0:
            return n
    return 1


def _material_ocr_weight(
    material: dict[str, Any], route: "recipes.FileRoute",
) -> int:
    """单材料 OCR 页当量 · 供整包目标片数估算。"""
    tt = (route.task_type or "").strip()
    try:
        pages = int(material.get("pdf_page_count") or 0)
    except (TypeError, ValueError):
        pages = 0
    size = int(material.get("size") or 0)
    if tt == "ocr_image":
        return 1
    if tt in ("docx_to_text", "doc_to_text", "txt_to_text", "xlsx_to_text"):
        return 1
    if tt == "pdf_to_text":
        if pages <= 0 and size > 0:
            pages = max(1, size // (200 * 1024))
        return max(1, (max(pages, 1) + 1) // 2)
    if tt == "pdf_ocr":
        if pages <= 0 and size > 0:
            pages = _estimate_scan_pages(size)
        return max(1, pages or 1)
    # 未知类型按轻量计，避免虚增
    if size >= 8 * 1024 * 1024:
        return max(1, _estimate_scan_pages(size) if size else 4)
    return 1


def _target_shard_count(
    n_online: int,
    n_materials: int,
    *,
    workload: Workload | None = None,
    part_plan: list[tuple[dict[str, Any], Any, int]] | None = None,
) -> int:
    """目标片数：按整包页当量估，再用在线台数卡上下限。

    - raw ≈ ceil(总页当量 / 每片合适页数)  · 大卷多切、小卷少切
    - lo  ≈ 在线台数（有足够活时先吃满节点）
    - hi  ≈ 在线台数 × Kmax（默认 4，低于 admission C=5，留续派空位）
    - 不再固定 N×2；客户端 shards_per_worker 仅作 Kmax 上限提示
    """
    import math

    params = _workload_params(workload)
    # Kmax 默认 4（< admission C=5，留续派）。App 常回传旧默认 shards_per_worker=2，
    # 不再用它压低上限，否则大卷又被锁死在 N×2。
    k_max = _env_int("PACKAGE_DIGEST_SHARDS_PER_WORKER_MAX", 4, 1, 5)
    try:
        import os as _os
        if (_os.environ.get("PACKAGE_DIGEST_HONOR_CLIENT_K") or "").strip() in (
            "1", "true", "TRUE", "yes",
        ):
            k_param = int(params.get("shards_per_worker") or 0)
            if 1 <= k_param <= 5:
                k_max = k_param
    except (TypeError, ValueError):
        pass
    pages_per = _env_int("PACKAGE_DIGEST_PAGES_PER_SHARD", 40, 10, 120)
    online = max(1, int(n_online or 1))
    n_materials = max(1, int(n_materials or 1))

    weight = 0
    if part_plan:
        for mat, route, _n in part_plan:
            try:
                weight += _material_ocr_weight(mat, route)
            except Exception:
                weight += 1
    if weight <= 0:
        # 无清单时退回中位估计：每材料约半片当量页
        weight = n_materials * max(8, pages_per // 5)

    raw = max(1, int(math.ceil(weight / float(pages_per))))
    hi = online * k_max
    # 有足够活 → 至少铺满在线节点；活很少 → 不必虚增空片
    if weight >= online * max(8, pages_per // 4):
        lo = online
    else:
        lo = max(1, min(online, raw, n_materials))
    # 材料少但很重（大 PDF 要页切）→ 允许片数 >> 材料数
    # 仅整包很轻时，才把上限收到 ≈ max(材料数, 在线)，避免空片
    if n_materials <= online and raw <= online:
        hi = min(hi, max(n_materials, online))
    target = max(lo, min(hi, raw))
    return max(1, min(_PARALLEL_HARD_CAP, int(target)))


def _batch_limits(n_online: int, n_light: int) -> tuple[int, int, int]:
    """返 (B_max 件数, W_max 重量, W_alone 单独成片阈值) · 随在线台数/材料数伸缩。"""
    b_max = _env_int("PACKAGE_DIGEST_BATCH_MAX", 5, 1, 8)
    w_max = _env_int("PACKAGE_DIGEST_BATCH_W_MAX", 8, 1, 40)
    w_alone = _env_int("PACKAGE_DIGEST_BATCH_W_ALONE", 6, 1, 40)
    n_online = max(0, int(n_online or 0))
    n_light = max(0, int(n_light or 0))
    # 节点多、轻材料不多 → 少合批，吃并行
    if n_online >= 4 and n_light <= n_online * 2:
        b_max = min(b_max, 2)
        w_max = min(w_max, 4)
    # 节点少、轻材料多 → 多合批，砍冷启动
    elif n_online <= 2 and n_light >= 8:
        b_max = min(8, max(b_max, 5))
        w_max = max(w_max, 12)
    return b_max, w_max, w_alone


def _shard_item_weight(meta: dict[str, Any]) -> int:
    """批装箱重量 · OCR 页当量。"""
    tt = str(meta.get("task_type") or "")
    try:
        pages = int(meta.get("part_pages") or meta.get("pdf_page_count") or 0)
    except (TypeError, ValueError):
        pages = 0
    try:
        size = int(meta.get("material_size") or 0)
    except (TypeError, ValueError):
        size = 0
    if tt == "ocr_image":
        return 1
    if tt == "pdf_to_text":
        if pages <= 0:
            pages = max(1, size // (200 * 1024)) if size else 1
        return max(1, (pages + 1) // 2)
    if tt == "pdf_ocr":
        if pages <= 0:
            pages = max(1, size // _EST_SCAN_BYTES_PER_PAGE) if size else 1
        return max(1, pages)
    return 10**9


def _is_batchable_shard(sh: Shard) -> bool:
    meta = sh.metadata or {}
    tt = str(meta.get("task_type") or "")
    if tt not in _BATCHABLE_TASKS:
        return False
    if meta.get("batch"):
        return False
    if int(meta.get("page_part_total") or 1) > 1:
        return False
    if meta.get("physical_split"):
        return False
    # 已有页范围的逻辑大切片不进批
    sm = meta.get("slice_meta") or {}
    if isinstance(sm, dict) and (
        sm.get("page_start") is not None or sm.get("page_pct_start") is not None
    ):
        return False
    ref = str(sh.input_ref or "").strip()
    if not ref:
        return False
    return True


def coalesce_light_shards(
    shards: list[Shard],
    *,
    n_online: int = 1,
    b_max: int | None = None,
    w_max: int | None = None,
    w_alone: int | None = None,
) -> list[Shard]:
    """把轻量同构单片合成 multi_file 批片。

    不变量:
      - 不同 task_type 不混批
      - 重 PDF / 已页切 / 物理拆 不进批
      - 批片 metadata.batch_cost = 件数(观测用); 调度仍按 1 进程占 1 并发位
    """
    if not shards or not _flex_batch_enabled():
        return shards

    light = [sh for sh in shards if _is_batchable_shard(sh)]
    if len(light) < 2:
        return shards

    lb, lw, la = _batch_limits(n_online, len(light))
    b_max = lb if b_max is None else max(1, min(8, int(b_max)))
    w_max = lw if w_max is None else max(1, min(40, int(w_max)))
    w_alone = la if w_alone is None else max(1, min(40, int(w_alone)))
    if b_max <= 1:
        return shards

    from collections import defaultdict

    fixed: list[tuple[int, Shard]] = []
    by_tt: dict[str, list[tuple[int, Shard]]] = defaultdict(list)
    for idx, sh in enumerate(shards):
        if _is_batchable_shard(sh):
            tt = str((sh.metadata or {}).get("task_type") or "")
            by_tt[tt].append((idx, sh))
        else:
            fixed.append((idx, sh))

    packed: list[tuple[int, Shard]] = []
    for tt, items in by_tt.items():
        items.sort(key=lambda x: (
            int((x[1].metadata or {}).get("material_index", x[0]) or 0),
            x[0],
        ))
        cur: list[tuple[int, Shard]] = []
        cur_w = 0

        def _flush() -> None:
            nonlocal cur, cur_w
            if not cur:
                return
            if len(cur) == 1:
                packed.append(cur[0])
            else:
                packed.append((cur[0][0], _merge_into_batch_shard([x[1] for x in cur])))
            cur = []
            cur_w = 0

        for item in items:
            sh = item[1]
            w = _shard_item_weight(sh.metadata or {})
            if w >= w_alone:
                _flush()
                packed.append(item)
                continue
            if cur and (len(cur) >= b_max or cur_w + w > w_max):
                _flush()
            cur.append(item)
            cur_w += w
        _flush()

    merged = fixed + packed
    merged.sort(key=lambda x: x[0])
    out = [sh for _, sh in merged]
    n = len(out)
    for i, sh in enumerate(out):
        sh.index = i
        sh.total = n
    logger.info(
        "package_recipe.flex_batch · online=%d light=%d → shards %d→%d "
        "(B_max=%d W_max=%d W_alone=%d)",
        n_online, len(light), len(shards), n, b_max, w_max, w_alone,
    )
    return out


def _merge_into_batch_shard(parts: list[Shard]) -> Shard:
    """N 个同构轻片 → 1 个 multi_file 批片。"""
    base = parts[0]
    meta0 = dict(base.metadata or {})
    items: list[dict[str, Any]] = []
    refs: list[str] = []
    total_size = 0
    total_pages = 0
    timeouts: list[int] = []
    weights: list[int] = []
    mems: list[int] = []

    for p in parts:
        m = dict(p.metadata or {})
        ref = str(p.input_ref or "").strip()
        if not ref:
            refs_m = m.get("input_refs") or []
            ref = str(refs_m[0]) if refs_m else ""
        refs.append(ref)
        try:
            sz = int(m.get("material_size") or 0)
        except (TypeError, ValueError):
            sz = 0
        try:
            pg = int(m.get("part_pages") or m.get("pdf_page_count") or 0)
        except (TypeError, ValueError):
            pg = 0
        total_size += sz
        total_pages += pg
        timeouts.append(int(m.get("timeout_s") or 120))
        weights.append(int(m.get("dispatch_weight") or 1))
        mems.append(int(m.get("min_memory_mb") or 0))
        items.append({
            "material_index": int(m.get("material_index", 0) or 0),
            "material_name": str(m.get("material_name") or ""),
            "material_ext": str(m.get("material_ext") or ""),
            "material_size": sz,
            "pdf_page_count": pg or None,
            "input_ref": ref,
            "route_reason": m.get("route_reason"),
            "task_type": m.get("task_type"),
        })

    # 超时: 首件全额 + 其余 55% (同进程摊冷启动)
    timeouts_sorted = sorted(timeouts, reverse=True)
    timeout_s = timeouts_sorted[0] + int(sum(timeouts_sorted[1:]) * 0.55)
    timeout_s = max(60, min(1800, timeout_s))

    short = "+".join((it["material_name"] or "?")[:16] for it in items[:3])
    if len(items) > 3:
        short += f"+{len(items) - 3}"

    meta0.update({
        "input_kind": "multi_file",
        "input_refs": refs,
        "batch": True,
        "batch_cost": len(parts),
        "batch_items": items,
        "material_index": min(int(it["material_index"]) for it in items),
        "material_name": f"batch×{len(parts)}:{short}",
        "material_size": total_size,
        "pdf_page_count": total_pages or None,
        "page_part_index": 0,
        "page_part_total": 1,
        "part_pages": None,
        "physical_split": False,
        "slice_meta": {},
        "timeout_s": timeout_s,
        "dispatch_weight": sum(weights) or len(parts),
        "min_memory_mb": max(mems) if any(mems) else None,
        "params": _shard_task_params(str(meta0.get("task_type") or "")),
    })

    return Shard(
        workload_id=base.workload_id,
        index=base.index,
        total=base.total,
        status=ShardStatus.PENDING,
        input_ref=refs[0] if refs else "",
        metadata=meta0,
    )


def _max_shards_budget(workload: Workload) -> int:
    """用户/注册表上限 · 硬顶 100 (真正并行还受在线台数约束)。"""
    try:
        from platform_v8.engine.task_registry import get_spec
        limit = int(get_spec("package_digest").max_shards_limit or _PARALLEL_HARD_CAP)
    except Exception:
        limit = _PARALLEL_HARD_CAP
    limit = max(1, min(_PARALLEL_HARD_CAP, limit))
    req = int(getattr(workload.spec, "max_shards", 0) or 0)
    if req > 0:
        return max(1, min(req, limit))
    return limit


def _page_parts_for(material: dict[str, Any], route: recipes.FileRoute) -> int:
    """重 PDF 二次切分数 · 优先真页数 · 轻文件 / 非 PDF 返回 1。"""
    tt = (route.task_type or "").strip()
    size = int(material.get("size") or 0)
    pages = material.get("pdf_page_count")
    try:
        pages_i = int(pages) if pages is not None else 0
    except (TypeError, ValueError):
        pages_i = 0
    has_real_page_count = pages_i > 0 and not material.get("pdf_page_count_approx")
    # 无页数时用体积估, 避免超大扫描件被当成 1 片
    if pages_i <= 0 and tt in ("pdf_ocr", "pdf_to_text") and size > 0:
        pages_i = _estimate_scan_pages(size)
        material["pdf_page_count"] = pages_i
        material["pdf_page_count_approx"] = True
    parts_max = _pdf_parts_max()
    pp_ocr = _pages_per_part_ocr()
    pp_text = _pages_per_part_text()

    if tt == "pdf_ocr":
        if has_real_page_count:
            if pages_i <= _MIN_PAGES_TO_SPLIT_OCR:
                return 1
            import math
            return max(2, min(parts_max, math.ceil(pages_i / pp_ocr)))
        if size < _PDF_OCR_SPLIT_BYTES:
            return 1
        if size >= 50 * 1024 * 1024:
            return min(parts_max, 16)
        if size >= 20 * 1024 * 1024:
            return min(parts_max, 10)
        if size >= 8 * 1024 * 1024:
            return min(parts_max, 6)
        return 2

    if tt == "pdf_to_text":
        if has_real_page_count:
            if pages_i < _MIN_PAGES_TO_SPLIT_TEXT:
                return 1
            import math
            return max(2, min(parts_max, math.ceil(pages_i / pp_text)))
        if size < _PDF_TEXT_SPLIT_BYTES:
            return 1
        if size >= 50 * 1024 * 1024:
            return min(parts_max, 8)
        if size >= 30 * 1024 * 1024:
            return min(parts_max, 4)
        return 2
    return 1


def _max_parts_for_material(material: dict[str, Any], route: recipes.FileRoute) -> int:
    """该材料理论上最多可切几片(受页数/体积上限约束)。"""
    tt = (route.task_type or "").strip()
    if tt not in ("pdf_ocr", "pdf_to_text"):
        return 1
    parts_max = _pdf_parts_max()
    try:
        pages_i = int(material.get("pdf_page_count") or 0)
    except (TypeError, ValueError):
        pages_i = 0
    if pages_i > 0:
        return max(1, min(parts_max, pages_i))
    size = int(material.get("size") or 0)
    if tt == "pdf_ocr" and size >= _PDF_OCR_SPLIT_BYTES:
        return parts_max
    if tt == "pdf_to_text" and size >= _PDF_TEXT_SPLIT_BYTES:
        return min(parts_max, 16)
    return 1


def _expand_parts_for_workers(
    part_plan: list[tuple[dict[str, Any], recipes.FileRoute, int]],
    budget: int,
    n_workers: int,
) -> list[tuple[dict[str, Any], recipes.FileRoute, int]]:
    """片数少于预算时拉高大 PDF, 吃满在线台数。

    n_workers / budget 均应为「真实在线可跑台数」导出的目标(≤100),
    不再接受虚增的 max_shards。
    """
    if budget < 1:
        budget = 1
    plan = [(m, r, max(1, int(n))) for m, r, n in part_plan]
    total = sum(n for _, _, n in plan)
    target = min(budget, max(total, int(n_workers or 0)))
    if target <= total:
        return plan

    # 优先给 pdf_ocr / 大体积加片
    def _grow_score(item: tuple[dict[str, Any], recipes.FileRoute, int]) -> int:
        m, r, n = item
        cap = _max_parts_for_material(m, r)
        if n >= cap:
            return -1
        tt = (r.task_type or "").strip()
        score = 0
        if tt == "pdf_ocr":
            score += 1000
        elif tt == "pdf_to_text":
            score += 500
        score += min(int(m.get("size") or 0) // (1024 * 1024), 200)
        score += min(int(m.get("pdf_page_count") or 0), 200)
        score += (cap - n)  # 还有余量的优先
        return score

    guard = 0
    while sum(n for _, _, n in plan) < target and guard < 10_000:
        guard += 1
        idx = max(range(len(plan)), key=lambda i: _grow_score(plan[i]))
        if _grow_score(plan[idx]) < 0:
            break
        m, r, n = plan[idx]
        plan[idx] = (m, r, n + 1)
    return plan


def _parts_floor(material: dict[str, Any], route: recipes.FileRoute) -> int:
    """压缩保底(page_first): pdf_ocr 按页需求不可被压成整包 1 片。"""
    tt = (route.task_type or "").strip()
    if tt == "pdf_ocr":
        return max(1, _page_parts_for(material, route))
    return 1


def _parts_floor_node_pack(material: dict[str, Any], route: recipes.FileRoute) -> int:
    """node_pack 保底: 允许压成 1 片/材料（一片内多页串行 · 一次冷启动）。

    仅超大扫描件保留少量切分，避免单片超时。
    """
    tt = (route.task_type or "").strip()
    if tt != "pdf_ocr":
        return 1
    try:
        pages = int(material.get("pdf_page_count") or 0)
    except (TypeError, ValueError):
        pages = 0
    size = int(material.get("size") or 0)
    if pages <= 0 and size > 0:
        pages = _estimate_scan_pages(size)
    if pages >= 120:
        # ~50 页/片保底 · 仍远少于旧版 20 页/片
        return max(2, min(6, (pages + 49) // 50))
    if pages >= 60:
        return 2
    return 1


def _fit_parts_to_budget(
    part_plan: list[tuple[dict[str, Any], recipes.FileRoute, int]],
    budget: int,
    *,
    mode: str = "page_first",
) -> list[tuple[dict[str, Any], recipes.FileRoute, int]]:
    """总片数超预算时压缩。

    page_first: OCR 页切保底（旧行为 · 易打出 65 片）
    node_pack: 软保底 · 预算不被 floor_sum 抬高
    """
    if budget < 1:
        budget = 1
    if mode == "node_pack":
        floors = [_parts_floor_node_pack(m, r) for m, r, _ in part_plan]
    else:
        floors = [_parts_floor(m, r) for m, r, _ in part_plan]
    plan = [
        (m, r, max(floors[i], int(n)))
        for i, (m, r, n) in enumerate(part_plan)
    ]
    floor_sum = sum(floors)
    if mode != "node_pack":
        # 旧: 扫描件页切优先于「≈在线台数」预算
        budget = max(budget, min(_PARALLEL_HARD_CAP, floor_sum))
    else:
        # 新: 预算贴节点目标; 若材料保底之和更大则只能升到 floor_sum
        # （材料数本身 > target 时由后续 flex_batch 再合）
        if floor_sum > budget:
            budget = min(_PARALLEL_HARD_CAP, floor_sum)

    while sum(n for _, _, n in plan) > budget:
        # 只削高于保底的片 · 优先削非 OCR / 余量最大的
        def _cut_score(i: int) -> int:
            m, r, n = plan[i]
            if n <= floors[i]:
                return -1
            tt = (r.task_type or "").strip()
            # 余量越大越先削; 非 pdf_ocr 优先削
            score = (n - floors[i]) * 10
            if tt != "pdf_ocr":
                score += 1000
            return score

        idx = max(range(len(plan)), key=_cut_score)
        if _cut_score(idx) < 0:
            break
        m, r, n = plan[idx]
        plan[idx] = (m, r, n - 1)

    # 保底之和仍超硬顶 → 最后才压 pdf_ocr(每份至少 2, 除非本来就是 1)
    while sum(n for _, _, n in plan) > budget:
        cands = [
            i for i, (m, r, n) in enumerate(plan)
            if (r.task_type or "").strip() == "pdf_ocr" and n > 2
        ]
        if not cands:
            break
        idx = max(cands, key=lambda i: plan[i][2])
        m, r, n = plan[idx]
        plan[idx] = (m, r, n - 1)

    # 仍超预算(材料数 > budget) → 截断材料(极端)
    if sum(n for _, _, n in plan) > budget:
        kept: list[tuple[dict[str, Any], recipes.FileRoute, int]] = []
        used = 0
        for m, r, n in plan:
            if used >= budget:
                break
            take = min(n, budget - used)
            kept.append((m, r, take))
            used += take
        plan = kept
    return plan


def _should_physical_split(
    material: dict[str, Any],
    route: recipes.FileRoute,
    n_parts: int,
) -> bool:
    """仅中等扫描 PDF 物理拆。超大文件逻辑页切, 避免 API 同步下传数 GB。"""
    if n_parts <= 1:
        return False
    if (route.task_type or "").strip() != "pdf_ocr":
        return False
    if not str(material.get("input_ref") or "").startswith(
        ("http://", "https://", "v8/account-", "uploads/tenant_")
    ):
        return False
    try:
        pages_i = int(material.get("pdf_page_count") or 0)
    except (TypeError, ValueError):
        pages_i = 0
    size = int(material.get("size") or 0)
    max_bytes = _physical_split_max_bytes()
    max_pages = _physical_split_max_pages()
    if size > max_bytes or (pages_i > 0 and pages_i > max_pages):
        logger.info(
            "package_recipe · skip physical_split (too large) · %s size=%d pages=%d "
            "→ logical page_range",
            material.get("name"), size, pages_i,
        )
        return False
    if pages_i >= _PHYSICAL_SPLIT_MIN_PAGES:
        return True
    if size >= _PHYSICAL_SPLIT_MIN_BYTES:
        return True
    return False


def _physical_split_parallel(
    workload: Workload,
    part_plan: list[tuple[dict[str, Any], recipes.FileRoute, int]],
) -> dict[int, list[str]]:
    """中等文件并行物理拆; 失败则该材料回退逻辑页切。"""
    from concurrent.futures import ThreadPoolExecutor, as_completed

    jobs: list[tuple[dict[str, Any], int]] = []
    for mat, route, n_parts in part_plan:
        if _should_physical_split(mat, route, n_parts):
            jobs.append((mat, int(n_parts)))
    if not jobs:
        return {}

    part_refs_map: dict[int, list[str]] = {}
    workers = max(1, min(_PHYSICAL_SPLIT_PARALLEL, len(jobs)))
    logger.info(
        "package_recipe · physical_split parallel jobs=%d workers=%d",
        len(jobs), workers,
    )

    def _one(mat: dict[str, Any], n_parts: int) -> tuple[int, list[str] | None, int]:
        mid = int(mat.get("index") or 0)
        refs = _physical_split_pdf_parts(workload, material=mat, n_parts=n_parts)
        return mid, refs, n_parts

    with ThreadPoolExecutor(max_workers=workers) as pool:
        futs = [pool.submit(_one, mat, n) for mat, n in jobs]
        for fut in as_completed(futs):
            try:
                mid, refs, n_parts = fut.result()
            except Exception as exc:
                logger.warning("package_recipe · physical_split worker err: %s", exc)
                continue
            name = next(
                (m.get("name") for m, n in jobs if int(m.get("index") or 0) == mid),
                f"mat_{mid}",
            )
            if refs and len(refs) == n_parts:
                part_refs_map[mid] = refs
                logger.info(
                    "package_recipe · physical_split ok · %s parts=%d", name, n_parts,
                )
            else:
                logger.warning(
                    "package_recipe · physical_split fallback page_range · %s", name,
                )
    return part_refs_map


def _touch_slicing_heartbeat(workload_id: Any) -> None:
    try:
        from platform_v8.storage import db as db_mod
        from platform_v8.storage.repo import WorkloadRepo
        with db_mod.session_scope() as s:
            WorkloadRepo.touch_slicing(s, str(workload_id))
            s.commit()
    except Exception as exc:
        logger.debug("package_recipe · touch_slicing skip: %s", exc)


def _page_ranges(page_count: int, n_parts: int) -> list[tuple[int, int]]:
    """0-index 右开区间列表。"""
    n_parts = max(1, min(int(n_parts), max(1, page_count)))
    base, extra = divmod(page_count, n_parts)
    ranges: list[tuple[int, int]] = []
    start = 0
    for i in range(n_parts):
        count = base + (1 if i < extra else 0)
        end = min(page_count, start + count)
        ranges.append((start, end))
        start = end
    return ranges


def _physical_split_pdf_parts(
    workload: Workload,
    *,
    material: dict[str, Any],
    n_parts: int,
) -> list[str] | None:
    """下载一次大 PDF → 按页拆小 PDF 上传 · 失败返 None(调用方回退 page_pct)。"""
    url = str(material.get("input_ref") or "")
    if not url:
        return None
    try:
        import fitz  # PyMuPDF
    except Exception as exc:
        logger.warning("package_recipe · physical_split 无 PyMuPDF: %s", exc)
        return None

    _touch_slicing_heartbeat(workload.id)
    tmpdir = tempfile.mkdtemp(prefix=f"pkg_psplit_{str(workload.id)[:8]}_")
    try:
        src_path = os.path.join(tmpdir, "src.pdf")
        max_bytes = _max_zip_bytes()
        _download_to_file(
            url, src_path, max_bytes=max_bytes, owner_id=int(workload.owner_id),
        )
        _touch_slicing_heartbeat(workload.id)

        doc = fitz.open(src_path)
        try:
            page_count = int(len(doc))
            if page_count < 2:
                return None
            # 若探测页数缺失/不准, 以实际页数为准重算区间
            ranges = _page_ranges(page_count, n_parts)
            if len(ranges) != n_parts:
                n_parts = len(ranges)
            refs: list[str] = []
            mat_index = int(material.get("index") or 0)
            safe_base = "".join(
                c if c.isalnum() or c in "._-" else "_"
                for c in (material.get("name") or "doc.pdf")
            )[:60]
            for part_i, (start, end) in enumerate(ranges):
                if end <= start:
                    continue
                out_path = os.path.join(tmpdir, f"part_{part_i:04d}.pdf")
                out = fitz.open()
                try:
                    out.insert_pdf(doc, from_page=start, to_page=end - 1)
                    out.save(out_path, deflate=True, garbage=3)
                finally:
                    out.close()
                put_url = _upload_file(
                    workload,
                    filename=f"{safe_base}.p{part_i:03d}.pdf",
                    path=out_path,
                    index=mat_index * 1000 + part_i,
                )
                try:
                    os.remove(out_path)
                except OSError:
                    pass
                if not put_url:
                    logger.warning(
                        "package_recipe · physical_split upload fail part=%d", part_i,
                    )
                    return None
                refs.append(put_url)
                if part_i % 4 == 0:
                    _touch_slicing_heartbeat(workload.id)
            if len(refs) != n_parts:
                return None
            material["pdf_page_count"] = page_count
            return refs
        finally:
            doc.close()
    except Exception as exc:
        logger.warning(
            "package_recipe · physical_split error %s: %s",
            material.get("name"), exc,
        )
        return None
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _mk_shard(
    workload: Workload,
    *,
    index: int,
    total: int,
    material: dict[str, Any],
    route: recipes.FileRoute,
    recipe_id: str,
    page_part_index: int = 0,
    page_part_total: int = 1,
    part_input_ref: str | None = None,
) -> Shard:
    name = material["name"]
    size = int(material.get("size") or 0)
    try:
        page_count = int(material.get("pdf_page_count") or 0)
    except (TypeError, ValueError):
        page_count = 0

    physical = bool(part_input_ref)
    slice_meta: dict[str, Any] = {}
    part_pages = 0
    orig_start = orig_end = None
    if page_part_total > 1 and page_count > 0:
        base, extra = divmod(page_count, page_part_total)
        start = 0
        for i in range(page_part_index):
            start += base + (1 if i < extra else 0)
        count = base + (1 if page_part_index < extra else 0)
        end = min(page_count, start + count)
        orig_start, orig_end = start, end
        part_pages = max(0, end - start)

    if physical:
        # 小 PDF 已是完整输入 · 勿再带 page_start 以免二次裁页错位
        slice_meta = {
            "physical_split": True,
            "source_page_start": orig_start,
            "source_page_end": orig_end,
            "source_total_pages": page_count or None,
        }
        input_ref = str(part_input_ref)
        # 体积按份数粗分 · 供调度权重
        part_size = max(1, size // max(1, page_part_total)) if size else 0
    else:
        if page_part_total > 1:
            slice_meta = {"page_index_base": 0}
            if page_count > 0 and orig_start is not None and orig_end is not None:
                slice_meta.update({
                    "page_start": orig_start,
                    "page_end": orig_end,
                    "total_pages": page_count,
                })
            else:
                slice_meta.update({
                    "page_pct_start": page_part_index / page_part_total,
                    "page_pct_end": (page_part_index + 1) / page_part_total,
                })
        input_ref = str(material.get("input_ref") or "")
        part_size = size

    timeout_s = _estimate_part_timeout_s(
        route.task_type, part_pages, part_size or size, page_part_total,
    )
    min_memory_mb = _estimate_min_memory_mb(
        route.task_type, part_pages or page_count, part_size or size,
    )

    return Shard(
        workload_id=workload.id,
        index=index,
        total=total,
        status=ShardStatus.PENDING,
        input_ref=input_ref,
        metadata={
            "slice_strategy": "package_recipe",
            "task_type": route.task_type,
            "code_url": default_code_url(route.task_type),
            "input_kind": route.input_kind,
            "material_name": name,
            "material_index": int(material.get("index", index)),
            "material_ext": material.get("ext") or recipes.ext_of(name),
            "material_size": part_size or size,
            "pdf_page_count": page_count or None,
            "route_reason": route.reason,
            "recipe": recipe_id,
            "page_part_index": page_part_index,
            "page_part_total": page_part_total,
            "part_pages": part_pages or None,
            "physical_split": physical,
            "timeout_s": timeout_s,
            "min_memory_mb": min_memory_mb or None,
            "dispatch_weight": _dispatch_weight(
                route.task_type, page_part_total, part_pages or page_count,
                part_size or size,
            ),
            "slice_meta": slice_meta,
            "params": _shard_task_params(route.task_type),
            "input_refs": [],
        },
    )


def _shard_task_params(task_type: str) -> dict[str, Any]:
    """原子技能默认参数 · pdf_ocr 启用自适应 DPI。"""
    tt = (task_type or "").strip()
    if tt == "pdf_ocr":
        return {
            "dpi_policy": "adaptive",
            "dpi": 96,
            "dpi_max": 200,
        }
    return {}


def _estimate_min_memory_mb(task_type: str, pages: int, size: int) -> int:
    """分片内存门槛 · 弱节点抢不到大 OCR 片。"""
    tt = (task_type or "").strip()
    if tt != "pdf_ocr":
        return 0
    pages = int(pages or 0)
    size = int(size or 0)
    if pages >= 8 or size >= 15 * 1024 * 1024:
        return 4096
    if pages >= 4 or size >= 8 * 1024 * 1024:
        return 2048
    return 2048  # pdf_ocr 默认至少 2G


def _estimate_part_timeout_s(task_type: str, part_pages: int, size: int, parts: int) -> int:
    tt = (task_type or "").strip()
    if part_pages > 0:
        per = 20 if tt == "pdf_ocr" else 3
        return max(60, min(3600, part_pages * per + 30))
    # 无页数: 按体积 / 份数粗估
    mb = max(1, size // (1024 * 1024))
    share = max(1, mb // max(1, parts))
    if tt == "pdf_ocr":
        return max(180, min(3600, share * 40))
    if tt == "pdf_to_text":
        return max(120, min(3600, share * 15))
    return 300


def _dispatch_weight(task_type: str, part_total: int, pages: int, size: int) -> int:
    """越大越优先派 · 重 OCR / 多页 / 大体积先上车。"""
    tt = (task_type or "").strip()
    w = 0
    if tt == "pdf_ocr":
        w += 1000
    elif tt == "pdf_to_text":
        w += 500
    elif tt in ("ocr_image",):
        w += 300
    w += min(int(part_total or 1), 20) * 15
    w += min(int(pages or 0), 200)
    w += min(int(size or 0) // (1024 * 1024), 80)
    return w


def _enumerate_materials(workload: Workload, recipe: recipes.PackageRecipe) -> list[dict[str, Any]]:
    spec = workload.spec
    kind = (spec.input_kind or "").strip() or "archive"
    if kind == "multi_file":
        return _from_multi_file(workload, recipe)
    if kind == "archive":
        return _from_archive(workload, recipe)
    if kind == "single_file" and spec.input_ref:
        name = _guess_name_from_url(spec.input_ref) or "material.bin"
        return [{
            "name": name,
            "ext": recipes.ext_of(name),
            "size": 0,
            "index": 0,
            "input_ref": spec.input_ref,
            "pdf_has_text": None,
        }]
    return []


def _from_multi_file(workload: Workload, recipe: recipes.PackageRecipe) -> list[dict[str, Any]]:
    """多文件直传: 材料已在 OSS · 优先 manifest 元数据 · 仅小 PDF 才整包 probe."""
    refs = list(workload.spec.input_refs or [])
    if not refs and workload.spec.input_ref:
        refs = [workload.spec.input_ref]
    params = workload.spec.params or {}
    names = _names_from_params(params, len(refs))
    sizes = _sizes_from_params(params, len(refs))
    page_counts = _page_counts_from_params(params, len(refs))
    has_texts = _has_text_from_params(params, len(refs))
    out: list[dict[str, Any]] = []
    tmpdir = tempfile.mkdtemp(prefix=f"pkg_mf_{str(workload.id)[:8]}_")
    probe_budget = _probe_full_download_max_bytes()
    try:
        for i, ref in enumerate(refs[: recipe.max_entries]):
            name = names[i] if i < len(names) else (_guess_name_from_url(ref) or f"file_{i}")
            ext = recipes.ext_of(name)
            size = int(sizes[i]) if i < len(sizes) else 0
            pdf_has_text = has_texts[i] if i < len(has_texts) else None
            pdf_page_count = page_counts[i] if i < len(page_counts) else None

            # 内嵌小 zip: 服务端展开成材料(与 archive 对齐)
            if ext == "zip":
                expanded = _expand_remote_zip_material(
                    workload, recipe, url=str(ref), base_index=len(out),
                    work_dir=tmpdir,
                )
                out.extend(expanded)
                continue

            if ext == "pdf":
                if size <= 0:
                    size = _head_content_length(
                        str(ref), owner_id=int(workload.owner_id),
                    ) or 0
                have_pages = isinstance(pdf_page_count, int) and pdf_page_count > 0
                if have_pages:
                    # 客户端已给页数 · 跳过整包 probe(has_text 缺失 → OCR 召回)
                    pass
                elif size > probe_budget:
                    pdf_page_count = _estimate_scan_pages(size)
                    logger.info(
                        "package_recipe · skip full probe · %s size=%d pages≈%s",
                        name, size, pdf_page_count,
                    )
                elif size > 0:
                    probed_has, probed_pages, probed_size = _probe_remote_pdf(
                        str(ref), work_dir=tmpdir, hint_size=size,
                        owner_id=int(workload.owner_id),
                    )
                    if probed_size > 0:
                        size = probed_size
                    if pdf_has_text is None:
                        pdf_has_text = probed_has
                    if not have_pages and probed_pages:
                        pdf_page_count = probed_pages
                else:
                    # 无 size: HEAD 后再决定
                    size = _head_content_length(
                        str(ref), owner_id=int(workload.owner_id),
                    ) or 0
                    if size > probe_budget:
                        pdf_page_count = _estimate_scan_pages(size)
                    elif size > 0:
                        probed_has, probed_pages, probed_size = _probe_remote_pdf(
                            str(ref), work_dir=tmpdir, hint_size=size,
                            owner_id=int(workload.owner_id),
                        )
                        if probed_size > 0:
                            size = probed_size
                        if pdf_has_text is None:
                            pdf_has_text = probed_has
                        if probed_pages:
                            pdf_page_count = probed_pages
            elif size <= 0:
                size = _head_content_length(
                    str(ref), owner_id=int(workload.owner_id),
                ) or 0

            out.append({
                "name": name,
                "ext": ext,
                "size": size,
                "index": len(out),
                "input_ref": ref,
                "pdf_has_text": pdf_has_text,
                "pdf_page_count": pdf_page_count,
            })
        if len(out) > recipe.max_entries:
            out = out[: recipe.max_entries]
        return out
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _names_from_params(params: dict, n: int) -> list[str]:
    del n
    manifest = params.get("file_manifest")
    if isinstance(manifest, list) and manifest:
        names = []
        for item in manifest:
            if isinstance(item, dict) and item.get("name"):
                names.append(str(item["name"]))
            elif isinstance(item, str):
                names.append(item)
        if names:
            return names
    names = params.get("filenames") or params.get("file_names")
    if isinstance(names, list):
        return [str(x) for x in names]
    return []


def _sizes_from_params(params: dict, n: int) -> list[int]:
    del n
    manifest = params.get("file_manifest")
    sizes: list[int] = []
    if isinstance(manifest, list):
        for item in manifest:
            if isinstance(item, dict):
                try:
                    sizes.append(max(0, int(item.get("size") or item.get("size_bytes") or 0)))
                except (TypeError, ValueError):
                    sizes.append(0)
            else:
                sizes.append(0)
    return sizes


def _page_counts_from_params(params: dict, n: int) -> list[int | None]:
    del n
    manifest = params.get("file_manifest")
    out: list[int | None] = []
    if not isinstance(manifest, list):
        return out
    for item in manifest:
        if not isinstance(item, dict):
            out.append(None)
            continue
        raw = (
            item.get("pdf_page_count")
            or item.get("page_count")
            or item.get("pages")
            or item.get("num_pages")
        )
        try:
            v = int(raw) if raw is not None else 0
            out.append(v if v > 0 else None)
        except (TypeError, ValueError):
            out.append(None)
    return out


def _has_text_from_params(params: dict, n: int) -> list[bool | None]:
    del n
    manifest = params.get("file_manifest")
    out: list[bool | None] = []
    if not isinstance(manifest, list):
        return out
    for item in manifest:
        if not isinstance(item, dict):
            out.append(None)
            continue
        if "pdf_has_text" in item:
            val = item.get("pdf_has_text")
        elif "has_text" in item:
            val = item.get("has_text")
        else:
            out.append(None)
            continue
        if val is None:
            out.append(None)
        else:
            out.append(bool(val))
    return out


def _head_content_length(url: str, *, owner_id: int | None = None) -> int:
    try:
        from platform_v8.services.url_safety import URLPolicy, safe_open
        read_url = _materialize_server_url(url, owner_id=owner_id)
        with safe_open(
            read_url,
            method="HEAD",
            headers={"User-Agent": "edge-package-digest/1.0"},
            policy=URLPolicy(timeout=30, max_response_bytes=1),
        ) as resp:
            cl = resp.headers.get("Content-Length")
            return max(0, int(cl)) if cl else 0
    except Exception:
        return 0


def _probe_remote_pdf(
    url: str, *, work_dir: str, hint_size: int = 0, owner_id: int | None = None,
) -> tuple[bool | None, int | None, int]:
    """下载 PDF 到临时文件探测 (has_text, page_count, size). 失败则尽量保留 hint_size."""
    path = os.path.join(work_dir, f"probe_{os.getpid()}_{id(url) % 10_000_000}.pdf")
    max_bytes = _max_zip_bytes()
    try:
        size = _download_to_file(
            url, path, max_bytes=max_bytes, owner_id=owner_id,
        )
        has, pages = recipes.probe_pdf_info(path)
        return has, pages, size
    except PackageSliceError:
        return None, None, max(0, int(hint_size or 0))
    except Exception as exc:
        logger.warning("package_recipe · remote pdf probe fail: %s", exc)
        return None, None, max(0, int(hint_size or 0))
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def _expand_remote_zip_material(
    workload: Workload,
    recipe: recipes.PackageRecipe,
    *,
    url: str,
    base_index: int,
    work_dir: str,
) -> list[dict[str, Any]]:
    """multi_file 里的 zip 成员 → 展开后 re-upload 各材料."""
    zip_path = os.path.join(work_dir, f"nested_{base_index}.zip")
    out: list[dict[str, Any]] = []
    try:
        _download_to_file(
            url,
            zip_path,
            max_bytes=_max_zip_bytes(),
            owner_id=int(workload.owner_id),
        )
        with zipfile.ZipFile(zip_path) as zf:
            for j, (arcname, member_path, member_size) in enumerate(
                _iter_flat_zip_files(
                    zf, work_dir=work_dir, max_depth=max(0, recipe.max_zip_depth - 1),
                )
            ):
                if base_index + len(out) >= recipe.max_entries:
                    break
                filename = arcname.rsplit("/", 1)[-1] or f"nested_{j}"
                ext = recipes.ext_of(filename)
                pdf_has_text = None
                pdf_page_count = None
                if ext == "pdf":
                    pdf_has_text, pdf_page_count = recipes.probe_pdf_info(member_path)
                put_url = _upload_file(
                    workload, filename=filename, path=member_path, index=base_index + j,
                )
                try:
                    os.remove(member_path)
                except OSError:
                    pass
                if not put_url:
                    logger.warning("package_recipe · nested zip 上传失败 · %s", arcname)
                    continue
                out.append({
                    "name": filename,
                    "ext": ext,
                    "size": int(member_size),
                    "index": base_index + len(out),
                    "input_ref": put_url,
                    "pdf_has_text": pdf_has_text,
                    "pdf_page_count": pdf_page_count,
                })
    except Exception as exc:
        logger.warning("package_recipe · expand remote zip fail: %s", exc)
    finally:
        try:
            os.remove(zip_path)
        except OSError:
            pass
    return out


def _max_zip_bytes() -> int:
    raw = os.environ.get("PACKAGE_DIGEST_MAX_ZIP_BYTES", str(_DEFAULT_MAX_ZIP_BYTES))
    try:
        return max(1, int(raw))
    except (TypeError, ValueError):
        return _DEFAULT_MAX_ZIP_BYTES


def _download_timeout_s(max_bytes: int) -> int:
    """大包按体积放宽超时 · 约每 10MB +1s, 夹在 120~3600。"""
    mb = max(1, int(max_bytes) // (1024 * 1024))
    return max(_DOWNLOAD_TIMEOUT_BASE, min(3600, _DOWNLOAD_TIMEOUT_BASE + mb // 10))


def _from_archive(workload: Workload, recipe: recipes.PackageRecipe) -> list[dict[str, Any]]:
    """落盘流式拆包: zip 不整包进内存 · 逐材料抽取/探测/上传后释放。"""
    url = workload.spec.input_ref
    if not url:
        raise PackageSliceError("missing_input_ref", "archive 缺少 input_ref")

    max_bytes = _max_zip_bytes()
    tmpdir = tempfile.mkdtemp(prefix=f"pkg_digest_{str(workload.id)[:8]}_")
    try:
        zip_path = os.path.join(tmpdir, "package.zip")
        zip_size = _download_to_file(
            url, zip_path, max_bytes=max_bytes, owner_id=int(workload.owner_id),
        )
        logger.info(
            "package_recipe · archive downloaded · workload=%s size=%d max=%d path=%s",
            workload.id, zip_size, max_bytes, zip_path,
        )
        try:
            zf = zipfile.ZipFile(zip_path)
        except zipfile.BadZipFile as exc:
            raise PackageSliceError("bad_zip", f"无法解析 zip: {exc}") from exc

        out: list[dict[str, Any]] = []
        upload_failures: list[str] = []
        with zf:
            for i, (arcname, member_path, member_size) in enumerate(
                _iter_flat_zip_files(
                    zf,
                    work_dir=tmpdir,
                    max_depth=recipe.max_zip_depth,
                )
            ):
                if i >= recipe.max_entries:
                    logger.warning(
                        "package_recipe · 超过 max_entries=%d · 截断其余",
                        recipe.max_entries,
                    )
                    break
                ext = recipes.ext_of(arcname)
                pdf_has_text = None
                pdf_page_count = None
                if ext == "pdf":
                    pdf_has_text, pdf_page_count = recipes.probe_pdf_info(member_path)
                filename = arcname.rsplit("/", 1)[-1] or f"file_{i}"
                logger.info(
                    "package_recipe · material %d · %s size=%d pages=%s · uploading",
                    i, filename, member_size, pdf_page_count,
                )
                put_url = _upload_file(
                    workload,
                    filename=filename,
                    path=member_path,
                    index=i,
                )
                try:
                    os.remove(member_path)
                except OSError:
                    pass
                if not put_url:
                    logger.warning("package_recipe · 上传失败 · %s", arcname)
                    upload_failures.append(arcname)
                    continue
                logger.info(
                    "package_recipe · material %d · %s uploaded ok",
                    i, filename,
                )
                out.append({
                    "name": filename,
                    "ext": ext,
                    "size": int(member_size),
                    "index": i,
                    "input_ref": put_url,
                    "pdf_has_text": pdf_has_text,
                    "pdf_page_count": pdf_page_count,
                })
        if upload_failures:
            preview = ", ".join(upload_failures[:5])
            more = f" …(+{len(upload_failures) - 5})" if len(upload_failures) > 5 else ""
            raise PackageSliceError(
                "upload_partial",
                f"材料上传失败 {len(upload_failures)} 个: {preview}{more}",
            )
        return out
    finally:
        shutil.rmtree(tmpdir, ignore_errors=True)


def _iter_flat_zip_files(
    zf: zipfile.ZipFile,
    *,
    work_dir: str,
    max_depth: int,
    prefix: str = "",
    depth: int = 0,
    _seq: list[int] | None = None,
) -> Iterator[tuple[str, str, int]]:
    """逐条写出成员到磁盘并 yield (display_name, path, size)."""
    seq = _seq if _seq is not None else [0]
    for info in zf.infolist():
        if info.is_dir():
            continue
        name = info.filename
        if name.startswith("__MACOSX/") or name.endswith(".DS_Store"):
            continue
        base = name.rsplit("/", 1)[-1]
        if not base:
            continue
        display = f"{prefix}{base}" if prefix else base
        seq[0] += 1
        safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in base)[:60]
        out_path = os.path.join(work_dir, f"m{depth}_{seq[0]:04d}_{safe}")
        try:
            with zf.open(info) as src, open(out_path, "wb") as dst:
                shutil.copyfileobj(src, dst, length=_DOWNLOAD_CHUNK)
        except Exception as exc:
            logger.warning("package_recipe · 抽取失败 %s: %s", display, exc)
            try:
                os.remove(out_path)
            except OSError:
                pass
            continue

        if recipes.ext_of(base) == "zip" and depth < max_depth:
            try:
                with zipfile.ZipFile(out_path) as nested:
                    yield from _iter_flat_zip_files(
                        nested,
                        work_dir=work_dir,
                        max_depth=max_depth,
                        prefix=f"{display}/",
                        depth=depth + 1,
                        _seq=seq,
                    )
            except Exception as exc:
                logger.warning("package_recipe · 嵌套 zip 失败 %s: %s", display, exc)
            finally:
                try:
                    os.remove(out_path)
                except OSError:
                    pass
            continue

        try:
            size = os.path.getsize(out_path)
        except OSError:
            size = int(getattr(info, "file_size", 0) or 0)
        yield display, out_path, size


def _materialize_server_url(url: str, *, owner_id: int | None) -> str:
    raw = str(url or "").strip()
    if raw.startswith(("v8/account-", "uploads/tenant_")):
        if owner_id is None:
            raise PackageSliceError("invalid_input_ref", "对象 key 缺少 owner 上下文")
        from platform_v8.services.storage_refs import materialize_get_url

        return materialize_get_url(owner_id, raw, _download_timeout_s(_max_zip_bytes()))
    return raw


def _download_to_file(
    url: str,
    dest: str,
    *,
    max_bytes: int,
    owner_id: int | None = None,
) -> int:
    """流式下载到磁盘 · 超限立即中止。返回写入字节数。"""
    timeout = _download_timeout_s(max_bytes)
    from platform_v8.services.url_safety import URLPolicy, safe_open
    read_url = _materialize_server_url(url, owner_id=owner_id)
    with safe_open(
        read_url,
        method="GET",
        headers={"User-Agent": "edge-package-digest/1.0"},
        policy=URLPolicy(timeout=timeout, max_response_bytes=max_bytes),
    ) as resp:
        cl = resp.headers.get("Content-Length")
        if cl:
            try:
                if int(cl) > max_bytes:
                    raise PackageSliceError(
                        "zip_too_large",
                        f"zip 超过上限 {max_bytes} bytes (Content-Length={cl})",
                    )
            except ValueError:
                pass
        written = 0
        with open(dest, "wb") as f:
            while True:
                chunk = resp.read(_DOWNLOAD_CHUNK)
                if not chunk:
                    break
                written += len(chunk)
                if written > max_bytes:
                    raise PackageSliceError(
                        "zip_too_large",
                        f"zip 超过上限 {max_bytes} bytes",
                    )
                f.write(chunk)
    return written


def _download(url: str) -> bytes:
    """兼容旧调用/单测 · 小包仍可读进内存。"""
    max_bytes = _max_zip_bytes()
    with tempfile.NamedTemporaryFile(prefix="pkg_dl_", suffix=".bin", delete=False) as tmp:
        path = tmp.name
    try:
        _download_to_file(url, path, max_bytes=max_bytes)
        with open(path, "rb") as f:
            return f.read()
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def _upload_file(
    workload: Workload,
    *,
    filename: str,
    path: str,
    index: int,
) -> str:
    """从本地文件流式 PUT 到 OSS · 避免大材料二次进内存。"""
    try:
        import requests as _req
        from platform_v8.services.oss_provider import get_oss_provider

        safe = "".join(c if c.isalnum() or c in "._-" else "_" for c in filename)[:80]
        key = f"v8/account-{workload.owner_id}/package/{workload.id}/{index:04d}_{safe}"
        ext = recipes.ext_of(filename)
        ct = "application/octet-stream"
        if ext in recipes.IMAGE_EXTS:
            ct = f"image/{'jpeg' if ext in ('jpg', 'jpeg') else ext}"
        elif ext == "pdf":
            ct = "application/pdf"
        size = os.path.getsize(path)
        # 大文件 PUT 超时放宽 · 约 2s/MB, 夹在 300~3600
        put_timeout = max(300, min(3600, int(size / (1024 * 1024) * 2) + 120))
        oss = get_oss_provider()
        put_info = oss.presign_put(key, content_type=ct, expires=max(600, put_timeout + 60))
        with open(path, "rb") as f:
            r = _req.put(
                put_info.url,
                data=f,
                headers={"Content-Type": ct, "Content-Length": str(size)},
                timeout=put_timeout,
            )
        if r.status_code not in (200, 201):
            logger.warning("package_recipe · OSS PUT fail status=%s", r.status_code)
            return ""
        return key
    except Exception as exc:
        logger.warning("package_recipe · OSS upload error: %s: %s", type(exc).__name__, exc)
        return ""


def _upload_bytes(workload: Workload, *, filename: str, content: bytes, index: int) -> str:
    """兼容旧调用/单测 · 小内容走临时文件再流式上传。"""
    with tempfile.NamedTemporaryFile(prefix="pkg_up_", suffix=".bin", delete=False) as tmp:
        tmp.write(content)
        path = tmp.name
    try:
        return _upload_file(workload, filename=filename, path=path, index=index)
    finally:
        try:
            os.remove(path)
        except OSError:
            pass


def _guess_name_from_url(url: str) -> str:
    try:
        from urllib.parse import urlparse, unquote
        path = unquote(urlparse(url).path or "")
        return path.rsplit("/", 1)[-1] or ""
    except Exception:
        return ""
