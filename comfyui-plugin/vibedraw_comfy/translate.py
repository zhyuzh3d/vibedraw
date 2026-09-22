"""Turn a Chinese prompt into English before it reaches ``CLIPTextEncode``.

Every checkpoint the plugin drives pairs with a text encoder trained on English
(DreamShaper8 LCM carries CLIP-L inside the checkpoint, FLUX.2 Klein pairs with
a Qwen3 text encoder), so Chinese characters arrive at the sampler as noise.
This module is the single place that fixes that.  It is backed by a small local
LLM behind an OpenAI-compatible ``/v1/chat/completions`` endpoint — Qwen3-0.6B
served by ``llama.cpp`` in the reference deployment.

Two rules keep it out of the way:

* a text without a CJK character is returned unchanged and never sent anywhere,
  so an all-English prompt is never reworded and never pays for a round trip;
* every failure returns the original text, because a missing translation must
  not fail a job, and must never silently drop what the user wrote.

The app asks for a translation when a prompt is saved and then submits the same
string on every redraw, so results are cached in process, keyed by source text.
"""

from __future__ import annotations

import re
import threading
from typing import Any, Iterable

import aiohttp

from . import settings as settings_module

MAX_TEXTS = 16
MAX_TEXT_CHARS = 2000
CACHE_LIMIT = 512

CJK = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]")
CJK_RUN = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]+")
THINK_TAIL = re.compile(r"</think>", re.IGNORECASE)
LABEL = re.compile(r"^(?:english|translation|英文)\s*[:：]\s*", re.IGNORECASE)

# A prompt is a bag of visual keywords, not prose, so the examples matter more
# than the instruction: a 0.6B model copies the shape of what it is shown.  The
# explicit "never Chinese" clauses are what stop it from echoing the input back
# on short keyword lists such as a negative prompt.
SYSTEM_PROMPT = (
    "You are a professional translator for image-generation prompts. "
    "Translate the user's text into English, keeping it a comma-separated list of visual keywords. "
    "Output only the English translation, never Chinese characters, no quotes, no notes. "
    "Any Chinese word must become English, even a single word. "
    "Describe a term in English rather than leaving it out.\n"
    "Examples:\n"
    "用户：一只猫在沙发上\nEnglish: a cat on a sofa\n"
    "用户：模糊、变形、水印、多手多脚\nEnglish: blurry, distorted, watermark, extra limbs, malformed hands\n"
    "用户：赛博朋克城市，霓虹灯\nEnglish: cyberpunk city, neon lights\n"
    "用户：把这只猫改成戴墨镜的样子\nEnglish: cat wearing sunglasses\n"
    "用户：水墨画风格，留白\nEnglish: ink wash painting style, negative space"
)

# Used only when the first answer still contains Chinese.
RETRY_PROMPT = (
    "Translate the user's Chinese text into English. "
    "Answer with English words only, never a Chinese character, never an explanation."
)

_CACHE: dict[str, str] = {}
_CACHE_LOCK = threading.RLock()


def has_cjk(text: Any) -> bool:
    """True when the text carries a character the image models cannot read."""
    return bool(CJK.search(str(text or "")))


def enabled() -> bool:
    config = settings_module.translate()
    return bool(config["enabled"] and config["url"])


def describe() -> dict[str, Any]:
    """What ``capabilities`` reports; never leaks the internal address."""
    config = settings_module.translate()
    return {
        "available": bool(config["enabled"] and config["url"]),
        "engine": str(config["model"] or ""),
        "target": "en",
        "rule": "text without CJK characters is passed through untouched",
    }


def _clean(text: Any) -> str:
    value = str(text or "")
    marker = value.rfind("</think>")
    if marker >= 0:
        value = value[marker + len("</think>") :]
    value = value.strip().strip('"').strip("'").strip()
    value = LABEL.sub("", value)
    value = value.lstrip(":：,，、")
    value = value.replace("，", ", ").replace("、", ", ")
    value = re.sub(r"\s+", " ", value)
    value = re.sub(r"\s*,\s*", ", ", value)
    value = re.sub(r"(?:\s*,\s*)+$", "", value)
    return value.strip(" ,")


def _strip_cjk(text: str) -> str:
    """Last resort: keep whatever English came with the leftover Chinese."""
    value = str(text or "").replace("，", ",").replace("、", ",")
    value = CJK_RUN.sub(" ", value)
    value = re.sub(r"\s+", " ", value)
    value = re.sub(r"\s*,\s*", ", ", value)
    value = re.sub(r"(?:\s*,\s*)+", ", ", value)
    return value.strip(" ,")


