#!/usr/bin/env python3
"""
geo_report.py — GEO 品牌监测报告生成脚本
适配千手引擎 run_script 协议

【应用场景】
GEO 厂商和企业市场部需要定期收到「品牌 AI 出镜报告」来评估 GEO 服务效果。
本脚本聚合多个 geo_monitor 和 geo_scan 任务的原始数据，
生成可直接交付给客户的 PDF/HTML 格式报告。

【谁买单】
- GEO 服务商：报告是交付物，用来证明服务效果，驱动续费
- 品牌市场部：月度 AI 品牌资产报告，内部汇报用
- 公关公司：舆情监测周报

【参数】
  brand: str                — 品牌名（必填）
  data_source: str          — 数据来源（"latest" 或任务 ID 列表）
  report_type: str          — daily/weekly/monthly
  include_recommendations: bool — 是否包含优化建议，默认 true
  output_format: str        — html/json（默认 json）

【输出】
  {
    brand: "品牌名",
    report_period: "2026-05",
    summary: {
      total_mentions: 156,
      mention_rate: 72.3,
      positive_rate: 65.2,
      negative_rate: 5.1,
      recommendation_rate: 48.7,
    },
    trends: {
      daily_mentions: [{date, mentions, positive, negative}],
      platform_breakdown: [{platform, mentions}],
    },
    issues_found: [{platform, issue_type, url, severity}],
    competitors: [{name, mention_rate}],
    recommendations: ["建议1", "建议2"],
    report_html: "<html>...</html>"
  }
"""
import os, json, time

params = json.loads(os.environ.get("EC_PARAMS", "{}"))
brand = params.get("brand", "")
report_type = params.get("report_type", "monthly")
include_recommendations = params.get("include_recommendations", True)

# ════════════════════════════════════
# 报告模板生成
# ════════════════════════════════════

def generate_html_report(brand: str, data: dict) -> str:
    """生成可交付的 HTML 报告"""
    s = data.get("summary", {})
    t = data.get("trends", {})
    
    html = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>{brand} · AI 品牌出镜报告</title>
