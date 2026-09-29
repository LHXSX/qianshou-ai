"""skill_loader · backend 启动时扫 skills/ 自动注册到 task_registry.

设计目的:
  - manifest.json v2 是全链路 SSoT · 不再让人手维护 task_registry._TASKS
  - 任何符合 v2 规范的 pack 启动时自动接入引擎
  - v1 pack 跳过(向后兼容 · 不阻止启动)
  - parse/validate 失败的 pack 跳过 + log error · 不阻止启动

入口:
    from platform_v8.engine.skill_loader import load_skills_to_registry
    stats = load_skills_to_registry()  # 在 lifespan startup 里调

Stats:
    {
      "registered": N,    # 成功注册的 tool 数
      "v1_skipped": M,    # v1 pack 跳过数 (告警 · 提醒迁移)
      "v2_pack_errors": K,  # v2 pack 校验失败(跳过)
      "tool_register_errors": E, # 单个 tool 注册失败
      "warns": W,         # WARN 总数(仍注册)
    }

设计文档: skills/SKILL_SPEC_V2.md
"""
from __future__ import annotations

import logging
import sys
from pathlib import Path
from typing import Dict, List, Optional

logger = logging.getLogger(__name__)

# skills/ 默认位置 · 跟 backend 工作目录无关
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
SKILLS_ROOT_DEFAULT = REPO_ROOT / "skills"


