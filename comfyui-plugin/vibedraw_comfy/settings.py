"""Persistent settings for the ComfyUI plugin.

Settings are written by the ``VibeDrawConfig`` node when the user queues it once,
so a user can configure the password and the models from inside ComfyUI without
editing JSON by hand.  The HTTP layer reads them on every request, so a change
takes effect immediately and never needs a ComfyUI restart.

Resolution order for the password:
    1. ``VIBEDRAW_PASSWORD`` environment variable (keeps secrets out of the graph)
    2. the password stored by the config node
    3. empty -> authentication disabled, and the document reports it

Nothing here may carry a default that only fits one machine.  A translation
backend address, a cache dtype chosen for a memory-starved box, a model file name
— all of those are deployment decisions and all of them default to "unset".
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

from . import capabilities

SCHEMA = "vibedraw-comfy-settings/v1"
ENVIRONMENT_PASSWORD = "VIBEDRAW_PASSWORD"
ENVIRONMENT_FILE = "VIBEDRAW_SETTINGS"
ENVIRONMENT_TRANSLATE_URL = "VIBEDRAW_TRANSLATE_URL"
ENVIRONMENT_TRANSLATE_MODEL = "VIBEDRAW_TRANSLATE_MODEL"
ENVIRONMENT_TRANSLATE_DISABLED = "VIBEDRAW_TRANSLATE_DISABLED"

#: Driven by the capability table, so a capability added there is configurable
#: here without a second list to keep in step.
TASKS: tuple[str, ...] = tuple(capabilities.ids())

#: Files a non-checkpoint task needs.  Qwen-Image 2.1 is published as three
#: separate files (diffusion model, text encoder, VAE) instead of one
#: checkpoint, so those tasks name each of them here rather than a checkpoint.
MODEL_ROLES = ("unet", "clip", "vae")

#: The checkpoint the plugin suggests for the realtime capability.  A suggestion,
#: not a requirement — the config node falls back to whatever is installed.
RECOMMENDED_CHECKPOINT = "DreamShaper8_LCM.safetensors"

#: Translation is off until an address is given: there is no default backend, and
#: picking one would hard-code a single deployment into the plugin.  ``enabled``
#: is the operator's intent; the effective switch is also gated on ``url``.
TRANSLATE_TIMEOUT_RANGE = (3.0, 120.0)
TRANSLATE_MEMORY_RANGE = (0, 200000)

#: A capability that was renamed still reads the key an older settings file used.
#: New writes drop the old key, so the file migrates itself on the first save.
RENAMED = {"render": "qwen"}

DEFAULTS: dict[str, Any] = {
    "schema": SCHEMA,
    "password": "",
    "checkpoints": {"quick": RECOMMENDED_CHECKPOINT, "inpaint": "", "upscale": "", "render": ""},
    "models": {"render": {"unet": "", "clip": "", "vae": ""}},
    "sampling": {
        "quick": {"sampler": "lcm", "scheduler": "sgm_uniform", "cfg": 2.0},
        "inpaint": {"sampler": "lcm", "scheduler": "sgm_uniform", "cfg": 2.0},
        "upscale": {"sampler": "lcm", "scheduler": "sgm_uniform", "cfg": 2.0},
        # A flow model sampled without classifier-free guidance (cfg 1.0), which
        # is also why its negative prompt has no effect: at cfg 1 there is
        # nothing to steer away from.
        "render": {"sampler": "euler", "scheduler": "simple", "cfg": 1.0},
    },
    # Per-family knobs that are genuinely deployment tuning rather than contract.
    # ``auto`` / ``default`` are what the model asks for; a box that is short on
    # memory sets ``int8`` here instead of the plugin assuming it.
    "families": {
        "qwen_image_21": {"cache_device": "auto", "cache_dtype": "default"},
    },
    "translate": {
        "enabled": True,
        "url": "",
        "model": "qwen3-0.6b",
        "timeout": 25.0,
        "memory_limit": 4000,
    },
}

_LOCK = threading.RLock()


def path() -> Path:
    override = os.environ.get(ENVIRONMENT_FILE, "").strip()
    if override:
        return Path(override).expanduser()
    return Path(__file__).resolve().parent / "vibedraw_settings.json"


def _read() -> dict[str, Any]:
    try:
        stored = json.loads(path().read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return stored if isinstance(stored, dict) else {}


def _keys(name: str) -> list[str]:
    """Keys to try for one capability, legacy first so the current one wins."""
    legacy = RENAMED.get(name)
    return ([legacy] if legacy else []) + [name]


def _number(value: Any, fallback: float, limits: tuple[float, float]) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    low, high = limits
    return min(max(float(value), low), high)


def _merge(base: dict[str, Any], stored: dict[str, Any]) -> dict[str, Any]:
    if isinstance(stored.get("password"), str):
        base["password"] = stored["password"]

    checkpoints = stored.get("checkpoints")
    if isinstance(checkpoints, dict):
        for name in TASKS:
            for key in _keys(name):
                value = checkpoints.get(key)
                if isinstance(value, str):
                    base["checkpoints"][name] = value.strip()

    models = stored.get("models")
    if isinstance(models, dict):
        for name in TASKS:
            entry = None
            for key in _keys(name):
                candidate = models.get(key)
                if isinstance(candidate, dict):
                    entry = candidate
            if not isinstance(entry, dict):
                continue
            slot = base["models"].setdefault(name, {})
            for role in MODEL_ROLES:
                value = entry.get(role)
                if isinstance(value, str):
                    slot[role] = value.strip()

    sampling = stored.get("sampling")
    if isinstance(sampling, dict):
        for name in TASKS:
            entry = None
            for key in _keys(name):
                candidate = sampling.get(key)
                if isinstance(candidate, dict):
                    entry = candidate
            if not isinstance(entry, dict):
                continue
            for key in ("sampler", "scheduler"):
                value = entry.get(key)
                if isinstance(value, str) and value.strip():
                    base["sampling"][name][key] = value.strip()
            value = entry.get("cfg")
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                base["sampling"][name]["cfg"] = float(value)

    stored_families = stored.get("families")
    if isinstance(stored_families, dict):
        for name, slot in base["families"].items():
            entry = stored_families.get(name)
            if not isinstance(entry, dict):
                continue
            for key in list(slot):
                value = entry.get(key)
                if isinstance(value, str) and value.strip():
                    slot[key] = value.strip()

    translation = stored.get("translate")
    if isinstance(translation, dict):
        value = translation.get("enabled")
        if isinstance(value, bool):
            base["translate"]["enabled"] = value
        for key in ("url", "model"):
            value = translation.get(key)
            if isinstance(value, str):
                base["translate"][key] = value.strip()
        base["translate"]["timeout"] = _number(
            translation.get("timeout"), base["translate"]["timeout"], TRANSLATE_TIMEOUT_RANGE)
        base["translate"]["memory_limit"] = int(_number(
            translation.get("memory_limit"), base["translate"]["memory_limit"], TRANSLATE_MEMORY_RANGE))
    return base


def load() -> dict[str, Any]:
    with _LOCK:
        return _merge(json.loads(json.dumps(DEFAULTS)), _read())


def password() -> str:
    environment = os.environ.get(ENVIRONMENT_PASSWORD, "").strip()
    if environment:
        return environment
    return str(load().get("password") or "").strip()


def authorization_required() -> bool:
    return bool(password())


def _disabled_by_environment() -> bool:
    value = os.environ.get(ENVIRONMENT_TRANSLATE_DISABLED, "").strip().lower()
    return value not in ("", "0", "false", "no", "off")


def translate() -> dict[str, Any]:
    """Where to send a Chinese prompt, after the environment has had its say."""
    stored = load()["translate"]
    url = os.environ.get(ENVIRONMENT_TRANSLATE_URL, "").strip() or str(stored["url"])
    model = os.environ.get(ENVIRONMENT_TRANSLATE_MODEL, "").strip() or str(stored["model"])
    return {
        "enabled": bool(stored["enabled"]) and not _disabled_by_environment() and bool(url.strip()),
        "url": url.strip(),
        "model": model.strip(),
        "timeout": _number(stored["timeout"], 25.0, TRANSLATE_TIMEOUT_RANGE),
        "memory_limit": int(_number(stored["memory_limit"], 4000, TRANSLATE_MEMORY_RANGE)),
    }


def family_options(name: str) -> dict[str, str]:
    """Deployment tuning for one family, as ``{option: value}``."""
    stored = load().get("families") or {}
    entry = stored.get(str(name or "").strip())
    if not isinstance(entry, dict):
        return {}
    return {key: str(value) for key, value in entry.items() if isinstance(value, str) and value}


def update(**fields: Any) -> dict[str, Any]:
    """Merge a partial settings patch into the stored file and return the result."""
    with _LOCK:
        stored = _read()
        if isinstance(fields.get("password"), str):
            stored["password"] = fields["password"]

        checkpoints = fields.get("checkpoints")
        if isinstance(checkpoints, dict):
            target = stored.setdefault("checkpoints", {})
            if not isinstance(target, dict):
                target = stored["checkpoints"] = {}
            for name in TASKS:
                value = checkpoints.get(name)
                if isinstance(value, str):
                    target[name] = value
                if RENAMED.get(name):
                    target.pop(RENAMED[name], None)

        models = fields.get("models")
        if isinstance(models, dict):
            target = stored.setdefault("models", {})
            if not isinstance(target, dict):
                target = stored["models"] = {}
            for name in TASKS:
                entry = models.get(name)
                if not isinstance(entry, dict):
                    continue
                slot = target.setdefault(name, {})
                if not isinstance(slot, dict):
                    slot = target[name] = {}
                for role in MODEL_ROLES:
                    value = entry.get(role)
                    if isinstance(value, str):
                        slot[role] = value.strip()
                if RENAMED.get(name):
                    target.pop(RENAMED[name], None)

        sampling = fields.get("sampling")
        if isinstance(sampling, dict):
            target = stored.setdefault("sampling", {})
            if not isinstance(target, dict):
                target = stored["sampling"] = {}
            for name in TASKS:
                entry = sampling.get(name)
                if not isinstance(entry, dict):
                    continue
                slot = target.setdefault(name, {})
                if not isinstance(slot, dict):
                    slot = target[name] = {}
                slot.update(entry)
                if RENAMED.get(name):
                    target.pop(RENAMED[name], None)

        families = fields.get("families")
        if isinstance(families, dict):
            target = stored.setdefault("families", {})
            if not isinstance(target, dict):
                target = stored["families"] = {}
            for name, entry in families.items():
                if not isinstance(entry, dict):
                    continue
                slot = target.setdefault(str(name), {})
                if not isinstance(slot, dict):
                    slot = target[str(name)] = {}
                for key, value in entry.items():
                    if isinstance(value, str):
                        slot[str(key)] = value.strip()

        translation = fields.get("translate")
        if isinstance(translation, dict):
            target = stored.setdefault("translate", {})
            if not isinstance(target, dict):
                target = stored["translate"] = {}
            value = translation.get("enabled")
            if isinstance(value, bool):
                target["enabled"] = value
            for key in ("url", "model"):
                value = translation.get(key)
                if isinstance(value, str):
                    target[key] = value.strip()
            if "timeout" in translation:
                target["timeout"] = _number(translation["timeout"], 25.0, TRANSLATE_TIMEOUT_RANGE)
            if "memory_limit" in translation:
                target["memory_limit"] = int(_number(
                    translation["memory_limit"], 4000, TRANSLATE_MEMORY_RANGE))

        stored["schema"] = SCHEMA
        destination = path()
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(stored, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(destination)
        return _merge(json.loads(json.dumps(DEFAULTS)), stored)


def checkpoint(task: str) -> str:
    settings = load()
    value = ""
    for key in _keys(task):
        candidate = str(settings["checkpoints"].get(key) or "").strip()
        if candidate:
            value = candidate
    if value:
        return value
    return str(settings["checkpoints"].get("quick") or "").strip()


def model_files(task: str) -> dict[str, str]:
    """The unet / clip / vae triple for a non-checkpoint capability (empty when unset).

    Reads the old key as well, so an installation that was configured under the
    capability's former name keeps working until the config node is queued once
    and rewrites the file.

    No fallback to another capability's files on purpose: mixing a text encoder
    with a different diffusion model is not a configuration the graph can run,
    and silently substituting one would produce a confusing ``no_model`` much
    later instead of right here.
    """
    settings = load()
    stored = settings.get("models") or {}
    entry: dict[str, Any] = {}
    for key in _keys(str(task or "").strip().lower()):
        candidate = stored.get(key)
        if isinstance(candidate, dict):
            entry = candidate
    return {role: str(entry.get(role) or "").strip() for role in MODEL_ROLES}
