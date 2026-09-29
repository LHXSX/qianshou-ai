#!/usr/bin/env python3
"""crawl_url_extract — 单 URL 抓取 + 结构化抽取 (企业级 · 2026-06-07 S5 升级)

新增:
  - **SSRF 防护**(同 crawl_url_fetch · 私网 IP 拦)
  - **手动 redirect**(每跳验白名单 + 私 IP)
  - **多 selector 并取**(selectors={"title":"h1","price":".price",...})
  - **metadata 抽取**(<meta>, og:*, twitter:*)
  - **链接抽取**(absolute_links)
  - robots 缓存
  - requests 懒加载

参数 (EC_PARAMS):
  url             str   必填
  mode            str   readability / css / meta / links / all (默认 readability)
  selector        str   mode=css 单 selector
  selectors       dict  mode=all/css 时多 selector  {"title":"h1","price":".price"}
  return_html     bool  返抽取的 HTML 片段
  timeout_s/max_bytes/user_agent  同前
  follow_redirects bool 默认 true
"""
import ipaddress
import json
import os
import socket
import sys
import threading
import time
from urllib.parse import urljoin, urlparse
from urllib.robotparser import RobotFileParser

try:
    import requests
    _HAS_REQUESTS = True
except ImportError:
    requests = None
    _HAS_REQUESTS = False

try:
    from selectolax.parser import HTMLParser
    _SELECTOLAX_OK = True
except ImportError:
    _SELECTOLAX_OK = False

try:
    from readability import Document
    _READABILITY_OK = True
except ImportError:
    _READABILITY_OK = False


_ALLOWED_DOMAINS = {
    "wikipedia.org", "en.wikipedia.org", "zh.wikipedia.org",
    "arxiv.org", "github.com", "raw.githubusercontent.com",
    "data.gov.cn", "data.gov", "wikidata.org", "openalex.org",
    "doi.org", "ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov",
    "nature.com", "science.org",
}
_UA = ("QianshouEdgeCompute-Crawler/1.0 "
       "(+https://www.qianshousuanli.com/crawl-policy; bot@qianshousuanli.com)")
_LAST_FETCH: dict = {}
_LAST_LOCK = threading.Lock()
_MIN_INTERVAL_S = 1.0
_ROBOTS_CACHE: dict = {}
_ROBOTS_LOCK = threading.Lock()


def _domain_allowed(url: str) -> tuple:
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception as e:
        return False, f"URL 解析失败: {e}"
    if not host:
        return False, "URL 无 hostname"
    if host in _ALLOWED_DOMAINS:
        return True, host
    for allowed in _ALLOWED_DOMAINS:
        if host.endswith("." + allowed):
            return True, host
    return False, f"域名 {host} 不在白名单"


def _is_private_ip(host: str) -> bool:
    try:
        for _, _, _, _, sock in socket.getaddrinfo(host, None):
            ip = sock[0]
            try:
                ip_obj = ipaddress.ip_address(ip)
                if (ip_obj.is_private or ip_obj.is_loopback
                        or ip_obj.is_link_local or ip_obj.is_multicast):
                    return True
            except ValueError:
                continue
    except socket.gaierror:
        return True
    return False


def _check_robots(url: str, ua: str) -> tuple:
    try:
        parts = urlparse(url)
        with _ROBOTS_LOCK:
            cached = _ROBOTS_CACHE.get(parts.netloc)
        if cached is None:
            rp = RobotFileParser()
            rp.set_url(f"{parts.scheme}://{parts.netloc}/robots.txt")
            try:
                rp.read()
            except Exception:
                with _ROBOTS_LOCK:
                    _ROBOTS_CACHE[parts.netloc] = False
                return True, "robots 不可达 · 默认允许"
            with _ROBOTS_LOCK:
                _ROBOTS_CACHE[parts.netloc] = rp
            cached = rp
        if cached is False:
            return True, "ok"
        if cached.can_fetch(ua, url):
            return True, "ok"
        return False, "robots.txt 禁止"
    except Exception:
        return True, "robots 异常 · 默认允许"


def _rate_limit(host: str):
    with _LAST_LOCK:
        last = _LAST_FETCH.get(host, 0.0)
        now = time.time()
        if now - last < _MIN_INTERVAL_S:
            time.sleep(_MIN_INTERVAL_S - (now - last))
        _LAST_FETCH[host] = time.time()


def _fail(msg: str, hint: str = "") -> int:
    out = {"status": "failed", "task_type": "crawl_url_extract",
           "error": msg, "summary_text": f"❌ {msg}"}
    if hint:
        out["hint"] = hint
    print(json.dumps(out, ensure_ascii=False))
    return 1


