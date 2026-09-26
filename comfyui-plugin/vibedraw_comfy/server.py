"""The CVP HTTP API for the VibeDraw ComfyUI plugin.

Three kinds of endpoint, and nothing else:

    GET  /cvp/info                        what this server can do        (public)
    POST /cvp/jobs                        submit one job                 (Bearer)
    GET  /cvp/jobs/{id}                   state, prompt, outputs         (Bearer)
    GET  /cvp/jobs/{id}/progress          state only — the polling call  (Bearer)
    GET  /cvp/jobs/{id}/output/{index}    fetch a finished image         (Bearer)
    POST /cvp/jobs/{id}/cancel            drop a queued job              (Bearer)
    POST /cvp/translate                   pre-translate a prompt         (Bearer)

``/cvp/info`` is the one a client calls first, and it answers with the whole
contract — the capabilities, the request schema they share, which model backs
each one and whether it is installed, and whether the password that arrived was
the right one.  It answers even when the password is wrong on purpose: knowing
*what* a server can do should not require having already configured it, and one
call then tells a client both "the address is right" and "the password is not".
The contract itself is defined in ``plans/cvp-spec.md``; the table it is built
from lives in :mod:`vibedraw_comfy.capabilities`.

The paths never carry a version.  The protocol version travels in the document
as ``spec``, so a client never has to guess a newer path, and a server may add
capabilities and fields without breaking one that is already shipped: a client
is required to ignore what it does not know.

Authentication
--------------
The password set in the ``VibeDrawConfig`` node (or the ``VIBEDRAW_PASSWORD``
environment variable) protects every job endpoint.  It is sent as
``Authorization: Bearer <password>``.  A wrong password answers ``401
unauthorized`` and nothing is queued.  Leaving it empty disables the check and
``/cvp/info`` says so through ``auth.required``.

Images are uploaded inline as base64 in the job body and are written into
``input/vibedraw/`` before the graph runs, so a built-in graph can reference
them through the ordinary ``LoadImage`` node.

Translation
-----------
A capability whose text encoder only reads English declares
``prompt.language: "en"``.  When such a job arrives with a prompt that is not
pure ASCII, the server translates it itself — memory first, backend second, and
the original text if both fail — so a client that knows nothing but how to POST
a job cannot feed a model something it cannot read.  A client may translate
earlier and show the user the result; that is a recommendation, not a rule.
Every answer says which of the two happened through ``prompt`` /
``prompt_source`` / ``translated``.

Legacy paths
------------
``/vibedraw/v1/*`` is what shipped clients and PoseGi already call.  Those
routes keep answering **their old document shapes** (see :mod:`vibedraw_comfy.
legacy`) and share the job handlers with the new ones, so nothing that works
today stops working.  Nothing new should call them.
"""

from __future__ import annotations

import base64
import binascii
import hmac
import inspect
import json
import os
import threading
import time
import uuid
from pathlib import Path
from typing import Any

import folder_paths
from aiohttp import web

from . import capabilities as capabilities_module
from . import families
from . import legacy
from . import settings as settings_module
from . import translate as translate_module
from .version import __version__

API_ROOT = capabilities_module.API_ROOT
LEGACY_ROOT = capabilities_module.LEGACY_ROOT
INPUT_SUBFOLDER = "vibedraw"
CLIENT_ID = "vibedraw"

MAX_BODY_BYTES = 32 * 1024 * 1024
MAX_TRACKED_JOBS = 256
MAX_PENDING_JOBS = 8

AUTH_HINT = "密码在 ComfyUI 的 VibeDraw 配置节点里设置。"

ERROR_STATUS = {
    "unauthorized": 401,
    "bad_request": 400,
    "unsupported_capability": 400,
    "unsupported_task": 400,
    "unsupported_size": 400,
    "unsupported_steps": 400,
    "bad_image": 400,
    "bad_mask": 400,
    "invalid_workflow": 400,
    "no_model": 409,
    "busy": 429,
    "not_found": 404,
    "internal": 500,
}

