#!/usr/bin/env python3
"""
crawl_url_fetch — 单 URL 抓取 · 公开数据采集

执行协议:
  输入: ENV EC_PARAMS = {"url": "https://...", "timeout_s": 30, "max_bytes": 2097152}
  输出: stdout JSON {status, task_type, summary, summary_text, fetched_at, ...}

合规设计 (节点端兜底 · 不依赖后端):
  1. 白名单兜底  · 域名必须在 _ALLOWED_DOMAINS (与后端 crawl_url_whitelist 表一致 hardcode 子集)
  2. robots.txt   · urllib.robotparser 查询 · 不允许就拒
  3. 限速         · 单脚本进程内 sleep 1s (防过快)
  4. 标准 UA      · 带平台标识 · 不伪装
  5. 大小限制     · max_bytes 默认 2 MB · 防大文件拉爆节点
  6. 严禁登录     · 不带 cookie · 不解析 form

P0: 这是 Phase 1 骨架 · Phase 2 由后端 submit.py 接 crawl_url_whitelist DB 表替换硬编码白名单
"""
import json
import os
import sys
import time
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

import requests

try:
    from selectolax.parser import HTMLParser
    _SELECTOLAX_OK = True
except ImportError:
    _SELECTOLAX_OK = False

# ── Phase 1 硬编码白名单 (Phase 2 由后端 DB 表接管) ──
# 仅公开学术/百科/官方数据站 (+ example.* 供验收/文档用例)
_ALLOWED_DOMAINS = {
    "wikipedia.org",
    "en.wikipedia.org",
    "zh.wikipedia.org",
    "arxiv.org",
    "github.com",
    "raw.githubusercontent.com",
    "data.gov.cn",
    "data.gov",
    "wikidata.org",
    "openalex.org",
    "doi.org",
    "ncbi.nlm.nih.gov",
    "pubmed.ncbi.nlm.nih.gov",
    "nature.com",     # 摘要页公开
    "science.org",    # 摘要页公开
    "example.com",
    "example.org",
    "example.net",
    "www.example.com",
    "httpbin.org",
}

# 标准 UA · 带平台标识 (合规要求 · 不伪装为浏览器)
_UA = "QianshouEdgeCompute-Crawler/1.0 (+https://www.qianshousuanli.com/crawl-policy; bot@qianshousuanli.com)"

# 单进程内 rate limit · 每域名最后一次 GET 时间戳
_LAST_FETCH_AT: dict[str, float] = {}
_MIN_INTERVAL_S = 1.0


def _is_private_or_metadata_ip(url: str) -> bool:
    """S2-T5 · SSRF 加固:检测 URL host 是否解析为私网/链路本地/云元数据 IP。
    
    拦截:
      - 169.254.0.0/16 (链路本地 · 含 AWS/阿里云元数据服务 169.254.169.254)
      - 127.0.0.0/8   (本机)
      - 10.0.0.0/8    (私网 A)
      - 172.16.0.0/12 (私网 B)
      - 192.168.0.0/16(私网 C)
      - fc00::/7 fe80::/10 (IPv6 私网/链路本地)
      - ::1 (IPv6 本机)
    
    DNS rebinding 攻击:每次发起请求都重新解析,redirect 跟随时调用本函数。
    返回 True = 应拦截。失败/无法解析按"不拦截"处理(避免误杀)。
    """
    from urllib.parse import urlparse
    import socket
    import ipaddress
    try:
        host = urlparse(url).hostname
        if not host:
            return False
        # 解析所有 A/AAAA 记录(防 multi-A DNS rebinding)
        try:
            addrs = socket.getaddrinfo(host, None)
        except Exception:
            return False
        for family, _t, _p, _c, sockaddr in addrs:
            ip = sockaddr[0]
            try:
                addr = ipaddress.ip_address(ip)
            except ValueError:
                continue
            if (addr.is_private or addr.is_loopback or addr.is_link_local
                    or addr.is_multicast or addr.is_unspecified or addr.is_reserved):
                return True
        return False
    except Exception:
        return False


def _extra_allow_domains(params: dict | None = None) -> set[str]:
    """LAN/验收额外域名：EC_PARAMS.allow_domains 或 EDGE_LAN_QA_CRAWL_ALLOW_DOMAINS。"""
    out: set[str] = set()
    raw_env = (os.environ.get("EDGE_LAN_QA_CRAWL_ALLOW_DOMAINS") or "").strip()
    for part in raw_env.split(","):
        d = part.strip().lower().lstrip(".")
        if d:
            out.add(d)
    params = params or {}
    extra = params.get("allow_domains") or params.get("crawl_allow_domains") or []
    if isinstance(extra, str):
        extra = [x.strip() for x in extra.split(",")]
    if isinstance(extra, (list, tuple, set)):
        for item in extra:
            d = str(item or "").strip().lower().lstrip(".")
            if d:
                out.add(d)
    return out