def _endpoint(url: str) -> str:
    value = str(url or "").strip().rstrip("/")
    if value.endswith("/v1/chat/completions"):
        return value
    if value.endswith("/v1"):
        return value + "/chat/completions"
    return value + "/v1/chat/completions"


def _remember(source: str, value: str) -> None:
    with _CACHE_LOCK:
        if len(_CACHE) >= CACHE_LIMIT:
            for key in list(_CACHE)[: CACHE_LIMIT // 4]:
                _CACHE.pop(key, None)
        _CACHE[source] = value


def _recall(source: str) -> str:
    with _CACHE_LOCK:
        return _CACHE.get(source, "")


async def _ask(session: aiohttp.ClientSession, url: str, model: str, prompt: str, text: str) -> str:
    payload: dict[str, Any] = {
        "messages": [{"role": "system", "content": prompt}, {"role": "user", "content": text}],
        "temperature": 0,
        "max_tokens": 400,
        # llama.cpp keeps the system prompt warm between calls, which is most of
        # the input for a prompt this short.
        "cache_prompt": True,
        # Qwen3 thinks by default, and a 0.6B model leaks that reasoning into the
        # answer.  ``enable_thinking`` false is the switch its own template reads.
        "chat_template_kwargs": {"enable_thinking": False},
    }
    if model:
        payload["model"] = model
    async with session.post(url, json=payload) as response:
        if response.status != 200:
            detail = (await response.text())[:200]
            raise RuntimeError(f"translator answered {response.status}: {detail}")
        body = await response.json(content_type=None)
    choices = body.get("choices") or []
    if not choices:
        raise RuntimeError("translator returned no choice")
    message = choices[0].get("message") if isinstance(choices[0], dict) else None
    return str((message or {}).get("content") or "")


async def _one(session: aiohttp.ClientSession, config: dict[str, Any], text: str) -> str | None:
    url = _endpoint(config["url"])
    model = str(config["model"] or "")
    answer = _clean(await _ask(session, url, model, SYSTEM_PROMPT, text))
    if answer and not has_cjk(answer):
        return answer
    retry = _clean(await _ask(session, url, model, RETRY_PROMPT, text))
    if retry and not has_cjk(retry):
        return retry
    salvaged = _strip_cjk(retry or answer)
    if salvaged and not has_cjk(salvaged):
        return salvaged
    return None


def _entry(source: str, text: str, translated: bool, *, cached: bool = False, reason: str = "") -> dict[str, Any]:
    item: dict[str, Any] = {"source": source, "text": text, "translated": translated, "cached": cached}
    if reason:
        item["reason"] = reason
    return item


async def translate(texts: Iterable[Any], target: str = "en") -> dict[str, Any]:
    """Translate a batch of prompts; English and failures come back unchanged."""
    sources = [str(item if item is not None else "")[:MAX_TEXT_CHARS] for item in list(texts)[:MAX_TEXTS]]
    config = settings_module.translate()
    usable = bool(config["enabled"] and config["url"])
    results: list[dict[str, Any]] = []
    todo: list[str] = []
    for source in sources:
        if not has_cjk(source):
            results.append(_entry(source, source, False, reason="not_needed"))
            continue
        cached = _recall(source)
        if cached:
            results.append(_entry(source, cached, True, cached=True))
            continue
        results.append(_entry(source, source, False, reason="unavailable" if not usable else ""))
        todo.append(source)
    if not todo or not usable:
        return {"engine": str(config["model"] or ""), "target": target, "available": usable, "results": results}

    timeout = aiohttp.ClientTimeout(total=float(config["timeout"] or 25.0))
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            for source in todo:
                try:
                    answer = await _one(session, config, source)
                except Exception:
                    answer = None
                if not answer:
                    continue
                _remember(source, answer)
                for index, item in enumerate(results):
                    if item["source"] == source and not item["translated"]:
                        results[index] = _entry(source, answer, True)
    except Exception:
        pass
    return {"engine": str(config["model"] or ""), "target": target, "available": usable, "results": results}


__all__ = ["MAX_TEXTS", "MAX_TEXT_CHARS", "describe", "enabled", "has_cjk", "translate"]
