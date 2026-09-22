"""HTTP API for the VibeDraw ComfyUI plugin.

This is the single contract an outside client (the VibeDraw app, or any other
developer's tool) talks to.  Everything the client needs is discoverable:

    GET  /vibedraw/v1/capabilities              what this server can do
    POST /vibedraw/v1/jobs                      submit one of the three tasks
    GET  /vibedraw/v1/jobs/{id}                 poll state, progress, outputs
    GET  /vibedraw/v1/jobs/{id}/output/{index}  fetch a finished image
    POST /vibedraw/v1/jobs/{id}/cancel          drop a queued job

Authentication
--------------
The password set in the ``VibeDrawConfig`` node (or the ``VIBEDRAW_PASSWORD``
environment variable) protects every job endpoint.  It is sent as
``Authorization: Bearer <password>``.  A wrong password answers ``401
unauthorized`` and nothing is queued.  Leaving it empty disables the check and
``capabilities`` says so, so a client never has to guess.

Images are uploaded inline as base64 in the job body and are written into
``input/vibedraw/`` before the graph runs, so a built-in graph can reference
them through the ordinary ``LoadImage`` node.
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

from . import settings as settings_module
from . import workflows

API_ROOT = "/vibedraw/v1"
SCHEMA = "vibedraw-comfy/v2"
INPUT_SUBFOLDER = "vibedraw"
CLIENT_ID = "vibedraw"

MAX_BODY_BYTES = 32 * 1024 * 1024
MAX_TRACKED_JOBS = 256
MAX_PENDING_JOBS = 8

ERROR_STATUS = {
    "unauthorized": 401,
    "bad_request": 400,
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
    "unsupported_task": "不支持的任务，请使用 quick / inpaint / upscale。",
    "unsupported_size": "该任务不支持这个画幅尺寸。",
    "unsupported_steps": "该任务不支持这个步数。",
    "bad_image": "参考图不是合法的 base64 PNG/JPEG。",
    "bad_mask": "局部重绘必须提供蒙版图。",
    "invalid_workflow": "内置工作流校验失败，可能是模型或节点缺失。",
    "no_model": "没有可用的模型，请先在 VibeDraw 配置节点里选择 checkpoint。",
    "busy": "队列已满，请稍后再试。",
    "not_found": "找不到这个任务。",
    "internal": "服务器内部错误。",
}

_JOBS: dict[str, dict[str, Any]] = {}
_JOBS_LOCK = threading.RLock()


# --------------------------------------------------------------------------- #
# helpers
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


def _checkpoint(task: str) -> str:
    try:
        name = settings_module.checkpoint(task)
    except Exception:
        return ""
    return name


def _available_checkpoints() -> list[str]:
    try:
        return [str(item) for item in folder_paths.get_filename_list("checkpoints")]
    except Exception:
        return []


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


def _outputs_of(prompt_id: str, entry: dict[str, Any] | None) -> list[dict[str, Any]]:
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
            files.append(
                {
                    "filename": filename,
                    "subfolder": str(image.get("subfolder") or ""),
                    "type": str(image.get("type") or "output"),
                    "url": f"{API_ROOT}/jobs/{prompt_id}/output/{len(files)}",
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


def _progress_of(job: dict[str, Any], state: str) -> float:
    if state == "completed":
        return 1.0
    if state in ("failed", "cancelled"):
        return 0.0
    expected = max(float(job.get("estimated_seconds") or 1.0), 0.4)
    elapsed = max(0.0, time.time() - float(job.get("created") or time.time()))
    if state == "queued":
        return round(min(0.05, elapsed / expected * 0.05), 4)
    return round(min(0.95, elapsed / expected), 4)


def _describe(job: dict[str, Any], running: list[str], pending: list[str], entry: dict[str, Any] | None) -> dict[str, Any]:
    state = _state_of(job, running, pending, entry)
    payload = {
        "id": job["id"],
        "task": job["task"],
        "state": state,
        "progress": _progress_of(job, state),
        "created": job["created"],
        "estimated_seconds": job.get("estimated_seconds"),
        "outputs": _outputs_of(job["id"], entry),
    }
    if state == "failed":
        payload["error"] = _error_of(entry) or "execution_error"
    return payload


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
# routes
# --------------------------------------------------------------------------- #

async def capabilities(request: web.Request) -> web.Response:
    tasks = []
    for task_id in workflows.task_ids():
        specification = workflows.TASK_SPECS[task_id]
        entry = {
            "id": specification["id"],
            "label": specification["label"],
            "description": specification["description"],
            "needs": dict(specification["needs"]),
            "sizes": [list(size) for size in specification["sizes"]],
            "steps": {
                "allowed": [int(value) for value in specification["steps"]["allowed"]],
                "default": int(specification["steps"]["default"]),
            },
            "params": json.loads(json.dumps(specification["params"])),
            "estimated_seconds": specification["estimated_seconds"],
            "model": _checkpoint(task_id),
        }
        tasks.append(entry)
    return _json(
        {
            "schema": SCHEMA,
            "plugin": "vibedraw_comfy",
            "tasks": tasks,
            "auth": {
                "required": bool(_password()),
                "scheme": "Bearer",
                "header": "Authorization",
                "hint": "密码在 ComfyUI 的 VibeDraw 配置节点里设置。",
            },
            "limits": {"max_body_bytes": MAX_BODY_BYTES, "max_pending_jobs": MAX_PENDING_JOBS},
            "checkpoints": _available_checkpoints(),
        }
    )


async def create_job(request: web.Request) -> web.Response:
    if not _authorized(request):
        return _fail("unauthorized")

    try:
        body = await request.json()
    except Exception:
        return _fail("bad_request")
    if not isinstance(body, dict):
        return _fail("bad_request")

    task = str(body.get("task") or "").strip().lower()
    try:
        specification = workflows.spec(task)
    except ValueError:
        return _fail("unsupported_task", detail={"task": task})

    size = _size_of(body.get("size"))
    steps_value = _number_of(body.get("steps"))
    try:
        chosen_size, chosen_steps = workflows.validate(
            task=task,
            size=size,
            steps=int(steps_value) if steps_value is not None else None,
        )
    except ValueError as error:
        code = str(error)
        return _fail(code if code in ERROR_STATUS else "bad_request", detail={"size": size, "steps": steps_value})

    needs = specification["needs"]
    if needs.get("mask") and not str(body.get("mask_base64") or "").strip() and not str(body.get("mask") or "").strip():
        return _fail("bad_mask")
    if needs.get("image") and not str(body.get("image_base64") or "").strip() and not str(body.get("image") or "").strip():
        return _fail("bad_image")

    checkpoint = _checkpoint(task)
    if not checkpoint:
        return _fail("no_model", detail={"checkpoints": _available_checkpoints()})
    if checkpoint not in _available_checkpoints():
        return _fail("no_model", message=f"模型 {checkpoint} 不在 ComfyUI 的 checkpoints 列表里。", detail={"checkpoints": _available_checkpoints()})

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

    settings = settings_module.load()
    sampling = settings["sampling"].get(task) or {}
    reference_default = specification["params"][0]["default"]
    reference_value = _number_of(body.get("ref_strength"), reference_default)
    grow_value = _number_of(body.get("grow_mask_by"), None)
    seed_value = _number_of(body.get("seed"), 0)
    try:
        graph, _ = workflows.build(
            task=task,
            checkpoint=checkpoint,
            sampling=sampling,
            image=image_name,
            mask=mask_name,
            prompt=str(body.get("prompt") or ""),
            negative_prompt=str(body.get("negative_prompt") or ""),
            seed=int(seed_value or 0),
            steps=chosen_steps,
            size=chosen_size,
            ref_strength=float(reference_value),
            grow_mask_by=int(grow_value) if grow_value is not None else None,
            filename_prefix=f"vibedraw/{task}",
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
        "task": task,
        "created": time.time(),
        "estimated_seconds": specification["estimated_seconds"],
        "size": chosen_size,
        "steps": chosen_steps,
        "ref_strength": float(reference_value),
        "cancelled": False,
    }
    _track(job)
    return _json({"job": _describe(job, running, pending + [prompt_id], None)}, status=202)


async def job_status(request: web.Request) -> web.Response:
    if not _authorized(request):
        return _fail("unauthorized")
    job_id = str(request.match_info.get("job_id") or "").strip()
    job = _tracked(job_id)
    entry = _history_entry(job_id)
    if job is None:
        if entry is None:
            return _fail("not_found")
        job = {"id": job_id, "task": "", "created": time.time(), "cancelled": False}
    running, pending = _queue_snapshot()
    return _json({"job": _describe(job, running, pending, entry)})


async def job_output(request: web.Request) -> web.Response:
    if not _authorized(request):
        return _fail("unauthorized")
    job_id = str(request.match_info.get("job_id") or "").strip()
    try:
        index = int(str(request.match_info.get("index") or "0"))
    except (TypeError, ValueError):
        return _fail("bad_request")
    files = _outputs_of(job_id, _history_entry(job_id))
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
        job = {"id": job_id, "task": "", "created": time.time(), "cancelled": True}
        _track(job)
    if job is None:
        return _fail("not_found")
    running, pending = _queue_snapshot()
    return _json({"job": _describe(job, running, pending, _history_entry(job_id))})


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
    routes.get(f"{API_ROOT}/capabilities")(capabilities)
    routes.post(f"{API_ROOT}/jobs")(create_job)
    routes.get(f"{API_ROOT}/jobs/{{job_id}}")(job_status)
    routes.get(f"{API_ROOT}/jobs/{{job_id}}/output/{{index}}")(job_output)
    routes.post(f"{API_ROOT}/jobs/{{job_id}}/cancel")(cancel_job)
    return True


__all__ = ["API_ROOT", "SCHEMA", "register_routes"]
