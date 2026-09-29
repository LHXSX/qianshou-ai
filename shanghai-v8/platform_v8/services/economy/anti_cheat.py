"""
反作弊 · 冗余执行多数派比对 (移植自 super_engine_v2/verifier/anti_cheat.py · 适配 v8)

设计:
  - 一个 workload 的同一片可派给多个节点 (redundancy_factor=2/3)
  - 全部完成后, 拿持久化 verification.content_sha256 多数投票
  - 跟多数派一致 → 信誉 + (SUCCESS 已加)
  - 跟多数派不一致 → 信誉硬罚 (MISMATCH 事件) + 不发 reward

API:
  evaluate_redundant_results(shards) → CheatVerdict
    cheating_nodes, honest_nodes, canonical_sha

⚠️ 当前 MVP 状态: 只实现比对算法 · 还没接 dispatcher 真冗余派发
   要启用需:
     1. WorkloadSpec 加 redundancy_factor: int = 1
     2. lifecycle.start 按 redundancy_factor 把同 shard 派给 N 个 worker
     3. aggregator finalize 前调本模块比对
     4. settlement 按 verdict 决定哪些节点拿钱
"""
from __future__ import annotations
import logging
from collections import Counter
from dataclasses import dataclass, field
from typing import Any, Iterable, Mapping

from sqlalchemy.orm import Session

from platform_v8.core import Shard
from platform_v8.services.economy.nce_observer import observe_shard, ShardOutcome

logger = logging.getLogger(__name__)


@dataclass
class CheatVerdict:
    """多数派比对结果"""
    workload_id: str
    canonical_sha256: str = ""
    cheating_nodes: list[str] = field(default_factory=list)   # worker_id 列表
    honest_nodes: list[str] = field(default_factory=list)
    reasons: list[str] = field(default_factory=list)

    @property
    def is_cheating(self) -> bool:
        return bool(self.cheating_nodes)

    @property
    def has_canonical(self) -> bool:
        return bool(self.honest_nodes)


def evaluate_redundant_results(
    workload_id: str,
    shards: Iterable[Shard],
    verifications: Mapping[str, Mapping[str, Any]],
    min_votes: int = 2,
) -> CheatVerdict:
    """
    多份冗余结果 · 多数投票 · 找出作弊节点

    - 至少 min_votes (=2) 份 DONE 结果才有意义
    - 哈希一致占多数 → honest
    - 不一致 → cheating
    - 全两两不同 → 全部 cheating (无法判定 canonical)
    """
    verdict = CheatVerdict(workload_id=workload_id)
    done_shards = [s for s in shards if s.worker_id]

    if len(done_shards) < min_votes:
        verdict.reasons.append(f"冗余结果不足: {len(done_shards)} < {min_votes}")
        return verdict

    # Only the verifier's persisted content digest is authoritative.  Object
    # keys/URLs differ between replicas and are worker-influenced identifiers.
    shard_hashes: list[tuple[str, str]] = []
    for shard in done_shards:
        verification = verifications.get(str(shard.id))
        digest = str((verification or {}).get("content_sha256") or "").lower()
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            verdict.reasons.append(
                f"缺少有效验证摘要: shard={str(shard.id)[:8]}"
            )
            return verdict
        shard_hashes.append((str(shard.worker_id), digest))
    counter = Counter(h for _wid, h in shard_hashes)
    top_sha, top_votes = counter.most_common(1)[0]

    # Strict majority.  In particular, two replicas settle only when both
    # agree.  A tie does not identify which worker cheated, so it quarantines
    # upstream without speculative punishment.
    if top_votes * 2 <= len(shard_hashes):
        verdict.reasons.append("无严格多数一致")
        return verdict

    verdict.canonical_sha256 = top_sha
    for wid, h in shard_hashes:
        if h == top_sha:
            verdict.honest_nodes.append(wid)
        else:
            verdict.cheating_nodes.append(wid)
            verdict.reasons.append(
                f"worker={wid[:8]} sha={h[:8]} vs canon={top_sha[:8]}"
            )
    return verdict


def punish_cheaters(s: Session, verdict: CheatVerdict) -> None:
    """对 cheating_nodes 列表中每个节点写 MISMATCH 事件 (硬惩罚 *0.5)"""
    errors: list[Exception] = []
    for wid in verdict.cheating_nodes:
        try:
            applied = observe_shard(wid, ShardOutcome.MISMATCH)
            if applied is False:
                errors.append(RuntimeError("penalty persistence failed"))
        except Exception as exc:
            errors.append(exc)
    if errors:
        logger.error(
            "anti_cheat · %d/%d penalties failed",
            len(errors),
            len(verdict.cheating_nodes),
        )
        raise RuntimeError(
            f"anti-cheat penalties failed for {len(errors)} worker(s)"
        ) from errors[0]
    if verdict.cheating_nodes:
        logger.warning(
            "anti_cheat · applied %d mismatch penalties",
            len(verdict.cheating_nodes),
        )
