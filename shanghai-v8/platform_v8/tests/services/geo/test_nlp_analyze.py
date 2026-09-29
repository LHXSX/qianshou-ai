"""
W2-3 · services/geo/nlp_analyze.py 单测

覆盖:
  1. 品牌被提及 + 排名 (位置靠前 = 排名靠前)
  2. 品牌未提及 · 返 mention_count=0 / rank=None / sentiment=None
  3. 别名匹配 (Apple / 苹果 / iPhone)
  4. 正面情感识别
  5. 负面情感识别
  6. 推荐 pattern 命中
  7. 竞品识别 (category=phone · 找到 Huawei 等)
  8. raw_excerpt 截取正确
"""
from __future__ import annotations
import sys
from pathlib import Path

import pytest

_ROOT = Path(__file__).resolve().parents[4]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from platform_v8.services.geo.nlp_analyze import analyze


def test_brand_mentioned_first_position_high_rank():
    """品牌首次出现在前 10% · 排名 1"""
    text = "Apple iPhone 是目前市面上最受欢迎的手机之一。它的特点包括性能强大、相机优秀、生态完整。"
    r = analyze(text, "Apple", brand_aliases=["苹果", "iPhone"])
    assert r.mention_count >= 1
    assert r.rank_position == 1
    assert r.sentiment is not None and r.sentiment > 0


def test_brand_not_mentioned():
    text = "我推荐华为和小米的手机 · 性价比高 · 体验好。"
    r = analyze(text, "Apple", brand_aliases=["苹果"])
    assert r.mention_count == 0
    assert r.rank_position is None
    assert r.sentiment is None
    assert not r.recommended


def test_brand_alias_matching():
    text = "iPhone 16 Pro 的设计很出色 · 苹果今年的旗舰拍照不错。"
    r = analyze(text, "Apple", brand_aliases=["苹果", "iPhone"])
    # iPhone × 1 + 苹果 × 1 = 2
    assert r.mention_count == 2


def test_positive_sentiment():
    text = "Apple 推荐这款产品 · 性能强大 · 体验优秀 · 值得购买。"
    r = analyze(text, "Apple")
    assert r.mention_count == 1
    assert r.sentiment is not None and r.sentiment > 0.5
    assert r.recommended is True


def test_negative_sentiment():
    text = "Apple 这款产品糟糕 · 性能差 · 卡顿严重 · 不推荐购买。"
    r = analyze(text, "Apple")
    assert r.mention_count == 1
    assert r.sentiment is not None and r.sentiment < 0


def test_recommended_pattern_hit():
    text = "对于 5000 元价位手机 · 我强烈推荐 华为 Mate · 性价比非常高。"
    r = analyze(text, "华为", brand_aliases=["Huawei"])
    assert r.mention_count >= 1
    assert r.recommended is True


def test_competitors_identification():
    text = "5000 元价位手机推荐: Apple 苹果 iPhone 16 · 华为 Mate · 小米 14 · 都是不错的选择。"
    r = analyze(text, "Apple", brand_aliases=["苹果"], category="phone")
    assert r.mention_count >= 1
    # 应识别出 华为 / 小米 (在 _COMMON_BRANDS['phone'] 里)
    assert any(c in r.competitors for c in ["华为", "Huawei"])
    assert any(c in r.competitors for c in ["小米", "Xiaomi"])
    # Apple 自己不在 competitors 里
    assert "Apple" not in r.competitors


def test_extra_competitors():
    """客户自定义竞品词典"""
    text = "TestBrandA 和 TestBrandB 都不错。"
    r = analyze(text, "TestBrandA",
                extra_competitors=["TestBrandB", "TestBrandC"])
    assert r.mention_count == 1
    assert "TestBrandB" in r.competitors
    assert "TestBrandC" not in r.competitors  # 没出现在 text


def test_raw_excerpt_around_brand():
    """摘录应包含品牌附近的上下文"""
    text = ("这是一段很长的引文" * 50 +
            "Apple 是值得推荐的品牌 · 性能强大 · 体验优秀。" +
            "这是另一段很长的尾巴" * 50)
    r = analyze(text, "Apple")
    assert "Apple" in r.raw_excerpt
    assert len(r.raw_excerpt) <= 500


def test_empty_response_returns_zero():
    r = analyze("", "Apple")
    assert r.mention_count == 0
    assert r.rank_position is None
    assert r.sentiment is None
    assert r.competitors == []
    assert r.raw_excerpt == ""


def test_sentiment_in_range():
    """sentiment 必须在 [-1.0, 1.0] · 不论文本"""
    texts = [
        "Apple 优秀 优秀 优秀 优秀 优秀 推荐 推荐 推荐 推荐 推荐",
        "Apple 糟糕 糟糕 糟糕 糟糕 糟糕 差 差 差 差 差",
        "Apple 是手机品牌之一。",
    ]
    for t in texts:
        r = analyze(t, "Apple")
        if r.sentiment is not None:
            assert -1.0 <= r.sentiment <= 1.0


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-v"]))