ERROR_MESSAGES = {
    "unauthorized": "访问密码不正确，请在 ComfyUI 的 VibeDraw 配置节点里核对密码。",
    "bad_request": "请求体不是合法 JSON。",
    "unsupported_capability": "不认识这个能力，请从信息接口的 capabilities 里取 id。",
    "unsupported_task": "不支持的任务，请使用 quick / inpaint / upscale / render。",
    "unsupported_size": "该能力不支持这个画幅尺寸。",
    "unsupported_steps": "该能力不支持这个步数。",
    "bad_image": "参考图不是合法的 base64 PNG/JPEG。",
    "bad_mask": "局部重绘必须提供蒙版图。",
    "invalid_workflow": "内置工作流校验失败，可能是模型或节点缺失。",
    "no_model": "没有可用的模型，请先在 VibeDraw 配置节点里选好这一能力要用的模型。",
    "busy": "队列已满，请稍后再试。",
    "not_found": "找不到这个任务。",
    "internal": "服务器内部错误。",
}

#: Enough to name the media type of an output without trusting a header.
MEDIA_TYPES = {
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}

_JOBS: dict[str, dict[str, Any]] = {}
_JOBS_LOCK = threading.RLock()


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #

def _prompt_server():
    try:
        from server import PromptServer
    except Exception:
        return None
    return getattr(PromptServer, "instance", None)


def _json(payload: Any, status: int = 200) -> web.Response:
    return web.json_response(payload, status=status, dumps=lambda value: json.dumps(value, ensure_ascii=False))


def _fail(code: str, message: str = "", *, status: int | None = None, detail: Any = None) -> web.Response:
    payload: dict[str, Any] = {"error": code, "message": message or ERROR_MESSAGES.get(code, code)}
    if detail is not None:
        payload["detail"] = detail
    return _json(payload, status or ERROR_STATUS.get(code, 400))


def _password() -> str:
    try:
        return settings_module.password()
    except Exception:
        return ""


def _token_of(request: web.Request) -> str:
    header = str(request.headers.get("Authorization") or "").strip()
    lowered = header.lower()
    if lowered.startswith("bearer "):
        return header[7:].strip()
    if lowered.startswith("basic "):
        try:
            decoded = base64.b64decode(header[6:].strip()).decode("utf-8", "replace")
            return decoded.split(":", 1)[-1].strip()
        except (binascii.Error, ValueError):
            return ""
    return str(request.headers.get("X-VibeDraw-Password") or "").strip()


def _authorized(request: web.Request) -> bool:
    expected = _password()
    if not expected:
        return True
    return hmac.compare_digest(_token_of(request), expected)


def _is_legacy(request: web.Request) -> bool:
    """Which of the two path families answered this request.

    The handlers are shared, so the *shape* of the answer is decided here: a
    client that calls the old path gets the old body, and the two never mix.
    """
    return str(request.path or "").startswith(LEGACY_ROOT)


def _who(legacy_request: bool, capability: str) -> dict[str, Any]:
    """How the two path families name a capability in ``detail``."""
    return {"task": capability} if legacy_request else {"capability": capability}


# --------------------------------------------------------------------------- #
# models
# --------------------------------------------------------------------------- #

def _available_files(folder: str) -> list[str]:
    try:
        return [str(item) for item in folder_paths.get_filename_list(folder)]
    except Exception:
        return []


def _available_map() -> dict[str, list[str]]:
    """Every model folder a capability can draw from, so a client can see the choices."""
    return {role: _available_files(folder) for role, folder in capabilities_module.ROLE_FOLDERS.items()}


def _checkpoint(capability: str) -> str:
    try:
        return settings_module.checkpoint(capability)
    except Exception:
        return ""


def _model_files(capability: str) -> dict[str, str]:
    try:
        return settings_module.model_files(capability)
    except Exception:
        return {}


def _models_of(capability: dict[str, Any]) -> list[dict[str, Any]]:
    """The implementation mount point of one capability, as the document reports it.

    One entry per role the family needs, and each one says whether that *file*
    is actually installed — the same judgement :func:`create_job` makes before
    queueing, so a client that configures itself from this document can never be
    surprised by ``no_model`` at submit time.

    An unreadable folder list (ComfyUI not fully started) is treated as "cannot
    judge", not as "missing": refusing to submit then would be wrong.
    """
    roles = list(capability.get("roles") or [])
    if "checkpoint" in roles:
        name = _checkpoint(capability["id"])
        available = _available_files("checkpoints")
        ready = bool(name) and (not available or name in available)
        return [{"role": "checkpoint", "name": name, "ready": ready,
                 "missing": [] if ready else ["checkpoint"]}]

    files = _model_files(capability["id"])
    entries: list[dict[str, Any]] = []
    for role in roles:
        name = str(files.get(role) or "").strip()
        available = _available_files(capabilities_module.ROLE_FOLDERS.get(role, ""))
        ready = bool(name) and (not available or name in available)
        entries.append({"role": role, "name": name, "ready": ready,
                        "missing": [] if ready else [role]})
    return entries


