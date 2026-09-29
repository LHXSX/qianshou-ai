#!/usr/bin/env python3
"""
ai_ppt_gen.py — AI 生成 PPT 脚本
根据主题和要点生成 PPT 文件

参数：
  topic: str          — PPT 主题
  slides: int         — 页数，默认 10
  style: str          — 风格（business/tech/education）
  outline: str        — 大纲（可选，不传则 AI 自动生成）
  language: str       — 语言（zh/en）

输出：
  { output_url, slides_count, topic }
"""
import os, json, time, base64
from urllib.request import Request, urlopen

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
topic = params.get("topic", "")
slide_count = min(params.get("slides", 10), 30)
style = params.get("style", "business")

WORK_DIR = os.environ.get("EC_OUTPUT_DIR", "/tmp")
os.makedirs(WORK_DIR, exist_ok=True)

def call_llm(prompt: str) -> str:
    """调 DeepSeek API 生成内容"""
    api_key = os.environ.get("AI_SCRIPT_API_KEY", "")
    api_url = os.environ.get("AI_SCRIPT_BASE_URL", "https://api.deepseek.com")
    
    data = json.dumps({
        "model": "deepseek-chat",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.7,
    }).encode()
    
    req = Request(
        f"{api_url}/v1/chat/completions",
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        }
    )
    resp = urlopen(req, timeout=60)
    result = json.loads(resp.read())
    return result["choices"][0]["message"]["content"]

def generate_ppt(t: str, slides: int, s: str, outline: str) -> str:
    """生成 PPT（用 python-pptx）"""
    # 先用 LLM 生成每页内容
    content_prompt = f"""为「{t}」生成一份 {slides} 页的{s}风格PPT大纲。
每页格式：标题|要点1,要点2,要点3
只输出内容，不要额外说明。"""
    
    if outline:
        content_prompt = f"""基于以下大纲，为「{t}」生成 {slides} 页PPT内容：
{outline}
每页格式：标题|要点1,要点2,要点3"""
    
    content = call_llm(content_prompt)
    
    # 用 python-pptx 生成文件
    try:
        from pptx import Presentation
        from pptx.util import Inches, Pt
    except ImportError:
        # fallback: 输出 markdown 格式
        out_path = os.path.join(WORK_DIR, f"{t[:20]}.md")
        with open(out_path, "w") as f:
            f.write(f"# {t}\n\n{content}")
        return out_path
    
    prs = Presentation()
    prs.slide_width = Inches(13.333)
    prs.slide_height = Inches(7.5)
    
    # 首页
    slide = prs.slides.add_slide(prs.slide_layouts[6])
    title = slide.shapes.title
    title.text = t
    
    # 内容页
    for line in content.strip().split("\n"):
        line = line.strip()
        if "|" in line:
            parts = line.split("|")
            slide = prs.slides.add_slide(prs.slide_layouts[1])
            slide.shapes.title.text = parts[0]
            for j, point in enumerate(parts[1].split(",")):
                if j < 5:
                    txBox = slide.shapes.add_textbox(Inches(1), Inches(2 + j * 0.8), Inches(11), Inches(0.7))
                    tf = txBox.text_frame
                    tf.text = point.strip()
    
    out_path = os.path.join(WORK_DIR, f"{t[:20]}.pptx")
    prs.save(out_path)
    return out_path

try:
    out_path = generate_ppt(topic, slide_count, style, params.get("outline", ""))
    result = {
        "status": "ok",
        "output_path": out_path,
        "slides": slide_count,
        "topic": topic[:50],
        "size_bytes": os.path.getsize(out_path),
        "time": time.time(),
    }
except Exception as e:
    result = {"status": "error", "error": str(e)[:200], "time": time.time()}

print(json.dumps(result, ensure_ascii=False))
