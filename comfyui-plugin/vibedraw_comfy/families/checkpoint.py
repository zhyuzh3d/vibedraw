"""The checkpoint family: one ``CheckpointLoaderSimple`` carries everything.

This is the img2img family.  It is ordinary latent img2img — encode the
reference, sample it with a denoise that the reference-strength knob sets — so
its ``ref_strength`` mechanism is "how much of the encoded reference latent is
kept": ``denoise = 1 - ref_strength``.
"""

from __future__ import annotations

from typing import Any

from . import graph

#: Model roles this family needs configured.
ROLES: tuple[str, ...] = ("checkpoint",)

REFERENCE_FLOOR = 0.05
REFERENCE_CEILING = 0.95
DENOISE_MINIMUM = 0.05
DENOISE_MAXIMUM = 1.0

#: Upscaling encodes the reference at its own resolution up to this cap, and only
#: grows the latent above it.  The cap is what keeps a 2048 px job from needing
#: roughly four times the memory of a 1024 px one.  It is deliberately *not* 512:
#: encoding at 512 and growing the latent afterwards put the reference through a
#: lossy round trip before the sampler ever saw it, which is why a "render" came
#: out soft and partly re-invented instead of sharper than the canvas it came from.
ENCODE_MAX = 1024


def denoise_from_reference(ref_strength: float) -> float:
    """How far the sampler may move away from the encoded reference.

    The single weight lever: the client says how tightly to follow the
    reference, and the family turns that into a denoise floor.
    """
    value = 1.0 - max(0.0, min(1.0, float(ref_strength)))
    return max(DENOISE_MINIMUM, min(DENOISE_MAXIMUM, value))


def build(
    *,
    models: dict[str, Any],
    image: str,
    masked: bool = False,
    mask: str = "",
    prompt: str = "",
    negative_prompt: str = "",
    seed: int = 0,
    steps: int,
    size: tuple[int, int],
    sampling: dict[str, Any],
    ref_strength: float,
    grow_mask_by: int = 0,
    filename_prefix: str = "vibedraw/vibedraw",
) -> dict[str, Any]:
    checkpoint = str((models or {}).get("checkpoint") or "").strip()
    if not checkpoint:
        raise ValueError("no_model")

    width, height = int(size[0]), int(size[1])
    # A reference larger than the cap is encoded smaller and grown from the
    # latent; at or below the cap it is encoded at the target size and the
    # sampler starts from the real picture.
    encode = (min(width, ENCODE_MAX), min(height, ENCODE_MAX))

    graph_nodes: dict[str, Any] = {
        "1": graph.checkpoint_node(checkpoint),
        "2": graph.load_image(image, "VibeDraw reference"),
        "3": graph.scale(["2", 0], encode[0], encode[1]),
        "5": graph.text_encode(prompt, ["1", 1], "VibeDraw prompt"),
        "6": graph.text_encode(negative_prompt, ["1", 1], "VibeDraw negative prompt"),
    }

    if masked:
        graph_nodes["10"] = graph.load_image(mask, "VibeDraw mask")
        graph_nodes["11"] = {"class_type": "ImageToMask",
                             "inputs": {"image": ["10", 0], "channel": "red"}}
        graph_nodes["4"] = {
            "class_type": "VAEEncodeForInpaint",
            "inputs": {"pixels": ["3", 0], "vae": ["1", 2], "mask": ["11", 0],
                       "grow_mask_by": max(0, min(64, int(grow_mask_by)))},
        }
    else:
        graph_nodes["4"] = {"class_type": "VAEEncode",
                            "inputs": {"pixels": ["3", 0], "vae": ["1", 2]}}

    latent: list[Any] = ["4", 0]
    if encode != (width, height):
        graph_nodes["12"] = graph.latent_upscale(["4", 0], width, height)
        latent = ["12", 0]

    graph_nodes["7"] = graph.sampler(["1", 0], ["5", 0], ["6", 0], latent, seed, steps,
                                     sampling, denoise_from_reference(ref_strength))
    graph_nodes["8"] = {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["1", 2]}}
    graph_nodes["9"] = graph.output_node(["8", 0], filename_prefix)
    return graph_nodes


__all__ = ["ENCODE_MAX", "ROLES", "build", "denoise_from_reference"]