def _models_of_id(capability_id: str) -> list[dict[str, Any]]:
    return _models_of(capabilities_module.spec_of(capability_id))


# --------------------------------------------------------------------------- #
# request body
# --------------------------------------------------------------------------- #

def _body_size(bytes_count: int) -> None:
    if bytes_count > MAX_BODY_BYTES:
        raise ValueError("bad_request")


def _decode_image(payload: Any, code: str) -> bytes:
    text = str(payload or "").strip()
    if not text:
        raise ValueError(code)
    if text[:5].lower() == "data:" and "," in text[:96]:
        text = text.split(",", 1)[1]
    try:
        raw = base64.b64decode(text, validate=True)
    except (binascii.Error, ValueError):
        raise ValueError(code) from None
    if not raw:
        raise ValueError(code)
    _body_size(len(raw))
    return raw


def _extension(raw: bytes) -> str:
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        return ".png"
    if raw[:2] == b"\xff\xd8":
        return ".jpg"
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return ".webp"
    return ".png"


def _store_image(payload: Any, code: str) -> str:
    raw = _decode_image(payload, code)
    name = f"{int(time.time() * 1000)}_{uuid.uuid4().hex[:10]}{_extension(raw)}"
    directory = Path(folder_paths.get_input_directory()) / INPUT_SUBFOLDER
    directory.mkdir(parents=True, exist_ok=True)
    (directory / name).write_bytes(raw)
    return f"{INPUT_SUBFOLDER}/{name}"


def _size_of(value: Any) -> list[int] | None:
    if isinstance(value, (list, tuple)) and len(value) >= 2:
        try:
            return [int(value[0]), int(value[1])]
        except (TypeError, ValueError):
            return None
    if isinstance(value, dict):
        try:
            return [int(value.get("width", 0)), int(value.get("height", 0))]
        except (TypeError, ValueError):
            return None
    return None


def _number_of(value: Any, fallback: Any = None) -> Any:
    if value is None:
        return fallback
    if isinstance(value, bool):
        return fallback
    if isinstance(value, (int, float)):
        return value
    try:
        return float(str(value).strip())
    except (TypeError, ValueError):
        return fallback


def _provided(value: Any) -> bool:
    """Did the client actually send this field, rather than spell out an empty one?"""
    return value not in (None, "", [], {})


def _sent(body: dict[str, Any], *names: str) -> bool:
    return any(_provided(body.get(name)) for name in names)


# --------------------------------------------------------------------------- #
# job bookkeeping
# --------------------------------------------------------------------------- #

def _track(job: dict[str, Any]) -> None:
    with _JOBS_LOCK:
        _JOBS[job["id"]] = job
        if len(_JOBS) > MAX_TRACKED_JOBS:
            for key in sorted(_JOBS, key=lambda item: float(_JOBS[item]["created"]))[: len(_JOBS) - MAX_TRACKED_JOBS]:
                _JOBS.pop(key, None)


def _tracked(job_id: str) -> dict[str, Any] | None:
    with _JOBS_LOCK:
        return _JOBS.get(job_id)


def _queue_snapshot() -> tuple[list[str], list[str]]:
    server = _prompt_server()
    queue = getattr(server, "prompt_queue", None) if server is not None else None
    if queue is None:
        return [], []
    try:
        running, pending = queue.get_current_queue()
    except Exception:
        return [], []
    return [_item_id(item) for item in running], [_item_id(item) for item in pending]


def _item_id(item: Any) -> str:
    try:
        return str(item[1])
    except (TypeError, IndexError, KeyError):
        return ""


def _history_entry(prompt_id: str) -> dict[str, Any] | None:
    server = _prompt_server()
    queue = getattr(server, "prompt_queue", None) if server is not None else None
    if queue is None:
        return None
    try:
        found = queue.get_history(prompt_id=prompt_id)
    except Exception:
        return None
    if isinstance(found, dict):
        entry = found.get(prompt_id)
        if isinstance(entry, dict):
            return entry
        if found and isinstance(next(iter(found.values())), dict):
            return next(iter(found.values()))
    return None


def _status_of(entry: dict[str, Any] | None) -> str:
    if not isinstance(entry, dict):
        return ""
    status = entry.get("status")
    if not isinstance(status, dict):
        return ""
    return str(status.get("status_str") or "")


