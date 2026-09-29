from platform_v8.engine.task_registry import Executor, get_spec
from platform_v8.scripts.tasks.pdf_ocr import _normalize_paddle_predict, _read_inputs


def test_pdf_ocr_uses_python_page_renderer():
    spec = get_spec("pdf_ocr")

    assert spec.executor == Executor.PYTHON3
    assert spec.required_tier == "ocr"
    assert "multi_file" in spec.accepted_input_kinds


def test_pdf_ocr_reads_every_pdf_from_archive(tmp_path, monkeypatch):
    (tmp_path / "a.pdf").write_bytes(b"%PDF-a")
    (tmp_path / "b.PDF").write_bytes(b"%PDF-b")
    (tmp_path / "ignored.txt").write_text("not a PDF")
    monkeypatch.setenv("EC_INPUT_KIND", "archive")
    monkeypatch.setenv("EC_INPUT_DIR", str(tmp_path))

    assert _read_inputs({}) == [
        ("a.pdf", b"%PDF-a"),
        ("b.PDF", b"%PDF-b"),
    ]


def test_pdf_ocr_default_dpi_starts_at_scan_quality():
    from platform_v8.scripts.tasks.pdf_ocr import _dpi_ladder

    assert _dpi_ladder({})[0] >= 144
    assert 200 in _dpi_ladder({})


def test_pdf_ocr_normalizes_paddle_v3_result():
    raw = [{
        "rec_texts": ["识别成功"],
        "rec_scores": [0.98],
        "rec_polys": [[[1, 2], [3, 2], [3, 4], [1, 4]]],
    }]

    assert _normalize_paddle_predict(raw) == [
        ([[1, 2], [3, 2], [3, 4], [1, 4]], "识别成功", 0.98),
    ]
