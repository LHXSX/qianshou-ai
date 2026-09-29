import json
import os
import subprocess
import sys
from pathlib import Path


SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "scripts"
    / "tasks"
    / "json_validate.py"
)


def _run(input_dir: Path) -> dict:
    env = os.environ.copy()
    env["EC_INPUT_KIND"] = "multi_file"
    env["EC_INPUT_DIR"] = str(input_dir)
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        capture_output=True,
        text=True,
        env=env,
        timeout=15,
        check=True,
    )
    return json.loads(proc.stdout.strip())


def test_validate_multi_file_pretty_json(tmp_path):
    (tmp_path / "000-valid.json").write_text(
        json.dumps([{"id": 1}, {"id": 2}], ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    (tmp_path / "001-invalid.json").write_text(
        '{"id": 3,}',
        encoding="utf-8",
    )

    out = _run(tmp_path)

    assert out["summary"]["files_total"] == 2
    assert out["summary"]["total"] == 2
    assert out["summary"]["valid"] == 1
    assert out["summary"]["invalid"] == 1
    assert out["result"][0]["type"] == "list"


def test_validate_multi_file_jsonl_by_line(tmp_path):
    (tmp_path / "000-rows.jsonl").write_text(
        '{"id":1}\n{"id":2}\nnot-json\n',
        encoding="utf-8",
    )

    out = _run(tmp_path)

    assert out["summary"]["files_total"] == 1
    assert out["summary"]["total"] == 3
    assert out["summary"]["valid"] == 2
    assert out["summary"]["invalid"] == 1
    assert [row["line"] for row in out["result"]] == [1, 2, 3]
