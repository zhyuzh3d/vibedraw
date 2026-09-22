"""Built-in ComfyUI graphs for the three VibeDraw tasks.

The plugin owns the graphs so a user never has to export an API workflow.  The
same specifications drive ``GET /vibedraw/v1/capabilities``, so the client and
the server can never disagree about which sizes, step counts, or parameters a
task accepts.

Reference influence
-------------------
``ref_strength`` is the single most important parameter: it is how strongly the
reference image constrains the result.  Higher means closer to the reference.
It maps onto the sampler's ``denoise`` in reverse, because a low denoise keeps
more of the encoded reference latent intact.
"""

from __future__ import annotations

from typing import Any

REFERENCE_FLOOR = 0.05
DENOISE_MINIMUM = 0.05
DENOISE_MAXIMUM = 1.0

#: Upscaling always encodes the *whole* canvas at this base size and then grows
#: the latent.  Encoding a 2048 px image directly would need roughly sixteen times
#: the memory for no extra quality, and every SD1.5-derived model is trained at
#: 512 anyway.
UPSCALE_BASE = 512


def denoise_from_reference(ref_strength: float) -> float:
    value = 1.0 - max(0.0, min(1.0, float(ref_strength)))
    return max(DENOISE_MINIMUM, min(DENOISE_MAXIMUM, value))


TASK_SPECS: dict[str, dict[str, Any]] = {
    "quick": {
        "id": "quick",
        "label": {"zh": "快速绘制", "en": "Quick draw"},
        "description": {
            "zh": "把画布当作参考图重绘一张 512 × 512 的速写稿，推荐 DreamShaper8 LCM。",
            "en": "Redraw the canvas as a 512 × 512 sketch. DreamShaper8 LCM is recommended.",
        },
        "needs": {"image": True, "mask": False, "prompt": True},
        "sizes": [[512, 512]],
        "steps": {"allowed": [2, 4, 6, 8], "default": 8},
        "params": [
            {
                "id": "ref_strength",
                "kind": "reference",
                "label": {"zh": "参考图权重", "en": "Reference influence"},
                "help": {
                    "zh": "越高越贴近画布原稿，越低越放手重画。",
                    "en": "Higher keeps closer to the canvas, lower redraws more freely.",
                },
                "minimum": REFERENCE_FLOOR,
                "maximum": 0.95,
                "default": 0.55,
            }
        ],
        "estimated_seconds": 1.2,
    },
    "inpaint": {
        "id": "inpaint",
        "label": {"zh": "局部重绘", "en": "Local redraw"},
        "description": {
            "zh": "只重画白色蒙版覆盖的区域，其余部分原样保留，推荐 DreamShaper8 LCM。",
            "en": "Repaint only the white mask area and keep everything else. DreamShaper8 LCM is recommended.",
        },
        "needs": {"image": True, "mask": True, "prompt": True},
        "sizes": [[512, 512]],
        "steps": {"allowed": [4, 6, 8, 12], "default": 6},
        "params": [
            {
                "id": "ref_strength",
                "kind": "reference",
                "label": {"zh": "参考图权重", "en": "Reference influence"},
                "help": {
                    "zh": "越高越贴近原图；蒙版内仍会被重画。",
                    "en": "Higher keeps closer to the original; the masked area is still redrawn.",
                },
                "minimum": REFERENCE_FLOOR,
                "maximum": 0.95,
                "default": 0.30,
            },
            {
                "id": "grow_mask_by",
                "kind": "integer",
                "label": {"zh": "蒙版外扩", "en": "Mask grow"},
                "help": {
                    "zh": "把重画范围向外扩几个像素，接缝更自然。",
                    "en": "Grow the repaint area by a few pixels so the seam blends.",
                },
                "minimum": 0,
                "maximum": 64,
                "default": 8,
            },
        ],
        "estimated_seconds": 2.6,
    },
    "upscale": {
        "id": "upscale",
        "label": {"zh": "放大绘制", "en": "Upscale draw"},
        "description": {
            "zh": "把 512 的画布放大到 1024 或 2048 并补细节；模型只要能接受 512 参考图、输出大图即可。",
            "en": "Upscale the 512 canvas to 1024 or 2048 and add detail. Any model that accepts a 512 reference works.",
        },
        "needs": {"image": True, "mask": False, "prompt": True},
        "sizes": [[1024, 1024], [2048, 2048]],
        "steps": {"allowed": [4, 8, 12, 16, 20], "default": 8},
        "params": [
            {
                "id": "ref_strength",
                "kind": "reference",
                "label": {"zh": "参考图权重", "en": "Reference influence"},
                "help": {
                    "zh": "建议保持较高，否则放大后会改变原构图。",
                    "en": "Keep this high, or upscaling will change the composition.",
                },
                "minimum": 0.30,
                "maximum": 0.95,
                "default": 0.75,
            }
        ],
        "estimated_seconds": 6.0,
    },
}


def task_ids() -> list[str]:
    return list(TASK_SPECS)


def spec(task: str) -> dict[str, Any]:
    value = TASK_SPECS.get(str(task or "").strip().lower())
    if value is None:
        raise ValueError("unsupported_task")
    return value


