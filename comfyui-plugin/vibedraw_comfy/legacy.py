"""The two discovery documents that already-shipped clients still call.

``GET /vibedraw/v1/capabilities`` and ``GET /vibedraw/v1/plugins`` predate the
CVP spec.  PoseGi reads them, so they keep answering **the old shapes** — not the
new document — and the job routes keep working under their old paths.  Nothing
new should use any of this.

Everything an old client could see is reconstructed from the capability table,
so there is still exactly one place where capabilities are defined.

**This whole module is temporary.**  Once PoseGi reads ``/cvp/info``, delete the
file, the two legacy routes and the legacy path constants together.
"""

from __future__ import annotations

from copy import deepcopy
from typing import Any, Callable

from . import capabilities
from .version import __version__

KIND_TYPES = {
    "reference": "number", "float": "number", "integer": "integer",
    "boolean": "boolean", "string": "string", "size": "array", "seed": "integer",
}

Resolver = Callable[[dict[str, Any]], list[dict[str, Any]]]


def _property(name: str, type_name: str, **extra: Any) -> dict[str, Any]:
    value: dict[str, Any] = {"type": type_name}
    value.update({key: item for key, item in extra.items() if item is not None})
    return value


def params(capability: dict[str, Any]) -> list[dict[str, Any]]:
    """The old ``params[]`` list: the continuous knobs, in the old shape."""
    schema = capabilities.INPUT_SCHEMAS[capability["input"]]["properties"]
    defaults = capability["defaults"]
    out: list[dict[str, Any]] = []
    for name, kind in (("ref_strength", "reference"), ("grow_mask_by", "integer")):
        if name not in schema:
            continue
        if name == "grow_mask_by" and not capability["needs"].get("mask"):
            continue
        field = schema[name]
        out.append({
            "id": name,
            "kind": kind,
            "label": deepcopy(field.get("title") or {}),
            "help": deepcopy(field.get("help") or {}),
            "minimum": field.get("minimum"),
            "maximum": field.get("maximum"),
            "default": defaults.get(name, field.get("default")),
        })
    return out


def model_label(capability: dict[str, Any], models: list[dict[str, Any]]) -> str:
    """The old ``tasks[].model`` string: the file a reader would want to see."""
    wanted = "checkpoint" if "checkpoint" in (capability.get("roles") or []) else "unet"
    for item in models or []:
        if item.get("role") == wanted:
            return str(item.get("name") or "")
    return ""


def model_state(capability: dict[str, Any], models: list[dict[str, Any]]) -> dict[str, Any]:
    """The old ``plugins[].model`` object: one entry, which may be a triple."""
    files = {str(item.get("role")): str(item.get("name") or "") for item in models or []}
    missing = [str(item.get("role")) for item in models or [] if not item.get("ready")]
    ready = bool(models) and not missing
    if "checkpoint" in (capability.get("roles") or []):
        return {"role": "checkpoint", "name": files.get("checkpoint", ""), "files": {},
                "available": ready, "ready": ready,
                "missing": [] if ready else ["checkpoint"]}
    return {"role": "triple", "name": files.get("unet", ""), "files": files,
            "available": ready, "ready": ready, "missing": missing}


