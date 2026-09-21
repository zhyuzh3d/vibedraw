"""Small HTTP adapter that injects VibeDraw fields into a ComfyUI graph."""

from __future__ import annotations

import base64
import binascii
import copy
import json
import mimetypes
import time
import uuid
from pathlib import Path
from typing import Any

from aiohttp import web

import execution
import folder_paths
import nodes
from server import PromptServer


SCHEMA = "vibedraw-comfy/v1"
MAX_IMAGE_BYTES = 8 * 1024 * 1024
_REGISTERED = False


def _json_error(message: str, status: int = 400, **extra: Any) -> web.Response:
    body = {"error": message}
    body.update(extra)
    return web.json_response(body, status=status)


def _node_map(workflow: dict[str, Any], class_name: str) -> list[tuple[str, dict[str, Any]]]:
    found: list[tuple[str, dict[str, Any]]] = []
    for node_id, node in workflow.items():
        if isinstance(node, dict) and node.get("class_type") == class_name:
            found.append((str(node_id), node))
    return found


def _input_dir() -> Path:
    path = Path(folder_paths.get_input_directory()) / "vibedraw"
    path.mkdir(parents=True, exist_ok=True)
    return path


def _decode_asset(value: Any, label: str) -> str:
    if not value:
        return ""
    if not isinstance(value, str):
        raise ValueError(f"{label} must be base64 text")
    encoded = value.split(",", 1)[-1]
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise ValueError(f"{label} is not valid base64") from exc
    if not raw or len(raw) > MAX_IMAGE_BYTES:
        raise ValueError(f"{label} is empty or exceeds {MAX_IMAGE_BYTES} bytes")
    suffix = ".png"
    try:
        mime = str(value.split(";", 1)[0].split(":", 1)[-1]).lower()
        suffix = mimetypes.guess_extension(mime) or suffix
    except Exception:
        pass
    name = f"{uuid.uuid4().hex}{suffix}"
    destination = _input_dir() / name
    destination.write_bytes(raw)
    return f"vibedraw/{name}"


