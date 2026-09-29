"""Isolated profile/price/device evidence; these fixtures are not official rates."""
from __future__ import annotations

from copy import deepcopy
from dataclasses import asdict
from decimal import Decimal
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from platform_v8.api.v8 import economy
from platform_v8.core import Worker, WorkerCapabilities, Workload, WorkloadSpec
from platform_v8.engine.assignment_payload import AssignmentPayloadError, build_assignment_payload
from platform_v8.engine import planner
from platform_v8.engine.task_registry import get_spec
from platform_v8.protocol.http_schema import WorkloadSpecIn
from platform_v8.protocol.media_profile import MediaInput, OfficialMediaProfile
from platform_v8.services import media_profiles as media
from platform_v8.services.economy import task_pricing as prices
from platform_v8.services.economy import workload_quote as tickets
from platform_v8.services.workloads import submit


@pytest.fixture
def video_profile() -> dict:
    return {"profile_id": "fixture.video.fast", "profile_version": 1, "capability": "video",
            "mode": "image_to_video", "quality": "fast", "orientation": "landscape",
            "width": 1344, "height": 768, "steps": 4, "fps": 24, "allowed_seconds": [3, 5],
            "input_roles": ["first_frame"], "max_assets": 1,
            "model_id": "fixture-model", "model_sha256": "a" * 64,
            "workflow_id": "fixture-workflow", "workflow_sha256": "b" * 64,
            "validation_receipt_sha256": "c" * 64, "min_vram_mb": 8192,
            "min_memory_mb": 16384, "timeout_s": 900, "price_version": 2,
            "price_unit": "second", "unit_price_yuan": "0.50", "min_charge_yuan": "0.10",
            "enabled": True}


@pytest.fixture
def spec(video_profile: dict) -> dict:
    return {"task_type": "video_generate", "input_kind": "params_only",
            "media_input": {"capability": "video", "mode": "image_to_video", "prompt": "云朵移动",
                            "negative_prompt": "", "quality": "fast", "orientation": "landscape",
                            "seconds": 5, "assets": [{"asset_id": "fixture.first", "sha256": "d" * 64,
                                                      "role": "first_frame"}],
                            "profile_id": video_profile["profile_id"], "profile_version": 1}}


@pytest.fixture
def settings(video_profile: dict, monkeypatch: pytest.MonkeyPatch) -> dict:
    value = {"version": 7, "media_profiles": [video_profile],
             "task_pricing": [{"task_type": "video_generate", "unit": "秒", "base_price": 999}],
             "quality_standard": 123, "speed_t24": 456}
    monkeypatch.setattr(prices, "_load_settings", lambda _session: value)
    return value


def test_exact_official_plan_uses_seconds_not_legacy_price_or_quality_factor(spec: dict, settings: dict) -> None:
    canonical = tickets.pricing_spec(spec)
    plan = media.canonical_media_plan(canonical, settings)
    quote = prices.compute_price_for_spec(None, canonical)
    assert (quote.total_yuan, quote.units, quote.shards) == (Decimal("2.50"), 5, 1)
    assert quote.profile_id == "fixture.video.fast"
    assert quote.profile_version == 1 and quote.price_version == 2
    assert quote.plan_sha256 == plan["plan_sha256"]
    assert quote.asset_manifest_sha256 == plan["asset_manifest_sha256"]
    shorter = deepcopy(spec)
    shorter["media_input"]["seconds"] = 3
    assert prices.compute_price_for_spec(None, tickets.pricing_spec(shorter)).total_yuan == Decimal("1.50")
    assert media.canonical_media_plan(shorter, settings)["plan_sha256"] != plan["plan_sha256"]


def test_image_profile_is_one_image_and_cannot_claim_video_duration(spec: dict, settings: dict, video_profile: dict) -> None:
    profile = {**video_profile, "profile_id": "fixture.image.fast", "capability": "image",
               "mode": "text_to_image", "orientation": "square", "width": 1024, "height": 1024,
               "fps": None, "allowed_seconds": [], "input_roles": [], "max_assets": 0,
               "price_unit": "image", "unit_price_yuan": "0.35"}
    settings["media_profiles"] = [profile]
    spec = {"task_type": "image_generate", "media_input": {
        **spec["media_input"], "capability": "image", "mode": "text_to_image", "orientation": "square",
        "seconds": None, "assets": [], "profile_id": profile["profile_id"]}}
    quote = prices.compute_price_for_spec(None, tickets.pricing_spec(spec))
    assert quote.units == 1 and quote.total_yuan == Decimal("0.35") and quote.seconds is None
    spec["media_input"]["seconds"] = 5
    with pytest.raises(ValueError):
        WorkloadSpecIn.model_validate(spec)


