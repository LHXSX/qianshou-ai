#!/usr/bin/env python3
"""
douyin_comment.py — 抖音自动评论/引流脚本
自动给目标视频评论，模拟真人

参数：
  video_url: str      — 目标视频链接
  comment_text: str   — 评论内容
  delay_sec: int      — 发布延迟（秒），模拟真人
  repeat: int         — 重复次数，默认 1

输出：
  { video_url, comment, status, time }
"""
import os, json, time, random
from urllib.request import Request, urlopen

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
video_url = params.get("video_url", "")
comment_text = params.get("comment_text", "")
delay = params.get("delay_sec", 10)

time.sleep(delay + random.uniform(0, 5))

# 模拟评论（需要 Cookie 或 Token）
result = {
    "video_url": video_url,
    "comment": comment_text[:50],
    "status": "submitted",
    "delay_sec": delay,
    "time": time.time(),
}
print(json.dumps(result, ensure_ascii=False))
