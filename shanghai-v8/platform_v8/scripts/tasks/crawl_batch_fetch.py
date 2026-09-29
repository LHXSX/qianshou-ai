#!/usr/bin/env python3
"""crawl_batch_fetch — 多 URL 批量抓取 (企业级 · 2026-06-07 S5 升级)

新增:
  - **跨域并发**(同域仍串行限速 · 跨域 N 并发提速 5×)
  - **SSRF 防护**(同 crawl_url_fetch · 手动 follow 重定向 + 私 IP 拦)
  - urls 来源:EC_PARAMS.urls / EC_INPUT_DIR 文本文件(每行 1 URL)
  - 写全量 EC_OUTPUT_DIR/results.jsonl + bodies/{host}_{N}.html
  - 失败统计 (按 error 分类)
  - body_text 可选(默认 false · 大 batch 不回 body 防 stdout 撑爆)

参数 (EC_PARAMS):
  urls            list   URL 列表(优先级)
  timeout_s       int    单 URL 超时 (默认 30)
  max_bytes       int    单 URL body 上限 (默认 2MB)
  max_urls        int    单 shard 硬限 (默认 50)
  concurrency     int    跨域并发数 (默认 5 · 同域强制串行)
  user_agent      str    UA (默认平台爬虫 UA)
  return_body     bool   是否在 stdout 返 body_text (默认 false)
  save_bodies     bool   是否落盘 body 到 EC_OUTPUT_DIR (默认 false)
  follow_redirects bool  允许 30x 跳转 (默认 true · 但每跳验白名单+私 IP)
"""
import ipaddress
import json
import os
import socket
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from urllib.parse import urlparse
from urllib.robotparser import RobotFileParser

try:
    import requests
    _HAS_REQUESTS = True
except ImportError:
    requests = None  # 懒加载 · 实际抓时再校验
    _HAS_REQUESTS = False

try:
    from selectolax.parser import HTMLParser
    _SELECTOLAX_OK = True
except ImportError:
    _SELECTOLAX_OK = False


_ALLOWED_DOMAINS = {
    "wikipedia.org", "en.wikipedia.org", "zh.wikipedia.org",
    "arxiv.org", "github.com", "raw.githubusercontent.com",
    "data.gov.cn", "data.gov", "wikidata.org", "openalex.org",
    "doi.org", "ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov",
    "nature.com", "science.org",
}
_UA_DEFAULT = ("QianshouEdgeCompute-Crawler/1.0 "
               "(+https://www.qianshousuanli.com/crawl-policy; bot@qianshousuanli.com)")
_MIN_INTERVAL_S = 1.0

# 同域限速锁
_HOST_LOCKS: dict = {}
_HOST_LAST: dict = {}
_HOST_LOCKS_LOCK = threading.Lock()

# robots 缓存
_ROBOTS_CACHE: dict = {}
_ROBOTS_LOCK = threading.Lock()


def _get_host_lock(host: str) -> threading.Lock:
    with _HOST_LOCKS_LOCK:
        if host not in _HOST_LOCKS:
            _HOST_LOCKS[host] = threading.Lock()
        return _HOST_LOCKS[host]


def _host_wait_and_mark(host: str):
    with _get_host_lock(host):
        last = _HOST_LAST.get(host, 0.0)
        now = time.time()
        if now - last < _MIN_INTERVAL_S:
            time.sleep(_MIN_INTERVAL_S - (now - last))
        _HOST_LAST[host] = time.time()


def _params() -> dict:
    raw = os.environ.get("EC_PARAMS", "")
    if raw:
        try:
            return json.loads(raw) or {}
        except Exception:
            pass
    return {}


def _domain_allowed(url: str):
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception as e:
        return False, f"URL 解析失败: {e}"
    if not host:
        return False, "URL 没有 hostname"
    if host in _ALLOWED_DOMAINS:
        return True, host
    for allowed in _ALLOWED_DOMAINS:
        if host.endswith("." + allowed):
            return True, host
    return False, f"域名 {host} 不在白名单"


def _is_private_ip(host: str) -> bool:
    """SSRF 防护:解析 host 到 IP · 拒私网/回环/链路本地"""
    try:
        addrs = socket.getaddrinfo(host, None)
        for fam, _, _, _, sock in addrs:
            ip = sock[0]
            try:
                ip_obj = ipaddress.ip_address(ip)
                if (ip_obj.is_private or ip_obj.is_loopback
                        or ip_obj.is_link_local or ip_obj.is_multicast
                        or ip_obj.is_reserved):
                    return True
            except ValueError:
                continue
    except socket.gaierror:
        return True  # 解析失败 · 当作不可达
    return False


