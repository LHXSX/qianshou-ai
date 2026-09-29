"""Read-only dependency and device gate for a candidate Windows H3 installation.

Run separately with the API Python and the candidate Comfy embedded Python.
No package is installed and no graph, model, sampler or GPU render is run.
"""

from __future__ import annotations

import sys

sys.dont_write_bytecode = True

import argparse
import hashlib
import importlib.metadata
import json
import os
import re
import shutil
import subprocess
from pathlib import Path
from urllib.parse import urlsplit


ROOT = Path(__file__).resolve().parents[1]
VENDOR_DIRS = {
    "ComfyUI": ".",
    "ComfyUI-KJNodes": "custom_nodes/ComfyUI-KJNodes",
    "ComfyUI_LayerStyle": "custom_nodes/ComfyUI_LayerStyle",
    "ComfyUI-VideoHelperSuite": "custom_nodes/ComfyUI-VideoHelperSuite",
}
AUTO_SAGE_CAPABILITIES = {(7, 5), (8, 0), (8, 6), (8, 9), (9, 0), (12, 0)}
# The pinned Comfy closure includes setuptools. Its standard shim is the only
# site startup hook admitted; all other .pth entries can import arbitrary code
# before this preflight runs or add another source tree to sys.path.
SETUPTOOLS_DISTUTILS_PTH_SHA256 = "2638ce9e2500e572a5e0de7faed6661eb569d1b696fcba07b0dd223da5f5d224"
BASE_ROOT_ENTRIES = {
    "DLLs", "Doc", "include", "Lib", "libs", "Scripts", "tcl",
    "LICENSE.txt", "NEWS.txt", "python.exe", "pythonw.exe", "python3.dll",
    "python312.dll", "vcruntime140.dll", "vcruntime140_1.dll",
}
VENV_ROOT_ENTRIES = {"Include", "Lib", "Scripts", "pyvenv.cfg"}
# These five non-code files are installed at the venv root by the exact locked
# color-matcher, fonttools, and sympy wheels.  Pin their installed bytes as
# well as their paths so the venv root cannot silently become an import source.
COMFY_VENV_DATA_SHA256 = {
    "tests/data/scotland_house.png": "ee72831c8230b569285b5254db2373e88e0befae74acb6022d42a0c8e91ad7d1",
    "tests/data/scotland_pitie.png": "e5aa2be84a6119d5aa9fdfeb4bbe824d7b8fea3baa71c2177325dc8343bc6193",
    "tests/data/scotland_plain.png": "459b97bafb1489f9ea2f1c376988a571b37cb56d46ea08a5ad91a98cb02cc177",
    "share/man/man1/ttx.1": "13bd45f6644d5a5b6d569ce59cfef0fdfaa443280f929879b3e02d55ad09b39d",
    "share/man/man1/isympy.1": "f4365d48e2102e292b0131e56e4743674e0b0508a0643504d3fa025c10ef741b",
}
EXPECTED_GIT_STATUS = {
    "ComfyUI": {
        " M comfy/ops.py", " M comfy/sd.py", " M comfy/weight_adapter/bypass.py",
        " M comfy_extras/nodes_minimax_h3.py", " M server.py", "?? comfy/minimax_lora_guard.py",
    },
    "ComfyUI-KJNodes": {" M nodes/model_optimization_nodes.py"},
    "ComfyUI_LayerStyle": set(),
    "ComfyUI-VideoHelperSuite": set(),
}


def reject(message: str) -> None:
    raise RuntimeError(message)


def canonical_name(name: str) -> str:
    return re.sub(r"[-_.]+", "-", name).lower()


