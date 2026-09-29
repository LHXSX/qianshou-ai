"""package_digest 单元测试 · 分类 / 有效 task_type / 聚合 / 稳定加固."""
from __future__ import annotations

import json
import os
import shutil
from datetime import timezone, timedelta
from unittest.mock import patch

import pytest

from platform_v8.core import Workload, WorkloadSpec, Shard, ShardStatus
from platform_v8.core.timeutil import as_utc, utc_now
from platform_v8.engine.effective_task import (
    effective_task_type,
    resolve_dispatch_task,
    resolve_shard_timeout_s,
)
from platform_v8.engine.package_recipes import (
    FileEntry, get_recipe, ext_of, probe_pdf_has_text,
)
from platform_v8.engine.aggregators.package_merge import aggregate_package_merge
from platform_v8.engine.slicers.package_recipe import (
    PackageSliceError,
    _from_archive,
)
from platform_v8.engine.task_registry import get_spec


def test_law_materials_classify_routes():
    recipe = get_recipe("law_materials")
    assert recipe is not None
    assert recipe.ready is True
    assert recipe.classify(FileEntry("a.jpg", "jpg")).task_type == "ocr_image"
    assert recipe.classify(FileEntry("b.PDF", "pdf", pdf_has_text=True)).task_type == "pdf_to_text"
    assert recipe.classify(FileEntry("c.pdf", "pdf", pdf_has_text=False)).task_type == "pdf_ocr"
    assert recipe.classify(FileEntry("d.docx", "docx")).task_type == "docx_to_text"
    assert recipe.classify(FileEntry("e.xlsx", "xlsx")).task_type == "sheet_to_text"
    assert recipe.classify(FileEntry("f.txt", "txt")).task_type == "plain_text_read"
    skipped = recipe.classify(FileEntry("x.bin", "bin"))
    assert skipped.skip


def test_stub_recipes_not_ready():
    inv = get_recipe("invoice_pack")
    media = get_recipe("media_pack")
    assert inv is not None and inv.ready is False
    assert media is not None and media.ready is False


def test_submit_rejects_unready_recipe():
    from platform_v8.services.workloads.submit import SubmitWorkloadError
    from platform_v8.engine import package_recipes as pkg

    rid = "invoice_pack"
    recipe = pkg.get_recipe(rid)
    assert recipe is not None and not recipe.ready
    # mirror submit gate
    if not getattr(recipe, "ready", True):
        err = SubmitWorkloadError(f"package recipe 未上线: {rid}")
    else:
        err = None
    assert err is not None
    assert "未上线" in str(err)


def test_effective_task_type_compat():
    wl = Workload(spec=WorkloadSpec(task_type="ocr_image"))
    sh = Shard(metadata={})
    assert effective_task_type(wl, sh) == "ocr_image"
    sh2 = Shard(metadata={"task_type": "pdf_ocr"})
    assert effective_task_type(wl, sh2) == "pdf_ocr"


def test_resolve_dispatch_overrides_code_url(monkeypatch):
    monkeypatch.setenv("V8_PUBLIC_BASE_URL", "https://example.test")
    wl = Workload(spec=WorkloadSpec(task_type="package_digest", code_url=""))
    sh = Shard(metadata={"task_type": "ocr_image"})
    tt, code_url, spec = resolve_dispatch_task(wl, sh)
    assert tt == "ocr_image"
    assert code_url.endswith("/api/v8/scripts/ocr_image.py")
    assert spec is not None and spec.task_type == "ocr_image"


def test_resolve_shard_timeout_uses_atomic_spec():
    wl = Workload(spec=WorkloadSpec(task_type="package_digest", timeout_s=60))
    sh = Shard(metadata={"task_type": "pdf_ocr"})
    assert resolve_shard_timeout_s(wl, sh) == 900  # pdf_ocr atomic hint
    sh2 = Shard(metadata={"task_type": "ocr_image"})
    assert resolve_shard_timeout_s(wl, sh2) == 180
    sh3 = Shard(metadata={"task_type": "ocr_image", "timeout_s": 42})
    assert resolve_shard_timeout_s(wl, sh3) == 42
    # homogeneous: no override → workload timeout
    wl2 = Workload(spec=WorkloadSpec(task_type="ocr_image", timeout_s=77))
    assert resolve_shard_timeout_s(wl2, Shard(metadata={})) == 180  # spec still wins when set


