"""Builders, one per model family, plus the one function that dispatches to them.

A family answers three questions and nothing else:

1. which model roles it needs configured (:data:`ROLES` on each module);
2. how (prompt, reference, size, steps, reference strength) become a graph;
3. what the reference-strength knob means *internally*.

The last one is the reason this package exists.  The contract fixes only the
direction and the domain of that knob ("higher = closer to the reference",
0.05–0.95); whether a family implements it as a denoise floor or by softening
the reference is its own business.  Swapping a model is adding a module and one
line below — not editing the HTTP layer, the discovery document and the config
node.
"""

from __future__ import annotations

from typing import Any

from . import checkpoint
from . import qwen_image

#: Explicit on purpose.  Two families do not need a registry, a decorator or an
#: import-time scan; a reader can see every family in one screen.
FAMILIES: dict[str, Any] = {
    "checkpoint": checkpoint,
    "qwen_image_21": qwen_image,
}


def get(name: str) -> Any:
    module = FAMILIES.get(str(name or "").strip())
    if module is None:
        raise ValueError("unsupported_capability")
    return module


def _options(module: Any, values: dict[str, Any]) -> dict[str, Any]:
    """Hand a family only the extra knobs it declares it takes."""
    return {key: values[key] for key in getattr(module, "OPTIONS", ()) if key in values}


def build(
    *,
    spec: dict[str, Any],
    models: dict[str, Any],
    sampling: dict[str, Any],
    image: str,
    mask: str = "",
    prompt: str = "",
    negative_prompt: str = "",
    seed: int = 0,
    steps: int,
    size: list[int] | tuple[int, int],
    ref_strength: float,
    grow_mask_by: int | None = None,
    options: dict[str, Any] | None = None,
    filename_prefix: str = "vibedraw/vibedraw",
) -> dict[str, Any]:
    """Build the graph for one already-validated request.

    ``spec`` comes from :func:`vibedraw_comfy.capabilities.spec_of`, so the
    enumerations were checked before anything here runs; this function's only
    job is picking the family and shaping the arguments.
    """
    module = get(spec["family"])
    masked = bool(spec["needs"].get("mask"))
    if grow_mask_by is None:
        grow_mask_by = int(spec["defaults"].get("grow_mask_by") or 0)
    return module.build(
        models=dict(models or {}),
        image=str(image),
        masked=masked,
        mask=str(mask or "") if masked else "",
        prompt=str(prompt or ""),
        negative_prompt=str(negative_prompt or ""),
        seed=int(seed),
        steps=int(steps),
        size=(int(size[0]), int(size[1])),
        sampling=dict(sampling or {}),
        ref_strength=float(ref_strength),
        grow_mask_by=int(grow_mask_by),
        filename_prefix=str(filename_prefix),
        **_options(module, dict(options or {})),
    )


__all__ = ["FAMILIES", "build", "get"]
