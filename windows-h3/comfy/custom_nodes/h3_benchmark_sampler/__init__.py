# SPDX-License-Identifier: GPL-3.0-or-later
"""Narrow benchmark entry for unmodified, pinned T8 sampling.py and core.py.

Upstream: T8mars/comfyui-minimax-h3-audio-T8
Revision: ad43472fc85e943aed895bf2246c6554177b9717
This entry deliberately does not import upstream nodes.py or register routes.
"""
import logging

from .sampling import setup_dual_clock_sampling


class QSH3BenchmarkDualClock:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model": ("MODEL",), "av_latent": ("LATENT",),
            "steps": ("INT", {"default": 8, "min": 4, "max": 8, "step": 4}),
            "shift_video": ("FLOAT", {"default": 6.0}),
            "shift_audio": ("FLOAT", {"default": 3.0}),
        }}

    RETURN_TYPES = ("MODEL", "SAMPLER", "SIGMAS")
    FUNCTION = "build"
    CATEGORY = "qianshou/benchmark"

    def build(self, model, av_latent, steps, shift_video, shift_audio):
        if steps not in (4, 8) or shift_video != 6.0 or shift_audio != 3.0:
            raise ValueError("This experiment requires the matched 4/8-step 768p, 6/3 recipe")
        result = setup_dual_clock_sampling(
            model, av_latent, steps, shift_video, shift_audio,
            sampler_name="dual_clock_euler", scheduler="native_flow")
        logging.info("QS benchmark T8 dual_clock_euler native_flow steps=%s sigmas=%s", steps, result[2].tolist())
        return result


NODE_CLASS_MAPPINGS = {"QSH3BenchmarkDualClock": QSH3BenchmarkDualClock}
