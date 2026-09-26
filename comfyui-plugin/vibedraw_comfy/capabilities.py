"""The CVP capability table, and the one document that describes it.

This module is the single source of truth for *what this server can do*.  The
HTTP layer, the config node and the offline tests all read it; adding a
capability here makes it appear in the discovery document, in the config node's
validation, and to every client, with no second table to forget.

Three ideas hold it together:

* **A capability declares a contract, not an implementation.**  ``values`` and
  ``defaults`` narrow what a client may send; which model runs behind it is the
  ``roles`` / ``family`` pair, and nothing outside ``families/`` reads those.
* **One signature shares one schema.**  Every ``txt-ref2img`` capability sends
  the same field names with the same meanings; only the allowed values differ.
  That is why a client writes its form once and can call all of them.
* **Capability ids are semantic.**  ``render``, not ``qwen``: swapping the model
  behind a capability must never change its id.  ``aliases`` exist only to keep
  a client that was written against an older name working.

The meanings of the fields themselves live in :data:`INPUT_SCHEMAS` and in
``plans/cvp-spec.md``; nothing here may invent a per-capability meaning for a
shared field.
"""

from __future__ import annotations

import json
from copy import deepcopy
from typing import Any, Callable

from .version import __version__

#: The protocol version.  It is reported in the document and never in a path —
#: see the spec's principle 2.
SPEC = "cvp/1"

API_ROOT = "/cvp"
#: The paths shipped clients (and PoseGi) already call.  Kept as aliases that
#: answer the *old* document shapes; see :mod:`legacy`.
LEGACY_ROOT = "/vibedraw/v1"

#: Legacy schema strings, still reported by the legacy projections so a client
#: that compares them does not reject the server.
API_SCHEMA = "vibedraw-comfy/v2"
DISCOVERY_SCHEMA = "vibedraw-comfy/discovery/v1"

PLUGIN_ID = "vibedraw_comfy"
PLUGIN_LABEL = {"zh": "ComfyUI VibeDraw 插件", "en": "ComfyUI VibeDraw Plugin"}

#: The relative paths a client should use.  Given here so a client never has to
#: assemble one itself.
ENDPOINTS: dict[str, str] = {
    "info": f"{API_ROOT}/info",
    "jobs": f"{API_ROOT}/jobs",
    "job": f"{API_ROOT}/jobs/{{job_id}}",
    "progress": f"{API_ROOT}/jobs/{{job_id}}/progress",
    "output": f"{API_ROOT}/jobs/{{job_id}}/output/{{index}}",
    "cancel": f"{API_ROOT}/jobs/{{job_id}}/cancel",
    "translate": f"{API_ROOT}/translate",
}

#: Functional classes.  An open set: a client must ignore one it does not know.
CATEGORIES = {
    "realtime": {"zh": "实时出图, 适合边画边看", "en": "Answers in a second or two; good while drawing"},
    "edit": {"zh": "在已有画面上做局部修改", "en": "Changes part of an existing picture"},
    "upscale": {"zh": "放大并补细节, 尽量不改构图", "en": "Enlarges and adds detail, keeping the composition"},
    "render": {"zh": "重画成成品图", "en": "Repaints the canvas into a finished picture"},
}

#: The domain of ``ref_strength``, everywhere, for every capability.  It is a
#: direction ("higher = closer to the reference"), not a mechanism: one family
#: implements it as a denoise floor, another by softening the reference, and
#: both are compliant.  Out-of-range values are clamped, not rejected.
REF_STRENGTH_RANGE = (0.05, 0.95)
GROW_MASK_RANGE = (0, 64)

_FIELD_HELP = {
    "prompt": {
        "zh": "画面描述。是否需要先译成英文由能力的 prompt.language 决定。",
        "en": "What to draw. Whether it must be English first is the capability's prompt.language.",
    },
    "negative_prompt": {
        "zh": "不想出现的内容。能力若声明忽略它, 发了也不生效。",
        "en": "What to avoid. A capability that declares it ignored will not act on it.",
    },
    "image_base64": {
        "zh": "参考图, PNG/JPEG 的 base64, 可直接给 data URL。",
        "en": "Reference image as base64 PNG/JPEG; a data URL is accepted as-is.",
    },
    "mask_base64": {
        "zh": "蒙版, 黑底白区, 白色 = 要重画。",
        "en": "Mask, black background with a white area; white means repaint.",
    },
    "size": {
        "zh": "输出画幅 [宽, 高]。只能取本能力 values.size 里列出的值。",
        "en": "Output canvas [width, height]; only the values in this capability's values.size.",
    },
    "steps": {
        "zh": "采样步数。只能取本能力 values.steps 里列出的值。",
        "en": "Sampling steps; only the values in this capability's values.steps.",
    },
    "seed": {
        "zh": "0 表示每张都不一样; 同一个值可以复现。",
        "en": "0 means a new seed each run; the same value reproduces.",
    },
    "ref_strength": {
        "zh": "0.05–0.95, 越大越贴近参考图, 越低越放手重画。越界会被夹到边界。",
        "en": "0.05–0.95. Higher stays closer to the reference, lower redraws more freely. Out of range is clamped.",
    },
    "grow_mask_by": {
        "zh": "把重画范围向外扩几个像素, 接缝更自然。0–64。",
        "en": "Grow the repaint area by a few pixels so the seam blends. 0–64.",
    },
}

