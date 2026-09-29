"""
短信链路单元测试。

分三层：
  1. **纯函数**（号码归一化、编码、签名、哈希）—— 不碰 DB，最快；
  2. **验证码状态机**（签发 / 核销 / 限次 / 重放 / 限额）—— 用 in-memory SQLite，
     只建 `we_sms_verifications` 一张表，所以不需要整套 schema；
  3. **上游交互**（SendSms 的请求组装与错误映射）—— 用注入的假 opener，
     **不发真短信**，但把"阿里云返回非 OK 时我们怎么反应"钉死。

之所以把第 3 层也写进来：真实链路上最容易出错的不是"能不能发出去"，
而是"发不出去的时候，我们有没有把它当成发出去了"。
"""
from __future__ import annotations

import json
from datetime import datetime, timedelta

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from platform_v8.services.sms import aliyun, verifications as v
from platform_v8.services.sms.config import SmsConfig, SmsConfigError, load_config

PEPPER = "test-pepper-not-a-real-secret"
PHONE = "13800138000"


@pytest.fixture()
def session():
    engine = create_engine("sqlite://")
    v.sms_verifications_t.create(engine)
    factory = sessionmaker(bind=engine)
    s = factory()
    try:
        yield s
    finally:
        s.close()


# ── 1. 纯函数 ────────────────────────────────────────────────

@pytest.mark.parametrize("raw,expected", [
    ("13800138000", "13800138000"),
    (" 138 0013 8000 ", "13800138000"),
    ("+8613800138000", "13800138000"),
    ("8613800138000", "13800138000"),
    ("138-0013-8000", "13800138000"),
])
def test_normalize_phone_accepts_common_shapes(raw, expected):
    assert v.normalize_phone(raw) == expected


@pytest.mark.parametrize("raw", ["", None, "12345", "12800138000", "1380013800", "138001380000", "abcdefghijk"])
def test_normalize_phone_rejects_bad_shapes(raw):
    with pytest.raises(v.PhoneError):
        v.normalize_phone(raw)


def test_percent_encode_follows_rfc3986():
    # 空格必须是 %20 而不是 +，`~` 必须保留 —— 这两点写错签名就会对不上。
    assert aliyun.percent_encode("a b") == "a%20b"
    assert aliyun.percent_encode("~") == "~"
    assert aliyun.percent_encode("a+b") == "a%2Bb"


def test_canonical_query_sorts_before_encoding():
    assert aliyun.canonical_query({"b": "2", "a": "1", "C": "3"}) == "C=3&a=1&b=2"


def test_signature_is_stable_and_secret_dependent():
    params = {"AccessKeyId": "k", "Action": "SendSms", "Z": "9"}
    first = aliyun.sign(params, "secret-a")
    assert first == aliyun.sign(params, "secret-a")
    assert first != aliyun.sign(params, "secret-b")


def test_hash_code_is_peppered_and_purpose_scoped():
    base = v.hash_code(PEPPER, PHONE, "login", "123456")
    assert len(base) == 64
    assert base != "123456"
    assert base != v.hash_code("other-pepper", PHONE, "login", "123456")
    assert base != v.hash_code(PEPPER, PHONE, "register", "123456")
    assert base != v.hash_code(PEPPER, "13800138001", "login", "123456")


def test_generate_code_is_six_digits():
    codes = {v.generate_code() for _ in range(200)}
    assert all(len(c) == 6 and c.isdigit() for c in codes)
    # 200 次里不该只有一个值 —— 那说明随机源坏了
    assert len(codes) > 100


# ── 2. 状态机 ────────────────────────────────────────────────

def _issue(session, now=None, purpose="login", phone=PHONE, cap=1000):
    return v.issue(
        session, phone=phone, purpose=purpose,
        pepper=PEPPER, daily_cap=cap, now=now,
    )


def test_issue_then_consume_happy_path(session):
    issued = _issue(session)
    assert issued.code.isdigit() and len(issued.code) == 6
    v.consume(session, phone=PHONE, purpose="login", code=issued.code, pepper=PEPPER)
    row = session.execute(v.sms_verifications_t.select()).one()
    assert row.status == "verified"
    assert row.consumed_at is not None