<style>
  body {{ font-family: -apple-system, 'Geist', sans-serif; max-width: 800px; margin: 0 auto; padding: 40px 24px; color: #171717; background: #fff; }}
  h1 {{ font-size: 32px; font-weight: 600; letter-spacing: -0.96px; margin-bottom: 4px; }}
  .subtitle {{ font-size: 14px; color: #808080; margin-bottom: 40px; }}
  .stats {{ display: grid; grid-template-columns: repeat(4, 1fr); gap: 16px; margin-bottom: 40px; }}
  .stat-card {{ padding: 20px; border-radius: 8px; box-shadow: rgba(0,0,0,0.08) 0px 0px 0px 1px; text-align: center; }}
  .stat-num {{ font-size: 36px; font-weight: 600; letter-spacing: -1.44px; }}
  .stat-label {{ font-size: 12px; color: #808080; margin-top: 4px; }}
  .section {{ margin-bottom: 32px; }}
  .section h2 {{ font-size: 20px; font-weight: 600; margin-bottom: 16px; }}
  table {{ width: 100%; border-collapse: collapse; }}
  th, td {{ padding: 10px 12px; text-align: left; border-bottom: 1px solid rgba(0,0,0,0.06); font-size: 14px; }}
  th {{ font-weight: 500; color: #808080; font-size: 12px; text-transform: uppercase; }}
  .badge {{ display: inline-block; padding: 2px 8px; border-radius: 9999px; font-size: 11px; font-weight: 500; }}
  .badge-green {{ background: #e8f5e9; color: #2e7d32; }}
  .badge-red {{ background: #fce4ec; color: #c62828; }}
  .badge-orange {{ background: #fff3e0; color: #e65100; }}
  .rec-card {{ padding: 16px; border-radius: 6px; background: #fafafa; margin-bottom: 8px; font-size: 14px; }}
  .footer {{ margin-top: 48px; padding-top: 24px; border-top: 1px solid rgba(0,0,0,0.06); font-size: 12px; color: #808080; text-align: center; }}
</style>
</head>
<body>
<h1>{brand}</h1>
<p class="subtitle">AI 品牌出镜报告 · {report_type} · {time.strftime('%Y-%m-%d')}</p>

<div class="stats">
  <div class="stat-card">
    <div class="stat-num">{s.get('mention_rate', 0)}%</div>
    <div class="stat-label">AI 提及率</div>
  </div>
  <div class="stat-card">
    <div class="stat-num">{s.get('positive_rate', 0)}%</div>
    <div class="stat-label">正面率</div>
  </div>
  <div class="stat-card">
    <div class="stat-num">{s.get('recommendation_rate', 0)}%</div>
    <div class="stat-label">推荐率</div>
  </div>
  <div class="stat-card">
    <div class="stat-num" style="color: {'#c62828' if s.get('negative_rate', 0) > 10 else '#2e7d32'};">{s.get('negative_rate', 0)}%</div>
    <div class="stat-label">负面率</div>
  </div>
</div>

<div class="section">
<h2>📊 平台表现</h2>
<table>
  <tr><th>平台</th><th>提及次数</th><th>正面率</th><th>推荐率</th></tr>
"""
    for p in t.get("platform_breakdown", [{"platform":"deepseek","mentions":0,"positive_rate":0,"recommend_rate":0}]):
        html += f"<tr><td>{p.get('platform','')}</td><td>{p.get('mentions',0)}</td><td>{p.get('positive_rate',0)}%</td><td>{p.get('recommend_rate',0)}%</td></tr>\n"
    
    html += """</table>
</div>

<div class="section">
<h2>⚠️ 待处理问题</h2>
"""
    issues = data.get("issues_found", [{"platform":"百度","issue_type":"negative","severity":"high","title":"示例"}])
    for issue in issues[:5]:
        badge = "badge-red" if issue.get("severity") == "high" else "badge-orange"
        html += f'<div class="rec-card">[{issue.get("platform","")}] {issue.get("title","")} <span class="badge {badge}">{issue.get("severity","")}</span></div>\n'
    
    if include_recommendations:
        html += """</div>
<div class="section">
<h2>💡 优化建议</h2>
"""
        for rec in data.get("recommendations", ["暂无建议"]):
            html += f'<div class="rec-card">→ {rec}</div>\n'
    
    html += f"""</div>
<div class="footer">
<p>报告由千手算力 GEO 监测系统自动生成 · {time.strftime('%Y-%m-%d %H:%M:%S')}</p>
</div>
</body>
</html>"""
    return html


def generate_recommendations(data: dict) -> list:
    """基于数据生成优化建议"""
    recs = []
    s = data.get("summary", {})
    
    if s.get("mention_rate", 0) < 50:
        recs.append(f"AI 提及率仅 {s.get('mention_rate', 0)}%，建议增加品牌结构化知识库内容投放")
    if s.get("negative_rate", 0) > 10:
        recs.append(f"负面率 {s.get('negative_rate', 0)}%，需要启动全网纠错和正面内容覆盖")
    if s.get("recommendation_rate", 0) < 30:
        recs.append("推荐率偏低，建议优化品牌差异化话术和场景化解决方案")
    
    if not recs:
        recs.append("品牌 AI 出镜表现良好，建议继续保持月度监测")
    
    return recs


# ════════════════════════════════════
# 主流程
# ════════════════════════════════════

def _fail(failure_class, error, summary_text=None, **extra):
    payload = {
        "task_type": "geo_report",
        "status": "failed",
        "contract_version": "1",
        "failure_class": failure_class,
        "error": error,
        "summary_text": summary_text or f"❌ {error}",
        "time": time.time(),
        **extra,
    }
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(1)


if not brand:
    _fail(
        "invalid_params",
        "缺少参数: brand (请传入品牌名)",
        usage={"brand": "品牌名", "report_type": "monthly", "data": {"summary": {}, "trends": {}, "issues_found": []}, "include_recommendations": True},
    )

# 禁止 mock：必须传入真实监测聚合数据（来自 geo_monitor / geo_scan 等上游结果）
data = params.get("data")
data_source = params.get("data_source")
if not isinstance(data, dict) or not data:
    _fail(
        "dependency_missing",
        "缺少真实监测数据: 请传入 params.data（geo_monitor/geo_scan 聚合结果）；禁止使用 mock 报告冒充 DONE",
        "❌ 无真实监测数据 · 拒绝生成假报告",
        usage={
            "brand": "品牌名",
            "data": {"summary": {"mention_rate": 0}, "trends": {"platform_breakdown": []}, "issues_found": []},
            "data_source": "upstream workload id / latest",
        },
        data_source=data_source,
    )

summary = data.get("summary") if isinstance(data.get("summary"), dict) else None
if not summary:
    _fail(
        "invalid_params",
        "params.data.summary 缺失或非法 · 无法生成诚实报告",
        "❌ 监测摘要缺失",
        data_source=data_source,
    )

# 显式拒绝「看起来像旧版内置假数据」的特征（防止误传 mock）
if data.get("_mock") is True or params.get("allow_mock") is True:
    _fail(
        "feature_unavailable",
        "mock 报告已禁用 · 无真实数据源时不得 DONE",
        "❌ mock 已禁用",
    )

data = dict(data)
data["summary"] = summary
if not isinstance(data.get("trends"), dict):
    data["trends"] = {"platform_breakdown": []}
if not isinstance(data.get("issues_found"), list):
    data["issues_found"] = []

data["recommendations"] = generate_recommendations(data) if include_recommendations else data.get("recommendations", [])
data["report_html"] = generate_html_report(brand, data)

output = {
    "task_type": "geo_report",
    "status": "ok",
    "contract_version": "1",
    "brand": brand,
    "report_type": report_type,
    "data_source": data_source,
    "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
    "summary": data["summary"],
    "trends": data["trends"],
    "issues_found": data.get("issues_found", []),
    "recommendations": data["recommendations"],
    "report_html": data["report_html"],
    "summary_text": f"✅ 已生成 {brand} · {report_type} 报告（真实数据）",
    "time": time.time(),
}

print(json.dumps(output, ensure_ascii=False, indent=2))