#: The request body shared by every ``txt-ref2img`` capability — declared once,
#: not once per capability.  JSON-Schema-shaped, plus three documentation keys
#: (``title`` / ``help`` / ``recommended``) that a validator ignores.
INPUT_SCHEMAS: dict[str, dict[str, Any]] = {
    "txt-ref2img/v1": {
        "type": "object",
        "required": ["capability"],
        "properties": {
            "capability": {
                "type": "string",
                "title": {"zh": "能力", "en": "Capability"},
                "help": {"zh": "能力 id, 或它的别名。", "en": "A capability id, or one of its aliases."},
            },
            "prompt": {
                "type": "string", "default": "", "recommended": True,
                "title": {"zh": "提示词", "en": "Prompt"}, "help": _FIELD_HELP["prompt"],
            },
            "negative_prompt": {
                "type": "string", "default": "",
                "title": {"zh": "反向提示词", "en": "Negative prompt"}, "help": _FIELD_HELP["negative_prompt"],
            },
            "image_base64": {
                "type": "string", "format": "base64-image",
                "title": {"zh": "参考图", "en": "Reference"}, "help": _FIELD_HELP["image_base64"],
            },
            "mask_base64": {
                "type": "string", "format": "base64-image",
                "title": {"zh": "蒙版", "en": "Mask"}, "help": _FIELD_HELP["mask_base64"],
            },
            "size": {
                "type": "array", "items": "integer", "length": 2,
                "title": {"zh": "画幅", "en": "Canvas"}, "help": _FIELD_HELP["size"],
            },
            "steps": {
                "type": "integer",
                "title": {"zh": "步数", "en": "Steps"}, "help": _FIELD_HELP["steps"],
            },
            "seed": {
                "type": "integer", "minimum": 0, "default": 0,
                "title": {"zh": "随机种子", "en": "Seed"}, "help": _FIELD_HELP["seed"],
            },
            "ref_strength": {
                "type": "number", "minimum": REF_STRENGTH_RANGE[0], "maximum": REF_STRENGTH_RANGE[1],
                "title": {"zh": "参考图权重", "en": "Reference influence"}, "help": _FIELD_HELP["ref_strength"],
            },
            "grow_mask_by": {
                "type": "integer", "minimum": GROW_MASK_RANGE[0], "maximum": GROW_MASK_RANGE[1],
                "title": {"zh": "蒙版外扩", "en": "Mask grow"}, "help": _FIELD_HELP["grow_mask_by"],
            },
        },
    }
}

SIGNATURE = "txt-ref2img"
INPUT_SCHEMA = "txt-ref2img/v1"
IMAGE_OUTPUT = {"modality": "img", "media_type": "image/png", "delivery": "url"}

