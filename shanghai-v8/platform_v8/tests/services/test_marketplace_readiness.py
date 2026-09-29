from platform_v8.services.marketplace.readiness import build_requirements, evaluate_readiness


def test_pdf_app_requirements_are_capabilities():
    req = build_requirements({"task_type": "pdf_to_text", "lendable": True})
    names = [c["name"] for c in req["required_capabilities"]]
    assert names == ["doc.pdf.text"]
    assert any(it.get("capability") == "doc.pdf.text" for it in req["items"])


def test_evaluate_missing_then_repaired():
    app = {"task_type": "pdf_to_text", "lendable": True}
    miss = evaluate_readiness(app, {"installed_tiers": [], "installed_software": []})
    assert "doc.pdf.text" in miss["missing_capabilities"]
    assert miss["exec_advice"] == "prefer_edge"
    assert miss["provision_plan"][0]["tier"] == "lite"

    ok = evaluate_readiness(app, {"installed_tiers": ["lite"], "installed_software": []})
    assert ok["missing_capabilities"] == []
    assert ok["exec_advice"] == "local_ok"


def test_new_client_capability_advertisement():
    app = {"task_type": "excel_export", "lendable": False}
    out = evaluate_readiness(
        app,
        {
            "provided_capabilities": [{"name": "data.table.read", "version": "1.0", "health": "healthy"}],
        },
    )
    assert out["local_ok"] is True
    assert out["exec_advice"] == "local_ok"


def test_runtime_v2_hides_tier_and_hard_matches_provided():
    """R7：V2 不列 tier；仅装 lite 不算满足；须正式 provided_capabilities。"""
    app = {"task_type": "pdf_to_text", "lendable": True, "execution_model": "runtime_v2"}
    req = build_requirements(app)
    assert req["execution_model"] == "runtime_v2"
    assert req["show_tiers"] is False
    assert req["required_tier"] == ""
    assert not any(it.get("key") == "tier" for it in req["items"])

    soft_only = evaluate_readiness(app, {"installed_tiers": ["lite"], "installed_software": ["pymupdf"]})
    assert soft_only["execution_model"] == "runtime_v2"
    assert "doc.pdf.text" in soft_only["missing_capabilities"]
    assert soft_only["local_ok"] is False
    assert soft_only["provision_plan"][0].get("action") == "install_provider"

    hard = evaluate_readiness(
        app,
        {
            "installed_tiers": [],
            "provided_capabilities": [
                {"name": "doc.pdf.text", "version": "1.0", "health": "healthy"},
            ],
        },
    )
    assert hard["missing_capabilities"] == []
    assert hard["local_ok"] is True
    assert hard["exec_advice"] == "local_ok"


def test_runtime_v2_quarantined_capability_still_missing():
    app = {"task_type": "excel_export", "execution_model": "runtime_v2", "lendable": False}
    out = evaluate_readiness(
        app,
        {
            "provided_capabilities": [
                {"name": "data.table.read", "version": "1.0", "health": "quarantined"},
            ],
        },
    )
    assert "data.table.read" in out["missing_capabilities"]
    assert out["local_ok"] is False