def load_skills_to_registry(
    skills_root: Optional[Path] = None,
    *,
    strict: bool = False,
    log_each_tool: bool = False,
) -> Dict[str, int]:
    """扫 skills/ → parse + validate manifest v2 → 注册到 task_registry.

    Args:
        skills_root: skills 目录 · 默认 <repo>/skills
        strict: True 时 WARN 也算失败(用于 CI · 启动时不建议)
        log_each_tool: True 时每注册一个 tool log 一行(调试用)

    Returns:
        stats dict
    """
    skills_root = Path(skills_root) if skills_root else SKILLS_ROOT_DEFAULT

    stats: Dict[str, int] = {
        "registered": 0,
        "v1_skipped": 0,
        "v2_pack_errors": 0,
        "tool_register_errors": 0,
        "warns": 0,
        "no_manifest_packs": 0,
        "total_v2_packs": 0,
    }

    if not skills_root.is_dir():
        logger.warning("skill_loader · skills 目录不存在: %s · 跳过自动注册", skills_root)
        return stats

    # 加 skills/ 到 sys.path · 让 _runtime 可 import
    skills_root_str = str(skills_root)
    if skills_root_str not in sys.path:
        sys.path.insert(0, skills_root_str)

    # 延迟 import · 失败也不阻止 backend 启动
    try:
        from _runtime import (  # type: ignore
            parse_manifest,
            validate_manifest,
            to_task_registry_kwargs,
            NotV2Error,
            ManifestParseError,
            Severity,
        )
    except ImportError as exc:
        logger.error("skill_loader · 无法 import _runtime · 自动注册中止: %s", exc)
        return stats

    try:
        from platform_v8.engine.task_registry import (
            TaskTypeSpec,
            TaskMode,
            register_dynamic,
        )
    except ImportError as exc:
        logger.error("skill_loader · 无法 import task_registry · 自动注册中止: %s", exc)
        return stats

    # 扫描每个 pack 目录
    for pack_dir in sorted(skills_root.iterdir()):
        if not pack_dir.is_dir():
            continue
        if pack_dir.name.startswith(("_", ".")):
            continue  # 跳过 _runtime / .git 等

        manifest_path = pack_dir / "manifest.json"
        if not manifest_path.is_file():
            stats["no_manifest_packs"] += 1
            continue

        # 1. 解析 manifest
        try:
            manifest = parse_manifest(manifest_path)
        except NotV2Error:
            stats["v1_skipped"] += 1
            logger.debug("skill_loader · %s 是 v1 manifest · 跳过", pack_dir.name)
            continue
        except ManifestParseError as exc:
            stats["v2_pack_errors"] += 1
            logger.error("skill_loader · %s manifest 解析失败 · 跳过: %s", pack_dir.name, exc)
            continue
        except Exception as exc:  # 兜底
            stats["v2_pack_errors"] += 1
            logger.exception("skill_loader · %s 未知错误 · 跳过: %s", pack_dir.name, exc)
            continue

        stats["total_v2_packs"] += 1

        # 2. 校验 manifest
        # backend 端不查脚本入口文件(可能不在镜像里) · 只查 schema 合法性
        issues = validate_manifest(manifest, check_files=False)
        errors = [i for i in issues if i.severity == Severity.ERROR]
        warns = [i for i in issues if i.severity == Severity.WARN]

        if errors or (strict and warns):
            stats["v2_pack_errors"] += 1
            err_lines = "\n".join(f"    {i}" for i in errors)
            logger.error(
                "skill_loader · pack=%s 校验失败 · 跳过注册 · %d ERROR%s:\n%s",
                manifest.pack_id, len(errors),
                f" / {len(warns)} WARN (strict)" if (strict and warns) else "",
                err_lines,
            )
            continue

        if warns:
            stats["warns"] += len(warns)
            warn_lines = "\n".join(f"    {i}" for i in warns)
            logger.warning(
                "skill_loader · pack=%s 有 %d WARN · 仍注册:\n%s",
                manifest.pack_id, len(warns), warn_lines,
            )

        # 3. 注册每个 tool 到 task_registry
        for tool in manifest.tools:
            try:
                kwargs = to_task_registry_kwargs(tool, pack_id=manifest.pack_id)
                # _mode_str 是 schema 用的占位 · 转 enum 后注入
                mode_str = kwargs.pop("_mode_str", "oneshot")
                spec = TaskTypeSpec(
                    **kwargs,
                    mode=TaskMode(mode_str),
                )
                register_dynamic(spec, preserve_static_sharding=True)
                stats["registered"] += 1
                if log_each_tool:
                    logger.info(
                        "skill_loader · 注册 task_type=%s mode=%s slicer=%s aggregator=%s",
                        tool.tool_id, mode_str, tool.engine.slicer, tool.engine.aggregator,
                    )
            except Exception as exc:
                stats["tool_register_errors"] += 1
                logger.error(
                    "skill_loader · 注册 task_type=%s pack=%s 失败: %s",
                    tool.tool_id, manifest.pack_id, exc,
                )

    # 4. 汇总日志
    logger.info(
        "skill_loader · 完成 · v2_packs=%d tools_registered=%d "
        "v1_skipped=%d pack_errors=%d tool_errors=%d warns=%d",
        stats["total_v2_packs"], stats["registered"],
        stats["v1_skipped"], stats["v2_pack_errors"],
        stats["tool_register_errors"], stats["warns"],
    )

    if stats["v1_skipped"] > 0:
        logger.info(
            "skill_loader · 提醒: %d 个 pack 仍是 v1 schema · 建议按 SKILL_SPEC_V2.md 迁移",
            stats["v1_skipped"],
        )

    return stats


def list_v2_pack_ids(skills_root: Optional[Path] = None) -> List[str]:
    """列出所有 v2 pack 的 id · 用于 API /admin/skills 等."""
    skills_root = Path(skills_root) if skills_root else SKILLS_ROOT_DEFAULT
    if not skills_root.is_dir():
        return []

    skills_root_str = str(skills_root)
    if skills_root_str not in sys.path:
        sys.path.insert(0, skills_root_str)

    try:
        from _runtime import parse_manifest, NotV2Error, ManifestParseError  # type: ignore
    except ImportError:
        return []

    pack_ids: List[str] = []
    for pack_dir in sorted(skills_root.iterdir()):
        if not pack_dir.is_dir() or pack_dir.name.startswith(("_", ".")):
            continue
        manifest_path = pack_dir / "manifest.json"
        if not manifest_path.is_file():
            continue
        try:
            m = parse_manifest(manifest_path)
            pack_ids.append(m.pack_id)
        except (NotV2Error, ManifestParseError):
            continue
    return pack_ids