def _patch_workflow(workflow: dict[str, Any], inputs: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    patched = copy.deepcopy(workflow)
    input_nodes = _node_map(patched, "VibeDrawInput")
    output_nodes = _node_map(patched, "VibeDrawOutput")
    if len(input_nodes) != 1:
        raise ValueError("workflow must contain exactly one VibeDrawInput node")
    if not output_nodes:
        raise ValueError("workflow must contain at least one VibeDrawOutput node")
    _, node = input_nodes[0]
    node_inputs = node.setdefault("inputs", {})
    allowed = ("prompt", "negative_prompt", "seed", "ref_strength", "steps", "width", "height", "image_file", "mask_file")
    for key in allowed:
        if key in inputs:
            node_inputs[key] = inputs[key]
    return patched, [node_id for node_id, _ in output_nodes]


async def _queue_prompt(workflow: dict[str, Any], client_id: str, output_nodes: list[str]) -> str:
    prompt_server = PromptServer.instance
    prompt_id = str(uuid.uuid4())
    number = prompt_server.number
    prompt_server.number += 1
    valid = await execution.validate_prompt(prompt_id, workflow, None)
    if not valid[0]:
        details = valid[1] if isinstance(valid[1], str) else "workflow validation failed"
        raise ValueError(json.dumps({"message": details, "node_errors": valid[3]}, ensure_ascii=False))
    extra_data = {
        "client_id": client_id,
        "vibedraw": {"schema": SCHEMA},
        "vibedraw_output_nodes": output_nodes,
        "create_time": int(time.time() * 1000),
    }
    prompt_server.prompt_queue.put((number, prompt_id, workflow, extra_data, valid[2], {}))
    return prompt_id


def _history(prompt_id: str) -> dict[str, Any] | None:
    value = PromptServer.instance.prompt_queue.get_history(prompt_id=prompt_id)
    return value.get(prompt_id) if isinstance(value, dict) else None


def _state(prompt_id: str, history: dict[str, Any] | None) -> str:
    if history is not None:
        status = history.get("status") or {}
        if status.get("status_str") in {"error", "failed"}:
            return "failed"
        return "succeeded"
    running, pending = PromptServer.instance.prompt_queue.get_current_queue()
    if any(item[1] == prompt_id for item in running):
        return "running"
    if any(item[1] == prompt_id for item in pending):
        return "queued"
    return "unknown"


def _outputs(history: dict[str, Any] | None, node_ids: list[str]) -> list[dict[str, Any]]:
    if not history:
        return []
    outputs = history.get("outputs") or {}
    result: list[dict[str, Any]] = []
    for node_id in node_ids:
        for image in (outputs.get(node_id) or {}).get("images", []):
            if isinstance(image, dict) and image.get("filename"):
                result.append({
                    "filename": image["filename"],
                    "subfolder": image.get("subfolder", ""),
                    "type": image.get("type", "output"),
                })
    return result


async def capabilities(_: web.Request) -> web.Response:
    return web.json_response({
        "schema": SCHEMA,
        "fields": {
            "prompt": "STRING",
            "negative_prompt": "STRING",
            "image_base64": "base64 image staged and injected into VibeDrawInput.image",
            "mask_base64": "base64 grayscale image staged and injected into VibeDrawInput.mask",
            "seed": "non-negative integer",
            "ref_strength": "0..2 semantic reference strength",
            "steps": "positive integer",
            "width": "positive integer",
            "height": "positive integer",
        },
        "nodes": {"input": "VibeDrawInput", "output": "VibeDrawOutput"},
    })


async def submit(request: web.Request) -> web.Response:
    try:
        body = await request.json()
    except Exception:
        return _json_error("request body must be valid JSON")
    if not isinstance(body, dict) or not isinstance(body.get("workflow"), dict):
        return _json_error("workflow must be an API-format workflow object")
    inputs = body.get("inputs") if isinstance(body.get("inputs"), dict) else {}
    inputs = dict(inputs)
    for key in ("prompt", "negative_prompt", "seed", "ref_strength", "steps", "width", "height"):
        if key in body and key not in inputs:
            inputs[key] = body[key]
    try:
        inputs["image_file"] = _decode_asset(body.get("image_base64"), "image_base64")
        inputs["mask_file"] = _decode_asset(body.get("mask_base64"), "mask_base64")
        workflow, output_nodes = _patch_workflow(body["workflow"], inputs)
        prompt_id = await _queue_prompt(workflow, str(body.get("client_id") or "vibedraw"), output_nodes)
    except ValueError as exc:
        return _json_error(str(exc))
    return web.json_response({"schema": SCHEMA, "job_id": prompt_id, "state": "queued", "output_nodes": output_nodes}, status=202)


async def job(request: web.Request) -> web.Response:
    prompt_id = request.match_info.get("prompt_id", "")
    history = _history(prompt_id)
    state = _state(prompt_id, history)
    if state == "unknown":
        return _json_error("job not found", status=404)
    node_ids: list[str] = []
    if history:
        prompt_record = history.get("prompt")
        extra: dict[str, Any] = {}
        if isinstance(prompt_record, list) and len(prompt_record) > 3 and isinstance(prompt_record[3], dict):
            extra = prompt_record[3]
        node_ids = [str(value) for value in extra.get("vibedraw_output_nodes", [])]
        if not node_ids:
            node_ids = [str(value) for value in (history.get("outputs") or {}).keys()]
    return web.json_response({"schema": SCHEMA, "job_id": prompt_id, "state": state, "outputs": _outputs(history, node_ids)})


def _register_routes() -> None:
    global _REGISTERED
    if _REGISTERED or PromptServer.instance is None:
        return
    routes = PromptServer.instance.routes
    routes.get("/vibedraw/v1/capabilities")(capabilities)
    routes.post("/vibedraw/v1/jobs")(submit)
    routes.get("/vibedraw/v1/jobs/{prompt_id}")(job)
    _REGISTERED = True


_register_routes()
