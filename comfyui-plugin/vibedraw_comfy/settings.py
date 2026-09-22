"""Persistent settings for the VibeDraw ComfyUI plugin.

Settings are written by the ``VibeDrawConfig`` node when the user queues it once,
so a user can configure the password and the checkpoints from inside ComfyUI
without editing JSON by hand.  The HTTP layer reads them on every request, so a
change takes effect immediately and never needs a ComfyUI restart.

Resolution order for the password:
    1. ``VIBEDRAW_PASSWORD`` environment variable (keeps secrets out of the graph)
    2. the password stored by the config node
    3. empty -> authentication disabled, and capabilities reports it
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path
from typing import Any

SCHEMA = "vibedraw-comfy-settings/v1"
ENVIRONMENT_PASSWORD = "VIBEDRAW_PASSWORD"
ENVIRONMENT_FILE = "VIBEDRAW_SETTINGS"

TASKS = ("quick", "inpaint", "upscale")

DEFAULTS: dict[str, Any] = {
    "schema": SCHEMA,
    "password": "",
    "checkpoints": {
        "quick": "DreamShaper8_LCM.safetensors",
        "inpaint": "",
        "upscale": "",
    },
    "sampling": {
        "quick": {"sampler": "lcm", "scheduler": "sgm_uniform", "cfg": 2.0},
        "inpaint": {"sampler": "lcm", "scheduler": "sgm_uniform", "cfg": 2.0},
        "upscale": {"sampler": "lcm", "scheduler": "sgm_uniform", "cfg": 2.0},
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


def _merge(base: dict[str, Any], stored: dict[str, Any]) -> dict[str, Any]:
    if isinstance(stored.get("password"), str):
        base["password"] = stored["password"]
    stored_checkpoints = stored.get("checkpoints")
    if isinstance(stored_checkpoints, dict):
        for name in TASKS:
            value = stored_checkpoints.get(name)
            if isinstance(value, str):
                base["checkpoints"][name] = value.strip()
    stored_sampling = stored.get("sampling")
    if isinstance(stored_sampling, dict):
        for name in TASKS:
            entry = stored_sampling.get(name)
            if not isinstance(entry, dict):
                continue
            for key in ("sampler", "scheduler"):
                value = entry.get(key)
                if isinstance(value, str) and value.strip():
                    base["sampling"][name][key] = value.strip()
            value = entry.get("cfg")
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                base["sampling"][name]["cfg"] = float(value)
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
        stored["schema"] = SCHEMA
        destination = path()
        destination.parent.mkdir(parents=True, exist_ok=True)
        temporary = destination.with_suffix(".json.tmp")
        temporary.write_text(json.dumps(stored, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        temporary.replace(destination)
        return _merge(json.loads(json.dumps(DEFAULTS)), stored)


def checkpoint(task: str) -> str:
    settings = load()
    value = str(settings["checkpoints"].get(task) or "").strip()
    if value:
        return value
    return str(settings["checkpoints"].get("quick") or "").strip()
