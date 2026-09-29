"""S4-T4 · text_replace 单测
回归 qa_pressure 历史 3/3 失败 bug: 客户端传 {old, new} 但脚本只读 {find, replace}
"""
import pytest


def test_text_replace_basic_find_replace(script_runner):
    """标准用法: stdin JSON 含 params.find/replace"""
    stdin = '{"lines":["hello world","hello again"],"params":{"find":"hello","replace":"hi"}}'
    out = script_runner("text_replace", stdin=stdin)
    assert out["status"] == "ok"
    assert out["result_lines"] == ["hi world", "hi again"]
    assert out["summary"]["replacements"] == 2


def test_text_replace_old_new_alias(script_runner):
    """S4-T4: 兼容 {old, new} 别名(qa_pressure 用的字段)"""
    stdin = '{"lines":["hello world"],"params":{"old":"hello","new":"千手"}}'
    out = script_runner("text_replace", stdin=stdin)
    assert out["status"] == "ok"
    assert out["result_lines"] == ["千手 world"]


def test_text_replace_ec_params(script_runner):
    """S4-T4: stdin 是纯文本, EC_PARAMS 提供 find/replace (executor 真实路径)"""
    out = script_runner(
        "text_replace",
        stdin="hello\nworld\nhello",
        params={"find": "hello", "replace": "hi"},
    )
    assert out["status"] == "ok"
    assert out["result_lines"] == ["hi", "world", "hi"]


def test_text_replace_ec_params_alias(script_runner):
    """S4-T4: EC_PARAMS 走 old/new 别名"""
    out = script_runner(
        "text_replace",
        stdin="hello world",
        params={"old": "hello", "new": "千手"},
    )
    assert out["status"] == "ok"
    assert out["result_lines"] == ["千手 world"]


def test_text_replace_missing_find_fails(script_runner):
    """缺 find/old → 友好错误"""
    with pytest.raises(RuntimeError) as excinfo:
        script_runner("text_replace", stdin="x\ny", params={"replace": "z"})
    assert "find" in str(excinfo.value).lower() or "old" in str(excinfo.value).lower()


def test_text_replace_regex(script_runner):
    """正则模式"""
    stdin = '{"lines":["abc123def","xyz456"],"params":{"find":"[0-9]+","replace":"N","regex":true}}'
    out = script_runner("text_replace", stdin=stdin)
    assert out["status"] == "ok"
    assert out["result_lines"] == ["abcNdef", "xyzN"]
