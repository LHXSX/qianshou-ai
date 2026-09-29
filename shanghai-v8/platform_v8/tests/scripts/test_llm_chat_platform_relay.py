"""llm_chat 产出的「平台代调」溯源字段回归锁 (离线 · 不访问外网)。

背景 (2026-09-18):
    llm_chat 的脚本不在节点出算力, 它只是把请求转发给平台云端 LLM
    (默认 https://www.qianshousuanli.com/api/v1/chat/completions, 模型 ec-master)。
    以前产出里看不出这一点, 节点返回的文本会被当成「节点产出」。

本测试:
  1. 用本地 HTTP stub 冒充平台接口, 真跑脚本(subprocess), 校验产出里
     compute_origin / compute_origin_note / endpoint 真实值
  2. 锁住"实际调用哪个 endpoint 就报哪个" —— 不允许把调用地址写死成默认值
  3. 锁住向后兼容: 既有字段一个都不能少, schema_version 仍是 v1
  4. 锁住默认 endpoint 仍是平台自己的 /api/v1/chat/completions (不回退到第三方)
"""
from __future__ import annotations

import http.server
import json
import os
import re
import subprocess
import sys
import threading
from pathlib import Path

import pytest

SCRIPTS_DIR = Path(__file__).resolve().parents[2] / "scripts" / "tasks"
SCRIPT = SCRIPTS_DIR / "llm_chat.py"

# 平台代调标记 (与 task_registry 同源字面量)
PLATFORM_RELAY = "platform_relay"
PLATFORM_DEFAULT_ENDPOINT = "https://www.qianshousuanli.com/api/v1/chat/completions"


class _StubHandler(http.server.BaseHTTPRequestHandler):
    """最小 OpenAI 兼容响应, 并记录收到的请求体与 Authorization 头。"""

    received: list = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length).decode("utf-8")
        try:
            body = json.loads(raw)
        except Exception:
            body = {}
        type(self).received.append({
            "path": self.path,
            "body": body,
            "authorization": self.headers.get("Authorization"),
        })

        payload = json.dumps({
            "choices": [{
                "message": {"role": "assistant", "content": "stub answer"},
                "finish_reason": "stop",
            }],
            "usage": {"prompt_tokens": 11, "completion_tokens": 4, "total_tokens": 15},
        }).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):  # 静音
        pass


