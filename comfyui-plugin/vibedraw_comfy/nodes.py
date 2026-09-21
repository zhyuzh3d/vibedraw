"""Typed VibeDraw input/output nodes.

The input node is intentionally small.  It reads transient files staged in
ComfyUI's input directory by the VibeDraw HTTP adapter and exposes ordinary
ComfyUI types to the user's graph.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import torch
from PIL import Image

import folder_paths
import nodes


def _empty_image() -> torch.Tensor:
    return torch.zeros((1, 1, 1, 3), dtype=torch.float32)


def _empty_mask() -> torch.Tensor:
    return torch.zeros((1, 1, 1), dtype=torch.float32)


def _safe_input_path(name: str) -> Path | None:
    if not name:
        return None
    try:
        return Path(folder_paths.get_annotated_filepath(str(name)))
    except Exception:
        return None


def _load_image(name: str) -> tuple[torch.Tensor, torch.Tensor]:
    path = _safe_input_path(name)
    if path is None or not path.is_file():
        return _empty_image(), _empty_mask()
    try:
        image = Image.open(path).convert("RGB")
        pixels = np.asarray(image, dtype=np.float32) / 255.0
        tensor = torch.from_numpy(pixels)[None, ...]
        return tensor, torch.zeros((1, image.height, image.width), dtype=torch.float32)
    except Exception:
        return _empty_image(), _empty_mask()


def _load_mask(name: str, fallback: torch.Tensor) -> torch.Tensor:
    path = _safe_input_path(name)
    if path is None or not path.is_file():
        return fallback
    try:
        image = Image.open(path).convert("L")
        values = np.asarray(image, dtype=np.float32) / 255.0
        return torch.from_numpy(values)[None, ...]
    except Exception:
        return fallback


class VibeDrawInput:
    """Expose the stable VibeDraw semantic inputs to a ComfyUI graph."""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "prompt": ("STRING", {"default": "", "multiline": True}),
                "negative_prompt": ("STRING", {"default": "", "multiline": True}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 9007199254740991}),
                "ref_strength": ("FLOAT", {"default": 0.8, "min": 0.0, "max": 2.0, "step": 0.01}),
                "steps": ("INT", {"default": 4, "min": 1, "max": 150}),
                "width": ("INT", {"default": 512, "min": 16, "max": 2048, "step": 8}),
                "height": ("INT", {"default": 512, "min": 16, "max": 2048, "step": 8}),
                "image_file": ("STRING", {"default": ""}),
                "mask_file": ("STRING", {"default": ""}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "IMAGE", "MASK", "INT", "FLOAT", "INT", "INT", "INT")
    RETURN_NAMES = ("prompt", "negative_prompt", "image", "mask", "seed", "ref_strength", "steps", "width", "height")
    FUNCTION = "emit"
    CATEGORY = "VibeDraw"

    def emit(
        self,
        prompt: str,
        negative_prompt: str,
        seed: int,
        ref_strength: float,
        steps: int,
        width: int,
        height: int,
        image_file: str,
        mask_file: str,
    ) -> tuple[Any, ...]:
        image, image_mask = _load_image(image_file)
        mask = _load_mask(mask_file, image_mask)
        return (
            str(prompt or ""),
            str(negative_prompt or ""),
            image,
            mask,
            int(seed),
            float(ref_strength),
            int(steps),
            int(width),
            int(height),
        )


class VibeDrawOutput(nodes.SaveImage):
    """A named SaveImage node used as the unambiguous final output."""

    CATEGORY = "VibeDraw"
    DESCRIPTION = "Save the final VibeDraw image for API retrieval."


NODE_CLASS_MAPPINGS = {
    "VibeDrawInput": VibeDrawInput,
    "VibeDrawOutput": VibeDrawOutput,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VibeDrawInput": "VibeDraw Input",
    "VibeDrawOutput": "VibeDraw Output",
}