@pytest.mark.parametrize("field,value", [("quality", "hd"), ("orientation", "portrait"), ("seconds", 10),
                                         ("profile_version", 2), ("profile_id", "unknown.profile")])
def test_profile_cannot_silently_accept_unverified_output(spec: dict, settings: dict, field: str, value) -> None:
    spec["media_input"][field] = value
    with pytest.raises(media.MediaProfileError):
        media.canonical_media_plan(spec, settings)


@pytest.mark.parametrize("key,value", [("params", {"seconds": 60}), ("input_ref", "https://media.example/input"),
                                     ("inline_input", "data:image/png;base64,abc"), ("input_refs", ["object"]),
                                     ("code_url", "https://example/runner.py"), ("redundancy_factor", 2)])
def test_media_input_cannot_hide_bytes_or_a_second_execution_contract(spec: dict, settings: dict, key: str, value) -> None:
    spec[key] = value
    with pytest.raises(media.MediaProfileError, match="禁止"):
        media.canonical_media_plan(spec, settings)


def test_metadata_rejects_unknown_dimensions_inline_media_or_ambiguous_roles(spec: dict) -> None:
    bad = {**spec["media_input"], "width": 4096}
    with pytest.raises(ValueError):
        MediaInput.model_validate(bad)
    for change in ({"mode": "text_to_video"}, {"assets": []},
                   {"assets": [{"asset_id": "fixture.first", "sha256": "d" * 64,
                                "role": "first_frame", "url": "https://example/input"}]}):
        with pytest.raises(ValueError):
            MediaInput.model_validate({**spec["media_input"], **change})


def test_first_last_frame_requires_two_explicit_distinct_assets(spec: dict, settings: dict) -> None:
    spec["media_input"]["mode"] = "first_last_frame"
    with pytest.raises(ValueError):
        MediaInput.model_validate(spec["media_input"])
    spec["media_input"]["assets"].append({"asset_id": "fixture.last", "sha256": "e" * 64, "role": "last_frame"})
    MediaInput.model_validate(spec["media_input"])
    with pytest.raises(media.MediaProfileError):
        media.canonical_media_plan(spec, settings)  # this fixture's workflow has only first-frame support


def test_official_profile_versions_and_rates_are_immutable(settings: dict) -> None:
    changed = deepcopy(settings)
    changed["media_profiles"][0]["unit_price_yuan"] = "1.00"
    with pytest.raises(media.MediaProfileError, match="新版本"):
        media.validate_profile_update(settings, changed)
    changed = deepcopy(settings)
    changed["media_profiles"][0]["enabled"] = False
    media.validate_profile_update(settings, changed)
    with pytest.raises(media.MediaProfileError, match="删除"):
        media.validate_profile_update(settings, {"media_profiles": []})


@pytest.mark.parametrize("field,value", [("allowed_seconds", [True]), ("fps", None), ("width", 768),
                                         ("unit_price_yuan", "NaN"), ("unit_price_yuan", "0"),
                                         ("enabled", "true"), ("input_roles", ["last_frame"]),
                                         ("max_assets", 0)])
def test_invalid_official_profile_fails_closed(video_profile: dict, field: str, value) -> None:
    video_profile[field] = value
    with pytest.raises(ValueError):
        OfficialMediaProfile.model_validate(video_profile)


@pytest.fixture
def device(spec: dict, settings: dict) -> tuple:
    plan = media.canonical_media_plan(spec, settings)
    identity = {key: plan[key] for key in ("profile_id", "profile_version", "model_sha256",
                                          "workflow_sha256", "validation_receipt_sha256")}
    worker = Worker(id="fixture-worker", owner_id=17, name="fixture 4060",
                    capabilities=WorkerCapabilities(gpu_count=1, gpu_model="NVIDIA GeForce RTX 4060",
                        vram_mb=8192, free_vram_mb=8192, total_memory_mb=32768,
                        media_profiles=[identity], max_media_concurrent=1, media_available_seconds=1000))
    binding = {**identity, "worker_id": worker.id, "owner_id": 17, "enabled": True,
               "gpu_model": worker.capabilities.gpu_model, "vram_mb": 8192,
               "hardware_qualification": "rtx_4060_or_better_verified", "max_concurrent": 1,
               "p90_execution_seconds": 600, "max_task_seconds": 900,
               "authorized_until": 2000, "verified_until": 2000}
    return worker, plan, binding


def test_device_name_and_self_advertisement_do_not_grant_authority(device: tuple) -> None:
    worker, plan, binding = device
    assert not media.worker_matches_media_plan(worker, plan, bindings=[], now=1000)
    assert media.worker_matches_media_plan(worker, plan, bindings=[binding], now=1000)


