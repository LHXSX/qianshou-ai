import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from platform_v8.scripts.tasks import pdf_info


SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "scripts"
    / "tasks"
    / "pdf_info.py"
)


def test_pdf_info_reads_all_pdf_files_from_input_dir(tmp_path, monkeypatch):
    (tmp_path / "000-first.pdf").write_bytes(b"first")
    (tmp_path / "001-second.pdf").write_bytes(b"second")
    (tmp_path / "ignore.txt").write_text("ignore", encoding="utf-8")
    monkeypatch.setenv("EC_INPUT_DIR", str(tmp_path))

    inputs = pdf_info._read_inputs()

    assert inputs == [
        ("000-first.pdf", b"first"),
        ("001-second.pdf", b"second"),
    ]


def test_pdf_info_multi_file_metadata(tmp_path):
    fitz = pytest.importorskip("fitz")
    for index, title in enumerate(("第一份", "第二份")):
        doc = fitz.open()
        doc.new_page()
        doc.set_metadata({"title": title})
        doc.save(tmp_path / f"{index:03d}-{title}.pdf")
        doc.close()

    env = os.environ.copy()
    env["EC_INPUT_KIND"] = "multi_file"
    env["EC_INPUT_DIR"] = str(tmp_path)
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        capture_output=True,
        text=True,
        env=env,
        timeout=15,
        check=True,
    )
    out = json.loads(proc.stdout.strip())

    assert out["status"] == "ok"
    assert out["summary"]["files_ok"] == 2
    assert out["summary"]["pages"] == 2
    assert [item["title"] for item in out["results"]] == ["第一份", "第二份"]
