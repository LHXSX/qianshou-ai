"""Reject incompatible H3 time-curve adapters before registering any patch."""


def guard_minimax_curve_lora(model, loaded, strength_model):
    if model is None or strength_model == 0:
        return
    diffusion = getattr(model.model, "diffusion_model", None)
    if not getattr(diffusion, "use_adaln_curves", False):
        return
    state = model.model.state_dict()
    bad = []
    for key, adapter in loaded.items():
        if not isinstance(key, str) or not key.endswith(".adaln_proj.linear.weight"):
            continue
        if key not in state or getattr(adapter, "name", None) != "lora":
            continue
        up, down, alpha, mid, dora, reshape = adapter.weights
        base = tuple(state[key].shape)
        delta = (up.shape[0], down.shape[1]) if len(up.shape) == len(down.shape) == 2 and up.shape[1] == down.shape[0] else None
        if mid is not None or reshape is not None or dora is not None or delta != base:
            bad.append(f"{key}: base={base}, LoRA={delta}")
    if bad:
        raise ValueError(
            "MiniMax H3 curve-basis LoRA incompatibility; rejected before applying any patches. "
            + f"{len(bad)} incompatible layers. Use a compatible non-pruned base or a curve-compatible adapter. "
            + "; ".join(bad[:3])
        )
