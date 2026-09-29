#!/usr/bin/env python3
"""Build portable non-native packages from SHA-verified official Electron assets; never run them."""
import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import stat
import subprocess
import tarfile
import tempfile
import time
from datetime import datetime, timezone
import urllib.request
import zipfile
from bundle_files import app_files

APP_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = APP_ROOT.parent.parent
RESERVE = 4 * 1024**3
VERSION = "44.0.0"
RELEASE_API = f"https://api.github.com/repos/electron/electron/releases/tags/v{VERSION}"



def digest(path):
    value = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def require_space(path, extra=0):
    free = shutil.disk_usage(path).free
    if free < RESERVE + extra:
        raise RuntimeError(f"INSUFFICIENT_DISK: {free} bytes free; require {RESERVE + extra}; keep at least 4 GiB")
    return free


def fetch(url):
    if not url.startswith("https://"):
        raise RuntimeError("Only verified HTTPS release URLs are accepted")
    return urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "qianshou-companion-release-builder"}), timeout=45)


def official_assets(cache):
    with fetch(RELEASE_API) as response:
        release = json.load(response)
    if release.get("tag_name") != f"v{VERSION}":
        raise RuntimeError("Release tag mismatch")
    assets = {asset["name"]: asset for asset in release["assets"]}
    sums = cache / "SHASUMS256.txt"
    download(assets["SHASUMS256.txt"], sums)
    hashes = {}
    for line in sums.read_text().splitlines():
        match = re.fullmatch(r"([0-9a-f]{64})\s+\*?(.+)", line)
        if match:
            hashes[match[2]] = match[1]
    return assets, hashes, digest(sums)


def download(asset, destination, expected=None):
    published = asset.get("digest", "")
    api_hash = published.removeprefix("sha256:") if published.startswith("sha256:") else None
    expected = expected or api_hash
    if not expected or len(expected) != 64 or (api_hash and api_hash != expected):
        raise RuntimeError("Official release checksums are absent or inconsistent")
    if destination.exists() and digest(destination) == expected:
        print(f"Verified cached {destination.name}", flush=True)
        return expected
    require_space(destination.parent, asset["size"] + 32 * 1024**2)
    temporary = destination.with_suffix(destination.suffix + ".partial")
    try:
        # curl detects truncated Content-Length transfers and resumes official HTTPS assets.
        process = subprocess.Popen(["curl", "--fail", "--location", "--silent", "--show-error", "--retry", "3", "--retry-all-errors", "--connect-timeout", "20", "--max-time", "300", "--continue-at", "-", "--output", str(temporary), asset["browser_download_url"]])
        while process.poll() is None:
            try:
                require_space(destination.parent, 16 * 1024**2)
            except BaseException:
                process.terminate()
                process.wait()
                raise
            time.sleep(5)
            size = temporary.stat().st_size if temporary.exists() else 0
            print(f"Downloading {destination.name}: {size}/{asset['size']} bytes", flush=True)
        if process.returncode:
            raise RuntimeError(f"Official download failed with curl exit {process.returncode}")
        size = temporary.stat().st_size
        if size != asset["size"] or digest(temporary) != expected:
            raise RuntimeError(f"Official checksum/size mismatch for {destination.name}: {size}/{asset['size']} bytes")
        temporary.replace(destination)
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    print(f"SHA-256 verified {destination.name}: {expected}", flush=True)
    return expected


def extract_runtime(archive, destination):
    with zipfile.ZipFile(archive) as runtime:
        total = sum(info.file_size for info in runtime.infolist())
        require_space(destination.parent, total * 2 + 256 * 1024**2)
        for info in runtime.infolist():
            name = PurePosixPath(info.filename)
            mode = info.external_attr >> 16
            if name.is_absolute() or ".." in name.parts or stat.S_ISLNK(mode):
                raise RuntimeError(f"Unexpected runtime archive path: {info.filename}")
            target = destination.joinpath(*name.parts)
            if info.is_dir():
                target.mkdir(parents=True, exist_ok=True)
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            with runtime.open(info) as stream, target.open("wb") as output:
                shutil.copyfileobj(stream, output)
            if mode & 0o777:
                target.chmod(mode & 0o777)