def _error_of(entry: dict[str, Any] | None) -> str:
    if not isinstance(entry, dict):
        return ""
    status = entry.get("status")
    messages = status.get("messages") if isinstance(status, dict) else None
    for entry_message in messages or []:
        if isinstance(entry_message, (list, tuple)) and len(entry_message) >= 2 and entry_message[0] == "execution_error":
            data = entry_message[1] if isinstance(entry_message[1], dict) else {}
            detail = str(data.get("exception_message") or data.get("exception_type") or "").strip()
            node = str(data.get("node_type") or "").strip()
            return f"{node}: {detail}".strip(": ") if node or detail else "execution_error"
    return ""


def _outputs_of(prompt_id: str, entry: dict[str, Any] | None, root: str) -> list[dict[str, Any]]:
    """Finished images, as absolute paths under ``root`` — a client must not re-join a base."""
    if not isinstance(entry, dict):
        return []
    outputs = entry.get("outputs")
    if not isinstance(outputs, dict):
        return []
    files: list[dict[str, Any]] = []
    for node_output in outputs.values():
        if not isinstance(node_output, dict):
            continue
        for image in node_output.get("images") or []:
            if not isinstance(image, dict):
                continue
            filename = str(image.get("filename") or "").strip()
            if not filename:
                continue
            suffix = Path(filename).suffix.lower()
            files.append(
                {
                    "index": len(files),
                    "filename": filename,
                    "subfolder": str(image.get("subfolder") or ""),
                    "type": str(image.get("type") or "output"),
                    "media_type": MEDIA_TYPES.get(suffix, "image/png"),
                    "url": f"{root}/jobs/{prompt_id}/output/{len(files)}",
                }
            )
    return files


def _state_of(job: dict[str, Any], running: list[str], pending: list[str], entry: dict[str, Any] | None) -> str:
    if job.get("cancelled"):
        return "cancelled"
    outcome = _status_of(entry)
    if outcome == "success":
        return "completed"
    if outcome:
        return "failed"
    if entry is not None:
        return "completed"
    job_id = job["id"]
    if job_id in running:
        return "running"
    if job_id in pending:
        return "queued"
    return "unknown"


def _queue_position(job_id: str, running: list[str], pending: list[str]) -> int | None:
    """How many jobs are ahead of this one; ``0`` while it is the one running.

    Unlike a percentage, this is a number every implementation can actually
    compute, which is why the progress endpoint reports it and not an estimate.
    """
    if job_id in running:
        return 0
    if job_id in pending:
        return pending.index(job_id)
    return None


def _legacy_progress(job: dict[str, Any], state: str) -> float | None:
    """The old fabricated percentage, kept only for the old paths.

    Derived from the capability's typical duration rather than measured, so it
    is a guess — the CVP paths report ``null`` instead of making one up.
    """
    if state == "completed":
        return 1.0
    if state in ("failed", "cancelled"):
        return 0.0
    if state not in ("queued", "running"):
        return None
    expected = max(float(job.get("typical_seconds") or 1.0), 0.4)
    elapsed = max(0.0, time.time() - float(job.get("created") or time.time()))
    if state == "queued":
        return round(min(0.05, elapsed / expected * 0.05), 4)
    return round(min(0.95, elapsed / expected), 4)


def _describe(job: dict[str, Any], running: list[str], pending: list[str],
              entry: dict[str, Any] | None, *, legacy_request: bool = False) -> dict[str, Any]:
    state = _state_of(job, running, pending, entry)
    job_id = str(job["id"])
    root = LEGACY_ROOT if legacy_request else API_ROOT
    outputs = _outputs_of(job_id, entry, root)

    if legacy_request:
        payload: dict[str, Any] = {
            "id": job_id,
            "task": str(job.get("requested") or job.get("capability") or ""),
            "state": state,
            "progress": _legacy_progress(job, state),
            "created": job.get("created"),
            "estimated_seconds": job.get("typical_seconds"),
            "outputs": [{key: item[key] for key in ("filename", "subfolder", "type", "url")} for item in outputs],
        }
    else:
        payload = {
            "id": job_id,
            "capability": str(job.get("capability") or ""),
            "state": state,
            "queue_position": _queue_position(job_id, running, pending),
            # Never a fabricated number: the CVP contract allows null.
            "progress": None,
            "created": job.get("created"),
            "typical_seconds": job.get("typical_seconds"),
            "prompt": str(job.get("prompt") or ""),
            "prompt_source": str(job.get("prompt_source") or ""),
            "translated": bool(job.get("translated")),
            "ignored": list(job.get("ignored") or []),
            "outputs": outputs,
        }
    if state == "failed":
        payload["error"] = _error_of(entry) or "execution_error"
    return payload


