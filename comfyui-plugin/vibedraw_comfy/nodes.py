"""Nodes for the VibeDraw ComfyUI plugin.

``VibeDrawConfig`` is the one node a user has to touch: it stores the shared
password, the checkpoint each capability uses, the three files the ``render``
capability needs (a diffusion model, a text encoder and a VAE), and the address
of the translator.  Queueing it once writes ``vibedraw_settings.json`` next to
the plugin, so the HTTP API picks the values up immediately without restarting
ComfyUI.

The graphs themselves are built by :mod:`vibedraw_comfy.families`, not here:
the HTTP layer is the only entry point, and it always uses those built-in
graphs.  ``VibeDrawInput`` / ``VibeDrawOutput`` are the two node classes those
graphs reference — a reader can put them in a window and see what VibeDraw
hands an ordinary ComfyUI checkpoint — but nothing patches a user-supplied
workflow any more.
"""

from __future__ import annotations

from typing import Any

import folder_paths
import nodes

from . import capabilities as capabilities_module
from . import settings as settings_module

SAME_AS_QUICK = "(same as quick)"

#: Taken from the capability table rather than written out again, so the range
#: the node shows is the range the HTTP layer accepts.
REFERENCE_LOW, REFERENCE_HIGH = capabilities_module.REF_STRENGTH_RANGE
REFERENCE_DEFAULT = float(capabilities_module.CAPABILITIES["quick"]["defaults"]["ref_strength"])


def _checkpoint_choices() -> list[str]:
    return _folder_choices("checkpoints")


def _folder_choices(folder: str) -> list[str]:
    try:
        return [str(name) for name in folder_paths.get_filename_list(folder)]
    except Exception:
        return []


def _choice_list() -> list[str]:
    choices = _checkpoint_choices()
    return [SAME_AS_QUICK] + choices if choices else [SAME_AS_QUICK]


def _quick_default(choices: list[str]) -> str:
    available = [name for name in choices if name != SAME_AS_QUICK]
    recommended = settings_module.RECOMMENDED_CHECKPOINT
    if recommended in available:
        return recommended
    return available[0] if available else SAME_AS_QUICK


def _resolve(value: str) -> str:
    text = str(value or "").strip()
    return "" if text == SAME_AS_QUICK else text


class VibeDrawConfig:
    """Store the plugin password, the checkpoints, the render triple and the translator address."""

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        choices = _choice_list()
        stored = settings_module.load()
        translation = settings_module.translate()
        render = settings_module.model_files("render")
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
            # The render triple lives here for the same reason: it is a second
            # family (a diffusion model, a text encoder and a VAE instead of one
            # checkpoint) and older graphs do not carry those widgets.
            "optional": {
                "translate_prompts": ("BOOLEAN", {"default": bool(translation["enabled"])}),
                "translator_url": ("STRING", {"default": str(translation["url"] or ""), "multiline": False}),
                "qwen_unet": (_folder_choices("diffusion_models") or [""], {"default": str(render.get("unet") or "")}),
                "qwen_text_encoder": (_folder_choices("text_encoders") or [""], {"default": str(render.get("clip") or "")}),
                "qwen_vae": (_folder_choices("vae") or [""], {"default": str(render.get("vae") or "")}),
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
        "The translator turns a prompt a text encoder cannot read into English; it runs when a job is submitted, "
        "so a client that sends Chinese still gets a picture. Leave its address empty to switch it off. "
        "The three model fields below configure 高质量生图 (render), which needs a diffusion model, a text encoder "
        "and a VAE instead of one checkpoint; all three must be set before that capability can run."
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
        qwen_unet: str | None = None,
        qwen_text_encoder: str | None = None,
        qwen_vae: str | None = None,
    ) -> tuple[str]:
        patch: dict[str, Any] = {
            "password": str(password or ""),
            "checkpoints": {
                "quick": str(quick_checkpoint or "").strip(),
                "inpaint": _resolve(inpaint_checkpoint),
                "upscale": _resolve(upscale_checkpoint),
            },
        }
        # Only write the render triple when the node actually carried it: a graph
        # saved before those widgets existed must not blank out a configuration
        # that was written from a settings file.
        if qwen_unet is not None or qwen_text_encoder is not None or qwen_vae is not None:
            patch["models"] = {
                "render": {
                    "unet": str(qwen_unet or "").strip(),
                    "clip": str(qwen_text_encoder or "").strip(),
                    "vae": str(qwen_vae or "").strip(),
                }
            }
        if translate_prompts is not None or translator_url is not None:
            patch["translate"] = {"enabled": True if translate_prompts is None else bool(translate_prompts)}
            # No default address exists on purpose: an older graph without the
            # widget must not overwrite whatever the operator configured, and a
            # fresh install starts with translation switched off rather than
            # pointed at some other machine's port.
            if translator_url is not None:
                patch["translate"]["url"] = str(translator_url).strip()
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
            translating = "翻译已关闭，需要英文提示词的能力将收到原文"
        render_state = settings_module.model_files("render")
        render_text = render_state.get("unet") if all(render_state.values()) else "未选"
        return (f"VibeDraw 设置已保存 · 快速 {saved['checkpoints']['quick'] or '未选'} · 高质量 {render_text} · {translating} · {protection}",)


class VibeDrawInput:
    """The semantic inputs a VibeDraw graph starts from, as an ordinary node.

    The ranges come from the capability table, so what this node shows is what
    the HTTP layer accepts — they used to be written out here as well, and had
    drifted (0–2.0 against a contract of 0.05–0.95).
    """

    @classmethod
    def INPUT_TYPES(cls) -> dict[str, Any]:
        return {
            "required": {
                "prompt": ("STRING", {"default": "", "multiline": True}),
                "negative_prompt": ("STRING", {"default": "", "multiline": True}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 9007199254740991}),
                "ref_strength": ("FLOAT", {"default": REFERENCE_DEFAULT, "min": REFERENCE_LOW,
                                           "max": REFERENCE_HIGH, "step": 0.01}),
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
