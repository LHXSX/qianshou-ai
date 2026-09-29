"""兼容层 · 旧脚本/伴侣下载仍引用 _ollama_pick。

实现已迁至 _llm_pick + _llm_client（llama.cpp OpenAI 兼容）。
"""
from __future__ import annotations

import sys
from pathlib import Path

_dir = str(Path(__file__).resolve().parent)
if _dir not in sys.path:
    sys.path.insert(0, _dir)

from _llm_pick import *  # noqa: F403
from _llm_pick import DEFAULT_LLM_BASE as DEFAULT_OLLAMA  # noqa: F401