def package(target, asset, expected, sums_hash, output, files):
    package_info = json.loads((APP_ROOT / "package.json").read_text())
    app_version = package_info["version"]
    archive = output / "runtime-cache" / asset["name"]
    runtime_hash = download(asset, archive, expected)
    folder_name = f"qianshou-companion-{app_version}-{target}-x64"
    extension = ".zip" if target == "win32" else ".tar.gz"
    destination = output / (folder_name + extension)
    if destination.exists():
        raise RuntimeError(f"OUTPUT_EXISTS: preserve or move {destination} before rebuilding")
    with tempfile.TemporaryDirectory(prefix="staging-", dir=output) as staging:
        folder = Path(staging) / folder_name
        extract_runtime(archive, folder)
        app = folder / "resources" / "app"
        (app / "lib").mkdir(parents=True, exist_ok=True)
        source_entries = []
        for name in files:
            source = APP_ROOT / "lib" / name
            dest = app / "lib" / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, dest)
            source_entries.append({"path": "lib/" + name, "sha256": digest(source), "bytes": source.stat().st_size})
        (app / "package.json").write_text(json.dumps({"name": "qianshou-companion", "productName": "千手协作端", "version": app_version, "distribution": "bundled", "channel": "preview", "type": "module", "main": "lib/main.js"}, ensure_ascii=False, indent=2) + "\n")
        shutil.copy2(REPO_ROOT / "LICENSE", app / "LICENSE-DeepSeek-MIT.txt")
        shutil.copy2(APP_ROOT / "node_modules/ws/LICENSE", app / "LICENSE-ws-MIT.txt")
        shutil.copy2(REPO_ROOT / "apps/qianshou-desktop/assets/icon.png", folder / "qianshou.png")
        (folder / "resources" / "default_app.asar").unlink(missing_ok=True)
        if target == "win32":
            (folder / "electron.exe").rename(folder / "QianshouCompanion.exe")
            launcher = "QianshouCompanion.exe"
            launch_zh = "完整解压 ZIP 后，双击 QianshouCompanion.exe。不要只从压缩包内运行 EXE。"
            launch_en = "Extract the complete ZIP, then run QianshouCompanion.exe. Do not run only the executable from inside the archive."
        else:
            (folder / "electron").rename(folder / "qianshou-companion")
            (folder / "qianshou-companion").chmod(0o755)
            launcher = "start-qianshou.sh"
            (folder / launcher).write_text('#!/bin/sh\nset -eu\napp_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$app_dir/qianshou-companion" "$@"\n')
            (folder / launcher).chmod(0o755)
            launch_zh = "解压 tar.gz，在图形桌面会话中运行 ./start-qianshou.sh。不要使用 root 或 --no-sandbox。系统须具备 Electron 所需桌面库、安全密钥服务与可用的 Chromium 沙箱。"
            launch_en = "Extract the tar.gz and run ./start-qianshou.sh in a graphical desktop session. Do not run as root or pass --no-sandbox. Electron desktop libraries, a secure secret service, and a usable Chromium sandbox are required."
        note_zh = f"千手协作端 {app_version} — {target} x64\n\n状态：已打包，未在目标系统启动验收。\n\n{launch_zh}\n\n在协作端选择授权工作目录，再填入主控 HTTPS 地址与五分钟有效的一次性配对码。http://127.0.0.1:3081 仅表示当前设备自身，不是另一台 Mac 主控。每项远程任务须本机批准；命令使用当前用户权限。桌面请求需要另行安装 RustDesk 并授予系统权限。此包没有安装 RustDesk、开放端口或配置网络入口。\n\n此为未签名便携发行包，不含系统安装器。帮助菜单提供检查软件更新；新版后台下载、验签，任务空闲后可重启升级，保留本地配置与自己的 API 密钥。Windows EXE 文件图标仍使用官方运行时图标，统一产品图标随包提供为 qianshou.png。校验与来源见 BUILD_MANIFEST.json。\n"
        note_en = f"Qianshou Companion {app_version} — {target} x64\n\nStatus: PACKAGED; NOT LAUNCH-VALIDATED ON THE TARGET OPERATING SYSTEM.\n\n{launch_en}\n\nSelect an approved workspace and enter the controller HTTPS address plus its five-minute pairing code. http://127.0.0.1:3081 refers to this device, not another Mac controller. Every task requires local approval; commands run with local-user privileges. Desktop requests require separately installed RustDesk and OS permissions. This package installs no remote desktop software, opens no ports, and configures no network ingress.\n\nThis unsigned portable package has no system installer. Help offers Check for Updates: releases download and verify in the background, then restart on request when tasks are idle, preserving local configuration and your own API keys. The Windows executable retains its official runtime icon; qianshou.png supplies the product icon. See BUILD_MANIFEST.json for checksums and provenance.\n"
        (folder / "开始使用.txt").write_text(note_zh, encoding="utf-8")
        (folder / "START_HERE.txt").write_text(note_en, encoding="utf-8")
        manifest = {"product": "千手协作端", "appVersion": app_version, "electronVersion": VERSION, "platform": target, "arch": "x64", "builtAt": datetime.now(timezone.utc).isoformat(), "buildHost": "macOS", "status": "PACKAGED_NOT_TARGET_LAUNCH_VALIDATED", "statusZh": "已打包，未在目标系统启动验收", "targetBinaryExecuted": False, "launcher": launcher, "runtime": {"url": asset["browser_download_url"], "sha256": runtime_hash, "officialShaSums256Sha256": sums_hash, "releaseApi": RELEASE_API}, "appFiles": source_entries, "validation": {"officialRuntimeChecksum": True, "appImportClosure": True, "targetLaunch": False, "targetPairAndExecute": False}, "macInstallationModified": False, "minimumFreeBytes": RESERVE}
        manifest["channel"] = "preview"
        manifest_text = json.dumps(manifest, ensure_ascii=False, indent=2) + "\n"
        (folder / "BUILD_MANIFEST.json").write_text(manifest_text)
        # Keep an auditable index inside the package before creating the outer archive.
        checksums = [f"{digest(path)}  {path.relative_to(folder).as_posix()}" for path in sorted(folder.rglob("*")) if path.is_file()]
        (folder / "PACKAGE_FILES.sha256").write_text("\n".join(checksums) + "\n")
        require_space(output, sum(path.stat().st_size for path in folder.rglob("*") if path.is_file()) + 64 * 1024**2)
        if target == "win32":
            with zipfile.ZipFile(destination, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as result:
                for path in sorted(folder.rglob("*")):
                    if path.is_file():
                        result.write(path, path.relative_to(Path(staging)).as_posix())
            with zipfile.ZipFile(destination) as result:
                if result.testzip() is not None:
                    raise RuntimeError("Packaged ZIP CRC validation failed")
        else:
            with tarfile.open(destination, "w:gz", compresslevel=6) as result:
                result.add(folder, arcname=folder_name)
            with tarfile.open(destination, "r:gz") as result:
                for member in result:
                    if member.isfile():
                        stream = result.extractfile(member)
                        for _ in iter(lambda: stream.read(1024 * 1024), b""):
                            pass
        manifest["archive"] = {"path": str(destination), "bytes": destination.stat().st_size, "sha256": digest(destination), "integrityChecked": True}
        (output / (folder_name + ".manifest.json")).write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n")
        (output / (folder_name + ".sha256")).write_text(f"{manifest['archive']['sha256']}  {destination.name}\n")
    require_space(output)
    print(json.dumps(manifest["archive"], ensure_ascii=False), flush=True)
    return manifest


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("targets", nargs="*", choices=["win32", "linux"], default=["win32", "linux"])
    parser.add_argument("--output", type=Path, default=APP_ROOT / "dist" / "portable")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    cache = args.output / "runtime-cache"
    cache.mkdir(exist_ok=True)
    require_space(args.output, 2 * 1024**3)
    files = app_files()
    assets, hashes, sums_hash = official_assets(cache)
    records = []
    for target in args.targets:
        name = f"electron-v{VERSION}-{target}-x64.zip"
        records.append(package(target, assets[name], hashes[name], sums_hash, args.output, files))
    (args.output / "RELEASE_MANIFEST.json").write_text(json.dumps({"statusZh": "已打包，未在目标系统启动验收", "targets": records, "freeBytesAfter": require_space(args.output)}, ensure_ascii=False, indent=2) + "\n")


if __name__ == "__main__":
    main()