def test_consumed_code_cannot_be_replayed(session):
    issued = _issue(session)
    v.consume(session, phone=PHONE, purpose="login", code=issued.code, pepper=PEPPER)
    with pytest.raises(v.CodeRejected):
        v.consume(session, phone=PHONE, purpose="login", code=issued.code, pepper=PEPPER)


def test_wrong_code_counts_an_attempt(session):
    issued = _issue(session)
    wrong = "000000" if issued.code != "000000" else "111111"
    with pytest.raises(v.CodeRejected):
        v.consume(session, phone=PHONE, purpose="login", code=wrong, pepper=PEPPER)
    row = session.execute(v.sms_verifications_t.select()).one()
    assert row.attempts == 1
    assert row.consumed_at is None
    # 猜错之后**正确码仍然可用**（不能因为一次手滑就锁死用户）
    v.consume(session, phone=PHONE, purpose="login", code=issued.code, pepper=PEPPER)


def test_max_attempts_locks_even_the_right_code(session):
    issued = _issue(session)
    wrong = "000000" if issued.code != "000000" else "111111"
    for _ in range(v.MAX_ATTEMPTS):
        with pytest.raises(v.CodeRejected):
            v.consume(session, phone=PHONE, purpose="login", code=wrong, pepper=PEPPER)
    with pytest.raises(v.CodeRejected):
        v.consume(session, phone=PHONE, purpose="login", code=issued.code, pepper=PEPPER)


def test_expired_code_is_rejected(session):
    start = datetime(2026, 9, 20, 5, 0, 0)
    issued = _issue(session, now=start)
    later = start + timedelta(seconds=v.CODE_TTL_SECONDS + 1)
    with pytest.raises(v.CodeRejected):
        v.consume(session, phone=PHONE, purpose="login", code=issued.code, pepper=PEPPER, now=later)


def test_purpose_is_isolated(session):
    issued = _issue(session, purpose="login")
    with pytest.raises(v.CodeRejected):
        v.consume(session, phone=PHONE, purpose="register", code=issued.code, pepper=PEPPER)


def test_per_phone_minute_limit(session):
    start = datetime(2026, 9, 20, 5, 0, 0)
    _issue(session, now=start)
    with pytest.raises(v.SmsLimitError) as excinfo:
        _issue(session, now=start + timedelta(seconds=30))
    assert excinfo.value.retry_after_seconds == 60


def test_per_phone_hour_limit(session):
    start = datetime(2026, 9, 20, 5, 0, 0)
    for i in range(v.PER_PHONE_CAP_HOUR):
        _issue(session, now=start + timedelta(minutes=2 * i))
    with pytest.raises(v.SmsLimitError):
        _issue(session, now=start + timedelta(minutes=2 * v.PER_PHONE_CAP_HOUR))


def test_global_daily_cap_stops_everyone(session):
    start = datetime(2026, 9, 20, 5, 0, 0)
    _issue(session, phone="13800138001", now=start, cap=2)
    _issue(session, phone="13800138002", now=start, cap=2)
    with pytest.raises(v.SmsLimitError) as excinfo:
        _issue(session, phone="13800138003", now=start, cap=2)
    assert "上限" in str(excinfo.value)


def test_mark_sent_and_failed_are_recorded(session):
    a = _issue(session)
    v.mark_sent(session, record_id=a.id, provider_msg_id="biz-1")
    b = _issue(session, phone="13800138009")
    v.mark_failed(session, record_id=b.id)
    rows = {r.phone: r for r in session.execute(v.sms_verifications_t.select())}
    assert rows[PHONE].status == "sent"
    assert rows[PHONE].provider_msg_id == "biz-1"
    assert rows["13800138009"].status == "failed"


def test_unknown_purpose_is_rejected(session):
    with pytest.raises(ValueError):
        _issue(session, purpose="nonsense")


# ── 3. 上游交互 ──────────────────────────────────────────────

def _config(**overrides) -> SmsConfig:
    base = dict(
        access_key_id="AKID", access_key_secret="SECRET",
        sign_name="测试签名", template_code="SMS_1", code_pepper=PEPPER,
    )
    base.update(overrides)
    return SmsConfig(**base)


class _FakeResponse:
    def __init__(self, payload: dict):
        self._body = json.dumps(payload).encode()

    def read(self) -> bytes:
        return self._body

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


