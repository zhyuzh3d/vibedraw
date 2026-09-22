"""Nodes for the VibeDraw ComfyUI plugin.

``VibeDrawConfig`` is the one node a user has to touch: it stores the shared
password and the checkpoints used by the three built-in tasks.  Queueing it once
writes ``vibedraw_settings.json`` next to the plugin, so the HTTP API picks the
values up immediately without restarting ComfyUI.

``VibeDrawInput`` / ``VibeDrawOutput`` remain for custom workflows: the plugin
still accepts a full API workflow whose ``VibeDrawInput`` node it patches.
"""

from __future__ import annotations

from typing import Any

import folder_paths
import nodes

from . import settings as settings_module

SAME_AS_QUICK = "(same as quick)"
RECOMMENDED_QUICK = "DreamShaper8_LCM.safetensors"


def _checkpoint_choices() -> list[str]:
    try:
        names = [str(name) for name in folder_paths.get_filename_list("checkpoints")]
    except Exception:
        names = []
    return names


def _choice_list() -> list[str]:
    choices = _checkpoint_choices()
    return [SAME_AS_QUICK] + choices if choices else [SAME_AS_QUICK]


def _quick_default(choices: list[str]) -> str:
    available = [name for name in choices if name != SAME_AS_QUICK]
    if RECOMMENDED_QUICK in available:
        return RECOMMENDED_QUICK
    return available[0] if available else SAME_AS_QUICK


def _resolve(value: str) -> str:
    text = str(value or "").strip()
    return "" if text == SAME_AS_QUICK else text


class VibeDrawConfig:
    """Store the plugin password, the checkpoints, and the translator address."""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        choices = _choice_list()
        stored = settings_module.load()
        translation = settings_module.translate()
        quick_choices = [name for name in choices if name != SAME_AS_QUICK]
        stored_quick = str(stored["checkpoints"].get("quick") or "").strip()
        return {
            "required": {
                "password": ("STRING", {"default": str(stored.get("password") or ""), "multiline": False}),
                "quick_checkpoint": (quick_choices or [SAME_AS_QUICK], {"default": stored_quick or _quick_default(choices)}),
                "inpaint_checkpoint": (choices, {"default": _resolve(stored["checkpoints"].get("inpaint", "")) or SAME_AS_QUICK}),
                "upscale_checkpoint": (choices, {"default": _resolve(stored["checkpoints"].get("upscale", "")) or SAME_AS_QUICK}),
            },
            # Optional so a graph saved before translation existed still loads.
            "optional": {
                "translate_prompts": ("BOOLEAN", {"default": bool(translation["enabled"])}),
                "translator_url": ("STRING", {"default": str(translation["url"] or ""), "multiline": False}),
            },
        }

    RETURN_TYPES = ("STRING",)
    RETURN_NAMES = ("status",)
    FUNCTION = "apply"
    CATEGORY = "VibeDraw"
    DESCRIPTION = (
        "Write the VibeDraw password, checkpoints and translator address. Queue this node once after every change; "
        "leaving the password empty disables authentication and lets anyone on your network draw. "
        "Set the VIBEDRAW_PASSWORD environment variable instead to keep the password out of the graph. "
        "The translator turns Chinese prompts into English, because no checkpoint here reads Chinese; "
        "leave its address empty to switch that off and require English prompts."
    )
    OUTPUT_NODE = True

    def apply(
        self,
        password: str,
        quick_checkpoint: str,
        inpaint_checkpoint: str,
        upscale_checkpoint: str,
        translate_prompts: bool | None = None,
        translator_url: str | None = None,
    ) -> tuple[str]:
        patch: dict[str, Any] = {
            "password": str(password or ""),
            "checkpoints": {
                "quick": str(quick_checkpoint or "").strip(),
                "inpaint": _resolve(inpaint_checkpoint),
                "upscale": _resolve(upscale_checkpoint),
            },
        }
        if translate_prompts is not None or translator_url is not None:
            patch["translate"] = {
                "enabled": True if translate_prompts is None else bool(translate_prompts),
                "url": settings_module.default_translate_url() if translator_url is None else str(translator_url).strip(),
            }
        saved = settings_module.update(**patch)
        environment = settings_module.password()
        if environment:
            protection = "密码来自 VIBEDRAW_PASSWORD 环境变量"
        elif saved["password"]:
            protection = "已启用密码保护"
        else:
            protection = "未设密码，局域网内任何人都可以出图"
        translation = settings_module.translate()
        if translation["enabled"]:
            translating = f"中文自动译英 → {translation['url']}"
        else:
            translating = "翻译已关闭，提示词需为英文"
        return (f"VibeDraw 设置已保存 · 快速 {saved['checkpoints']['quick'] or '未选'} · {translating} · {protection}",)


class VibeDrawInput:
    """Expose the stable VibeDraw semantic inputs to a custom ComfyUI graph."""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "prompt": ("STRING", {"default": "", "multiline": True}),
                "negative_prompt": ("STRING", {"default": "", "multiline": True}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 9007199254740991}),
                "ref_strength": ("FLOAT", {"default": 0.55, "min": 0.0, "max": 2.0, "step": 0.01}),
                "steps": ("INT", {"default": 8, "min": 1, "max": 150}),
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
        import torch
        from pathlib import Path

        import numpy as np
        from PIL import Image

        def empty_image() -> Any:
            return torch.zeros((1, 1, 1, 3), dtype=torch.float32)

        def empty_mask() -> Any:
            return torch.zeros((1, 1, 1), dtype=torch.float32)

        def resolve(name: str):
            if not name:
                return None
            try:
                path = Path(folder_paths.get_annotated_filepath(str(name)))
            except Exception:
                return None
            return path if path.is_file() else None

        image_path = resolve(image_file)
        if image_path is None:
            image, image_mask = empty_image(), empty_mask()
        else:
            try:
                loaded = Image.open(image_path).convert("RGB")
                pixels = np.asarray(loaded, dtype=np.float32) / 255.0
                image = torch.from_numpy(pixels)[None, ...]
                image_mask = torch.zeros((1, loaded.height, loaded.width), dtype=torch.float32)
            except Exception:
                image, image_mask = empty_image(), empty_mask()

        mask_path = resolve(mask_file)
        mask = image_mask
        if mask_path is not None:
            try:
                loaded_mask = Image.open(mask_path).convert("L")
                values = np.asarray(loaded_mask, dtype=np.float32) / 255.0
                mask = torch.from_numpy(values)[None, ...]
            except Exception:
                mask = image_mask

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
    DESCRIPTION = "Save the final VibeDraw image so the plugin can serve it over HTTP."


NODE_CLASS_MAPPINGS = {
    "VibeDrawConfig": VibeDrawConfig,
    "VibeDrawInput": VibeDrawInput,
    "VibeDrawOutput": VibeDrawOutput,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VibeDrawConfig": "VibeDraw 配置 (Config)",
    "VibeDrawInput": "VibeDraw Input",
    "VibeDrawOutput": "VibeDraw Output",
}