#: The capability table.
#:
#: ``roles`` and ``family`` are implementation: the first says which model slots
#: must be configured, the second says which module under ``families/`` builds
#: the graph.  Nothing else reads them, and they are not published.
CAPABILITIES: dict[str, dict[str, Any]] = {
    "quick": {
        "id": "quick",
        "aliases": [],
        "category": ["realtime"],
        "signature": SIGNATURE,
        "input": INPUT_SCHEMA,
        "output": IMAGE_OUTPUT,
        "label": {"zh": "快速生图", "en": "Quick draw"},
        "description": {
            "zh": "把画布当作参考图重绘一张 512 × 512 的速写稿。",
            "en": "Redraw the canvas as a 512 × 512 sketch.",
        },
        "prompt": {"language": "en"},
        "needs": {"prompt": True, "image": True, "mask": False},
        "ignores": [],
        "values": {"size": [[512, 512]], "steps": [2, 4, 6, 8]},
        "defaults": {"size": [512, 512], "steps": 8, "ref_strength": 0.55},
        "roles": ["checkpoint"],
        "family": "checkpoint",
        "typical_seconds": 1.2,
    },
    "inpaint": {
        "id": "inpaint",
        "aliases": [],
        "category": ["edit"],
        "signature": SIGNATURE,
        "input": INPUT_SCHEMA,
        "output": IMAGE_OUTPUT,
        "label": {"zh": "局部重绘", "en": "Local redraw"},
        "description": {
            "zh": "只重画白色蒙版覆盖的区域, 其余部分原样保留。",
            "en": "Repaint only the white mask area and keep everything else.",
        },
        "prompt": {"language": "en"},
        "needs": {"prompt": True, "image": True, "mask": True},
        "ignores": [],
        "values": {"size": [[512, 512]], "steps": [4, 6, 8, 12]},
        "defaults": {"size": [512, 512], "steps": 6, "ref_strength": 0.30, "grow_mask_by": 8},
        "roles": ["checkpoint"],
        "family": "checkpoint",
        "typical_seconds": 2.6,
    },
    "upscale": {
        "id": "upscale",
        "aliases": [],
        "category": ["upscale"],
        "signature": SIGNATURE,
        "input": INPUT_SCHEMA,
        "output": IMAGE_OUTPUT,
        "label": {"zh": "图像放大", "en": "Upscale"},
        "description": {
            "zh": "把画布放大到 1024 或 2048 并补细节。",
            "en": "Upscale the canvas to 1024 or 2048 and add detail.",
        },
        "prompt": {"language": "en"},
        "needs": {"prompt": True, "image": True, "mask": False},
        "ignores": [],
        "values": {"size": [[1024, 1024], [2048, 2048]], "steps": [4, 8, 12, 16, 20]},
        "defaults": {"size": [1024, 1024], "steps": 8, "ref_strength": 0.75},
        "roles": ["checkpoint"],
        "family": "checkpoint",
        "typical_seconds": 6.0,
    },
    "render": {
        "id": "render",
        "aliases": ["qwen"],
        "category": ["render"],
        "signature": SIGNATURE,
        "input": INPUT_SCHEMA,
        "output": IMAGE_OUTPUT,
        "label": {"zh": "高质量生图", "en": "High quality render"},
        "description": {
            "zh": "重画成一张 1024 以内的成品图。比速写模型重得多, 单张要几十秒。",
            "en": "Repaint the canvas into a finished picture up to 1024 px. Far heavier than a sketch model.",
        },
        "prompt": {"language": "any"},
        "needs": {"prompt": True, "image": True, "mask": False},
        # Sampled at cfg 1: there is nothing to steer away from, so the field is
        # declared ignored rather than quietly accepted and dropped.
        "ignores": ["negative_prompt"],
        "values": {
            "size": [[512, 512], [576, 576], [640, 640], [704, 704], [768, 768],
                     [832, 832], [896, 896], [960, 960], [1024, 1024]],
            "steps": [12, 16, 20, 25, 30, 40],
        },
        "defaults": {"size": [1024, 1024], "steps": 20, "ref_strength": 0.95},
        "roles": ["unet", "clip", "vae"],
        "family": "qwen_image_21",
        "typical_seconds": 45.0,
    },
}

#: Which model role lives in which ComfyUI folder.  Kept beside the resolver so
#: "is this file installed" is answered per role, exactly as submission does it.
ROLE_FOLDERS = {"checkpoint": "checkpoints", "unet": "diffusion_models",
                "clip": "text_encoders", "vae": "vae"}

Resolver = Callable[[str], dict[str, Any]]


def ids() -> list[str]:
    return list(CAPABILITIES)


def names() -> list[str]:
    """Every name a client may submit: the ids and all their aliases."""
    out: list[str] = []
    for entry in CAPABILITIES.values():
        out.append(entry["id"])
        out.extend(entry["aliases"])
    return out


def find(name: Any) -> dict[str, Any] | None:
    """Resolve an id *or* an alias to the capability it names."""
    wanted = str(name or "").strip().lower()
    if not wanted:
        return None
    entry = CAPABILITIES.get(wanted)
    if entry is not None:
        return entry
    for candidate in CAPABILITIES.values():
        if wanted in [str(alias).lower() for alias in candidate["aliases"]]:
            return candidate
    return None


def spec_of(name: Any) -> dict[str, Any]:
    """Like :func:`find`, but raises ``unsupported_capability``."""
    entry = find(name)
    if entry is None:
        raise ValueError("unsupported_capability")
    return entry


