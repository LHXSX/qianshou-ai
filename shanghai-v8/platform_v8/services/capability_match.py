"""能力广告 + 垂类模型匹配 (capability-aware routing)

核心：
  - 节点端：在 we_workers.capabilities JSONB 内声明
        specialty:        ["photo-edit", "ocr"]
        equipped_models:  ["sam-vit-b", "lama", "gfpgan-v1.4", "realesrgan-x4"]
        model_health:     {"sam-vit-b": "loaded", "lama": "ready"}
  - Skill 端：在 manifest.json 内声明 (schema_version >= 1.1)
        industry:         "photography"
        required_models:  [{"id": "sam-vit-b"}, {"id": "lama"}]
  - 调度器：用本模块的 filter_capable() 在 candidates 集合上做过滤

设计:
  - 软匹配 (soft match)：允许 industry 不声明 → 不过滤；required_models 缺位 → 不过滤
  - 模糊匹配 (fuzzy)：equipped_models 是字符串 set，比对用 set ⊆ set
  - 健康过滤 (health gate)：仅认 model_health[m] in {"loaded","ready"} 的节点真正算"装好"
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Iterable, Sequence


# ── 健康状态白名单 ─────────────────────────────────────
HEALTHY_MODEL_STATES = {"loaded", "ready", "warm", "available"}


@dataclass
class SkillRequirements:
    """从 skill manifest 解析出的运行需求"""
    industry: str | None = None
    required_models: list[str] = field(default_factory=list)
    min_ram_gb: float = 0.0
    min_disk_mb: float = 0.0
    network_access: bool = False

    @classmethod
    def from_manifest(cls, manifest: dict) -> "SkillRequirements":
        req = manifest.get("requirements") or {}
        rm = manifest.get("required_models") or []
        # 兼容两种形式：[{"id":"sam"}] 或 ["sam"]
        models: list[str] = []
        for m in rm:
            if isinstance(m, str):
                models.append(m)
            elif isinstance(m, dict):
                mid = m.get("id") or m.get("name")
                if mid:
                    models.append(mid)
        return cls(
            industry=manifest.get("industry"),
            required_models=models,
            min_ram_gb=float(req.get("min_ram_gb", 0)),
            min_disk_mb=float(req.get("min_disk_mb", 0)),
            network_access=bool(req.get("network_access", False)),
        )


@dataclass
class NodeAd:
    """从 we_workers.capabilities JSONB 解析出的节点能力广告"""
    worker_id: str
    specialty: set[str] = field(default_factory=set)
    equipped_models: set[str] = field(default_factory=set)
    model_health: dict[str, str] = field(default_factory=dict)
    ram_gb: float = 0.0
    disk_mb: float = 0.0
    has_network: bool = True
    raw: dict = field(default_factory=dict)

    @classmethod
    def from_worker(cls, worker) -> "NodeAd":
        """兼容三种入参:
          - Worker 对象 (capabilities = WorkerCapabilities dataclass)
          - SQL row (capabilities = dict)
          - dict 本身
        """
        cap_obj = getattr(worker, "capabilities", None) or {}
        # 转成 dict 统一处理 (WorkerCapabilities dataclass 也支持)
        if hasattr(cap_obj, "__dataclass_fields__"):
            from dataclasses import asdict
            cap = asdict(cap_obj)
        elif isinstance(cap_obj, dict):
            cap = cap_obj
        else:
            cap = {}
        specialty = cap.get("specialty") or []
        models = cap.get("equipped_models") or []
        health = cap.get("model_health") or {}
        # ram/disk 兼容多种命名（不同 client 上报风格不一）
        ram = float(cap.get("ram_gb") or cap.get("memory_gb") or 0)
        # 没有 ram 也试 total_memory_mb (v8 client 上报这字段)
        if not ram and cap.get("total_memory_mb"):
            ram = float(cap["total_memory_mb"]) / 1024.0
        disk = float(cap.get("disk_mb") or cap.get("disk_free_mb") or 0)
        return cls(
            worker_id=str(getattr(worker, "id", "")),
            specialty=set(specialty if isinstance(specialty, list) else []),
            equipped_models=set(models if isinstance(models, list) else []),
            model_health=health if isinstance(health, dict) else {},
            ram_gb=ram,
            disk_mb=disk,
            has_network=bool(cap.get("network", True)),
            raw=cap,
        )

    def healthy_models(self) -> set[str]:
        """仅返回处于"已加载/就绪"状态的模型"""
        if not self.model_health:
            # 若节点未上报健康，默认全部 equipped_models 视为可用
            return set(self.equipped_models)
        return {
            m for m in self.equipped_models
            if self.model_health.get(m, "").lower() in HEALTHY_MODEL_STATES
        }


# ── 主过滤函数 ─────────────────────────────────────────
def matches(ad: NodeAd, req: SkillRequirements, *, strict_health: bool = True) -> tuple[bool, str]:
    """单节点 vs skill 需求匹配 · 返回 (是否匹配, 原因短语)
    strict_health=True 时要求 required_models 必须处于 healthy 状态
    """
    # ── 1) industry 匹配（软）──
    if req.industry:
        if req.industry not in ad.specialty:
            return False, f"specialty_missing:{req.industry}"

    # ── 2) required_models 匹配（硬）──
    if req.required_models:
        avail = ad.healthy_models() if strict_health else ad.equipped_models
        missing = [m for m in req.required_models if m not in avail]
        if missing:
            return False, f"models_missing:{','.join(missing)}"

    # ── 3) 资源最低门槛 ──
    if req.min_ram_gb and ad.ram_gb and ad.ram_gb < req.min_ram_gb:
        return False, f"ram_below:{ad.ram_gb}<{req.min_ram_gb}"

    if req.min_disk_mb and ad.disk_mb and ad.disk_mb < req.min_disk_mb:
        return False, f"disk_below:{ad.disk_mb}<{req.min_disk_mb}"

    # ── 4) 网络访问 ──
    if req.network_access and not ad.has_network:
        return False, "no_network"

    return True, "ok"


def filter_capable(
    workers: Iterable,
    manifest: dict,
    *,
    strict_health: bool = True,
) -> list[tuple[NodeAd, str]]:
    """筛选出能跑某 skill 的节点列表 · 返回 [(NodeAd, reason), ...] 仅 reason='ok' 才入选
    入参 workers 是 Worker 对象迭代器
    """
    req = SkillRequirements.from_manifest(manifest)
    out: list[tuple[NodeAd, str]] = []
    for w in workers:
        ad = NodeAd.from_worker(w)
        ok, reason = matches(ad, req, strict_health=strict_health)
        if ok:
            out.append((ad, reason))
    return out


def explain_all(
    workers: Iterable,
    manifest: dict,
    *,
    strict_health: bool = True,
) -> list[dict]:
    """诊断模式：返回每个节点的匹配结果与失败原因 · 用于 admin/debug endpoint"""
    req = SkillRequirements.from_manifest(manifest)
    out: list[dict] = []
    for w in workers:
        ad = NodeAd.from_worker(w)
        ok, reason = matches(ad, req, strict_health=strict_health)
        out.append({
            "worker_id": ad.worker_id,
            "matched": ok,
            "reason": reason,
            "specialty": sorted(ad.specialty),
            "equipped_models": sorted(ad.equipped_models),
            "healthy_models": sorted(ad.healthy_models()),
        })
    return out


__all__ = [
    "SkillRequirements",
    "NodeAd",
    "matches",
    "filter_capable",
    "explain_all",
    "HEALTHY_MODEL_STATES",
]