def _fetch_with_safe_redirect(url: str, ua: str, timeout_s: int,
                              max_bytes: int, follow_redirects: bool):
    """手动 follow redirects · 每跳验白名单 + 私 IP"""
    cur = url
    redirects = 0
    max_redir = 5
    while True:
        resp = requests.get(
            cur,
            headers={
                "User-Agent": ua,
                "Accept": "text/html,application/xhtml+xml,*/*;q=0.9",
                "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
            },
            timeout=timeout_s,
            allow_redirects=False,
            stream=True,
        )
        if follow_redirects and resp.status_code in (301, 302, 303, 307, 308):
            redirects += 1
            if redirects > max_redir:
                raise RuntimeError(f"redirect > {max_redir}")
            new_url = resp.headers.get("Location") or ""
            if new_url.startswith("/"):
                new_url = urljoin(cur, new_url)
            ok, msg = _domain_allowed(new_url)
            if not ok:
                raise RuntimeError(f"重定向到非白名单: {new_url}")
            if _is_private_ip(msg):
                raise RuntimeError(f"重定向到私网: {new_url}")
            cur = new_url
            continue
        return resp, cur, redirects


def _extract_meta(tree) -> dict:
    """meta / og: / twitter: / json-ld"""
    meta = {}
    for node in tree.css("meta"):
        name = (node.attributes.get("name") or node.attributes.get("property") or "").lower()
        content = node.attributes.get("content") or ""
        if name and content:
            meta[name] = content[:500]
    return meta


def _extract_links(tree, base_url: str, max_n: int = 200) -> list:
    out = []
    seen = set()
    for node in tree.css("a"):
        href = node.attributes.get("href") or ""
        if not href or href.startswith(("javascript:", "mailto:", "#")):
            continue
        abs_url = urljoin(base_url, href)
        if abs_url in seen:
            continue
        seen.add(abs_url)
        text = (node.text(strip=True) or "")[:100]
        out.append({"url": abs_url, "text": text})
        if len(out) >= max_n:
            break
    return out