def _progress_payload(job_id: str, job: dict[str, Any] | None, entry: dict[str, Any] | None,
                      running: list[str], pending: list[str]) -> dict[str, Any]:
    """The light polling answer: state and position, never output parsing."""
    state = "unknown"
    if job is not None:
        state = _state_of(job, running, pending, entry)
    elif entry is not None:
        state = "completed" if not _status_of(entry) or _status_of(entry) == "success" else "failed"
    elif job_id in running:
        state = "running"
    elif job_id in pending:
        state = "queued"
    return {"id": job_id, "state": state,
            "queue_position": _queue_position(job_id, running, pending),
            "progress": None}


def _safe_output_path(kind: str, subfolder: str, filename: str) -> Path | None:
    roots = {
        "output": getattr(folder_paths, "get_output_directory", None),
        "temp": getattr(folder_paths, "get_temp_directory", None),
        "input": getattr(folder_paths, "get_input_directory", None),
    }
    getter = roots.get(kind) or roots["output"]
    if getter is None:
        return None
    try:
        root = Path(getter()).resolve()
    except Exception:
        return None
    parts = [part for part in str(subfolder or "").replace("\\", "/").split("/") if part not in ("", ".")]
    if any(part == ".." for part in parts):
        return None
    candidate = root.joinpath(*parts, str(filename or "").strip()).resolve()
    try:
        if os.path.commonpath([str(root), str(candidate)]) != str(root):
            return None
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


async def _drop_pending(job_id: str) -> bool:
    server = _prompt_server()
    queue = getattr(server, "prompt_queue", None) if server is not None else None
    if queue is None:
        return False
    remover = getattr(queue, "delete_queue_item", None)
    if not callable(remover):
        return False
    try:
        return bool(await _maybe_await(remover(lambda item: _item_id(item) == job_id)))
    except Exception:
        return False


async def _interrupt_running() -> bool:
    server = _prompt_server()
    queue = getattr(server, "prompt_queue", None) if server is not None else None
    for owner in (queue, server):
        if owner is None:
            continue
        for name in ("interrupt_current_processing", "interrupt_processing"):
            action = getattr(owner, name, None)
            if not callable(action):
                continue
            try:
                await _maybe_await(action())
                return True
            except Exception:
                continue
    return False


# --------------------------------------------------------------------------- #
# information
# --------------------------------------------------------------------------- #

async def info(request: web.Request) -> web.Response:
    """``GET /cvp/info`` — the whole contract, and deliberately public.

    A wrong password is not an error here: ``auth.authorized`` says which it was,
    which is what lets one call answer "is the address right" and "is the
    password right" at the same time.
    """
    return _json(
        capabilities_module.document(
            resolve=_models_of_id,
            authorized=_authorized(request),
            auth_required=bool(_password()),
            translation=translate_module.describe(),
            available=_available_map(),
            auth_hint=AUTH_HINT,
        )
    )


async def legacy_plugins(request: web.Request) -> web.Response:
    """The old discovery document, projected from the capability table."""
    return _json(
        legacy.plugins_document(
            resolve=_models_of,
            authorized=_authorized(request),
            auth_required=bool(_password()),
            translation=translate_module.describe(),
            checkpoints=_available_files("checkpoints"),
            auth_hint=AUTH_HINT,
        )
    )


async def legacy_capabilities(request: web.Request) -> web.Response:
    """The old capability document, projected from the same table."""
    return _json(
        legacy.capabilities_document(
            resolve=_models_of,
            authorized=_authorized(request),
            auth_required=bool(_password()),
            translation=translate_module.describe(),
            checkpoints=_available_files("checkpoints"),
            limits={"max_body_bytes": MAX_BODY_BYTES, "max_pending_jobs": MAX_PENDING_JOBS},
        )
    )


# --------------------------------------------------------------------------- #
# jobs
# --------------------------------------------------------------------------- #

def _no_model(capability: str, legacy_request: bool, models: list[dict[str, Any]],
              folder: str, name: str) -> web.Response:
    """The one ``no_model`` answer, from the one place that decides it."""
    if folder:
        return _fail("no_model", message=f"模型 {name} 不在 ComfyUI 的 {folder} 目录里。",
                     detail={**_who(legacy_request, capability), "role": folder, "available": _available_files(folder)})
    missing = [item["role"] for item in models if not item.get("ready")]
    return _fail("no_model",
                 detail={**_who(legacy_request, capability), "missing": missing,
                         "models": {item["role"]: item["name"] for item in models}})


