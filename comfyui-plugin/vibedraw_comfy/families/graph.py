"""Graph fragments shared by every family.

A family module decides *what* the graph is; these helpers are only the parts
that are identical whichever model sits at the front of it.  Keeping them here
rather than in one family means neither has to import the other.
"""

from __future__ import annotations

from typing import Any


def checkpoint_node(name: str) -> dict[str, Any]:
    return {"class_type": "CheckpointLoaderSimple",
            "inputs": {"ckpt_name": name},
            "_meta": {"title": "VibeDraw checkpoint"}}


def unet_node(name: str) -> dict[str, Any]:
    return {"class_type": "UNETLoader",
            "inputs": {"unet_name": name, "weight_dtype": "default"},
            "_meta": {"title": "VibeDraw diffusion model"}}


def clip_node(name: str, clip_type: str) -> dict[str, Any]:
    return {"class_type": "CLIPLoader",
            "inputs": {"clip_name": name, "type": clip_type},
            "_meta": {"title": "VibeDraw text encoder"}}


def vae_node(name: str) -> dict[str, Any]:
    return {"class_type": "VAELoader",
            "inputs": {"vae_name": name},
            "_meta": {"title": "VibeDraw VAE"}}


def load_image(name: str, title: str) -> dict[str, Any]:
    return {"class_type": "LoadImage", "inputs": {"image": name}, "_meta": {"title": title}}


def scale(source: list[Any], width: int, height: int) -> dict[str, Any]:
    return {
        "class_type": "ImageScale",
        "inputs": {"image": source, "upscale_method": "lanczos",
                   "width": int(width), "height": int(height), "crop": "disabled"},
    }


def latent_upscale(source: list[Any], width: int, height: int) -> dict[str, Any]:
    return {
        "class_type": "LatentUpscale",
        "inputs": {"samples": source, "upscale_method": "bilinear",
                   "width": int(width), "height": int(height), "crop": "disabled"},
    }


def text_encode(text: str, clip: list[Any], title: str) -> dict[str, Any]:
    return {"class_type": "CLIPTextEncode",
            "inputs": {"text": str(text or ""), "clip": clip},
            "_meta": {"title": title}}


def sampler(model: Any, positive: Any, negative: Any, latent: Any, seed: int, steps: int,
            sampling: dict[str, Any], denoise: float) -> dict[str, Any]:
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


def output_node(images: list[Any], filename_prefix: str) -> dict[str, Any]:
    """Node ``"9"`` is always the output node; the HTTP layer validates the
    prompt against exactly that id, so no family may move it."""
    return {"class_type": "VibeDrawOutput",
            "inputs": {"images": images, "filename_prefix": filename_prefix}}


__all__ = ["checkpoint_node", "clip_node", "latent_upscale", "load_image", "output_node",
           "sampler", "scale", "text_encode", "unet_node", "vae_node"]