@pytest.mark.parametrize("field,value", [("free_vram_mb", 4000), ("vram_mb", 4096), ("total_memory_mb", 8192),
                                         ("media_profiles", []), ("max_media_concurrent", 0),
                                         ("media_available_seconds", 500), ("gpu_count", 0),
                                         ("contribute_mode", "paused"), ("throttle_pct", 0)])
def test_device_current_resources_cannot_exceed_profile_limits(device: tuple, field: str, value) -> None:
    worker, plan, binding = device
    setattr(worker.capabilities, field, value)
    assert not media.worker_matches_media_plan(worker, plan, bindings=[binding], now=1000)


@pytest.mark.parametrize("field,value", [("owner_id", 18), ("workflow_sha256", "f" * 64),
                                         ("validation_receipt_sha256", "f" * 64), ("enabled", False),
                                         ("authorized_until", 1500), ("verified_until", 999),
                                         ("max_task_seconds", 600), ("p90_execution_seconds", 950),
                                         ("max_concurrent", 2), ("hardware_qualification", "self_declared")])
def test_verified_binding_and_owner_authorization_cannot_be_overstated(device: tuple, field: str, value) -> None:
    worker, plan, binding = device
    binding[field] = value
    assert not media.worker_matches_media_plan(worker, plan, bindings=[binding], now=1000)


def test_device_single_slot_and_tampered_plan_are_rejected(device: tuple) -> None:
    worker, plan, binding = device
    worker.active_shards = 1
    assert not media.worker_matches_media_plan(worker, plan, bindings=[binding], now=1000)
    worker.active_shards = 0
    plan["seconds"] = 120
    assert not media.worker_matches_media_plan(worker, plan, bindings=[binding], now=1000)


def test_media_registry_does_not_send_media_through_file_slicers() -> None:
    for task_type in ("image_generate", "video_generate"):
        task = get_spec(task_type)
        assert task.requires_official_media_profile
        assert task.accepted_input_kinds == ("params_only",)
        assert task.max_shards_limit == 1