def _resolve_models(capability: dict[str, Any], legacy_request: bool) -> tuple[dict[str, str], web.Response | None]:
    """The files this capability will run on, or the error to answer with.

    Checkpoint capabilities fall back to the ``quick`` checkpoint when their own
    slot is empty — that is what ``settings.checkpoint()`` does and therefore
    what the graph would use, so a job submitted against the fallback is not
    refused here.
    """
    if "checkpoint" in (capability.get("roles") or []):
        name = _checkpoint(capability["id"])
        if not name:
            return {}, _fail("no_model", detail={**_who(legacy_request, capability["id"]),
                                                 "checkpoints": _available_files("checkpoints")})
        available = _available_files("checkpoints")
        if available and name not in available:
            return {}, _no_model(capability["id"], legacy_request, [], "checkpoints", name)
        return {"checkpoint": name}, None

    files = {role: str(_model_files(capability["id"]).get(role) or "").strip()
             for role in capability.get("roles") or []}
    for role in capability.get("roles") or []:
        name = files[role]
        folder = capabilities_module.ROLE_FOLDERS.get(role, "")
        if not name:
            return {}, _fail("no_model", detail={**_who(legacy_request, capability["id"]),
                                                 "missing": role, "models": files})
        available = _available_files(folder)
        if available and name not in available:
            return {}, _no_model(capability["id"], legacy_request, [], folder, name)
    return files, None


async def create_job(request: web.Request) -> web.Response:
    legacy_request = _is_legacy(request)
    if not _authorized(request):
        return _fail("unauthorized")

    try:
        body = await request.json()
    except Exception:
        return _fail("bad_request")
    if not isinstance(body, dict):
        return _fail("bad_request")

    # ``capability`` is the CVP name and wins; ``task`` is what older clients
    # still send, and what the old paths keep answering with.
    requested = str(body.get("capability") or body.get("task") or "").strip().lower()
    capability = capabilities_module.find(requested)
    if capability is None:
        if legacy_request:
            return _fail("unsupported_task", detail={"task": requested})
        return _fail("unsupported_capability", detail={"capability": requested})
    name = str(capability["id"])

    size = _size_of(body.get("size"))
    steps_value = _number_of(body.get("steps"))
    try:
        chosen_size, chosen_steps = capabilities_module.validate_values(
            capability, size, int(steps_value) if steps_value is not None else None)
    except ValueError as error:
        code = str(error)
        return _fail(code if code in ERROR_STATUS else "bad_request",
                     detail={"size": size, "steps": steps_value})

    seed_value = _number_of(body.get("seed"), 0)
    seed = int(seed_value or 0)
    if seed < 0:
        return _fail("bad_request", "seed 不能是负数。", detail={"seed": seed_value})

    needs = capability.get("needs") or {}
    if needs.get("mask") and not _sent(body, "mask_base64", "mask"):
        return _fail("bad_mask")
    if needs.get("image") and not _sent(body, "image_base64", "image"):
        return _fail("bad_image")

    models, refused = _resolve_models(capability, legacy_request)
    if refused is not None:
        return refused

    running, pending = _queue_snapshot()
    if len(pending) >= MAX_PENDING_JOBS:
        return _fail("busy", detail={"pending": len(pending)})

    try:
        image_name = _store_image(body.get("image_base64") or body.get("image"), "bad_image")
        mask_name = ""
        if needs.get("mask"):
            mask_name = _store_image(body.get("mask_base64") or body.get("mask"), "bad_mask")
    except ValueError as error:
        return _fail(str(error))

    # A field the capability declares it ignores is not passed on, and is
    # reported back so the client can tell the user instead of pretending it
    # took effect.  Only fields the request actually carried are listed.
    ignored = [field for field in capability.get("ignores") or [] if _provided(body.get(field))]

    prompt_source = str(body.get("prompt") or "")
    prompt_used, translated = prompt_source, False
    if needs.get("prompt") and str((capability.get("prompt") or {}).get("language") or "") == "en":
        prompt_used, translated = await translate_module.ensure_english(prompt_source)
    if "negative_prompt" in ignored:
        negative_prompt = ""
    else:
        negative_prompt = str(body.get("negative_prompt") or "")

    settings = settings_module.load()
    sampling = settings["sampling"].get(name) or {}
    ref_strength = capabilities_module.clamp_ref_strength(
        body.get("ref_strength"), float(capability["defaults"]["ref_strength"]))
    grow_value = _number_of(body.get("grow_mask_by"), None)
    low, high = capabilities_module.GROW_MASK_RANGE
    grow_mask_by = None if grow_value is None else int(min(max(int(grow_value), low), high))

    try:
        graph = families.build(
            spec=capability,
            models=models,
            sampling=sampling,
            image=image_name,
            mask=mask_name,
            prompt=prompt_used,
            negative_prompt=negative_prompt,
            seed=seed,
            steps=chosen_steps,
            size=chosen_size,
            ref_strength=ref_strength,
            grow_mask_by=grow_mask_by,
            options=settings_module.family_options(str(capability.get("family") or "")),
            filename_prefix=f"vibedraw/{name}",
        )
    except ValueError as error:
        code = str(error)
        return _fail(code if code in ERROR_STATUS else "bad_request")
    except Exception:
        return _fail("internal", "内置工作流生成失败。")

    server = _prompt_server()
    if server is None:
        return _fail("internal", "ComfyUI 服务未就绪。")

    prompt_id = str(uuid.uuid4())
    try:
        import execution

        valid = await execution.validate_prompt(prompt_id, graph, ["9"])
    except Exception:
        return _fail("internal", "工作流校验无法执行。")

    if not valid or not valid[0]:
        reasons = valid[1] if valid and len(valid) > 1 else ""
        node_errors = valid[3] if valid and len(valid) > 3 else None
        text = reasons if isinstance(reasons, str) else json.dumps(reasons, ensure_ascii=False)
        return _fail("invalid_workflow", text or ERROR_MESSAGES["invalid_workflow"], detail={"node_errors": node_errors})

    outputs_to_execute = valid[2]
    queue = getattr(server, "prompt_queue", None)
    if queue is None:
        return _fail("internal", "ComfyUI 队列不可用。")

    try:
        number = int(getattr(server, "number", 0))
        server.number = number + 1
    except Exception:
        number = 0
    extra_data = {"client_id": CLIENT_ID, "create_time": int(time.time() * 1000)}
    try:
        queue.put((number, prompt_id, graph, extra_data, outputs_to_execute, {}))
    except Exception:
        return _fail("internal", "任务入队失败。")

    job = {
        "id": prompt_id,
        "capability": name,
        # What the client actually asked for, so an old client polling a job it
        # submitted as "qwen" still reads back "qwen".
        "requested": requested or name,
        "created": time.time(),
        "typical_seconds": capability.get("typical_seconds"),
        "size": chosen_size,
        "steps": chosen_steps,
        "ref_strength": ref_strength,
        "prompt": prompt_used,
        "prompt_source": prompt_source,
        "translated": translated,
        "ignored": ignored,
        "cancelled": False,
    }
    _track(job)
    return _json({"job": _describe(job, running, pending + [prompt_id], None, legacy_request=legacy_request)}, status=202)