def require_interpreter_root_layout(prefix: Path, base: Path, *, comfy: bool) -> None:
    if {item.name for item in base.iterdir()} != BASE_ROOT_ENTRIES:
        reject("基础 Python 根含非固定顶层软件来源")
    if (base / f"python{sys.version_info.major}{sys.version_info.minor}.zip").exists():
        reject("基础 Python 含未锁定的可导入 ZIP")
    for item in base.iterdir():
        if item.is_symlink() or getattr(item, "is_junction", lambda: False)():
            reject("基础 Python 根含链接")
    if prefix == base:
        return
    expected = VENV_ROOT_ENTRIES | ({"tests", "share"} if comfy else set())
    if {item.name for item in prefix.iterdir()} != expected:
        reject("候选 venv 根含非固定顶层软件来源")
    for item in prefix.iterdir():
        if item.is_symlink() or getattr(item, "is_junction", lambda: False)():
            reject("候选 venv 根含链接")
    if comfy:
        for top in ("tests", "share"):
            tree = prefix / top
            actual = set()
            for item in tree.rglob("*"):
                if item.is_symlink() or getattr(item, "is_junction", lambda: False)():
                    reject("候选 venv 数据目录含链接")
                if item.is_file():
                    if item.stat().st_nlink != 1:
                        reject("候选 venv 数据文件含硬链接")
                    rel = item.relative_to(prefix).as_posix()
                    actual.add(rel)
                    expected_sha = COMFY_VENV_DATA_SHA256.get(rel)
                    if expected_sha is None or hashlib.sha256(item.read_bytes()).hexdigest() != expected_sha:
                        reject("候选 venv 根数据文件与固定 wheel 不符")
                elif not item.is_dir():
                    reject("候选 venv 数据目录含非普通条目")
            if actual != {name for name in COMFY_VENV_DATA_SHA256 if name.startswith(top + "/")}:
                reject("候选 venv 根数据文件集合不固定")