def allowed_sizes(task: str) -> list[list[int]]:
    return [list(size) for size in spec(task)["sizes"]]


def _checkpoint_node(checkpoint: str) -> dict[str, Any]:
    return {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": checkpoint}, "_meta": {"title": "VibeDraw checkpoint"}}


def _load_image(name: str, title: str) -> dict[str, Any]:
    return {"class_type": "LoadImage", "inputs": {"image": name}, "_meta": {"title": title}}


def _scale(source: list[Any], width: int, height: int) -> dict[str, Any]:
    return {
        "class_type": "ImageScale",
        "inputs": {"image": source, "upscale_method": "lanczos", "width": int(width), "height": int(height), "crop": "disabled"},
    }


def _latent_upscale(source: list[Any], width: int, height: int) -> dict[str, Any]:
    return {
        "class_type": "LatentUpscale",
        "inputs": {"samples": source, "upscale_method": "bilinear", "width": int(width), "height": int(height), "crop": "disabled"},
    }


def _text_encode(text: str, clip: list[Any], title: str) -> dict[str, Any]:
    return {"class_type": "CLIPTextEncode", "inputs": {"text": str(text or ""), "clip": clip}, "_meta": {"title": title}}


def _sampler(model, positive, negative, latent, seed, steps, sampling, denoise) -> dict[str, Any]:
    return {
        "class_type": "KSampler",
        "inputs": {
            "model": model,
            "positive": positive,
            "negative": negative,
            "latent_image": latent,
            "seed": int(seed),
            "steps": int(steps),
            "cfg": float(sampling.get("cfg", 2.0)),
            "sampler_name": str(sampling.get("sampler", "lcm")),
            "scheduler": str(sampling.get("scheduler", "sgm_uniform")),
            "denoise": float(denoise),
        },
    }


def build(
    *,
    task: str,
    checkpoint: str,
    sampling: dict[str, Any],
    image: str,
    mask: str = "",
    prompt: str = "",
    negative_prompt: str = "",
    seed: int = 0,
    steps: int | None = None,
    size: list[int] | None = None,
    ref_strength: float | None = None,
    grow_mask_by: int | None = None,
    filename_prefix: str = "vibedraw/vibedraw",
) -> tuple[dict[str, Any], list[str]]:
    specification = spec(task)
    width, height = size or specification["sizes"][0]
    chosen_steps = int(steps if steps is not None else specification["steps"]["default"])
    reference = float(specification["params"][0]["default"] if ref_strength is None else ref_strength)
    denoise = denoise_from_reference(reference)

    graph: dict[str, Any] = {
        "1": _checkpoint_node(checkpoint),
        "2": _load_image(image, "VibeDraw reference"),
        "5": _text_encode(prompt, ["1", 1], "VibeDraw prompt"),
        "6": _text_encode(negative_prompt, ["1", 1], "VibeDraw negative prompt"),
    }

    if task == "upscale":
        graph["3"] = _scale(["2", 0], UPSCALE_BASE, UPSCALE_BASE)
    else:
        graph["3"] = _scale(["2", 0], width, height)

    if task == "inpaint":
        grow = int(grow_mask_by if grow_mask_by is not None else specification["params"][1]["default"])
        graph["10"] = _load_image(mask, "VibeDraw mask")
        graph["11"] = {"class_type": "ImageToMask", "inputs": {"image": ["10", 0], "channel": "red"}}
        graph["4"] = {
            "class_type": "VAEEncodeForInpaint",
            "inputs": {"pixels": ["3", 0], "vae": ["1", 2], "mask": ["11", 0], "grow_mask_by": max(0, min(64, grow))},
        }
        latent: list[Any] = ["4", 0]
    else:
        graph["4"] = {"class_type": "VAEEncode", "inputs": {"pixels": ["3", 0], "vae": ["1", 2]}}
        latent = ["4", 0]

    if task == "upscale":
        graph["12"] = _latent_upscale(["4", 0], width, height)
        latent = ["12", 0]

    graph["7"] = _sampler(["1", 0], ["5", 0], ["6", 0], latent, seed, chosen_steps, sampling, denoise)
    graph["8"] = {"class_type": "VAEDecode", "inputs": {"samples": ["7", 0], "vae": ["1", 2]}}
    graph["9"] = {"class_type": "VibeDrawOutput", "inputs": {"images": ["8", 0], "filename_prefix": filename_prefix}}
    return graph, ["9"]


def validate(*, task: str, size: list[int] | None, steps: int | None) -> tuple[list[int], int]:
    specification = spec(task)
    sizes = [list(value) for value in specification["sizes"]]
    chosen = [int(size[0]), int(size[1])] if size else sizes[0]
    if chosen not in sizes:
        raise ValueError("unsupported_size")
    allowed_steps = [int(value) for value in specification["steps"]["allowed"]]
    selected = int(steps if steps is not None else specification["steps"]["default"])
    if selected not in allowed_steps:
        raise ValueError("unsupported_steps")
    return chosen, selected
