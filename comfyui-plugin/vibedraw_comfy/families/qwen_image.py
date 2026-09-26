"""The Qwen-Image 2.1 family: a diffusion model + text encoder + VAE triple.

This is a *reference-conditioned* generator, not img2img, and that changes what
the reference-strength knob has to mean.  Sampling always starts from an empty
latent at ``denoise = 1`` and the reference picture is spliced into the token
sequence, so there is no encoded reference latent to keep — "denoise less" has
nothing to hold on to.  The family therefore applies the same knob to the
reference itself: it softens the picture by an amount that grows as the strength
falls, which is as close as this model gets to being told to stop copying the
composition.

The direction is the same as the checkpoint family's ("higher = closer to the
reference"), which is all the contract asks for: the mechanism is free.
"""

from __future__ import annotations

from typing import Any

from ..capabilities import REF_STRENGTH_RANGE
from . import graph

#: Model roles this family needs configured.
ROLES: tuple[str, ...] = ("unet", "clip", "vae")

#: Extra knobs this family takes from the settings file.  Declared so the
#: dispatcher can hand a family its own options and nothing else.
OPTIONS: tuple[str, ...] = ("cache_device", "cache_dtype")

#: The Qwen text encoder is loaded through ``CLIPLoader`` with this type.
CLIP_TYPE = "qwen_image"

#: How much a reference may be softened when the strength is turned down.
#: ``ImageBlur`` caps ``blur_radius`` at 31 and ``sigma`` at 10.
FADE_MAX = 0.85
BLUR_RADIUS_MAX = 31
BLUR_SIGMA_MAX = 10.0


def reference_fade(ref_strength: float) -> float:
    """How far the reference is softened before it reaches the encoder.

    Measured on the reference box: asking this model for a partial denoise over a
    reference latent makes it hand the latent back almost untouched (0.45 and
    even 0.70 came back as the reference with a slight blur, only 0.95 really
    repainted).  So the knob moves to the reference instead.

    The blur is deliberately *not* a blend towards a flat grey — that tinted the
    whole render, because the model happily painted the grey back out as a
    washed-out background.
    """
    low, high = REF_STRENGTH_RANGE
    span = high - low
    normalized = (max(low, min(high, float(ref_strength))) - low) / span
    return round(FADE_MAX * (1.0 - normalized), 3)


def _reference_blur(fade: float) -> dict[str, Any]:
    """The blur that turns a fade amount into ``ImageBlur`` settings.

    ``blur_radius`` only goes up to 31, so the radius and the sigma are moved
    together: a wide radius on its own rings around the edges of a 1024 px
    picture, and a large sigma on its own leaves a visible ghost of the original
    silhouette, which is exactly the thing a low strength is trying to remove.
    """
    radius = int(round(1 + fade * (BLUR_RADIUS_MAX - 1)))
    sigma = round(0.1 + fade * (BLUR_SIGMA_MAX - 0.1), 1)
    return {"class_type": "ImageBlur",
            "inputs": {"image": ["11", 0], "blur_radius": radius, "sigma": sigma},
            "_meta": {"title": "VibeDraw reference strength"}}


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
    cache_device: str = "auto",
    cache_dtype: str = "default",
    filename_prefix: str = "vibedraw/vibedraw",
) -> dict[str, Any]:
    """A graph that mirrors the model's own contract rather than pretending it is
    an ordinary checkpoint: ``UNETLoader`` + ``CLIPLoader(type=qwen_image)`` +
    ``VAELoader`` feed the KV-cache wrapper, ``TextEncodeQwenImage21`` turns
    prompt, negative prompt **and the reference picture** into a conditioning
    pair, and the sampler runs from an empty latent at ``denoise = 1``.

    The reference is scaled to the output canvas first, because the node resizes
    what it is given to ``resolution`` anyway and doing it here keeps the aspect
    ratio exact.
    """
    if masked:
        # The capability declares needs.mask false, so the HTTP layer never
        # routes a mask here.  Refusing beats quietly ignoring one.
        raise ValueError("bad_mask")

    files = dict(models or {})
    unet = str(files.get("unet") or "").strip()
    clip = str(files.get("clip") or "").strip()
    vae = str(files.get("vae") or "").strip()
    if not (unet and clip and vae):
        raise ValueError("no_model")

    width, height = int(size[0]), int(size[1])
    fade = reference_fade(ref_strength)

    nodes: dict[str, Any] = {
        "9": graph.output_node(["8", 0], filename_prefix),
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["3", 0]}},
        "7": graph.sampler(["4", 0], ["5", 0], ["5", 1], ["6", 0], seed, steps, sampling, 1.0),
        "6": {"class_type": "EmptyLatentImage",
              "inputs": {"width": width, "height": height, "batch_size": 1}},
        "5": {
            "class_type": "TextEncodeQwenImage21",
            "inputs": {
                "clip": ["2", 0],
                "prompt": str(prompt or ""),
                "negative_prompt": str(negative_prompt or ""),
                # The reference already carries the canvas size; telling the node
                # the same number keeps it from resizing a second time.
                "resolution": max(width, height),
                "vae": ["3", 0],
                "images.image_1": ["12", 0] if fade > 0 else ["11", 0],
            },
            "_meta": {"title": "VibeDraw prompt and reference"},
        },
        "4": {"class_type": "QwenImage21Cache",
              "inputs": {"model": ["1", 0], "device": str(cache_device or "auto"),
                         "dtype": str(cache_dtype or "default")},
              "_meta": {"title": "VibeDraw text cache"}},
        "3": graph.vae_node(vae),
        "2": graph.clip_node(clip, CLIP_TYPE),
        "1": graph.unet_node(unet),
        # "10" loads the picture, "11" scales it to the output canvas, and "12"
        # is what the encoder actually sees: "11" as it is, or "11" softened by
        # the strength knob.  The soften step must live on its own id — reading
        # "11" and writing "11" is a dependency cycle and ComfyUI rejects the
        # whole prompt with "Dependency cycle detected".
        "10": graph.load_image(image, "VibeDraw reference"),
        "11": graph.scale(["10", 0], width, height),
    }
    if fade > 0:
        nodes["12"] = _reference_blur(fade)
    return nodes


__all__ = ["CLIP_TYPE", "ROLES", "build", "reference_fade"]