def require_python_source_paths(comfy_root: Path | None = None) -> None:
    # -B disables bytecode; it does not suppress PYTHONPATH, PYTHONHOME, or
    # embedded Python's python312._pth entries.  Only the interpreter's own
    # standard library/site-packages and this preflight script may be imported.
    forbidden = ("PYTHONPATH", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONSTARTUP")
    present = [name for name in forbidden if os.environ.get(name)]
    if present:
        reject("Python 环境注入变量未清理: " + ", ".join(present))
    if os.environ.get("PYTHONNOUSERSITE") != "1":
        reject("候选进程必须禁用 Python 用户 site-packages")
    prefix = Path(sys.prefix).resolve(strict=True)
    base = Path(sys.base_prefix).resolve(strict=True)
    script_dir = Path(__file__).resolve(strict=True).parent
    allowed_comfy = None
    if comfy_root is not None:
        if (not comfy_root.is_absolute() or not comfy_root.is_dir() or comfy_root.is_symlink() or
                getattr(comfy_root, "is_junction", lambda: False)()):
            reject("候选 Comfy 源码根无效或被链接")
        allowed_comfy = comfy_root.resolve(strict=True)
    allowed_paths = {
        script_dir, prefix, prefix / "Lib" / "site-packages",
        base, base / "Lib", base / "DLLs",
        base / f"python{sys.version_info.major}{sys.version_info.minor}.zip",
    }
    if allowed_comfy is not None:
        allowed_paths.add(allowed_comfy)
    for raw in sys.path:
        if not raw:
            reject("Python sys.path 含相对当前目录")
        entry = Path(raw)
        if not entry.is_absolute():
            reject("Python sys.path 含相对搜索路径")
        resolved = entry.resolve(strict=False)
        if resolved in allowed_paths:
            continue
        reject("Python sys.path 含候选解释器之外的软件来源")
    require_interpreter_root_layout(prefix, base, comfy=comfy_root is not None)


def require_site_hooks(site_root: Path, pins: dict[str, str]) -> None:
    for path in site_root.iterdir():
        if path.name.casefold() in {"sitecustomize.py", "usercustomize.py"}:
            reject("候选 site-packages 含启动时代码钩子")
        if not path.name.casefold().endswith(".pth"):
            continue
        if (path.name != "distutils-precedence.pth" or pins.get("setuptools") != "82.0.1" or
                not path.is_file() or path.is_symlink() or path.stat().st_nlink != 1 or
                hashlib.sha256(path.read_bytes()).hexdigest() != SETUPTOOLS_DISTUTILS_PTH_SHA256):
            reject("候选 site-packages 含未锁定的 .pth 启动钩子")


def require_distributions(pins: dict[str, str]) -> None:
    installed = {}
    for dist in importlib.metadata.distributions():
        name = dist.metadata.get("Name")
        if not isinstance(name, str) or not name.strip():
            reject("候选环境含无名分发包")
        canonical = canonical_name(name)
        if canonical in installed:
            reject("候选环境含重复分发包: " + canonical)
        installed[canonical] = dist
    allowed = {canonical_name(name) for name in pins} | {"pip"}
    extras = set(installed) - allowed
    if extras:
        reject("候选环境含未锁定分发包: " + ", ".join(sorted(extras)))
    mismatches = [name for name, pin in pins.items()
                  if canonical_name(name) not in installed or installed[canonical_name(name)].version != pin]
    if mismatches:
        # Report names only; paths or private environment values are never printed.
        reject("依赖缺失或版本不符: " + ", ".join(sorted(mismatches)))
    site_root = (Path(sys.prefix).resolve(strict=True) / "Lib" / "site-packages")
    for name in pins:
        location = Path(installed[canonical_name(name)].locate_file("")).resolve(strict=True)
        if not location.is_relative_to(site_root):
            reject("安装包不在候选解释器 site-packages: " + name)
    if "pip" in installed:
        location = Path(installed["pip"].locate_file("")).resolve(strict=True)
        if not location.is_relative_to(site_root):
            reject("引导 pip 不在候选解释器 site-packages")
    require_site_hooks(site_root, pins)


def require_wheel_lock(lock: dict, mode: str) -> None:
    wheel_lock = json.loads((ROOT / lock["wheelLock"]).read_text(encoding="utf-8"))
    if (wheel_lock.get("schemaVersion") != 1 or wheel_lock.get("scope") != lock["scope"] or
            wheel_lock.get("target") != {"python": "3.12.10", "implementation": "CPython", "platform": "win_amd64"}):
        reject("Python wheel 来源锁 schema/平台不匹配")
    resolved = lock["apiResolved" if mode == "api" else "comfyResolved"]
    expected = {f"{canonical_name(name)}=={version}" for name, version in resolved.items()}
    if set(wheel_lock["profiles"][mode]) != expected or len(wheel_lock["profiles"][mode]) != len(expected):
        reject("Python wheel profile 与依赖闭包不一致")
    if set(wheel_lock["wheels"]) != set(wheel_lock["profiles"]["api"]) | set(wheel_lock["profiles"]["comfy"]):
        reject("Python wheel 锁存在缺失或额外分发包")
    for key in expected:
        row = wheel_lock["wheels"][key]
        if not re.fullmatch(r"[0-9a-f]{64}", row["sha256"]):
            reject("Python wheel SHA256 不合法")
        url = urlsplit(row["url"])
        if (url.scheme != "https" or url.hostname not in
                ("files.pythonhosted.org", "download-r2.pytorch.org", "github.com") or
                url.username or url.password or url.query or url.fragment):
            reject("Python wheel 来源不是固定公开地址")
        if not row["filename"].endswith(".whl"):
            reject("Python wheel 文件名不合法")
    # PEP 610 direct_url is optional for ordinary index installs. When present,
    # require its recorded archive hash to agree with the public wheel lock.
    installed = {canonical_name(d.metadata["Name"]): d for d in importlib.metadata.distributions()}
    for name, version in resolved.items():
        dist = installed[canonical_name(name)]
        raw = dist.read_text("direct_url.json")
        if not raw:
            continue
        try:
            origin = json.loads(raw)
            digest = origin["archive_info"]["hashes"]["sha256"]
        except (TypeError, KeyError, ValueError):
            reject("安装包来源缺少可核 SHA256: " + name)
        if digest != wheel_lock["wheels"][f"{canonical_name(name)}=={version}"]["sha256"]:
            reject("安装包来源 wheel 摘要与锁不符: " + name)


def require_python_version(lock: dict, mode: str) -> None:
    version = lock["apiPython" if mode == "api" else "comfyPython"]
    expected = tuple(int(part) for part in version.split("."))
    if len(expected) != 3 or sys.version_info[:3] != expected:
        reject("Python 完整版本与固定安装基线不符")


def clean_git_env() -> dict[str, str]:
    env = {name: value for name, value in os.environ.items()
           if not name.upper().startswith("GIT_")}
    env["GIT_CONFIG_NOSYSTEM"] = "1"
    env["GIT_CONFIG_GLOBAL"] = os.devnull
    env["GIT_OPTIONAL_LOCKS"] = "0"
    return env


def git_file_identity(executable: Path, expected_sha256: str) -> tuple:
    if (not executable.is_absolute() or executable.name != "git.exe" or
            executable.parent.name.casefold() != "bin" or
            executable.parent.parent.name.casefold() != "mingw64"):
        reject("受控 Git 不是固定 engine 绝对路径")
    for part in (executable, *executable.parents):
        if part.exists() and (part.is_symlink() or getattr(part, "is_junction", lambda: False)()):
            reject("受控 Git 路径含链接或 junction")
    if not executable.is_file():
        reject("受控 Git engine 缺失")
    resolved = executable.resolve(strict=True)
    stat = executable.stat()
    identity = (str(resolved), stat.st_dev, stat.st_ino, stat.st_size,
                stat.st_ctime_ns, stat.st_mtime_ns)
    siblings = {"git.exe", "git-upload-pack.exe", "git-receive-pack.exe",
                "git-upload-archive.exe"}
    if stat.st_nlink != 4:
        reject("受控 Git engine 四硬链接布局不符")
    for name in siblings:
        sibling = executable.parent / name
        if (not sibling.is_file() or sibling.is_symlink() or
                getattr(sibling, "is_junction", lambda: False)()):
            reject("受控 Git engine 硬链接成员缺失或被链接")
        other = sibling.stat()
        if (other.st_dev, other.st_ino, other.st_nlink) != (stat.st_dev, stat.st_ino, 4):
            reject("受控 Git engine 硬链接成员与固定文件不一致")
    if hashlib.sha256(executable.read_bytes()).hexdigest() != expected_sha256:
        reject("受控 Git 可执行字节与固定来源锁不符")
    return identity


def require_fixed_git(lock: dict) -> Path:
    raw = os.environ.get("H3_CANONICAL_GIT_EXE", "")
    if not raw:
        reject("受控 Git 绝对路径未配置")
    executable = Path(raw)
    git_lock = lock["externalExecutables"]["git"]
    git_file_identity(executable, git_lock["observedSha256"])
    result = subprocess.run([str(executable), "--version"], capture_output=True,
                            text=True, timeout=10, check=False, env=clean_git_env())
    if result.returncode or result.stdout.strip() != "git version " + git_lock["observedVersion"]:
        reject("受控 Git 版本与固定来源锁不符")
    return executable


def require_external_tools(lock: dict) -> Path:
    if set(lock["externalExecutables"]) != {"git", "ffmpeg", "nvidia-smi"}:
        reject("外部程序来源锁集合不固定")
    git_executable = require_fixed_git(lock)
    for name in ("ffmpeg", "nvidia-smi"):
        executable = shutil.which(name)
        if not executable:
            reject("外部程序不可用: " + name)
        result = subprocess.run(
            [executable, "-version" if name == "ffmpeg" else "--version"],
            capture_output=True,
            text=True,
            timeout=10,
            check=False,
        )
        if result.returncode != 0 or not result.stdout.strip():
            reject("外部程序版本无法核验: " + name)
        if name == "ffmpeg":
            expected_version = lock["externalExecutables"]["ffmpeg"]["observedVersion"]
            if not result.stdout.startswith("ffmpeg version " + expected_version + " "):
                reject("ffmpeg 版本与固定基线不符")
            expected_hash = lock["externalExecutables"]["ffmpeg"]["observedSha256"]
            hasher = hashlib.sha256()
            with open(executable, "rb") as reader:
                for chunk in iter(lambda: reader.read(8 * 1024 * 1024), b""):
                    hasher.update(chunk)
            if hasher.hexdigest() != expected_hash:
                reject("ffmpeg 可执行字节与固定基线不符")
    return git_executable


def git_read(git_executable: Path, expected_sha256: str, repo: Path,
             arguments: list[str], *, text: bool = True) -> subprocess.CompletedProcess:
    identity_before = git_file_identity(git_executable, expected_sha256)
    result = subprocess.run(
        [str(git_executable), "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false",
         "-C", str(repo), *arguments],
        capture_output=True, text=text, timeout=15, check=False, env=clean_git_env(),
    )
    if git_file_identity(git_executable, expected_sha256) != identity_before:
        reject("受控 Git 文件身份在来源核验中改变")
    return result


def git_oid(repo: Path, expression: str, git_executable: Path,
            expected_sha256: str) -> str:
    proc = git_read(git_executable, expected_sha256, repo,
                    ["rev-parse", "--verify", expression])
    value = proc.stdout.strip()
    if proc.returncode != 0 or not re.fullmatch(r"[0-9a-f]{40}", value):
        reject("供应商源码缺少可核对的 Git 提交或 tree")
    return value


def require_vendor_roots(comfy_root: Path, manifest: dict,
                         git_executable: Path, git_sha256: str) -> None:
    for vendor in manifest["vendors"]:
        path = comfy_root / VENDOR_DIRS[vendor["name"]]
        if not path.is_dir():
            reject("供应商源码目录缺失: " + vendor["name"])
        if git_oid(path, "HEAD", git_executable, git_sha256) != vendor["commit"]:
            reject("供应商提交不匹配: " + vendor["name"])
        if git_oid(path, "HEAD^{tree}", git_executable, git_sha256) != vendor["tree"]:
            reject("供应商 tree 不匹配: " + vendor["name"])
        status = git_read(git_executable, git_sha256, path,
                          ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
                          text=False)
        if status.returncode != 0:
            reject("供应商工作树状态不可核验: " + vendor["name"])
        actual = {item.decode("utf-8", errors="strict") for item in status.stdout.split(b"\0") if item}
        if actual != EXPECTED_GIT_STATUS[vendor["name"]]:
            reject("供应商工作树存在非预期变化: " + vendor["name"])

    # Comfy ignores custom_nodes/* in Git. Require the exact five additions;
    # otherwise package init could import an unmeasured custom node.
    tracked = git_read(git_executable, git_sha256, comfy_root,
                       ["ls-tree", "-r", "--name-only", "HEAD", "--", "custom_nodes"])
    if tracked.returncode != 0:
        reject("custom_nodes 上游文件清单不可核验")
    baseline = {p.split("/")[1] for p in tracked.stdout.splitlines() if p.startswith("custom_nodes/")}
    additions = {"ComfyUI-KJNodes", "ComfyUI_LayerStyle", "ComfyUI-VideoHelperSuite", "h3_benchmark_sampler", "qs_h3_source_attestor"}
    actual_children = {p.name for p in (comfy_root / "custom_nodes").iterdir()}
    if actual_children != baseline | additions:
        reject("custom_nodes 目录含非固定源码")
    sampler = comfy_root / "custom_nodes" / "h3_benchmark_sampler"
    if not sampler.is_dir() or sampler.is_symlink():
        reject("h3_benchmark_sampler 目录缺失或链接")
    if {p.name for p in sampler.iterdir()} != {"__init__.py", "core.py", "sampling.py", "LICENSE", "COPYING"}:
        reject("h3_benchmark_sampler 文件集合不固定")


def require_vendor_file_hashes(comfy_root: Path) -> None:
    lock = json.loads((ROOT / "comfy" / "vendor-lock.json").read_text(encoding="utf-8"))
    physical_root = comfy_root.resolve(strict=True)
    for rel, expected in lock["targetSha256"].items():
        path = comfy_root.joinpath(*rel.split("/"))
        if not path.is_file() or path.is_symlink() or not path.resolve(strict=True).is_relative_to(physical_root):
            reject("固定 vendor 源文件缺失、链接或越界")
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected:
            reject("固定 vendor 源文件摘要不符")


def require_measured_roles(comfy_root: Path, manifest: dict) -> None:
    physical_root = comfy_root.resolve(strict=True)
    for role in manifest["canonicalTarget10"]:
        path = comfy_root.joinpath(*role["path"].split("/"))
        if not path.is_file() or path.is_symlink():
            reject("固定配方测量文件缺失或链接: " + role["role"])
        if not path.resolve(strict=True).is_relative_to(physical_root):
            reject("固定配方测量文件不在候选安装根内: " + role["role"])
        data = path.read_bytes()
        raw = hashlib.sha256(data).hexdigest()
        lf = hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()
        if raw != role["rawSha256"] or lf != role["lfSha256"]:
            reject("固定配方测量文件与当前 pin 不符: " + role["role"])


def require_explicit_config() -> None:
    names = (
        "H3_COMFY_BASE",
        "H3_COMFY_ROOT",
        "H3_ADAPTER_INPUT_ROOT",
        "H3_ADAPTER_OUTPUT_ROOT",
        "H3_JOBS_DIR",
        "H3_MACHINE_LABEL",
        "H3_COMFY_MODEL_ROOT",
        "H3_WORKFLOW_DIR",
        "GPU_SLOT_FILE",
        "H3_CANONICAL_MANIFEST_PATH",
    )
    missing = [name for name in names if not os.environ.get(name)]
    if missing:
        reject("必需本机配置缺失: " + ", ".join(missing))
    for name in names[1:]:
        if name == "H3_MACHINE_LABEL":
            continue
        value = Path(os.environ[name])
        if not value.is_absolute():
            reject("本机配置必须使用绝对路径: " + name)
        if name == "GPU_SLOT_FILE":
            lock = value.with_name(value.name + ".lock")
            if not value.parent.is_dir() or value.parent.is_symlink() or getattr(value.parent, "is_junction", lambda: False)():
                reject("GPU_SLOT_FILE 父目录必须是现存物理目录")
            for candidate in (value, lock):
                if (not candidate.is_file() or candidate.is_symlink() or
                        getattr(candidate, "is_junction", lambda: False)() or
                        candidate.stat().st_nlink != 1):
                    reject("GPU slot 私有 state/lock 文件尚未由受控安装器初始化")
            if lock.stat().st_size < 1:
                reject("GPU slot lock 文件为空；请由受控安装器恢复")
            try:
                state = json.loads(value.read_bytes().decode("utf-8"))
            except (OSError, UnicodeError, ValueError):
                reject("GPU slot state 无法读取；请在空队列下由受控安装器修复")
            if not isinstance(state, dict) or "occupant" not in state or state["occupant"] not in (None, "z", "seedvr", "h3"):
                reject("GPU slot state 结构不符；请由受控安装器修复")
        elif name == "H3_CANONICAL_MANIFEST_PATH":
            if not value.is_file() or value.is_symlink() or getattr(value, "is_junction", lambda: False)():
                reject("H3_CANONICAL_MANIFEST_PATH 必须是现存的普通清单文件")
        elif not value.is_dir() or value.is_symlink():
            reject("本机配置目录缺失或是链接: " + name)
    comfy_base = os.environ["H3_COMFY_BASE"]
    if not re.fullmatch(r"http://(?:127\.0\.0\.1|\[::1\]):[0-9]{2,5}", comfy_base):
        reject("H3_COMFY_BASE 必须是本机 loopback URL")
    if not 1 <= int(comfy_base.rsplit(":", 1)[1]) <= 65535:
        reject("H3_COMFY_BASE 端口不合法")


def require_installed_manifest() -> None:
    path = Path(os.environ["H3_CANONICAL_MANIFEST_PATH"])
    if path.name != "canonical-manifest.json":
        reject("H3_CANONICAL_MANIFEST_PATH 必须指向装配器写入的清单名称")
    archived = (ROOT / "manifest.json").read_bytes()
    installed = path.read_bytes()
    if hashlib.sha256(installed).digest() != hashlib.sha256(archived).digest():
        reject("候选安装的 canonical manifest 与归档源码不一致")


def require_candidate_source_root(comfy_root: Path | None) -> None:
    if comfy_root is None or not comfy_root.is_absolute() or not comfy_root.is_dir():
        reject("--comfy-root 必须是候选 ComfyUI 的现存绝对安装根")
    if Path(os.environ["H3_COMFY_MODEL_ROOT"]).resolve(strict=True) != comfy_root.resolve(strict=True):
        reject("H3_COMFY_MODEL_ROOT 与 --comfy-root 源码根不一致")


def require_gpu_candidate(gpu_index: int | None) -> None:
    try:
        import torch
        import triton
        import sageattention
    except ImportError:
        raise RuntimeError("torch、Triton 或 sageattention 无法导入") from None
    if triton.__version__ != "3.5.1":
        reject("Triton Windows 运行模块版本与固定基线不符")
    if not callable(getattr(sageattention, "sageattn", None)):
        reject("sageattention.sageattn 不可用")
    if torch.version.cuda != "13.0" or not torch.cuda.is_available():
        reject("CUDA 运行时或 GPU 不可用；当前锁仅记录 CUDA 13.0 构建")
    count = torch.cuda.device_count()
    if gpu_index is None:
        if count != 1:
            reject("有多个 GPU 时必须显式指定 --gpu-index；无 GPU 时拒绝")
        gpu_index = 0
    if gpu_index < 0 or gpu_index >= count:
        reject("--gpu-index 超出可用设备范围")
    capability = tuple(torch.cuda.get_device_capability(gpu_index))
    if capability not in AUTO_SAGE_CAPABILITIES:
        reject("GPU compute capability 不在当前 SageAttention auto 源码分支集合")
    # This is only a compatibility candidate, never evidence of actual video.
    print("GPU 静态能力候选通过；仍须按平台规则完成本机受控 self-test 与真实样片验收")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", required=True, choices=("api", "comfy"))
    parser.add_argument("--comfy-root", type=Path)
    parser.add_argument("--gpu-index", type=int, help="Candidate CUDA device index; required when multiple are visible")
    args = parser.parse_args()
    lock = json.loads((ROOT / "dependencies.lock.json").read_text(encoding="utf-8"))
    manifest = json.loads((ROOT / "manifest.json").read_text(encoding="utf-8"))
    if manifest["scope"] != lock["scope"]:
        reject("源码与依赖锁 scope 不一致")
    require_python_source_paths(args.comfy_root if args.mode == "comfy" else None)
    require_python_version(lock, args.mode)
    require_distributions(lock["apiResolved" if args.mode == "api" else "comfyResolved"])
    require_wheel_lock(lock, args.mode)
    require_explicit_config()
    require_installed_manifest()
    git_executable = require_external_tools(lock)
    if args.mode == "api":
        print("API 分发包版本闸通过；未启动服务")
        return 0
    require_candidate_source_root(args.comfy_root)
    require_vendor_roots(args.comfy_root, manifest, git_executable,
                         lock["externalExecutables"]["git"]["observedSha256"])
    require_vendor_file_hashes(args.comfy_root)
    require_measured_roles(args.comfy_root, manifest)
    require_gpu_candidate(args.gpu_index)
    print("Comfy 源码/依赖/设备静态闸通过；未执行 H3 作业")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, KeyError) as error:
        print("拒绝: " + str(error), file=sys.stderr)
        sys.exit(1)