def job_schema(capability: dict[str, Any]) -> dict[str, Any]:
    """The old per-capability request schema (superseded by a shared one)."""
    english_only = capability["prompt"]["language"] == "en"
    needs = capability["needs"]
    properties: dict[str, Any] = {}

    properties["task"] = _property(
        "task", "string", const=capability["id"], required=True,
        help={"zh": "任务名,与 plugins[].id 相同。", "en": "Task name; same as plugins[].id."})
    properties["prompt"] = _property(
        "prompt", "string", default="", required=False, recommended=bool(needs.get("prompt")),
        language="en" if english_only else "any",
        help={"zh": "画面描述。" + ("这条任务的编码器只认英文,中文请先用 /translate 翻译。" if english_only
                                  else "这条任务的编码器能读中文,不必先翻译。"),
              "en": "What to draw. " + ("This pipeline's text encoder only reads English; translate first via /translate."
                                        if english_only else "This pipeline's encoder reads Chinese; no translation needed.")})
    properties["negative_prompt"] = _property(
        "negative_prompt", "string", default="", required=False,
        help={"zh": "不想出现的内容；cfg 为 1 的任务会忽略它。", "en": "What to avoid; a task sampled at cfg 1 ignores it."})

    required = ["task"]
    if needs.get("image"):
        properties["image_base64"] = _property(
            "image_base64", "string", format="base64-image", required=True,
            help={"zh": "参考图,PNG/JPEG 的 base64,可直接给 data URL。",
                  "en": "Reference image as base64 PNG/JPEG; a data URL is accepted as-is."})
        required.append("image_base64")
    if needs.get("mask"):
        properties["mask_base64"] = _property(
            "mask_base64", "string", format="base64-image", required=True,
            help={"zh": "蒙版,黑底白区,白色 = 要重画。",
                  "en": "Mask, black background with a white area; white means repaint."})
        required.append("mask_base64")

    for parameter in params(capability):
        entry = _property(
            str(parameter["id"]), KIND_TYPES.get(str(parameter.get("kind")), "number"),
            title=deepcopy(parameter.get("label") or {}), help=deepcopy(parameter.get("help") or {}),
            default=parameter.get("default"), minimum=parameter.get("minimum"),
            maximum=parameter.get("maximum"), vibedraw_kind=parameter.get("kind"))
        entry["required"] = False
        properties[str(parameter["id"])] = entry

    properties["size"] = _property(
        "size", "array", items="integer", length=2,
        enum=[list(value) for value in capability["values"]["size"]],
        default=list(capability["defaults"]["size"]), required=False,
        help={"zh": "画幅 [宽, 高],只能取 enum 里列出的值。", "en": "Canvas [width, height]; only the listed values are accepted."})
    properties["steps"] = _property(
        "steps", "integer", enum=[int(value) for value in capability["values"]["steps"]],
        default=int(capability["defaults"]["steps"]), required=False,
        help={"zh": "采样步数,只能取 enum 里列出的值。", "en": "Sampling steps; only the listed values are accepted."})
    properties["seed"] = _property(
        "seed", "integer", default=0, minimum=0, required=False,
        help={"zh": "0 表示每张都不一样；同一个 seed 可以复现。", "en": "0 means a new seed each run; the same seed reproduces."})
    return {"type": "object", "required": required, "properties": properties}


def plugin_entry(capability: dict[str, Any], models: list[dict[str, Any]]) -> dict[str, Any]:
    """One entry of the old ``/plugins`` ``plugins[]`` array."""
    english_only = capability["prompt"]["language"] == "en"
    state = model_state(capability, models)
    return {
        "id": capability["id"],
        "kind": "pipeline",
        "family": capability["family"],
        "label": deepcopy(capability["label"]),
        "description": deepcopy(capability["description"]),
        "english_only": english_only,
        "prompt_language": "en" if english_only else "any",
        "needs": deepcopy(capability["needs"]),
        "sizes": [list(value) for value in capability["values"]["size"]],
        "steps": {"allowed": [int(value) for value in capability["values"]["steps"]],
                  "default": int(capability["defaults"]["steps"])},
        "params": [dict(parameter) for parameter in params(capability)],
        "schema": job_schema(capability),
        "model": state,
        "model_roles": list(capability.get("roles") or []),
        "ready": bool(state["ready"]),
        "estimated_seconds": capability["typical_seconds"],
    }


def task_entry(capability: dict[str, Any], models: list[dict[str, Any]]) -> dict[str, Any]:
    """One entry of the old ``/capabilities`` ``tasks[]`` array."""
    return {
        "id": capability["id"],
        "label": deepcopy(capability["label"]),
        "description": deepcopy(capability["description"]),
        "needs": deepcopy(capability["needs"]),
        "sizes": [list(value) for value in capability["values"]["size"]],
        "steps": {"allowed": [int(value) for value in capability["values"]["steps"]],
                  "default": int(capability["defaults"]["steps"])},
        "params": params(capability),
        "estimated_seconds": capability["typical_seconds"],
        "model": model_label(capability, models),
    }


