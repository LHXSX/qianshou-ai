"""pdf_ocr / package_recipe 引擎守卫: 执行器 · 页切保底 · 假成功 · 快切片策略."""
from __future__ import annotations

from platform_v8.engine.aggregator import _soft_failure_message
from platform_v8.engine.package_recipes import FileRoute
from platform_v8.engine.slicers import package_recipe as pr
from platform_v8.engine.slicers.package_recipe import _fit_parts_to_budget, _page_parts_for
from platform_v8.engine.task_registry import TASK_REGISTRY, Executor


def test_pdf_ocr_executor_is_python3():
    spec = TASK_REGISTRY["pdf_ocr"]
    assert spec.executor == Executor.PYTHON3
    assert not (spec.onnx_model or "").strip()


def test_ocr_image_still_onnx():
    spec = TASK_REGISTRY["ocr_image"]
    assert spec.executor == Executor.ONNX
    assert spec.onnx_model == "rapid_ocr_v1"


def test_soft_fail_decode_image_error():
    payload = (
        '{"status":"ok","task_type":"pdf_ocr","result_text":"","pages":[],'
        '"errors":[{"error":"解码图像失败","page":1}],'
        '"summary":{"pages":0,"pages_failed":1,"total_chars":0}}'
    )
    msg = _soft_failure_message(payload)
    assert msg is not None
    assert "解码图像失败" in msg


def test_soft_fail_skips_blank_ok_ocr():
    payload = (
        '{"status":"ok","task_type":"pdf_ocr","result_text":"",'
        '"pages":[{"page":1,"text":""}],'
        '"summary":{"pages":1,"pages_failed":0,"total_chars":0}}'
    )
    assert _soft_failure_message(payload) is None


def test_fit_keeps_ocr_page_parts_under_small_online_budget():
    route = FileRoute(task_type="pdf_ocr", input_kind="single_file", reason="pdf_scan_or_unknown")
    mat = {"name": "big.pdf", "size": 50 * 1024 * 1024, "pdf_page_count": 40, "index": 0}
    desired = _page_parts_for(mat, route)
    assert desired >= 2
    plan = [(mat, route, desired)]
    for i in range(11):
        light = FileRoute(task_type="docx_to_text", input_kind="single_file", reason="docx")
        plan.append(({"name": f"a{i}.docx", "size": 1000, "index": i + 1}, light, 1))
    fitted = _fit_parts_to_budget(plan, budget=12)
    ocr_parts = fitted[0][2]
    assert ocr_parts == desired, f"ocr parts crushed: {ocr_parts} vs desired {desired}"
    assert sum(n for _, _, n in fitted) >= desired


def test_ocr_pages_per_part_coarser_default():
    assert pr._DEFAULT_PAGES_PER_PART_OCR >= 20
    route = FileRoute(task_type="pdf_ocr", reason="scan")
    mat = {"name": "x.pdf", "size": 10 * 1024 * 1024, "pdf_page_count": 40, "index": 0}
    # 40 页 / 20 ≈ 2 片 (旧 4 页/片会切成 10)
    assert _page_parts_for(mat, route) == 2


def test_huge_pdf_skips_physical_split():
    route = FileRoute(task_type="pdf_ocr", reason="scan")
    mat = {
        "name": "huge.pdf",
        "size": 600 * 1024 * 1024,
        "pdf_page_count": 800,
        "index": 0,
        "input_ref": "https://example.com/huge.pdf",
    }
    assert pr._should_physical_split(mat, route, n_parts=40) is False


def test_medium_pdf_allows_physical_split():
    route = FileRoute(task_type="pdf_ocr", reason="scan")
    mat = {
        "name": "mid.pdf",
        "size": 15 * 1024 * 1024,
        "pdf_page_count": 20,
        "index": 0,
        "input_ref": "https://example.com/mid.pdf",
    }
    assert pr._should_physical_split(mat, route, n_parts=3) is True


def test_manifest_page_counts_parsed():
    params = {
        "file_manifest": [
            {"name": "a.pdf", "size": 100, "pdf_page_count": 12},
            {"name": "b.pdf", "size": 200, "pages": 5},
            {"name": "c.docx", "size": 50},
        ],
    }
    pages = pr._page_counts_from_params(params, 3)
    assert pages == [12, 5, None]


def test_estimate_scan_pages():
    assert pr._estimate_scan_pages(750 * 1024) == 1
    assert pr._estimate_scan_pages(600 * 1024 * 1024) >= 800
