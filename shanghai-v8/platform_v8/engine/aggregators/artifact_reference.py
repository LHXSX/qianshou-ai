"""Single immutable file reference aggregation. Never import an object reader."""
from platform_v8.core import Workload, Shard, WorkloadResult
from platform_v8.protocol.artifact import parse_artifact_ref, validate_artifact_against_context


def aggregate_artifact_reference(workload: Workload, shards: list[Shard]) -> WorkloadResult:
    if len(shards) != 1:
        raise ValueError("bounded file result requires exactly one shard")
    shard = shards[0]
    artifact = parse_artifact_ref(shard.output_ref)
    if artifact is None or not artifact.object_version_id:
        raise ValueError("bounded file result requires an immutable artifact reference")
    validate_artifact_against_context(artifact, account_id=int(workload.owner_id),
                                      workload_id=str(workload.id), shard_id=str(shard.id))
    return WorkloadResult(output_ref=artifact.to_storage_ref(), summary="完成 1 个文件结果",
                          elapsed_ms=int(shard.elapsed_ms or 0),
                          metadata={"shard_count": 1, "strategy": "artifact_reference"})