def prompt_policy(entries: list[dict[str, Any]], translation: dict[str, Any]) -> dict[str, Any]:
    backend = translation.get("backend") or {}
    return {
        "translate_endpoint": f"{capabilities.LEGACY_ROOT}/translate",
        "translate_available": bool(translation.get("available")),
        "engine": str(backend.get("model") or ""),
        "target": "en",
        "rule": str(translation.get("rule") or ""),
        "english_only_pipelines": [entry["id"] for entry in entries if entry["english_only"]],
        "any_language_pipelines": [entry["id"] for entry in entries if not entry["english_only"]],
    }


def _resolve_all(resolve: Resolver) -> list[dict[str, Any]]:
    return [plugin_entry(value, resolve(value)) for value in capabilities.CAPABILITIES.values()]


def _auth(authorized: bool, auth_required: bool, hint: str) -> dict[str, Any]:
    return {"required": bool(auth_required), "authorized": bool(authorized), "scheme": "Bearer",
            "header": "Authorization", "hint": hint}


def plugins_document(*, resolve: Resolver, authorized: bool, auth_required: bool,
                     translation: dict[str, Any], checkpoints: list[str],
                     auth_hint: str = "") -> dict[str, Any]:
    """The old ``GET /vibedraw/v1/plugins`` body."""
    entries = _resolve_all(resolve)
    document = {
        "schema": capabilities.DISCOVERY_SCHEMA,
        "api_schema": capabilities.API_SCHEMA,
        "plugin": {"id": capabilities.PLUGIN_ID, "label": deepcopy(capabilities.PLUGIN_LABEL),
                   "version": __version__},
        "endpoints": {
            "plugins": f"{capabilities.LEGACY_ROOT}/plugins",
            "capabilities": f"{capabilities.LEGACY_ROOT}/capabilities",
            "jobs": f"{capabilities.LEGACY_ROOT}/jobs",
            "job": f"{capabilities.LEGACY_ROOT}/jobs/{{job_id}}",
            "output": f"{capabilities.LEGACY_ROOT}/jobs/{{job_id}}/output/{{index}}",
            "cancel": f"{capabilities.LEGACY_ROOT}/jobs/{{job_id}}/cancel",
            "translate": f"{capabilities.LEGACY_ROOT}/translate",
        },
        "auth": _auth(authorized, auth_required, auth_hint or "密码在 ComfyUI 的 VibeDraw 配置节点里设置。"),
        "plugins": entries,
        "prompt_policy": prompt_policy(entries, translation),
        "checkpoints": [str(name) for name in checkpoints],
    }
    return document


def capabilities_document(*, resolve: Resolver, authorized: bool, auth_required: bool,
                          translation: dict[str, Any], checkpoints: list[str],
                          limits: dict[str, Any]) -> dict[str, Any]:
    """The old ``GET /vibedraw/v1/capabilities`` body."""
    entries = _resolve_all(resolve)
    translated = {"available": bool(translation.get("available")),
                  "engine": str((translation.get("backend") or {}).get("model") or ""),
                  "target": "en", "rule": str(translation.get("rule") or "")}
    return {
        "schema": capabilities.API_SCHEMA,
        "plugin": capabilities.PLUGIN_ID,
        "plugin_version": __version__,
        "tasks": [task_entry(value, resolve(value)) for value in capabilities.CAPABILITIES.values()],
        "plugins": entries,
        "discovery": capabilities.DISCOVERY_SCHEMA,
        "prompt_policy": prompt_policy(entries, translation),
        "auth": {"required": bool(auth_required), "scheme": "Bearer", "header": "Authorization",
                 "hint": "密码在 ComfyUI 的 VibeDraw 配置节点里设置。"},
        "limits": deepcopy(limits),
        "translate": translated,
        "checkpoints": [str(name) for name in checkpoints],
    }


__all__ = ["capabilities_document", "job_schema", "model_label", "model_state", "params",
           "plugin_entry", "plugins_document", "prompt_policy", "task_entry"]
