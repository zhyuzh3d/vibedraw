"""Turn a prompt a text encoder cannot read into one it can.

Some capabilities run a text encoder that only understands English.  Which ones
is declared per capability (``prompt.language``) and published in the discovery
document, so this module never has to guess.

**This runs inside the submit path.**  A client may translate ahead of time and
show the user the result; a client that does nothing still gets a correct job,
because the server fills the gap.  That is the whole point: a third-party tool
that only knows how to POST a job must not be able to feed Chinese into a model
that cannot read it.

Two things keep it cheap and safe:

* **The memory is keyed by the source text and the target language, and nothing
  else.**  A translation is a fact about two languages — "一只猫在沙发上" means "a
  cat on a sofa" no matter which engine produced it, and the source text already
  says which language it is in.  The engine, the model and the prompt revision
  are recorded *beside* the entry as provenance, never as part of the key, so
  swapping in a better backend still hits, while a future "refresh the whole
  memory with the better engine" sweep can tell which entries came from where.
* **The memory outlives the process.**  It is a file next to the settings, so
  restarting ComfyUI or reinstalling the plugin does not throw it away.

Failures never fail a job and never drop what the user wrote: every error path
returns the original text.
"""

from __future__ import annotations

import hashlib
import json
import re
import threading
import time
from pathlib import Path
from typing import Any, Iterable

import aiohttp

from . import settings as settings_module

MAX_TEXTS = 16
MAX_TEXT_CHARS = 2000
MEMORY_SCHEMA = "cvp-translation-memory/v1"
MEMORY_FILE = "vibedraw_translations.json"
TARGET = "en"

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

#: Used only when the first answer still contains unreadable characters.
RETRY_PROMPT = (
    "Translate the user's text into English. "
    "Answer with English words only, never a Chinese character, never an explanation."
)

#: Identifies the wording above, so an entry can say which revision produced it
#: without that revision taking part in the lookup key.
PROMPT_VERSION = hashlib.sha256((SYSTEM_PROMPT + RETRY_PROMPT).encode("utf-8")).hexdigest()[:12]

_LOCK = threading.RLock()
_MEMORY: dict[str, dict[str, Any]] | None = None


# --------------------------------------------------------------------------- #
# what needs translating
# --------------------------------------------------------------------------- #

def needs_translation(text: Any) -> bool:
    """True when the text carries a character an English-only encoder cannot read.

    Deliberately **not** "contains Chinese": Cyrillic, Greek, Arabic and Thai are
    just as opaque to CLIP-L, and a check that only looked for CJK would pass
    them straight through to come back as noise.  Whitespace is never a trigger,
    so a trailing newline does not buy a round trip.
    """
    return any(not char.isascii() and not char.isspace() for char in str(text or ""))


def enabled() -> bool:
    config = settings_module.translate()
    return bool(config["enabled"] and config["url"])


# --------------------------------------------------------------------------- #
# the translation memory
# --------------------------------------------------------------------------- #

def memory_path() -> Path:
    return settings_module.path().parent / MEMORY_FILE


def _key(source: str, target: str) -> str:
    """The lookup key: target language + source text.  Nothing else."""
    return hashlib.sha256(f"{target}\x00{source}".encode("utf-8")).hexdigest()[:16]


def _read_memory() -> dict[str, dict[str, Any]]:
    try:
        stored = json.loads(memory_path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    entries = stored.get("entries") if isinstance(stored, dict) else None
    if not isinstance(entries, dict):
        return {}
    return {str(key): value for key, value in entries.items() if isinstance(value, dict)}


def _entries() -> dict[str, dict[str, Any]]:
    global _MEMORY
    with _LOCK:
        if _MEMORY is None:
            _MEMORY = _read_memory()
        return _MEMORY


def _flush() -> None:
    """Write the memory out atomically, evicting the oldest past the limit."""
    with _LOCK:
        entries = _entries()
        limit = int((settings_module.translate() or {}).get("memory_limit") or 0)
        if limit and len(entries) > limit:
            order = sorted(entries, key=lambda key: float(entries[key].get("created") or 0))
            for key in order[: len(entries) - limit]:
                entries.pop(key, None)
        payload = {"schema": MEMORY_SCHEMA, "entries": entries}
        destination = memory_path()
        try:
            destination.parent.mkdir(parents=True, exist_ok=True)
            temporary = destination.with_suffix(".json.tmp")
            temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=1) + "\n",
                                 encoding="utf-8")
            temporary.replace(destination)
        except OSError:
            # A memory that cannot be written is still a working memory.
            pass


def recall(source: str, target: str = TARGET) -> str:
    entry = _entries().get(_key(source, target)) or {}
    return str(entry.get("text") or "")


def remember(pairs: Iterable[tuple[str, str, str]]) -> int:
    """Store ``(source, text, engine)`` translations and flush once."""
    config = settings_module.translate()
    now = time.time()
    stored = 0
    with _LOCK:
        entries = _entries()
        for source, text, engine in pairs:
            value = str(text or "").strip()
            if not source or not value:
                continue
            entries[_key(source, TARGET)] = {
                "source": source,
                "target": TARGET,
                "text": value,
                # Provenance, not key material: lets a later sweep tell which
                # entries came from a weaker engine or an older wording.
                "engine": str(engine or ""),
                "prompt_version": PROMPT_VERSION,
                "created": now,
            }
            stored += 1
    if stored:
        _flush()
    return stored


