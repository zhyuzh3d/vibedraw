"""The Qwen-Image 2.1 family: a diffusion model + text encoder + VAE triple.

这是本插件唯一"两种用法"的家族, 而且这个区别来自模型自己:

* **带参考图** —— 参考图与提示词一起进编码器, 再作为 reference latent 拼进序列, 这就是
  参考图编辑。
* **不带参考图** —— 纯文生图。核心节点 ``TextEncodeQwenImage21`` 的 ``images`` 输入
  ``min = 0``, 空着是它明确支持的路径, 所以这里不需要拿一张白图去凑。

采样永远从空 latent 起步、``denoise = 1``(见下面对 ref_strength 的说明)。

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
OPTIONS: tuple[str, ...] = ("cache_device", "cache_dtype", "reference_edge")

#: The Qwen text encoder is loaded through ``CLIPLoader`` with this type.
CLIP_TYPE = "qwen_image"

#: How much a reference may be softened when the strength is turned down.
#: ``ImageBlur`` caps ``blur_radius`` at 31 and ``sigma`` at 10.
FADE_MAX = 0.85
BLUR_RADIUS_MAX = 31
BLUR_SIGMA_MAX = 10.0

#: 参考图送进编码器之前缩到多大。原生引擎管这一项叫 ``reference_resolution``, 语义是
#: "约 edge × edge 像素"的面积预算(保持比例、对齐到 32), 核心节点自己就是这么算的。
#: 这里的默认值取核心节点的默认值(1024)：出厂默认不带部署选择, 哪台机器想省算力就在
#: ``vibedraw_settings.json`` 的 ``families.qwen_image_21.reference_edge`` 里写小一点。
#: **它不影响出图画幅** —— 画幅由能力表的 size 域和客户端选的那个值决定。
REFERENCE_EDGE = 1024
REFERENCE_EDGE_RANGE = (128, 2048)

#: 核心节点 ``TextEncodeQwenImage21`` 把参考图对齐到这个步长(它自己的 step 就是 32)。
#: 我们的预缩也对齐到同一档, 于是它拿到手就是它自己会算的那个尺寸, 不再缩第二次。
REFERENCE_STEP = 32


def clamped_edge(raw: Any, fallback: float = REFERENCE_EDGE) -> int:
    """设置文件里那一项是文本(见 settings.family_options), 所以这里自己收口。

    名字不能叫 ``reference_edge`` —— 那是 ``build`` 的同名参数, 会把这层遮掉。
    """
    low, high = REFERENCE_EDGE_RANGE
    try:
        value = int(float(raw))
    except (TypeError, ValueError):
        value = int(fallback)
    return int(min(max(value, low), high))


def reference_megapixels(edge: int) -> float:
    """「约 edge × edge 像素」换算成**面积预算** —— 核心节点自己就是这么解释 ``resolution`` 的。

    参考图只能按面积缩: 给一个硬目标框(``ImageScale``)就必然要在比例不符时拉伸, 而定妆照
    是 9:16, 用户手上那张老照片可能是 3:4, 两者都不该被压进画幅的比例里 —— 生图画幅已经
    由采样 latent 定死了(见 capabilities 的 size 域), 参考图只管"长什么样"。
    """
    return round(edge * edge / (1024.0 * 1024.0), 4)


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
    reference_edge: Any = REFERENCE_EDGE,
    filename_prefix: str = "vibedraw/vibedraw",
) -> dict[str, Any]:
    """A graph that mirrors the model's own contract rather than pretending it is
    an ordinary checkpoint: ``UNETLoader`` + ``CLIPLoader(type=qwen_image)`` +
    ``VAELoader`` feed the KV-cache wrapper, ``TextEncodeQwenImage21`` turns
    prompt, negative prompt and — when there is one — the reference picture into
    a conditioning pair, and the sampler runs from an empty latent at
    ``denoise = 1``.

    ``image`` 为空就是纯文生图: 不建 LoadImage / ImageScaleToTotalPixels / ImageBlur, 也不给
    节点挂参考图输入。这不是特例分支, 而是这个模型本来就支持的两种用法之一。

    带参考图时先按 ``reference_edge`` 把图缩到"约 edge² 像素"(按面积缩, **保持源图自己的
    比例**), 再把这个 edge 作为 ``resolution`` 交给它 —— 于是它拿到手就不会再缩第二次。
    画幅**不来自参考图**: 它由采样 latent 决定, 参考图只提供"长什么样"。
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
    reference = bool(str(image or "").strip())
    # 参考图永远不会被放大到比画布还大: 那既不会多出细节, 又要多算一遍。
    edge = min(clamped_edge(reference_edge, REFERENCE_EDGE), max(width, height))

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
                # 有参考图时这个数是它被编码到的面积预算; 没有参考图时它只决定节点那个
                # **用不到的**空 latent(我们的采样 latent 来自 "6"), 所以照画幅给。
                "resolution": edge if reference else max(width, height),
                "vae": ["3", 0],
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
    }
    if reference:
        # "10" loads the picture, "11" shrinks it to the reference budget, and "12"
        # is what the encoder actually sees: "11" as it is, or "11" softened by
        # the strength knob.  The soften step must live on its own id — reading
        # "11" and writing "11" is a dependency cycle and ComfyUI rejects the
        # whole prompt with "Dependency cycle detected".
        #
        # "11" 必须是 scale_to_pixels 而**不是** graph.scale: 后者吃硬目标框, 比例不符时
        # 会把定妆照拉变形, 而变形之后从图上完全看不出来(画幅是对的, 脸被拉长了)。
        nodes["5"]["inputs"]["images.image_1"] = ["12", 0] if fade > 0 else ["11", 0]
        nodes["10"] = graph.load_image(image, "VibeDraw reference")
        nodes["11"] = graph.scale_to_pixels(["10", 0], reference_megapixels(edge), REFERENCE_STEP)
        if fade > 0:
            nodes["12"] = _reference_blur(fade)
    return nodes


__all__ = ["CLIP_TYPE", "OPTIONS", "REFERENCE_EDGE", "ROLES", "build", "clamped_edge",
           "reference_fade", "reference_megapixels"]