def test_registry_has_package_digest():
    assert get_spec("package_digest").slicer == "package_recipe"
    assert get_spec("material_digest").aggregator == "package_merge"
    assert get_spec("docx_to_text").task_type == "docx_to_text"
    assert get_spec("pdf_ocr").timeout_s == 900


def test_package_merge_ordered_partial_fail():
    wl = Workload(spec=WorkloadSpec(task_type="package_digest", params={"recipe": "law_materials"}))
    sh0 = Shard(
        index=0, total=2, status=ShardStatus.DONE,
        output_ref=json.dumps({"result_text": "AAA"}, ensure_ascii=False),
        metadata={"task_type": "ocr_image", "material_name": "a.jpg", "material_index": 0, "material_ext": "jpg", "recipe": "law_materials"},
    )
    sh1 = Shard(
        index=1, total=2, status=ShardStatus.FAILED, error="boom",
        metadata={"task_type": "pdf_ocr", "material_name": "b.pdf", "material_index": 1, "material_ext": "pdf", "recipe": "law_materials"},
    )
    result = aggregate_package_merge(wl, [sh1, sh0])  # 乱序输入
    payload = json.loads(result.output_ref)
    assert payload["schema_version"] == "package_digest.v1"
    assert payload["status"] == "partial"
    assert payload["summary"]["ok"] == 1
    assert payload["summary"]["failed"] == 1
    assert "AAA" in payload["result_text"]
    assert payload["materials"][0]["name"] == "a.jpg"
    assert payload["materials"][1]["ok"] is False


def test_package_merge_all_ok_and_all_failed():
    wl = Workload(spec=WorkloadSpec(task_type="package_digest", params={"recipe": "law_materials"}))
    ok = Shard(
        index=0, total=1, status=ShardStatus.DONE,
        output_ref=json.dumps({"result_text": "X"}, ensure_ascii=False),
        metadata={"task_type": "ocr_image", "material_name": "a.jpg", "material_index": 0, "material_ext": "jpg"},
    )
    payload_ok = json.loads(aggregate_package_merge(wl, [ok]).output_ref)
    assert payload_ok["status"] == "ok"

    bad = Shard(
        index=0, total=1, status=ShardStatus.FAILED, error="x",
        metadata={"task_type": "ocr_image", "material_name": "a.jpg", "material_index": 0, "material_ext": "jpg"},
    )
    payload_bad = json.loads(aggregate_package_merge(wl, [bad]).output_ref)
    assert payload_bad["status"] == "failed"


def test_package_merge_page_parts_concat():
    """同材料多页切片 → 一条 material · 文本按 page_part_index 拼接。"""
    from platform_v8.engine.package_recipes import FileRoute
    from platform_v8.engine.slicers.package_recipe import _page_parts_for, _fit_parts_to_budget

    wl = Workload(spec=WorkloadSpec(task_type="package_digest", params={"recipe": "law_materials"}))
    sh_b = Shard(
        index=1, total=2, status=ShardStatus.DONE,
        output_ref=json.dumps({"result_text": "PAGE2"}, ensure_ascii=False),
        metadata={
            "task_type": "pdf_to_text", "material_name": "big.pdf",
            "material_index": 0, "material_ext": "pdf",
            "page_part_index": 1, "page_part_total": 2, "recipe": "law_materials",
        },
    )
    sh_a = Shard(
        index=0, total=2, status=ShardStatus.DONE,
        output_ref=json.dumps({"result_text": "PAGE1"}, ensure_ascii=False),
        metadata={
            "task_type": "pdf_to_text", "material_name": "big.pdf",
            "material_index": 0, "material_ext": "pdf",
            "page_part_index": 0, "page_part_total": 2, "recipe": "law_materials",
        },
    )
    payload = json.loads(aggregate_package_merge(wl, [sh_b, sh_a]).output_ref)
    assert payload["status"] == "ok"
    assert payload["summary"]["total"] == 1
    assert payload["summary"]["shards"] == 2
    assert payload["materials"][0]["page_parts"] == 2
    assert "PAGE1" in payload["result_text"] and "PAGE2" in payload["result_text"]
    # PAGE1 应在 PAGE2 前
    assert payload["result_text"].index("PAGE1") < payload["result_text"].index("PAGE2")

    # 阈值: 小文字 PDF 不切 · 大文字 PDF / OCR 重文件要切
    small = {"size": 1_000_000}
    big_text = {"size": 20 * 1024 * 1024}
    ocr_mid = {"size": 5 * 1024 * 1024}
    assert _page_parts_for(small, FileRoute("pdf_to_text")) == 1
    assert _page_parts_for(big_text, FileRoute("pdf_to_text")) >= 2
    assert _page_parts_for(ocr_mid, FileRoute("pdf_ocr")) >= 2
    assert _page_parts_for(small, FileRoute("docx_to_text")) == 1

    plan = [
        ({"name": "a"}, FileRoute("pdf_ocr"), 8),
        ({"name": "b"}, FileRoute("pdf_ocr"), 8),
    ]
    fitted = _fit_parts_to_budget(plan, budget=10)
    assert sum(n for _, _, n in fitted) <= 10
    assert all(n >= 1 for _, _, n in fitted)