def main() -> int:
    t0 = time.time()
    try:
        params = json.loads(os.environ.get("EC_PARAMS", "{}"))
    except Exception as e:
        return _fail(f"EC_PARAMS 解析失败: {e}")

    url = (params.get("url") or "").strip()
    mode = (params.get("mode") or "readability").lower()
    selector = params.get("selector") or ""
    selectors = params.get("selectors") or {}
    timeout_s = int(params.get("timeout_s") or 30)
    max_bytes = int(params.get("max_bytes") or 2 * 1024 * 1024)
    ua = params.get("user_agent") or _UA
    follow_redirects = bool(params.get("follow_redirects", True))
    return_html = bool(params.get("return_html"))

    # 1. 参数完整性
    if not url:
        return _fail("缺 url")
    if not url.startswith(("http://", "https://")):
        return _fail("URL 必须 http/https")
    if mode == "css" and not (selector or selectors):
        return _fail("mode=css 需 selector 或 selectors")

    # 2. 域名白名单 + SSRF(优先于依赖检查 · 让恶意输入早拒)
    ok, msg = _domain_allowed(url)
    if not ok:
        return _fail(msg)
    host = msg
    if _is_private_ip(host):
        return _fail(f"SSRF 拦截: {host}")

    # 3. 模式依赖校验
    if mode == "readability" and not _READABILITY_OK:
        return _fail("节点缺 readability-lxml")
    if not _SELECTOLAX_OK and mode in ("css", "all", "links", "meta"):
        return _fail("节点缺 selectolax")
    if not _HAS_REQUESTS:
        return _fail("节点缺 requests")

    ok, robot_msg = _check_robots(url, ua)
    if not ok:
        return _fail(robot_msg)

    _rate_limit(host)

    try:
        resp, final_url, redirects = _fetch_with_safe_redirect(
            url, ua, timeout_s, max_bytes, follow_redirects)
    except Exception as e:
        return _fail(f"请求失败: {e}")

    body_bytes = b""
    for chunk in resp.iter_content(chunk_size=64 * 1024):
        body_bytes += chunk
        if len(body_bytes) >= max_bytes:
            body_bytes = body_bytes[:max_bytes]
            break

    encoding = resp.encoding or "utf-8"
    body_text = body_bytes.decode(encoding, errors="replace")
    status_code = resp.status_code
    content_type = resp.headers.get("Content-Type", "")

    title = ""
    extracted_text = ""
    extracted_html = ""
    extracted_count = 0
    extracted_blocks = {}
    metadata = {}
    links = []

    # selectolax 树预解析 · 多模式共用
    tree = None
    if _SELECTOLAX_OK and "html" in content_type.lower() or mode in ("css", "meta", "links", "all"):
        try:
            tree = HTMLParser(body_text)
            t_node = tree.css_first("title")
            if t_node:
                title = (t_node.text() or "").strip()[:200]
        except Exception:
            tree = None

    if mode == "readability":
        try:
            doc = Document(body_text)
            title = (doc.short_title() or title).strip()[:200]
            extracted_html = doc.summary(html_partial=True)
            if _SELECTOLAX_OK:
                t = HTMLParser(extracted_html)
                extracted_text = (t.text(separator="\n", strip=True) or "")[:20000]
            else:
                extracted_text = extracted_html[:20000]
            extracted_count = 1 if extracted_text else 0
        except Exception as e:
            return _fail(f"readability 抽取失败: {e}")

    elif mode == "css":
        if not tree:
            return _fail("HTML 解析失败")
        if selectors:
            for name, sel in selectors.items():
                try:
                    nodes = tree.css(sel)
                    extracted_blocks[name] = {
                        "selector": sel,
                        "count": len(nodes),
                        "values": [(n.text(separator=" ", strip=True) or "")[:1000]
                                   for n in nodes[:20]],
                    }
                    extracted_count += len(nodes)
                except Exception as exc:
                    extracted_blocks[name] = {"selector": sel, "error": str(exc)[:200]}
        else:
            try:
                nodes = tree.css(selector)
                extracted_count = len(nodes)
                extracted_text = "\n\n".join(
                    (n.text(separator=" ", strip=True) or "")[:5000] for n in nodes[:50]
                )[:20000]
                extracted_html = "\n\n".join(
                    (n.html or "")[:8000] for n in nodes[:20]
                )[:40000]
            except Exception as e:
                return _fail(f"css 抽取失败: {e}")

    elif mode == "meta":
        if not tree:
            return _fail("HTML 解析失败")
        metadata = _extract_meta(tree)
        extracted_count = len(metadata)

    elif mode == "links":
        if not tree:
            return _fail("HTML 解析失败")
        links = _extract_links(tree, final_url, max_n=int(params.get("max_links") or 200))
        extracted_count = len(links)

    elif mode == "all":
        # 一站抽 readability 主内容 + meta + links + 自定义 selectors
        if _READABILITY_OK:
            try:
                doc = Document(body_text)
                title = (doc.short_title() or title).strip()[:200]
                extracted_html = doc.summary(html_partial=True)
                if _SELECTOLAX_OK:
                    t = HTMLParser(extracted_html)
                    extracted_text = (t.text(separator="\n", strip=True) or "")[:20000]
            except Exception:
                pass
        if tree:
            metadata = _extract_meta(tree)
            links = _extract_links(tree, final_url,
                                   max_n=int(params.get("max_links") or 100))
            for name, sel in (selectors or {}).items():
                try:
                    nodes = tree.css(sel)
                    extracted_blocks[name] = {
                        "selector": sel,
                        "count": len(nodes),
                        "values": [(n.text(separator=" ", strip=True) or "")[:1000]
                                   for n in nodes[:20]],
                    }
                except Exception as exc:
                    extracted_blocks[name] = {"selector": sel, "error": str(exc)[:200]}
        extracted_count = (1 if extracted_text else 0) + len(metadata) + len(links)

    else:
        return _fail(f"未知 mode={mode} (readability/css/meta/links/all)")

    elapsed_ms = int((time.time() - t0) * 1000)

    out = {
        "status": "ok", "schema_version": "v1", "task_type": "crawl_url_extract",
        "elapsed_ms": elapsed_ms,
        "summary": {
            "url": url, "final_url": final_url, "redirects": redirects,
            "host": host, "status_code": status_code,
            "content_type": content_type, "bytes": len(body_bytes),
            "mode": mode, "selector": selector,
            "selectors": list((selectors or {}).keys()),
            "title": title,
            "text_length": len(extracted_text),
            "html_length": len(extracted_html),
            "extracted_count": extracted_count,
            "metadata_count": len(metadata),
            "links_count": len(links),
            "extracted_text": extracted_text,
            "extracted_html": extracted_html if return_html else "",
            "extracted_blocks": extracted_blocks,
            "metadata": metadata,
            "links": links,
            "fetched_at": int(time.time()),
        },
        "summary_text": (
            f"✅ 抽取 ({mode}) · {title or '(无标题)'}\n"
            f"🔗 {final_url}" + (f" (重定向 {redirects} 次)" if redirects > 0 else "") + "\n"
            f"📦 块 {extracted_count} · 文本 {len(extracted_text)} · "
            f"meta {len(metadata)} · 链接 {len(links)}\n"
            f"⏱ {elapsed_ms}ms"
        ),
    }
    print(json.dumps(out, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