def clamp_ref_strength(value: Any, fallback: float) -> float:
    """Clamp a continuous knob to its declared domain.

    Enumerations (``size`` / ``steps``) reject an out-of-range value; a
    continuous value is clamped and echoed back, because there is no plausible
    reason to fail a job over 0.96.
    """
    low, high = REF_STRENGTH_RANGE
    try:
        number = float(value)
    except (TypeError, ValueError):
        return float(fallback)
    if number != number:  # NaN
        return float(fallback)
    return round(min(max(number, low), high), 4)


def validate_values(capability: dict[str, Any], size: Any, steps: Any) -> tuple[list[int], int]:
    """The enumeration check, shared by every capability.

    Raises ``unsupported_size`` / ``unsupported_steps`` — the same codes the
    document promises, so a client that renders its form from ``values`` can
    never build a request this rejects.
    """
    sizes = [[int(value[0]), int(value[1])] for value in capability["values"]["size"]]
    if size is None:
        chosen = list(capability["defaults"]["size"])
    elif isinstance(size, (list, tuple)) and len(size) >= 2:
        try:
            chosen = [int(size[0]), int(size[1])]
        except (TypeError, ValueError):
            raise ValueError("unsupported_size") from None
    else:
        raise ValueError("unsupported_size")
    if chosen not in sizes:
        raise ValueError("unsupported_size")

    allowed = [int(value) for value in capability["values"]["steps"]]
    if steps is None:
        selected = int(capability["defaults"]["steps"])
    else:
        try:
            selected = int(steps)
        except (TypeError, ValueError):
            raise ValueError("unsupported_steps") from None
    if selected not in allowed:
        raise ValueError("unsupported_steps")
    return chosen, selected


def clean_defaults(capability: dict[str, Any]) -> dict[str, Any]:
    """The defaults a client may rely on, as plain JSON."""
    return json.loads(json.dumps(capability["defaults"]))


def entry(capability: dict[str, Any], models: list[dict[str, Any]]) -> dict[str, Any]:
    """One capability as it appears in the document."""
    return {
        "id": capability["id"],
        "aliases": list(capability["aliases"]),
        "category": list(capability["category"]),
        "signature": capability["signature"],
        "input": capability["input"],
        "output": deepcopy(capability["output"]),
        "label": deepcopy(capability["label"]),
        "description": deepcopy(capability["description"]),
        "prompt": deepcopy(capability["prompt"]),
        "needs": deepcopy(capability["needs"]),
        "ignores": list(capability["ignores"]),
        "values": deepcopy(capability["values"]),
        "defaults": clean_defaults(capability),
        "models": models,
        "ready": bool(models) and all(item.get("ready") for item in models),
        "typical_seconds": capability["typical_seconds"],
    }


def capabilities(resolve: Resolver) -> list[dict[str, Any]]:
    return [entry(value, list(resolve(value["id"]) or [])) for value in CAPABILITIES.values()]


def document(*, resolve: Resolver, authorized: bool, auth_required: bool, translation: dict[str, Any],
             available: dict[str, list[str]] | None = None, auth_hint: str = "") -> dict[str, Any]:
    """The whole discovery document.

    Answers even when the password is wrong: ``auth.authorized`` says which it
    was, which is what lets a client tell "the address is right, the password is
    not" out of the one call it was going to make anyway.

    ``translation`` and ``available`` are supplied by the caller rather than read
    here: this module is the specification, and it must not depend on the parts
    of the server that touch the network or ComfyUI's model folders.
    """
    return {
        "spec": SPEC,
        "plugin": {"id": PLUGIN_ID, "label": deepcopy(PLUGIN_LABEL), "version": __version__},
        "auth": {
            "required": bool(auth_required),
            "authorized": bool(authorized),
            "scheme": "Bearer",
            "header": "Authorization",
            "hint": auth_hint or "密码在 ComfyUI 的 VibeDraw 配置节点里设置。",
        },
        "endpoints": dict(ENDPOINTS),
        "input_schemas": deepcopy(INPUT_SCHEMAS),
        "capabilities": capabilities(resolve),
        "translation": deepcopy(translation or {}),
        "models": {"available": deepcopy(available or {})},
    }


__all__ = [
    "API_ROOT", "API_SCHEMA", "CAPABILITIES", "CATEGORIES", "DISCOVERY_SCHEMA", "ENDPOINTS",
    "GROW_MASK_RANGE", "INPUT_SCHEMAS", "LEGACY_ROOT", "PLUGIN_ID", "PLUGIN_LABEL",
    "REF_STRENGTH_RANGE", "ROLE_FOLDERS", "SPEC", "capabilities", "clamp_ref_strength",
    "clean_defaults", "document", "entry", "find", "ids", "names", "spec_of", "validate_values",
]