async def job_status(request: web.Request) -> web.Response:
    legacy_request = _is_legacy(request)
    if not _authorized(request):
        return _fail("unauthorized")
    job_id = str(request.match_info.get("job_id") or "").strip()
    job = _tracked(job_id)
    entry = _history_entry(job_id)
    if job is None:
        if entry is None:
            return _fail("not_found")
        job = {"id": job_id, "capability": "", "requested": "", "created": time.time(), "cancelled": False}
    running, pending = _queue_snapshot()
    return _json({"job": _describe(job, running, pending, entry, legacy_request=legacy_request)})


async def job_progress(request: web.Request) -> web.Response:
    """``GET /cvp/jobs/{id}/progress`` — what a client polls while it waits.

    Returns state and queue position only.  It reads the history entry because
    that is the only way to know whether a job that left the queue succeeded,
    but it never walks the outputs, which is the expensive half of the full
    status call.  ``progress`` is ``null``: the contract allows it, and inventing
    a number would be worse than admitting there is none.
    """
    if not _authorized(request):
        return _fail("unauthorized")
    job_id = str(request.match_info.get("job_id") or "").strip()
    job = _tracked(job_id)
    entry = _history_entry(job_id)
    running, pending = _queue_snapshot()
    if job is None and entry is None and job_id not in running and job_id not in pending:
        return _fail("not_found")
    return _json({"job": _progress_payload(job_id, job, entry, running, pending)})


