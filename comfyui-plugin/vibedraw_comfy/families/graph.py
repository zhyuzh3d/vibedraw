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
    """缩到**硬目标框**。``crop: "disabled"`` 意味着源图会被拉伸成这个框的样子。

    img2img 那条路要的就是这个(它必须和采样 latent 对齐), 但**参考图绝不能走这里**:
    参考图一旦被拉进一个比例不同的框里, 定妆照的脸就被压变形了, 而且后面每个环节都
    看不出来 —— 只能按面积缩, 见 ``scale_to_pixels``。
    """
    return {
        "class_type": "ImageScale",
        "inputs": {"image": source, "upscale_method": "lanczos",
                   "width": int(width), "height": int(height), "crop": "disabled"},
    }


def scale_to_pixels(source: list[Any], megapixels: float, step: int = 32) -> dict[str, Any]:
    """按**面积预算**缩放, **保持源图自己的比例**, 再对齐到 ``step``。

    这是参考图唯一正确的缩法: 只吃"约多少百万像素", 比例永远是源图自己的, 所以无论
    用户裁了 9:16 还是丢进来一张 3:4 的老照片, 都不会被拉伸。
    """
    return {
        "class_type": "ImageScaleToTotalPixels",
        "inputs": {"image": source, "upscale_method": "lanczos",
                   "megapixels": float(megapixels), "resolution_steps": int(step)},
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
           "sampler", "scale", "scale_to_pixels", "text_encode", "unet_node", "vae_node"]