def memory_size() -> int:
    return len(_entries())


# --------------------------------------------------------------------------- #
# answers
# --------------------------------------------------------------------------- #

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


def _strip_unreadable(text: str) -> str:
    """Last resort: keep whatever English came with the leftover characters."""
    value = str(text or "").replace("，", ",").replace("、", ",")
    value = re.sub(r"[^\x00-\x7f]+", " ", value)
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


async def _one(session: aiohttp.ClientSession, config: dict[str, Any], text: str) -> str:
    """One text through the backend, with the retry and salvage ladder."""
    url = _endpoint(config["url"])
    model = str(config["model"] or "")
    answer = _clean(await _ask(session, url, model, SYSTEM_PROMPT, text))
    if answer and not needs_translation(answer):
        return answer
    retry = _clean(await _ask(session, url, model, RETRY_PROMPT, text))
    if retry and not needs_translation(retry):
        return retry
    salvaged = _strip_unreadable(retry or answer)
    if salvaged and not needs_translation(salvaged):
        return salvaged
    return ""


def _entry(source: str, text: str, translated: bool, *, cached: bool = False, reason: str = "") -> dict[str, Any]:
    item: dict[str, Any] = {"source": source, "text": text, "translated": translated, "cached": cached}
    if reason:
        item["reason"] = reason
    return item


def _usable() -> dict[str, Any] | None:
    config = settings_module.translate()
    if not (config["enabled"] and config["url"]):
        return None
    return config


async def _translate_missing(config: dict[str, Any], texts: list[str]) -> dict[str, str]:
    """Translate the texts that are not in the memory; returns ``{source: text}``."""
    answers: dict[str, str] = {}
    timeout = aiohttp.ClientTimeout(total=float(config["timeout"] or 25.0))
    try:
        async with aiohttp.ClientSession(timeout=timeout) as session:
            for source in texts:
                try:
                    answer = await _one(session, config, source)
                except Exception:
                    answer = ""
                if answer:
                    answers[source] = answer
    except Exception:
        pass
    return answers


async def translate(texts: Iterable[Any], target: str = TARGET) -> dict[str, Any]:
    """Translate a batch of prompts; English and failures come back unchanged."""
    sources = [str(item if item is not None else "")[:MAX_TEXT_CHARS] for item in list(texts)[:MAX_TEXTS]]
    config = settings_module.translate()
    usable = bool(config["enabled"] and config["url"])
    results: list[dict[str, Any]] = []
    todo: list[str] = []
    for source in sources:
        if not needs_translation(source):
            results.append(_entry(source, source, False, reason="not_needed"))
            continue
        cached = recall(source)
        if cached:
            results.append(_entry(source, cached, True, cached=True))
            continue
        # Stays as a pass-through unless the batch below turns it into a
        # translation, which is what makes an unreachable backend look like "the
        # text came back unchanged" rather than an error.
        results.append(_entry(source, source, False, reason="" if usable else "unavailable"))
        todo.append(source)

    if todo and usable:
        answers = await _translate_missing(config, todo)
        if answers:
            remember((source, answers[source], str(config["model"] or "")) for source in answers)
        for index, item in enumerate(results):
            answer = answers.get(item["source"])
            if answer and not item["translated"]:
                results[index] = _entry(item["source"], answer, True)

    return {"engine": str(config["model"] or ""), "target": target,
            "available": usable, "results": results}


async def ensure_english(text: Any, target: str = TARGET) -> tuple[str, bool]:
    """The submit-path fallback: ``(text to use, whether it was translated)``.

    Never raises and never returns an empty string for a non-empty input: a
    missing translation must not fail a job, and must never silently drop what
    the user wrote.
    """
    source = str(text or "")[:MAX_TEXT_CHARS]
    if not source or not needs_translation(source):
        return source, False
    config = _usable()
    if config is None:
        return source, False
    cached = recall(source)
    if cached:
        return cached, True
    answer = (await _translate_missing(config, [source])).get(source, "")
    if not answer:
        return source, False
    remember([(source, answer, str(config["model"] or ""))])
    return answer, True


def describe() -> dict[str, Any]:
    """What the discovery document reports; never leaks the internal address."""
    config = settings_module.translate()
    available = bool(config["enabled"] and config["url"])
    return {
        "available": available,
        "mode": "auto-on-submit",
        "target": TARGET,
        "backend": {"style": "openai-chat-completions", "model": str(config["model"] or "")},
        "memory": {"schema": MEMORY_SCHEMA, "entries": memory_size(),
                   "limit": int(config["memory_limit"])},
        "rule": "提示词只含 ASCII 时原样提交, 不发起翻译",
    }


__all__ = ["MAX_TEXTS", "MAX_TEXT_CHARS", "MEMORY_FILE", "MEMORY_SCHEMA", "PROMPT_VERSION",
           "TARGET", "describe", "enabled", "ensure_english", "memory_path", "memory_size",
           "needs_translation", "recall", "remember", "translate"]