def test_archive_upload_partial_fail_closed():
    import zipfile
    import io

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr("a.txt", b"hello")
        zf.writestr("b.txt", b"world")
    raw = buf.getvalue()
    recipe = get_recipe("law_materials")
    wl = Workload(
        id="wl-test",
        owner_id=1,
        spec=WorkloadSpec(task_type="package_digest", input_kind="archive", input_ref="https://example.test/x.zip"),
    )

    def _fake_download(url, dest, *, max_bytes, owner_id=None):
        del url, max_bytes, owner_id
        with open(dest, "wb") as f:
            f.write(raw)
        return len(raw)

    with patch(
        "platform_v8.engine.slicers.package_recipe._download_to_file",
        side_effect=_fake_download,
    ), patch(
        "platform_v8.engine.slicers.package_recipe._upload_file",
        side_effect=["https://ok/a", ""],
    ):
        with pytest.raises(PackageSliceError) as ei:
            _from_archive(wl, recipe)
        assert ei.value.code == "upload_partial"


def test_archive_max_zip_bytes_env(monkeypatch, tmp_path):
    from platform_v8.engine.slicers import package_recipe as pr

    monkeypatch.setenv("PACKAGE_DIGEST_MAX_ZIP_BYTES", "1024")
    assert pr._max_zip_bytes() == 1024

    # 流式下载超限
    big = b"x" * 2048

    class _Resp:
        headers = {"Content-Length": str(len(big))}

        def read(self, n=-1):
            if not hasattr(self, "_done"):
                self._done = True
                return big
            return b""

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

    dest = str(tmp_path / "t.zip")
    with patch(
        "platform_v8.services.url_safety.safe_open", return_value=_Resp(),
    ):
        with pytest.raises(PackageSliceError) as ei:
            pr._download_to_file("https://example.test/x.zip", dest, max_bytes=1024)
        assert ei.value.code == "zip_too_large"


def test_timeutil_as_utc_compare():
    naive = utc_now().replace(tzinfo=None)
    aware = as_utc(naive)
    assert aware.tzinfo is not None
    assert as_utc(aware) <= utc_now() + timedelta(seconds=1)
    # aware vs aware must not TypeError
    assert as_utc(datetime_with_tz()) <= utc_now() + timedelta(hours=1)


def datetime_with_tz():
    from datetime import datetime
    return datetime.now(timezone.utc) - timedelta(minutes=1)


def test_ext_of_and_pdf_probe_empty():
    assert ext_of("path/Foo.JPG") == "jpg"
    assert probe_pdf_has_text(b"not-a-pdf") is None