def test_mainline_formal_channel_unavailable_for_admin_contract_quote_and_dispatch(
    spec: dict, settings: dict, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(economy, "_load_settings", lambda _session: settings)
    calls = []
    monkeypatch.setattr(submit.WorkloadRepo, "create", lambda *_args: calls.append("workload"))
    monkeypatch.setattr(submit.ledger_svc, "escrow_hold", lambda *_args, **_kwargs: calls.append("ledger"))
    for admin in (False, True):
        with pytest.raises(submit.SubmitWorkloadError, match="quote_unavailable"):
            submit.submit_workload(None, submit.SubmitInput(owner_id=17, name="video", spec_dict=spec,
                                                          budget=Decimal("2.50"), is_admin=admin))
        with pytest.raises(HTTPException) as error:
            economy.estimate_workload(economy.EstimateRequest(spec=spec), session=None,
                                      current=SimpleNamespace(id=17, is_admin=admin))
        assert error.value.status_code == 503
    with pytest.raises(HTTPException) as error:
        economy.quote_task(economy.QuoteRequest(task_type="video_generate", workload=5), session=None,
                           current=SimpleNamespace(id=17))
    assert error.value.status_code == 503
    quote = prices.compute_price_for_spec(None, tickets.pricing_spec(spec))
    with pytest.raises(media.MediaProfileError, match="quote_unavailable"):
        tickets.issue_confirmation(account_id=17, spec=spec, quote=quote)
    workload = Workload(spec=WorkloadSpec(task_type="video_generate", media_input=spec["media_input"]))
    assert planner.schedule_assignments([SimpleNamespace(id="fixture-shard")],
                                        [SimpleNamespace(id="fixture-worker")], workload=workload) == []
    with pytest.raises(AssignmentPayloadError, match="quote_unavailable"):
        build_assignment_payload(None, workload, worker_id="fixture-worker")
    assert calls == []


def test_missing_media_plan_and_policy_errors_deny_planner_push_and_pull(device: tuple, monkeypatch) -> None:
    worker, _plan, _binding = device
    workload = Workload(spec=WorkloadSpec(task_type="video_generate"))
    assert planner._filter_by_requirements([worker], workload) == []
    assert not planner.worker_can_run(worker, workload)
    monkeypatch.setattr(planner, "_filter_by_protocol_profile", lambda *_args: 1 / 0)
    assert not planner.worker_can_run(worker, workload)


def test_public_catalog_reports_unavailable_and_never_exposes_bindings(settings: dict, monkeypatch) -> None:
    monkeypatch.setattr(economy, "_load_settings", lambda _session: settings)
    out = economy.media_profiles_endpoint(None, SimpleNamespace(id=17))
    assert out["billing_status"] == "unavailable" and out["code"] == "quote_unavailable"
    assert len(out["profiles"]) == 1 and "live_signed_preflight" in out["missing_integrations"]
    assert "worker_id" not in str(out)


def test_sqlite_roundtrip_preserves_canonical_input_device_capacity_and_server_bindings(
    spec: dict, settings: dict, device: tuple, monkeypatch,
) -> None:
    """Real repository reads and policy filtering, with an isolated local database."""
    import time
    from sqlalchemy import create_engine, insert, update
    from sqlalchemy.orm import sessionmaker
    from platform_v8.storage import db
    from platform_v8.storage.repo import create_all_for_testing, WorkloadRepo, WorkerRepo, kv_t

    engine = create_engine("sqlite:///:memory:", future=True)
    create_all_for_testing(engine)
    factory = sessionmaker(bind=engine)
    monkeypatch.setattr(db, "_session_factory", factory)
    worker, plan, binding = device
    binding["authorized_until"] = int(time.time()) + 2000
    binding["verified_until"] = int(time.time()) + 2000
    workload = Workload(owner_id=17, name="isolated plan",
                        spec=WorkloadSpec(task_type="video_generate", input_kind="params_only",
                                          media_input=spec["media_input"], media_profile=plan))
    try:
        with factory() as session:
            restored = WorkloadRepo.create(session, workload)
            WorkerRepo.upsert(session, worker_id=worker.id, owner_id=worker.owner_id, name=worker.name,
                              capabilities=asdict(worker.capabilities))
            session.execute(insert(kv_t).values(k=media.DEVICE_BINDINGS_KEY, v=[binding]))
            session.execute(insert(kv_t).values(k=economy._ECONOMY_SETTINGS_KEY, v=settings))
            session.commit()
        with factory() as session:
            restored = WorkloadRepo.by_id(session, workload.id)
            restored_worker = WorkerRepo.by_id(session, worker.id)
            assert restored.spec.media_input == spec["media_input"]
            assert restored.spec.media_profile == plan
            assert restored_worker.capabilities.free_vram_mb == 8192
            assert restored_worker.capabilities.media_profiles == worker.capabilities.media_profiles
            assert media.load_device_bindings(session) == [binding]
        assert media.filter_media_workers([restored_worker], restored) == [restored_worker]
        with factory() as session:
            binding["enabled"] = False
            session.execute(update(kv_t).where(kv_t.c.k == media.DEVICE_BINDINGS_KEY).values(v=[binding]))
            session.commit()
        assert media.filter_media_workers([restored_worker], restored) == []
        with factory() as session:
            paused = {**asdict(worker.capabilities), "contribute_mode": "paused"}
            stored_paused = WorkerRepo.upsert(session, worker_id=worker.id, owner_id=worker.owner_id,
                                             name=worker.name, capabilities=paused)
            assert stored_paused.capabilities.contribute_mode == "paused"
        # A restarted process reads the server KV afresh; node advertisements
        # cannot restore revoked owner supply or make the paid channel ready.
        with pytest.raises(media.MediaProfileError, match="quote_unavailable"):
            media.require_formal_media_channel(restored)
    finally:
        engine.dispose()


def test_real_http_catalog_and_unavailable_quote_use_existing_authenticated_routes(
    spec: dict, settings: dict, monkeypatch,
) -> None:
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine, insert
    from sqlalchemy.orm import sessionmaker
    from sqlalchemy.pool import StaticPool
    from platform_v8.storage.repo import create_all_for_testing, kv_t

    engine = create_engine("sqlite://", poolclass=StaticPool, connect_args={"check_same_thread": False})
    create_all_for_testing(engine)
    factory = sessionmaker(bind=engine)
    with factory() as session:
        session.execute(insert(kv_t).values(k=economy._ECONOMY_SETTINGS_KEY, v=settings))
        session.commit()
    app = FastAPI()
    app.include_router(economy.router)
    # The account dependency is the explicit test principal; no production
    # account, external service, or real billing is asserted by this test.
    app.dependency_overrides[economy.get_current_account] = lambda: SimpleNamespace(id=17, is_admin=False)
    def session_dependency():
        with factory() as session:
            yield session
    app.dependency_overrides[economy.get_session] = session_dependency
    try:
        with TestClient(app) as client:
            out = client.get("/api/v8/economy/media-profiles")
            assert out.status_code == 200 and out.json()["billing_status"] == "unavailable"
            response = client.post("/api/v8/economy/estimate", json={"spec": spec})
            assert response.status_code == 503 and "quote_unavailable" in response.json()["detail"]
            assert "quote_token" not in response.json()
            assert client.post("/api/v8/economy/quote", json={"task_type": "video_generate", "workload": 5}).status_code == 503
    finally:
        engine.dispose()