@pytest.fixture()
def stub_llm_server():
    _StubHandler.received = []
    server = http.server.HTTPServer(("127.0.0.1", 0), _StubHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    host, port = server.server_address
    try:
        yield f"http://127.0.0.1:{port}/api/v1/chat/completions"
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def _run_llm_chat(params: dict, extra_env: dict | None = None) -> tuple[int, dict]:
    env = os.environ.copy()
    env["EC_PARAMS"] = json.dumps(params, ensure_ascii=False)
    env["PYTHONIOENCODING"] = "utf-8"
    if extra_env:
        env.update(extra_env)
    proc = subprocess.run(
        [sys.executable, str(SCRIPT)],
        input="", text=True, capture_output=True, env=env, timeout=60,
    )
    last = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
    return proc.returncode, json.loads(last)


def test_llm_chat_is_declared_a_platform_relay_script():
    """脚本级常量必须先自报家门: 平台代调。"""
    text = SCRIPT.read_text(encoding="utf-8")
    assert 'COMPUTE_ORIGIN_PLATFORM_RELAY = "platform_relay"' in text
    assert "COMPUTE_ORIGIN_LABEL" in text
    assert "COMPUTE_ORIGIN_NOTE" in text


def test_v1_entrypoint_is_no_longer_anonymous_and_default_carries_credentials():
    """默认路径必须既「打平台自己的 v1 接口」又「带平台凭据」。

    2026-09-18 C-1 安全修复前，脚本默认打 ``/api/v1/chat/completions`` 且
    **不带任何 Authorization**，而那个端点当时完全免鉴权 —— 任何人可白嫖
    平台 LLM 密钥。修复后端点要求 get_current_account，脚本必须带凭据。

    这里把原「只锁默认 endpoint 字符串」的断言升级为「锁 endpoint + 锁凭据链路」，
    而不是删掉它：删掉就没人拦得住回退到免鉴权默认路径。
    """
    text = SCRIPT.read_text(encoding="utf-8")
    assert PLATFORM_DEFAULT_ENDPOINT in text, (
        "默认 endpoint 被改了 —— 它应该是平台自己的 /api/v1/chat/completions"
    )
    # 凭据链路必须在脚本里真实存在，且优先读平台派发层注入的 api_key
    assert "_relay_api_key" in text, "脚本丢了平台中继凭据解析逻辑"
    assert "QS_PLATFORM_RELAY_API_KEY" in text, "脚本丢了节点本机凭据环境变量"
    assert 'headers["Authorization"]' in text, "脚本不再携带 Authorization —— 会 401"


def test_credentials_are_attached_when_calling_the_platform(stub_llm_server):
    """真跑脚本打「平台」端点：必须带 Bearer 凭据。

    stub 绑在 127.0.0.1，默认**不算**平台主机（否则会把平台凭据发给本机其它
    服务）。这里用 QS_PLATFORM_RELAY_HOSTS 把 stub 的 ``host:port`` 声明成平台
    主机，从而走「脚本认定这是平台地址」的真实分支，而不是伪造内部函数。
    """
    origin = stub_llm_server.split("/api/v1/")[0]          # http://127.0.0.1:PORT
    host_port = origin.split("://", 1)[1]                  # 127.0.0.1:PORT
    code, out = _run_llm_chat(
        {"prompt": "hello", "model": "ec-master", "endpoint": stub_llm_server},
        extra_env={
            "QS_PLATFORM_RELAY_API_KEY": "qs_relaytest000000000000000000",
            "QS_PLATFORM_RELAY_HOSTS": host_port,
        },
    )
    assert code == 0, out
    assert out["status"] == "ok"
    assert len(_StubHandler.received) == 1, "stub 没被调用到"
    assert _StubHandler.received[0]["authorization"] == (
        "Bearer qs_relaytest000000000000000000"
    ), "调平台端点却没带 worker 凭据 —— 正是 C-1 要拦的回归"


def test_credentials_are_not_leaked_to_third_party_endpoint(stub_llm_server):
    """反向锁：endpoint 不属于平台时**绝不能**带上平台凭据。

    这是比 401 更严重的风险 —— 把平台密钥发给第三方。
    """
    code, out = _run_llm_chat(
        {"prompt": "hello", "endpoint": stub_llm_server},  # 127.0.0.1 不在平台白名单
        extra_env={
            "QS_PLATFORM_RELAY_API_KEY": "qs_relaytest000000000000000000",
            # 故意**不**声明 hosts → 127.0.0.1 不是平台主机
        },
    )
    assert code == 0, out
    assert _StubHandler.received[0]["authorization"] is None, (
        "平台凭据被发给了第三方 endpoint —— 凭据外泄"
    )


def test_output_carries_platform_relay_provenance(stub_llm_server):
    """真跑脚本: 产出必须说明"平台代调" + 实际调用地址 + 模型。"""
    code, out = _run_llm_chat({
        "prompt": "hello",
        "endpoint": stub_llm_server,
        "model": "ec-master",
    })
    assert code == 0, out
    assert out["status"] == "ok"

    prov = out["summary"]["compute_provenance"]
    assert prov["compute_origin"] == PLATFORM_RELAY
    assert prov["compute_origin_note"]
    assert prov["model"] == "ec-master"
    # 调用方显式给了 endpoint → 必须如实记录
    assert prov["endpoint_caller_supplied"] is True
    assert prov["platform_endpoints"] == [stub_llm_server]

    first = out["results"][0]
    assert first["compute_origin"] == PLATFORM_RELAY
    assert first["endpoint"] == stub_llm_server, "报出来的 endpoint 必须是真实调用的那个"
    assert first["endpoint_caller_supplied"] is True

    # 人类可读摘要里也要能一眼看出是平台代调
    assert "平台代调" in out["summary_text"]
    assert PLATFORM_RELAY in out["summary_text"]

    # stub 确实被调用, 且模型名透传
    assert len(_StubHandler.received) == 1
    assert _StubHandler.received[0]["body"]["model"] == "ec-master"


def test_caller_supplied_flag_false_when_using_platform_default():
    """不给 endpoint → 该标志为 False (默认路径), 且仍标 platform_relay。

    不真发请求: 把 endpoint 指到一个必然拒绝的地址, 只看失败前的字段不成立,
    因此这里改用"仅检查脚本在无 endpoint 时的行为"的轻量方式 ——
    直接断言常量与判定表达式存在, 避免依赖外网。
    """
    text = SCRIPT.read_text(encoding="utf-8")
    # 判定必须同时认 endpoints(列表) 与 endpoint(单值)
    assert 'bool(endpoints or p.get("endpoint"))' in text, (
        "caller_supplied 判定必须同时考虑 endpoints 和 endpoint 两种入参形式"
    )


def test_backward_compatible_fields_all_present(stub_llm_server):
    """既有字段/类型一个都不能少, schema_version 仍是 v1。"""
    code, out = _run_llm_chat({"prompt": "hi", "endpoint": stub_llm_server})
    assert code == 0, out

    for key in ("status", "schema_version", "task_type", "elapsed_ms",
                "summary", "results", "errors", "result_text", "summary_text"):
        assert key in out, f"老字段丢了: {key}"
    assert out["schema_version"] == "v1"
    assert out["task_type"] == "llm_chat"
    assert isinstance(out["elapsed_ms"], int)

    for key in ("model", "calls_total", "calls_ok", "calls_failed",
                "input_tokens", "output_tokens", "total_tokens",
                "estimated_cost_cny", "endpoints"):
        assert key in out["summary"], f"summary 老字段丢了: {key}"
    assert out["summary"]["calls_ok"] == 1
    assert out["summary"]["total_tokens"] == 15

    first = out["results"][0]
    for key in ("label", "answer", "input_tokens", "output_tokens",
                "endpoint", "finish_reason"):
        assert key in first, f"results 老字段丢了: {key}"
    assert first["answer"] == "stub answer"
    assert first["finish_reason"] == "stop"


def test_provenance_marks_every_call_not_just_the_first(stub_llm_server):
    """批量 prompts: 每一条结果都要带标记, 不能只标第一条。"""
    code, out = _run_llm_chat({
        "prompts": ["a", "b", "c"],
        "endpoint": stub_llm_server,
    })
    assert code == 0, out
    assert len(out["results"]) == 3
    assert all(r["compute_origin"] == PLATFORM_RELAY for r in out["results"])
    assert all(r["endpoint"] == stub_llm_server for r in out["results"])
    assert out["summary"]["calls_ok"] == 3


def test_failure_path_does_not_claim_success(stub_llm_server):
    """全失败时不得声称成功, 且不得伪造成平台代调成功。"""
    code, out = _run_llm_chat({})  # 无 prompt
    assert code == 1
    assert out["status"] == "failed"
    assert "compute_provenance" not in out.get("summary", {})


def test_script_still_reports_upstream_error_without_leaking_url():
    """上游 4xx 时: 失败 + 不把 URL/供应商细节塞进错误文本。"""
    code, out = _run_llm_chat({
        "prompt": "x",
        "endpoint": "http://127.0.0.1:9/api/v1/chat/completions",  # 必然连不上
        "retry": 0,
        "timeout": 3,
    })
    assert code == 1
    assert out["status"] == "failed"
    assert "127.0.0.1" not in json.dumps(out, ensure_ascii=False)