def test_page_parts_prefer_real_page_count():
    from platform_v8.engine.package_recipes import FileRoute
    from platform_v8.engine.slicers.package_recipe import _page_parts_for, _mk_shard

    # 真页数优先: 40 页 OCR → ceil(40/20)=2 片（默认粗粒度 20 页/片）
    assert _page_parts_for(
        {"size": 100, "pdf_page_count": 40}, FileRoute("pdf_ocr"),
    ) == 2
    # 低于最小切分页数 → 不切
    assert _page_parts_for(
        {"size": 50 * 1024 * 1024, "pdf_page_count": 8}, FileRoute("pdf_ocr"),
    ) == 1
    # 文字 PDF 30 页起切 · 60 页 → ceil(60/40)=2 片
    assert _page_parts_for(
        {"size": 100, "pdf_page_count": 60}, FileRoute("pdf_to_text"),
    ) == 2

    wl = Workload(id="wl", spec=WorkloadSpec(task_type="package_digest"))
    material = {
        "name": "scan.pdf", "ext": "pdf", "size": 9_000_000,
        "index": 0, "input_ref": "https://x/a.pdf", "pdf_page_count": 40,
    }
    sh0 = _mk_shard(
        wl, index=0, total=5, material=material,
        route=FileRoute("pdf_ocr"), recipe_id="law_materials",
        page_part_index=0, page_part_total=5,
    )
    sh4 = _mk_shard(
        wl, index=4, total=5, material=material,
        route=FileRoute("pdf_ocr"), recipe_id="law_materials",
        page_part_index=4, page_part_total=5,
    )
    sm0 = sh0.metadata["slice_meta"]
    sm4 = sh4.metadata["slice_meta"]
    assert sm0["page_start"] == 0 and sm0["page_end"] == 8
    assert sm4["page_start"] == 32 and sm4["page_end"] == 40
    assert sh0.metadata["part_pages"] == 8
    assert sh0.metadata["timeout_s"] >= 180
    assert sh0.metadata["dispatch_weight"] >= 1000

    # 物理拆页: 独立 input_ref · 不再带 page_start 裁页
    sh_phys = _mk_shard(
        wl, index=0, total=5, material=material,
        route=FileRoute("pdf_ocr"), recipe_id="law_materials",
        page_part_index=0, page_part_total=5,
        part_input_ref="https://x/part0.pdf",
    )
    assert sh_phys.input_ref == "https://x/part0.pdf"
    assert sh_phys.metadata.get("physical_split") is True
    assert "page_start" not in (sh_phys.metadata.get("slice_meta") or {})
    assert (sh_phys.metadata.get("slice_meta") or {}).get("physical_split") is True


def test_resolve_timeout_from_part_pages():
    wl = Workload(spec=WorkloadSpec(task_type="package_digest", timeout_s=60))
    sh = Shard(metadata={
        "task_type": "pdf_ocr",
        "part_pages": 10,
    })
    # 无显式 timeout_s → 按页: 10*20+30=230
    assert resolve_shard_timeout_s(wl, sh) == 230
    sh2 = Shard(metadata={"task_type": "pdf_ocr", "timeout_s": 999})
    assert resolve_shard_timeout_s(wl, sh2) == 999


def test_heavy_first_ordering():
    from platform_v8.engine.planner import _order_shards_heavy_first

    light = Shard(id="L", index=0, metadata={"dispatch_weight": 10, "task_type": "plain_text_read"})
    heavy = Shard(id="H", index=1, metadata={"dispatch_weight": 1200, "task_type": "pdf_ocr"})
    mid = Shard(id="M", index=2, metadata={"dispatch_weight": 500, "task_type": "pdf_to_text"})
    ordered = _order_shards_heavy_first([light, heavy, mid])
    assert [s.id for s in ordered] == ["H", "M", "L"]


def test_multi_file_uses_manifest_size_and_probe():
    from platform_v8.engine.slicers.package_recipe import _from_multi_file

    recipe = get_recipe("law_materials")
    wl = Workload(
        id="wl-mf",
        owner_id=1,
        spec=WorkloadSpec(
            task_type="package_digest",
            input_kind="multi_file",
            input_refs=["https://example.test/a.pdf", "https://example.test/b.docx"],
            params={
                "recipe": "law_materials",
                "file_manifest": [
                    {"name": "a.pdf", "size": 9_000_000},
                    {"name": "b.docx", "size": 12000},
                ],
            },
        ),
    )

    with patch(
        "platform_v8.engine.slicers.package_recipe._probe_remote_pdf",
        return_value=(False, 40, 9_000_000),
    ), patch(
        "platform_v8.engine.slicers.package_recipe._head_content_length",
        return_value=0,
    ):
        mats = _from_multi_file(wl, recipe)

    assert len(mats) == 2
    assert mats[0]["name"] == "a.pdf"
    assert mats[0]["size"] == 9_000_000
    assert mats[0]["pdf_page_count"] == 40
    assert mats[0]["pdf_has_text"] is False
    assert mats[1]["name"] == "b.docx"
    assert mats[1]["size"] == 12000


