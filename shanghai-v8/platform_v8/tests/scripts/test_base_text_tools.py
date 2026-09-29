"""S4-T4 · 基础文本/编码工具脚本回归 (qa_pressure 用到的全部)"""
import base64
from pathlib import Path

import pytest


def test_base64_encode(script_runner):
    out = script_runner("base64_encode", stdin="Hello 千手")
    assert out.get("status") == "ok"


def test_base64_decode(script_runner):
    out = script_runner("base64_decode", stdin="SGVsbG8gV29ybGQ=")
    assert out.get("status") == "ok"
    assert out["summary"]["items"] == 1
    assert out["result"][0]["decoded"] == "Hello World"


def test_base64_decode_reads_ec_input_dir(script_runner, tmp_path: Path):
    """multi_file 节点只设 EC_INPUT_DIR、stdin 为空 · 必须能读到内容。"""
    (tmp_path / "a.txt").write_text(base64.b64encode(b"one").decode() + "\n", encoding="utf-8")
    (tmp_path / "b.txt").write_text(base64.b64encode(b"two").decode() + "\n", encoding="utf-8")
    (tmp_path / "c.txt").write_text(base64.b64encode(b"three").decode() + "\n", encoding="utf-8")
    out = script_runner(
        "base64_decode",
        stdin="",
        env_extra={"EC_INPUT_DIR": str(tmp_path)},
    )
    assert out.get("status") == "ok"
    assert out["summary"]["items"] == 3
    assert out["summary"]["success"] == 3
    assert [r["decoded"] for r in out["result"]] == ["one", "two", "three"]


def test_base64_encode_reads_ec_input_dir(script_runner, tmp_path: Path):
    (tmp_path / "a.txt").write_text("alpha\n", encoding="utf-8")
    (tmp_path / "b.txt").write_text("beta\n", encoding="utf-8")
    out = script_runner(
        "base64_encode",
        stdin="",
        env_extra={"EC_INPUT_DIR": str(tmp_path)},
    )
    assert out.get("status") == "ok"
    assert out["summary"]["items"] == 2
    assert out["result"][0]["base64"] == base64.b64encode(b"alpha").decode()
    assert out["result"][1]["base64"] == base64.b64encode(b"beta").decode()


def test_text_split(script_runner):
    out = script_runner("text_split", stdin="a\nb\nc")
    assert out.get("status") == "ok"


def test_regex_extract(script_runner):
    out = script_runner(
        "regex_extract",
        stdin="订单 123 金额 456.78",
        params={"pattern": r"\d+(?:\.\d+)?"},
    )
    assert out.get("status") == "ok"


def test_text_mask(script_runner):
    out = script_runner("text_mask", stdin="电话 13812345678 邮箱 test@x.com")
    assert out.get("status") == "ok"


def test_line_count(script_runner):
    out = script_runner("line_count", stdin="\n".join(f"l{i}" for i in range(10)))
    assert out.get("status") == "ok"


def test_word_count(script_runner):
    out = script_runner("word_count", stdin="the quick brown fox " * 5)
    assert out.get("status") == "ok"


def test_md5_batch(script_runner):
    out = script_runner("md5_batch", stdin="hello\nworld")
    assert out.get("status") == "ok"


def test_hash_batch(script_runner):
    out = script_runner("hash_batch", stdin="a\nb")
    assert out.get("status") == "ok"


def test_md5_batch_reads_ec_input_dir(script_runner, tmp_path: Path):
    (tmp_path / "a.txt").write_text("alpha", encoding="utf-8")  # 无尾换行
    (tmp_path / "b.txt").write_text("beta\n", encoding="utf-8")
    out = script_runner("md5_batch", stdin="", env_extra={"EC_INPUT_DIR": str(tmp_path)})
    assert out["status"] == "ok"
    assert out["summary"]["items"] == 2
    assert len(out["result_lines"]) == 2
    assert out["result"][0]["value"] == "alpha"
    assert out["result"][1]["value"] == "beta"


def test_hash_batch_reads_ec_input_dir_sorted(script_runner, tmp_path: Path):
    (tmp_path / "b.txt").write_text("second", encoding="utf-8")
    (tmp_path / "a.txt").write_text("first", encoding="utf-8")
    out = script_runner(
        "hash_batch",
        stdin="",
        params={"algorithm": "md5"},
        env_extra={"EC_INPUT_DIR": str(tmp_path)},
    )
    assert out["status"] == "ok"
    assert out["summary"]["total"] == 2
    assert out["summary"]["algorithm"] == "md5"
    assert [r["input"] for r in out["results"]] == ["first", "second"]
    assert all(len(r["hash"]) == 32 for r in out["results"])


def test_hash_collision_rejects_multi_files(script_runner, tmp_path: Path):
    (tmp_path / "a.txt").write_text("one\n", encoding="utf-8")
    (tmp_path / "b.txt").write_text("two\n", encoding="utf-8")
    with pytest.raises(RuntimeError) as ei:
        script_runner(
            "hash_collision_search",
            stdin="",
            env_extra={"EC_INPUT_DIR": str(tmp_path)},
        )
    assert "只支持单份文本" in str(ei.value)


def test_hash_collision_reads_params(script_runner):
    out = script_runner(
        "hash_collision_search",
        stdin="",
        params={"prefix": "demo", "target_zeros": 3, "max_nonce": 5_000_000},
    )
    assert out["status"] == "ok"
    assert out["summary"]["prefix"] == "demo"
    assert out["summary"]["target_zeros"] == 3
    assert out["summary"]["found"] is True
    assert out["result_lines"][0].startswith("nonce=")


def test_json_validate(script_runner):
    out = script_runner("json_validate", stdin='{"a":1}')
    assert out.get("status") == "ok"


def test_url_parse(script_runner):
    out = script_runner("url_parse", stdin="https://example.com/p?q=1")
    assert out.get("status") == "ok"


def test_encoding_detect(script_runner):
    out = script_runner("encoding_detect", stdin="Hello 中文")
    assert out.get("status") == "ok"


def test_pi_compute(script_runner):
    out = script_runner("pi_compute", stdin="", params={"digits": 100})
    assert out.get("status") == "ok"


def test_monte_carlo(script_runner):
    """monte_carlo 历史脚本无 status 字段,看是否返 result π 估值"""
    out = script_runner("monte_carlo", stdin="", params={"samples": 1000})
    assert "result" in out
    assert 2.5 < float(out["result"]) < 4.0  # π 估值合理范围