def test_send_params_carry_sign_template_and_code():
    params = aliyun.build_send_params(
        config=_config(), phone=PHONE, code="123456",
        now=datetime(2026, 9, 20, 5, 0, 0), nonce="fixed-nonce",
    )
    assert params["Action"] == "SendSms"
    assert params["PhoneNumbers"] == PHONE
    assert params["SignName"] == "测试签名"
    assert params["TemplateCode"] == "SMS_1"
    assert json.loads(params["TemplateParam"]) == {"code": "123456"}
    assert params["Timestamp"] == "2026-09-20T05:00:00Z"


def test_send_sms_ok_returns_biz_id():
    captured = {}

    def opener(url, timeout=None):
        captured["url"] = url
        return _FakeResponse({"Code": "OK", "BizId": "biz-9", "RequestId": "req-9"})

    result = aliyun.send_sms(config=_config(), phone=PHONE, code="123456", opener=opener)
    assert result.biz_id == "biz-9"
    assert "Signature=" in captured["url"]
    assert "SignName=" in captured["url"]


def test_send_sms_business_error_is_not_reported_as_success():
    def opener(url, timeout=None):
        return _FakeResponse({"Code": "isv.MOBILE_NUMBER_ILLEGAL", "Message": "号码不合法"})

    with pytest.raises(aliyun.SmsSendError) as excinfo:
        aliyun.send_sms(config=_config(), phone=PHONE, code="123456", opener=opener)
    assert excinfo.value.code == "isv.MOBILE_NUMBER_ILLEGAL"
    assert excinfo.value.retryable is False  # 号码错了，重试无用


def test_send_sms_flow_control_is_retryable():
    def opener(url, timeout=None):
        return _FakeResponse({"Code": "isv.BUSINESS_LIMIT_CONTROL", "Message": "触发流控"})

    with pytest.raises(aliyun.SmsSendError) as excinfo:
        aliyun.send_sms(config=_config(), phone=PHONE, code="123456", opener=opener)
    assert excinfo.value.retryable is True


def test_send_sms_network_failure_is_retryable():
    def opener(url, timeout=None):
        raise TimeoutError("boom")

    with pytest.raises(aliyun.SmsSendError) as excinfo:
        aliyun.send_sms(config=_config(), phone=PHONE, code="123456", opener=opener)
    assert excinfo.value.retryable is True


# ── 4. 配置 ──────────────────────────────────────────────────

def test_load_config_requires_every_key(monkeypatch):
    for key in ("QIANSHOU_SMS_ACCESS_KEY_ID", "QIANSHOU_SMS_ACCESS_KEY_SECRET",
                "QIANSHOU_SMS_SIGN_NAME", "QIANSHOU_SMS_TEMPLATE_CODE"):
        monkeypatch.delenv(key, raising=False)
    with pytest.raises(SmsConfigError):
        load_config()


def test_load_config_reads_and_masks(monkeypatch):
    monkeypatch.setenv("QIANSHOU_SMS_ACCESS_KEY_ID", "AKID")
    monkeypatch.setenv("QIANSHOU_SMS_ACCESS_KEY_SECRET", "SECRET")
    monkeypatch.setenv("QIANSHOU_SMS_SIGN_NAME", "签名")
    monkeypatch.setenv("QIANSHOU_SMS_TEMPLATE_CODE", "SMS_1")
    monkeypatch.setenv("QIANSHOU_SMS_DAILY_CAP", "300")
    config = load_config()
    assert config.daily_cap == 300
    # describe() 是给日志/自检用的 —— **绝不能含密钥内容**
    described = json.dumps(config.describe(), ensure_ascii=False)
    assert "SECRET" not in described and "AKID" not in described


def test_load_config_rejects_non_numeric_cap(monkeypatch):
    monkeypatch.setenv("QIANSHOU_SMS_ACCESS_KEY_ID", "AKID")
    monkeypatch.setenv("QIANSHOU_SMS_ACCESS_KEY_SECRET", "SECRET")
    monkeypatch.setenv("QIANSHOU_SMS_SIGN_NAME", "签名")
    monkeypatch.setenv("QIANSHOU_SMS_TEMPLATE_CODE", "SMS_1")
    monkeypatch.setenv("QIANSHOU_SMS_DAILY_CAP", "abc")
    with pytest.raises(SmsConfigError):
        load_config()