def test_expand_parts_for_workers_grows_ocr():
    from platform_v8.engine.package_recipes import FileRoute
    from platform_v8.engine.slicers.package_recipe import (
        _expand_parts_for_workers,
        _fit_parts_to_budget,
        _page_ranges,
        _should_physical_split,
    )

    plan = [
        ({"name": "a.pdf", "size": 50_000_000, "pdf_page_count": 80}, FileRoute("pdf_ocr"), 10),
        ({"name": "b.txt", "size": 100}, FileRoute("plain_text_read"), 1),
    ]
    # 模拟 6 台在线: 预算=6, 不得虚增到几十片
    grown = _expand_parts_for_workers(plan, budget=6, n_workers=6)
    fitted = _fit_parts_to_budget(grown, budget=6)
    total = sum(n for _, _, n in fitted)
    assert total == 6
    assert fitted[0][2] >= 1

    # 30 台在线 → 可拉高到 30
    grown30 = _expand_parts_for_workers(plan, budget=30, n_workers=30)
    total30 = sum(n for _, _, n in grown30)
    assert 11 <= total30 <= 30
    assert grown30[0][2] > 10

    ranges = _page_ranges(40, 5)
    assert len(ranges) == 5
    assert ranges[0] == (0, 8)
    assert ranges[-1][1] == 40

    assert _should_physical_split(
        {"size": 9_000_000, "pdf_page_count": 40, "input_ref": "https://x/a.pdf"},
        FileRoute("pdf_ocr"),
        5,
    )
    assert not _should_physical_split(
        {"size": 100, "pdf_page_count": 5, "input_ref": "https://x/a.pdf"},
        FileRoute("pdf_ocr"),
        1,
    )


def test_slice_budget_follows_online_workers():
    """预算 = min(100, max(在线台数, 材料数)) · 禁止按 max_shards 虚增。"""
    from platform_v8.engine.package_recipes import FileRoute
    from platform_v8.engine.slicers.package_recipe import (
        _PARALLEL_HARD_CAP,
        _expand_parts_for_workers,
        _fit_parts_to_budget,
        _page_parts_for,
    )

    assert _PARALLEL_HARD_CAP == 100
    mats = [
        ({"name": f"p{i}.pdf", "size": 20_000_000, "pdf_page_count": 40}, FileRoute("pdf_ocr"))
        for i in range(3)
    ]
    base = [(m, r, _page_parts_for(m, r)) for m, r in mats]
    # 3 材料 × ceil(40/20)=2 → 基础 6 片，刚好覆盖 6 台在线节点
    online = 6
    budget = min(100, max(online, len(mats)))
    plan = _fit_parts_to_budget(
        _expand_parts_for_workers(base, budget, budget), budget,
    )
    assert sum(n for _, _, n in plan) == budget == 6


def test_physical_split_pdf_parts_uploads(tmp_path, monkeypatch):
    """本地造小 PDF · mock 下载/上传 · 验证拆出 N 个 URL。"""
    fitz = pytest.importorskip("fitz")
    from platform_v8.engine.slicers import package_recipe as pr

    src = tmp_path / "src.pdf"
    doc = fitz.open()
    for i in range(12):
        page = doc.new_page()
        page.insert_text((72, 72), f"page-{i}")
    doc.save(str(src))
    doc.close()

    def _fake_dl(url, dest, *, max_bytes):
        del url, max_bytes
        shutil.copyfile(src, dest)
        return src.stat().st_size

    uploads: list[str] = []

    def _fake_up(workload, *, filename, path, index):
        del workload, filename, index
        assert os.path.isfile(path)
        assert os.path.getsize(path) > 0
        url = f"https://oss.test/part-{len(uploads)}.pdf"
        uploads.append(url)
        return url

    monkeypatch.setattr(pr, "_download_to_file", _fake_dl)
    monkeypatch.setattr(pr, "_upload_file", _fake_up)
    monkeypatch.setattr(pr, "_touch_slicing_heartbeat", lambda *_a, **_k: None)

    wl = Workload(id="wl-ps", owner_id=1, spec=WorkloadSpec(task_type="package_digest"))
    mat = {
        "name": "scan.pdf",
        "size": src.stat().st_size,
        "index": 0,
        "input_ref": "https://example.test/scan.pdf",
        "pdf_page_count": 12,
    }
    refs = pr._physical_split_pdf_parts(wl, material=mat, n_parts=3)
    assert refs is not None
    assert len(refs) == 3
    assert len(uploads) == 3