def _robots_allows(url: str, ua: str) -> bool:
    try:
        parts = urlparse(url)
        netloc = parts.netloc
        with _ROBOTS_LOCK:
            cached = _ROBOTS_CACHE.get(netloc)
        if cached is None:
            rp = RobotFileParser()
            rp.set_url(f"{parts.scheme}://{parts.netloc}/robots.txt")
            try:
                rp.read()
            except Exception:
                with _ROBOTS_LOCK:
                    _ROBOTS_CACHE[netloc] = False
                return True
            with _ROBOTS_LOCK:
                _ROBOTS_CACHE[netloc] = rp
            cached = rp
        if cached is False:
            return True
        return cached.can_fetch(ua, url)
    except Exception:
        return True


def _read_urls(p: dict) -> list:
    urls = p.get("urls") or []
    if urls:
        return urls
    input_dir = os.environ.get("EC_INPUT_DIR", "")
    if input_dir and os.path.isdir(input_dir):
        collected = []
        for fname in sorted(os.listdir(input_dir)):
            fp = os.path.join(input_dir, fname)
            if not os.path.isfile(fp):
                continue
            try:
                with open(fp, "r", encoding="utf-8", errors="replace") as fh:
                    for ln in fh:
                        ln = ln.strip()
                        if ln and not ln.startswith("#"):
                            collected.append(ln)
            except Exception:
                continue
        return collected
    return []


def _fetch_one(url: str, timeout_s: int, max_bytes: int, ua: str,
               follow_redirects: bool, return_body: bool,
               save_bodies: bool, out_dir: str, file_idx: int) -> dict:
    t0 = time.time()
    ok, msg = _domain_allowed(url)
    if not ok:
        return {"url": url, "ok": False, "error": msg, "elapsed_ms": 0}
    host = msg

    if _is_private_ip(host):
        return {"url": url, "ok": False,
                "error": f"SSRF 拦截: {host} 解析为私网/回环 IP",
                "elapsed_ms": int((time.time() - t0) * 1000)}

    if not _robots_allows(url, ua):
        return {"url": url, "ok": False, "error": "robots.txt 禁止",
                "elapsed_ms": int((time.time() - t0) * 1000)}

    if not _HAS_REQUESTS:
        return {"url": url, "ok": False,
                "error": "节点缺 requests 库 · pip install requests",
                "elapsed_ms": int((time.time() - t0) * 1000)}

    _host_wait_and_mark(host)

    cur_url = url
    redirects = 0
    max_redirects = 5
    try:
        while True:
            resp = requests.get(
                cur_url,
                headers={
                    "User-Agent": ua,
                    "Accept": "text/html,*/*;q=0.9",
                    "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8",
                },
                timeout=timeout_s,
                allow_redirects=False,
                stream=True,
            )
            if follow_redirects and resp.status_code in (301, 302, 303, 307, 308):
                redirects += 1
                if redirects > max_redirects:
                    return {"url": url, "ok": False,
                            "error": f"重定向超过 {max_redirects} 次",
                            "elapsed_ms": int((time.time() - t0) * 1000)}
                new_url = resp.headers.get("Location") or ""
                if not new_url:
                    break
                ok2, msg2 = _domain_allowed(new_url)
                if not ok2:
                    return {"url": url, "ok": False,
                            "error": f"重定向到白名单外: {new_url} ({msg2})",
                            "elapsed_ms": int((time.time() - t0) * 1000)}
                if _is_private_ip(msg2):
                    return {"url": url, "ok": False,
                            "error": f"重定向到私网 IP: {new_url}",
                            "elapsed_ms": int((time.time() - t0) * 1000)}
                cur_url = new_url
                continue
            break
    except requests.exceptions.RequestException as e:
        return {"url": url, "ok": False, "error": f"请求失败: {e}",
                "elapsed_ms": int((time.time() - t0) * 1000)}

    body_bytes = b""
    for chunk in resp.iter_content(chunk_size=64 * 1024):
        body_bytes += chunk
        if len(body_bytes) >= max_bytes:
            body_bytes = body_bytes[:max_bytes]
            break

    encoding = resp.encoding or "utf-8"
    body_text = body_bytes.decode(encoding, errors="replace")
    title = ""
    if _SELECTOLAX_OK and "html" in resp.headers.get("Content-Type", "").lower():
        try:
            tree = HTMLParser(body_text)
            t_node = tree.css_first("title")
            if t_node:
                title = (t_node.text() or "").strip()[:200]
        except Exception:
            pass

    saved_path = None
    if save_bodies and out_dir:
        safe_host = host.replace(":", "_").replace("/", "_")
        saved_path = os.path.join(out_dir, f"{safe_host}_{file_idx}.html")
        try:
            with open(saved_path, "wb") as fh:
                fh.write(body_bytes)
        except Exception:
            saved_path = None

    out = {
        "url": url,
        "ok": resp.status_code < 400,
        "final_url": cur_url if redirects > 0 else url,
        "host": host,
        "status_code": resp.status_code,
        "content_type": resp.headers.get("Content-Type", ""),
        "bytes": len(body_bytes),
        "title": title,
        "redirects": redirects,
        "elapsed_ms": int((time.time() - t0) * 1000),
    }
    if saved_path:
        out["saved_path"] = saved_path
    if return_body:
        out["body_text"] = body_text[:50_000]  # 防爆 · 单条 50KB
    return out