def _domain_allowed(url: str, extra: set[str] | None = None) -> tuple[bool, str]:
    """检查 URL 域名在白名单"""
    try:
        host = urlparse(url).hostname or ""
        host = host.lower()
    except Exception as e:
        return False, f"URL 解析失败: {e}"
    if not host:
        return False, "URL 没有 hostname"
    allow = set(_ALLOWED_DOMAINS) | (extra or set())
    if host in allow:
        return True, host
    for allowed in allow:
        if host.endswith("." + allowed):
            return True, host
    return False, f"域名 {host} 不在白名单 · 节点拒绝抓取"


def _check_robots(url: str, ua: str) -> tuple[bool, str]:
    """查 robots.txt · 失败/超时时默认允许 (大部分公开站没 robots)

    2026-06-06 · 用 requests 带超时抓(urllib RobotFileParser.read() 内部 urlopen 无超时·
    抓慢站/被限速站会无限卡 → watchdog timeout 杀任务)。8s 超时·失败保守允许。
    """
    try:
        parts = urlparse(url)
        robots_url = f"{parts.scheme}://{parts.netloc}/robots.txt"
        resp = requests.get(robots_url, timeout=8, headers={"User-Agent": ua})
        if resp.status_code >= 400:
            return True, f"robots.txt {resp.status_code} · 默认允许"
        rp = RobotFileParser()
        rp.parse(resp.text.splitlines())
        if rp.can_fetch(ua, url):
            return True, "robots ok"
        return False, "robots.txt 禁止该 UA 访问此 URL"
    except Exception as e:
        # 拿不到 robots(超时/网络) · 保守允许 (大部分公开站点没 robots)
        return True, f"robots.txt 不可达 ({e}) · 默认允许"


def _rate_limit(host: str):
    """单进程内每域名 ≥1s 间隔"""
    last = _LAST_FETCH_AT.get(host, 0.0)
    now = time.time()
    delta = now - last
    if delta < _MIN_INTERVAL_S:
        time.sleep(_MIN_INTERVAL_S - delta)
    _LAST_FETCH_AT[host] = time.time()