async def job_output(request: web.Request) -> web.Response:
    if not _authorized(request):
        return _fail("unauthorized")
    job_id = str(request.match_info.get("job_id") or "").strip()
    try:
        index = int(str(request.match_info.get("index") or "0"))
    except (TypeError, ValueError):
        return _fail("bad_request")
    files = _outputs_of(job_id, _history_entry(job_id), LEGACY_ROOT if _is_legacy(request) else API_ROOT)
    if index < 0 or index >= len(files):
        return _fail("not_found")
    chosen = files[index]
    path = _safe_output_path(chosen["type"], chosen["subfolder"], chosen["filename"])
    if path is None:
        return _fail("not_found")
    response = web.FileResponse(path)
    response.headers["Cache-Control"] = "private, max-age=3600"
    response.headers["Content-Disposition"] = f'inline; filename="{chosen["filename"]}"'
    return response


async def cancel_job(request: web.Request) -> web.Response:
    legacy_request = _is_legacy(request)
    if not _authorized(request):
        return _fail("unauthorized")
    job_id = str(request.match_info.get("job_id") or "").strip()
    job = _tracked(job_id)
    running, pending = _queue_snapshot()
    if job is None and job_id not in running and job_id not in pending:
        return _fail("not_found")
    dropped = False
    if job_id in pending:
        dropped = await _drop_pending(job_id)
    elif job_id in running:
        dropped = await _interrupt_running()
    if job is not None:
        job["cancelled"] = True
    elif dropped:
        job = {"id": job_id, "capability": "", "requested": "", "created": time.time(), "cancelled": True}
        _track(job)
    if job is None:
        return _fail("not_found")
    running, pending = _queue_snapshot()
    return _json({"job": _describe(job, running, pending, _history_entry(job_id), legacy_request=legacy_request)})


async def translate_prompts(request: web.Request) -> web.Response:
    """Pre-translate a prompt so a client can show the user the English it will send.

    Optional — a job submitted with Chinese is translated on the way in anyway.
    A text without a non-ASCII character comes back untouched, and so does every
    text when the translator is off or unreachable: the caller decides what to
    do, it never has to handle an error.
    """
    if not _authorized(request):
        return _fail("unauthorized")
    try:
        body = await request.json()
    except Exception:
        return _fail("bad_request")
    if not isinstance(body, dict):
        return _fail("bad_request")
    raw = body.get("texts")
    if isinstance(raw, str):
        raw = [raw]
    if not isinstance(raw, list) or not raw:
        return _fail("bad_request")
    outcome = await translate_module.translate([item for item in raw], target=str(body.get("target") or "en"))
    return _json(outcome)


# --------------------------------------------------------------------------- #
# wiring
# --------------------------------------------------------------------------- #

def register_routes() -> bool:
    """Attach the API to the running ComfyUI server; safe to call once at import."""
    server = _prompt_server()
    if server is None:
        return False
    routes = getattr(server, "routes", None)
    if routes is None:
        return False
    application = getattr(server, "app", None)
    if application is not None:
        try:
            application._client_max_size = MAX_BODY_BYTES
        except Exception:
            pass

    # The contract.
    routes.get(f"{API_ROOT}/info")(info)
    routes.post(f"{API_ROOT}/jobs")(create_job)
    routes.get(f"{API_ROOT}/jobs/{{job_id}}")(job_status)
    routes.get(f"{API_ROOT}/jobs/{{job_id}}/progress")(job_progress)
    routes.get(f"{API_ROOT}/jobs/{{job_id}}/output/{{index}}")(job_output)
    routes.post(f"{API_ROOT}/jobs/{{job_id}}/cancel")(cancel_job)
    routes.post(f"{API_ROOT}/translate")(translate_prompts)

    # The paths shipped clients (and PoseGi) already call.  Same job handlers,
    # old response shapes; see the module docstring and vibedraw_comfy.legacy.
    routes.get(f"{LEGACY_ROOT}/plugins")(legacy_plugins)
    routes.get(f"{LEGACY_ROOT}/capabilities")(legacy_capabilities)
    routes.post(f"{LEGACY_ROOT}/jobs")(create_job)
    routes.get(f"{LEGACY_ROOT}/jobs/{{job_id}}")(job_status)
    routes.get(f"{LEGACY_ROOT}/jobs/{{job_id}}/output/{{index}}")(job_output)
    routes.post(f"{LEGACY_ROOT}/jobs/{{job_id}}/cancel")(cancel_job)
    routes.post(f"{LEGACY_ROOT}/translate")(translate_prompts)
    return True


__all__ = ["API_ROOT", "LEGACY_ROOT", "register_routes"]