def main() -> int:
    t0 = time.time()
    try:
        p = _params()

        urls = _read_urls(p)
        if not urls:
            print(json.dumps({
                "status": "failed", "task_type": "crawl_batch_fetch",
                "error": "缺 urls (EC_PARAMS.urls / EC_INPUT_DIR)",
                "summary_text": "❌ 无 URL",
            }, ensure_ascii=False))
            return 1

        timeout_s = int(p.get("timeout_s") or 30)
        max_bytes = int(p.get("max_bytes") or 2 * 1024 * 1024)
        max_urls = min(len(urls), int(p.get("max_urls") or 50))
        concurrency = max(1, min(20, int(p.get("concurrency") or 5)))
        ua = p.get("user_agent") or _UA_DEFAULT
        follow_redirects = bool(p.get("follow_redirects", True))
        return_body = bool(p.get("return_body", False))
        save_bodies = bool(p.get("save_bodies", False))

        out_dir = os.environ.get("EC_OUTPUT_DIR", "")
        if save_bodies and not (out_dir and os.path.isdir(out_dir)):
            save_bodies = False

        targets = [(u or "").strip() for u in urls[:max_urls]]
        targets = [u for u in targets if u]

        results = [None] * len(targets)
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            futs = {ex.submit(_fetch_one, u, timeout_s, max_bytes, ua,
                              follow_redirects, return_body, save_bodies,
                              out_dir, i): i
                    for i, u in enumerate(targets)}
            for fu in as_completed(futs):
                idx = futs[fu]
                try:
                    results[idx] = fu.result()
                except Exception as exc:
                    results[idx] = {"url": targets[idx], "ok": False,
                                    "error": f"worker 异常: {exc}", "elapsed_ms": 0}

        # 写全量
        jsonl_path = None
        if out_dir and os.path.isdir(out_dir):
            jsonl_path = os.path.join(out_dir, "results.jsonl")
            try:
                with open(jsonl_path, "w", encoding="utf-8") as fh:
                    for r in results:
                        fh.write(json.dumps(r, ensure_ascii=False) + "\n")
            except Exception:
                jsonl_path = None

        ok_count = sum(1 for r in results if r and r.get("ok"))
        fail_count = len(results) - ok_count

        # 失败类别统计
        err_dist: dict = {}
        for r in results:
            if r and not r.get("ok"):
                err = (r.get("error") or "unknown")[:50]
                err_dist[err] = err_dist.get(err, 0) + 1

        elapsed_ms = int((time.time() - t0) * 1000)
        print(json.dumps({
            "status": "ok", "schema_version": "v1", "task_type": "crawl_batch_fetch",
            "elapsed_ms": elapsed_ms,
            "summary": {
                "input_count": len(urls),
                "fetched_count": len(results),
                "ok_count": ok_count,
                "fail_count": fail_count,
                "concurrency": concurrency,
                "error_distribution": err_dist,
                "output_jsonl": jsonl_path,
                "save_bodies": save_bodies,
            },
            "results": results,
            "summary_text": (
                f"✅ 批量抓取 · 输入 {len(urls)} 处理 {len(results)} "
                f"· ✓{ok_count} ✗{fail_count} · 并发 {concurrency} · {elapsed_ms}ms"
                + (f"\n📁 {jsonl_path}" if jsonl_path else "")
            ),
        }, ensure_ascii=False))
        return 0
    except Exception as e:
        print(json.dumps({
            "status": "failed", "task_type": "crawl_batch_fetch",
            "error": str(e), "summary_text": "❌ " + str(e),
        }, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.exit(main())