def main() -> int:
    t0 = time.time()
    try:
        params_raw = os.environ.get("EC_PARAMS", "{}")
        params = json.loads(params_raw)
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "crawl_url_fetch",
            "error": f"EC_PARAMS 解析失败: {e}",
            "summary_text": "❌ 任务参数不合法",
        }, ensure_ascii=False))
        return 1

    url = (params.get("url") or "").strip()
    timeout_s = int(params.get("timeout_s") or 30)
    max_bytes = int(params.get("max_bytes") or 2 * 1024 * 1024)  # 2 MB 默认
    user_agent = params.get("user_agent") or _UA
    extra_domains = _extra_allow_domains(params)

    if not url:
        print(json.dumps({
            "status": "failed", "task_type": "crawl_url_fetch",
            "error": "缺少 url 参数",
            "summary_text": "❌ params.url 为空",
        }, ensure_ascii=False))
        return 1
    if not url.startswith(("http://", "https://")):
        print(json.dumps({
            "status": "failed", "task_type": "crawl_url_fetch",
            "error": "URL 必须是 http(s) scheme",
            "summary_text": "❌ 只支持 http/https",
        }, ensure_ascii=False))
        return 1

    # ── 白名单兜底 ──
    ok, msg = _domain_allowed(url, extra_domains)
    if not ok:
        print(json.dumps({
            "status": "failed", "task_type": "crawl_url_fetch",
            "error": msg,
            "summary_text": f"❌ {msg}",
        }, ensure_ascii=False))
        return 1
    host = msg  # _domain_allowed 返回的 host

    # ── robots.txt ──
    ok, msg = _check_robots(url, user_agent)
    if not ok:
        print(json.dumps({
            "status": "failed", "task_type": "crawl_url_fetch",
            "error": msg,
            "summary_text": f"❌ {msg}",
        }, ensure_ascii=False))
        return 1

    # ── 限速 ──
    _rate_limit(host)

    # ── 真正 GET (S2-T5 · 2026-06-07 SSRF 加固 · S5 加重试) ──
    # 不再 allow_redirects=True · 改为手动跟随并对每一跳做:
    #   1. host 白名单复查(防 redirect 出白名单)
    #   2. 私网/链路本地/云元数据 IP 拦截(防 169.254.169.254 / 10.x / 192.168.x / 127.x)
    # S5 新增:
    #   - 网络错误/5xx 自动重试 2 次(指数退避 1s/3s)
    #   - 429 尊重 Retry-After
    #   - 4xx 客户端错误立即失败(不浪费重试配额)
    headers = {
        "User-Agent": user_agent,
        "Accept": "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
    }
    max_retries = int(params.get("max_retries", 2))
    retry_count = 0
    retry_backoff_s = [1, 3]  # 第 1 次重试 1s · 第 2 次 3s

    def _get_with_redirect():
        """跟随 redirect (每跳验白名单/私网) · 返 resp"""
        current_url = url
        for _hop in range(6):
            ok, msg = _domain_allowed(current_url, extra_domains)
            if not ok:
                raise requests.exceptions.RequestException(f"redirect 出白名单: {msg}")
            if _is_private_or_metadata_ip(current_url):
                raise requests.exceptions.RequestException(
                    f"SSRF 拦截: redirect 到私网/云元数据 IP ({current_url[:80]})"
                )
            r = requests.get(
                current_url, headers=headers, timeout=timeout_s,
                allow_redirects=False, stream=True,
            )
            if r.status_code in (301, 302, 303, 307, 308):
                next_url = r.headers.get("Location", "")
                if not next_url:
                    return r
                if not next_url.startswith(("http://", "https://")):
                    from urllib.parse import urljoin
                    next_url = urljoin(current_url, next_url)
                current_url = next_url
                r.close()
                continue
            return r
        raise requests.exceptions.RequestException("超过 6 次 redirect 上限")

    try:
        while True:
            try:
                resp = _get_with_redirect()
            except requests.exceptions.Timeout:
                if retry_count < max_retries:
                    time.sleep(retry_backoff_s[retry_count])
                    retry_count += 1
                    continue
                raise
            except requests.exceptions.ConnectionError:
                if retry_count < max_retries:
                    time.sleep(retry_backoff_s[retry_count])
                    retry_count += 1
                    continue
                raise
            # 429 处理:尊重 Retry-After(<= 10s)
            if resp.status_code == 429 and retry_count < max_retries:
                ra = resp.headers.get("Retry-After", "")
                wait_s = 10
                try:
                    wait_s = min(10, max(1, int(ra)))
                except ValueError:
                    pass
                resp.close()
                time.sleep(wait_s)
                retry_count += 1
                continue
            # 5xx 服务端错误 · 重试
            if 500 <= resp.status_code < 600 and retry_count < max_retries:
                resp.close()
                time.sleep(retry_backoff_s[retry_count])
                retry_count += 1
                continue
            break  # 4xx / 2xx 退出循环
    except requests.exceptions.Timeout:
        print(json.dumps({
            "status": "failed", "task_type": "crawl_url_fetch",
            "error": f"请求超时 ({timeout_s}s)",
            "summary_text": f"❌ 抓 {url} 超时",
        }, ensure_ascii=False))
        return 1
    except requests.exceptions.RequestException as e:
        print(json.dumps({
            "status": "failed", "task_type": "crawl_url_fetch",
            "error": f"请求失败: {e}",
            "summary_text": f"❌ 网络错误: {e}",
        }, ensure_ascii=False))
        return 1

    # 大小限制 (流式读 · 超过截断)
    body_bytes = b""
    for chunk in resp.iter_content(chunk_size=64 * 1024):
        body_bytes += chunk
        if len(body_bytes) >= max_bytes:
            body_bytes = body_bytes[:max_bytes]
            break

    status_code = resp.status_code
    content_type = resp.headers.get("Content-Type", "")
    final_url = resp.url
    encoding = resp.encoding or "utf-8"

    # 文本解码 (容错)
    try:
        body_text = body_bytes.decode(encoding, errors="replace")
    except Exception:
        body_text = body_bytes.decode("utf-8", errors="replace")

    # 抽 title + 文本预览 (有 selectolax 的话)
    title = ""
    text_preview = ""
    links_count = 0
    if _SELECTOLAX_OK and "html" in content_type.lower():
        try:
            tree = HTMLParser(body_text)
            title_node = tree.css_first("title")
            if title_node:
                title = (title_node.text() or "").strip()[:200]
            # 移除 script/style · 拿正文预览
            for sel in ("script", "style", "noscript"):
                for node in tree.css(sel):
                    node.decompose()
            body_node = tree.css_first("body")
            if body_node:
                text_preview = (body_node.text(separator=" ", strip=True) or "")[:500]
            links_count = len(tree.css("a"))
        except Exception:
            pass

    elapsed_ms = int((time.time() - t0) * 1000)

    summary = {
        "url": url,
        "final_url": final_url,
        "host": host,
        "status_code": status_code,
        "content_type": content_type,
        "bytes": len(body_bytes),
        "encoding": encoding,
        "title": title,
        "text_preview": text_preview,
        "links_count": links_count,
        "retry_count": retry_count,  # S5 · 记录重试次数(0 = 一次成功)
        "fetched_at": int(time.time()),
    }

    print(json.dumps({
        "status": "ok",
        "schema_version": "v1",
        "task_type": "crawl_url_fetch",
        "elapsed_ms": elapsed_ms,
        "summary": summary,
        # 完整 HTML 不内联 (太大) · 调用方需要可加 params.return_body=true 走 OSS
        "body_truncated": body_text[:8192] if params.get("return_body_preview") else "",
        "summary_text": (
            f"✅ 抓取完成\n"
            f"🔗 {url}\n"
            f"📡 HTTP {status_code} · {content_type}\n"
            f"📏 {len(body_bytes)} 字节\n"
            f"📰 标题: {title or '(无)'}\n"
            f"🔢 链接数: {links_count}\n"
            f"⏱️ {elapsed_ms} ms"
        ),
    }, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
