#!/usr/bin/env python3
"""Offline self-check for the CVP contract and its two projections.

Runs anywhere — no ComfyUI, no aiohttp, no network, no model files.  The two
modules ComfyUI normally provides (``folder_paths``, ``nodes``) plus ``aiohttp``
are stubbed into ``sys.modules`` before the package is imported: importing
``vibedraw_comfy`` runs ``__init__.py``, which pulls in the node definitions and
registers the HTTP routes, and neither is needed to inspect a document built
purely from data.

    python3 tests/test_spec.py

What it locks down:

* the information document: ``spec``, the capability ids, exactly one shared
  input schema, ``category`` / ``signature`` on every entry, and that the whole
  thing is plain JSON;
* the signature grammar of ``plans/cvp-spec.md`` §2 — including that
  ``txt-ref23dgs`` splits on its *last* ``2``;
* aliases (``qwen`` is ``render``) and the two boundary rules: an enumeration
  rejects an unknown value, a continuous value is clamped;
* the translation memory survives a process restart, and its key is the source
  text and nothing else, so a better engine still hits;
* the shipped defaults carry no deployment: an empty translator address and a
  cache dtype the model's own author would default to;
* the legacy projection — the two old documents still carry the keys PoseGi
  reads, and the config node reads its ranges from the capability table.
"""

from __future__ import annotations

import json
import os
import sys
import tempfile
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))


def _stub(name: str, **attributes) -> None:
    """Put a stand-in module in place so the package imports outside ComfyUI."""
    if name in sys.modules:
        return
    module = types.ModuleType(name)
    for key, value in attributes.items():
        setattr(module, key, value)
    sys.modules[name] = module


# translate.py imports aiohttp at module scope; server.py needs aiohttp.web for
# its annotations, which ``from __future__ import annotations`` never evaluates.
_stub("aiohttp", ClientSession=object, ClientTimeout=object, web=types.SimpleNamespace())
# nodes.py imports these; the folder listing is a fixed little catalogue so the
# config node can be exercised without ComfyUI.
_MODEL_FILES = {"checkpoints": ["DreamShaper8_LCM.safetensors", "sd15-realistic.safetensors"]}
_stub("folder_paths",
      get_filename_list=lambda folder: list(_MODEL_FILES.get(folder, [])),
      get_annotated_filepath=lambda name: name,
      get_input_directory=lambda: tempfile.gettempdir(),
      get_output_directory=lambda: tempfile.gettempdir(),
      get_temp_directory=lambda: tempfile.gettempdir())
_stub("nodes", SaveImage=type("SaveImage", (), {}))

# The settings file and the translation memory live next to each other, so
# pointing the first at a scratch directory keeps this run out of the real
# install — and lets the memory test pretend the process restarted.
_SCRATCH = Path(tempfile.mkdtemp(prefix="cvp-test-"))
os.environ["VIBEDRAW_SETTINGS"] = str(_SCRATCH / "vibedraw_settings.json")
for _name in ("VIBEDRAW_PASSWORD", "VIBEDRAW_TRANSLATE_URL", "VIBEDRAW_TRANSLATE_MODEL"):
    os.environ.pop(_name, None)

from vibedraw_comfy import capabilities, families, legacy, nodes, server, settings, translate  # noqa: E402


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def forget_settings() -> None:
    """Drop the scratch settings file so the next test starts from the defaults."""
    settings.path().unlink(missing_ok=True)


def fake_models(capability: dict) -> list[dict]:
    """A resolver stand-in: every role of this capability is installed."""
    return [{"role": role, "name": f"{capability['id']}-{role}.safetensors",
             "ready": True, "missing": []} for role in capability["roles"]]


def split_signature(signature: str) -> tuple[str, str]:
    """The parsing rule from the spec: cut on the **last** ``2``."""
    head, _, tail = str(signature).rpartition("2")
    return head, tail


def check_information_document() -> None:
    document = capabilities.document(
        resolve=lambda name: fake_models(capabilities.spec_of(name)),
        authorized=True, auth_required=True,
        translation=translate.describe(),
        available={"checkpoint": ["a.safetensors"]},
    )

    # 1) 协议版本在响应体里,不在路径里
    check(document["spec"] == "cvp/1", "协议版本必须放在响应体里")
    check(document["plugin"]["version"] == "2.2.0", "插件版本要通过文档播报")
    check(document["auth"]["required"] is True and document["auth"]["authorized"] is True, "auth 要如实反映传入值")

    # 2) 能力必须是四个语义 id,模型名不许当 id
    ids = [entry["id"] for entry in document["capabilities"]]
    check(ids == capabilities.ids(), f"能力清单必须与能力表同序同集合,得到 {ids}")
    check(ids == ["quick", "inpaint", "upscale", "render"], f"四个语义 id,得到 {ids}")
    check("qwen" not in ids, "模型名不许当能力 id")

    # 3) 同一签名只有一份共享 schema
    check(list(document["input_schemas"]) == ["txt-ref2img/v1"], "当前只该有 txt-ref2img/v1 一份 schema")
    schema = document["input_schemas"]["txt-ref2img/v1"]
    check(schema["required"] == ["capability"], "必填项只有 capability,其余看 needs")
    for entry in document["capabilities"]:
        check(entry["input"] == "txt-ref2img/v1", f"{entry['id']}: input 必须指向共享 schema")
        check(entry["category"] and set(entry["category"]) <= set(capabilities.CATEGORIES),
              f"{entry['id']}: category 必须在已知类别里")
        check(entry["signature"] == "txt-ref2img", f"{entry['id']}: 当前四个能力同签名")
        check(bool(entry["models"]) and entry["ready"], f"{entry['id']}: 解析成功的模型必须 ready")
        check(set(entry["defaults"]) <= set(schema["properties"]),
              f"{entry['id']}: defaults 不许出现 schema 里没有的字段")
        # roles / family 是实现细节,刻意不出现在文档里;但要能被家族层接住
        internal = capabilities.CAPABILITIES[entry["id"]]
        check(set(internal["roles"]) <= set(capabilities.ROLE_FOLDERS),
              f"{entry['id']}: 模型角色要有对应目录")
        check(internal["family"] in families.FAMILIES, f"{entry['id']}: family 必须存在")
        check("roles" not in entry and "family" not in entry,
              f"{entry['id']}: 实现细节不许播报给客户端")

    # 4) 端点给的是相对路径,三类都在
    check(document["endpoints"]["info"] == "/cvp/info", "信息接口路径")
    check(document["endpoints"]["jobs"] == "/cvp/jobs", "提交接口路径")
    check(document["endpoints"]["progress"] == "/cvp/jobs/{job_id}/progress", "进度接口路径")
    check(document["endpoints"]["translate"] == "/cvp/translate", "翻译接口路径")

    # 5) 签名语法:除分隔符 2 外不许出现数字,且以最后一个 2 为界
    for entry in document["capabilities"]:
        head, tail = split_signature(entry["signature"])
        check(head and tail, f"{entry['id']}: 签名两侧都不能为空")
        check(not any(char.isdigit() for char in head + tail),
              f"{entry['id']}: 签名里除分隔符 2 外不许出现数字")
    check(split_signature("txt-ref23dgs") == ("txt-ref", "3dgs"), "txt-ref23dgs 必须切在最后一个 2")
    check(split_signature("txt-refs2glb") == ("txt-refs", "glb"), "多图参考的签名也要能解析")

    # 6) 必须是能直接 json.dumps 的纯数据
    encoded = json.dumps(document, ensure_ascii=False)
    restored = json.loads(encoded)
    check(restored["plugin"]["id"] == capabilities.PLUGIN_ID, "要能穿过 JSON 往返")
    check(json.dumps(restored, ensure_ascii=False) == encoded, "文档要能稳定往返")


def check_capability_lookup() -> None:
    # 别名:老客户端发 qwen 仍然工作,但解析出来的是 render
    check(capabilities.find("qwen")["id"] == "render", "qwen 是 render 的别名")
    check(capabilities.find("render")["id"] == "render", "本名也能解析")
    check(capabilities.find("QWEN")["id"] == "render", "别名不区分大小写")
    check(capabilities.find("nope") is None, "不认识的能力要返回 None")
    check("qwen" in capabilities.names() and "render" in capabilities.names(), "names() 要给全部可提交名")
    try:
        capabilities.spec_of("nope")
        raise AssertionError("spec_of 遇到不认识的能力必须抛错")
    except ValueError as error:
        check(str(error) == "unsupported_capability", f"错误码要是 unsupported_capability,得到 {error}")

    # 每个能力的 family 都必须是真实存在的家族模块
    for entry in capabilities.CAPABILITIES.values():
        check(entry["family"] in families.FAMILIES, f"{entry['id']}: family {entry['family']} 不存在")
    check(families.get("qwen_image_21").ROLES == ("unet", "clip", "vae"), "render 一族要三个槽位")
    check(families.get("checkpoint").ROLES == ("checkpoint",), "checkpoint 一族只要一个槽位")
    try:
        families.get("nope")
        raise AssertionError("不认识的家族必须抛错")
    except ValueError as error:
        check(str(error) == "unsupported_capability", f"错误码要是 unsupported_capability,得到 {error}")


def check_boundary_rules() -> None:
    quick = capabilities.spec_of("quick")
    check(capabilities.validate_values(quick, None, None) == ([512, 512], 8), "不传就用 defaults")
    for size, steps, expected in (
        ([513, 513], 8, "unsupported_size"),
        ([512, 512], 7, "unsupported_steps"),
        ("512x512", 8, "unsupported_size"),
    ):
        try:
            capabilities.validate_values(quick, size, steps)
            raise AssertionError(f"枚举越界必须报错: {size} / {steps}")
        except ValueError as error:
            check(str(error) == expected, f"期望 {expected},得到 {error}")

    # 连续量夹边并回显,不报错
    check(capabilities.clamp_ref_strength(2.0, 0.55) == 0.95, "越上界夹到 0.95")
    check(capabilities.clamp_ref_strength(-1, 0.55) == 0.05, "越下界夹到 0.05")
    check(capabilities.clamp_ref_strength(0.5, 0.55) == 0.5, "区间内原样")
    check(capabilities.clamp_ref_strength("oops", 0.55) == 0.55, "不是数字就用默认值")
    check(capabilities.clamp_ref_strength(None, 0.30) == 0.30, "缺省就用默认值")

    # 渲染一族声明忽略反向提示词,这是它自己的事实,不是通用规则
    check(capabilities.spec_of("render")["ignores"] == ["negative_prompt"], "render 要声明忽略反向提示词")
    check(capabilities.spec_of("quick")["ignores"] == [], "checkpoint 三族不许声明忽略任何字段")


def check_translation_memory() -> None:
    # 触发条件:不是"含中文",而是"不是全 ASCII"
    check(translate.needs_translation("hello world") is False, "纯 ASCII 不翻")
    check(translate.needs_translation("  \n\t ") is False, "空白不算")
    check(translate.needs_translation("") is False, "空串不翻")
    check(translate.needs_translation("一只猫") is True, "中文要翻")
    check(translate.needs_translation("Привет") is True, "俄语同样要翻,不能只认中日韩")
    check(translate.needs_translation("γειά") is True, "希腊语同样要翻")

    source = "一只猫在沙发上"
    check(translate.memory_path().name == "vibedraw_translations.json", "记忆库文件名")
    check(translate.memory_path().parent == _SCRATCH, "记忆库必须落在设置同目录")

    # 存 → 读 → 命中
    check(translate.memory_size() == 0, "起步时记忆库是空的")
    check(translate.remember([(source, "a cat on a sofa", "engine-a")]) == 1, "写入一条")
    check(translate.recall(source) == "a cat on a sofa", "立刻命中")
    check(translate.memory_size() == 1, "只该有一条")

    # 键 = 原文 + 目标语言,与引擎无关:换个引擎写同一条,仍是同一条,但引擎留作旁注
    check(translate.remember([(source, "a cat on a sofa v2", "engine-b")]) == 1, "换引擎再写一次")
    check(translate.memory_size() == 1, "键不含引擎,换引擎不许产生第二条")
    check(translate.recall(source) == "a cat on a sofa v2", "后写的覆盖先写的")
    entries = json.loads(translate.memory_path().read_text(encoding="utf-8"))
    check(entries["schema"] == "cvp-translation-memory/v1", "记忆库要有自己的 schema")
    entry = list(entries["entries"].values())[0]
    check(entry["engine"] == "engine-b", "引擎要作为旁注记下来,便于将来重刷")
    check(entry["source"] == source and entry["target"] == "en", "条目要记得原文与目标语言")
    check(translate._key(source, "en") != translate._key(source, "zh"), "键含目标语言,为将来多目标留位")

    # 换目标语言不该命中
    check(translate.recall(source, "zh") == "", "别的目标语言是另一条事实")

    # 重启进程:内存丢掉,文件还在
    translate._MEMORY = None
    check(translate.memory_size() == 1, "重启后条数不变")
    check(translate.recall(source) == "a cat on a sofa v2", "重启后仍然命中")

    # describe() 给信息接口用,不许泄露内部地址
    described = translate.describe()
    check(described["mode"] == "auto-on-submit", "翻译是提交时兜底")
    check(described["available"] is False, "没配地址就是不可用")
    check(described["memory"]["entries"] == 1, "条数要播报")
    check("http" not in json.dumps(described), "不许播报后端地址")
    check(translate.enabled() is False, "没有地址就是关闭")


def check_settings() -> None:
    check(settings.TASKS == tuple(capabilities.ids()), "设置的任务集合必须等于能力表")
    check(set(settings.DEFAULTS["checkpoints"]) == set(capabilities.ids()), "每个能力都要有 checkpoint 槽位")
    check(set(settings.DEFAULTS["sampling"]) == set(capabilities.ids()), "每个能力都要有采样设置")
    check(settings.RENAMED == {"render": "qwen"}, "改名只有一个映射")

    # 去设备化:默认值是"未配置",不是某一台机器的地址或参数
    check(settings.DEFAULTS["translate"]["url"] == "", "默认翻译地址必须是空")
    check(settings.path().name == "vibedraw_settings.json", "设置文件名")
    check(settings.DEFAULTS["checkpoints"]["quick"] == settings.RECOMMENDED_CHECKPOINT,
          "推荐 checkpoint 只有一处常量")
    check(settings.DEFAULTS["families"]["qwen_image_21"]["cache_dtype"] == "default",
          "缓存 dtype 的默认值取模型作者的建议,不是某台机器的权宜值")
    check(set(settings.DEFAULTS["families"]["qwen_image_21"]) == set(families.get("qwen_image_21").OPTIONS),
          "family 的可调项要与家族声明一致")

    # 旧键自迁移:老安装文件里是 models.qwen,新代码要用 render 读到它
    (settings.path()).write_text(
        json.dumps({"checkpoints": {"qwen": "old.safetensors"},
                    "models": {"qwen": {"unet": "u.safetensors", "clip": "c.safetensors", "vae": "v.safetensors"}}}),
        encoding="utf-8")
    files = settings.model_files("render")
    check(files["unet"] == "u.safetensors" and files["clip"] == "c.safetensors", f"旧键要能读到,得到 {files}")
    settings.update(models={"render": {"unet": "u2.safetensors", "clip": "c.safetensors", "vae": "v.safetensors"}})
    stored = json.loads(settings.path().read_text(encoding="utf-8"))
    check("qwen" not in stored["models"], "保存一次之后旧键要被清掉")
    check(settings.model_files("render")["unet"] == "u2.safetensors", "新值生效")
    check(settings.checkpoint("quick") == settings.RECOMMENDED_CHECKPOINT, "quick 的 checkpoint 照旧")
    forget_settings()


def check_nodes_read_the_table() -> None:
    check(nodes.REFERENCE_LOW == capabilities.REF_STRENGTH_RANGE[0], "节点下界来自能力表")
    check(nodes.REFERENCE_HIGH == capabilities.REF_STRENGTH_RANGE[1], "节点上界来自能力表")
    check(nodes.REFERENCE_DEFAULT == capabilities.CAPABILITIES["quick"]["defaults"]["ref_strength"], "默认值来自能力表")
    check(not hasattr(nodes, "RECOMMENDED_QUICK"), "推荐模型名只留一处")

    fields = nodes.VibeDrawInput.INPUT_TYPES()["required"]
    check(fields["ref_strength"][1]["min"] == 0.05 and fields["ref_strength"][1]["max"] == 0.95,
          f"节点范围必须等于 HTTP 侧契约,得到 {fields['ref_strength'][1]}")

    config = nodes.VibeDrawConfig.INPUT_TYPES()
    check("qwen_unet" in config["optional"], "render 的三个模型槽位要在配置节点里")
    check(config["required"]["quick_checkpoint"][1]["default"] == settings.RECOMMENDED_CHECKPOINT,
          "没有可用 checkpoint 时也要给出推荐值")
    status = nodes.VibeDrawConfig().apply(
        password="", quick_checkpoint=settings.RECOMMENDED_CHECKPOINT,
        inpaint_checkpoint=nodes.SAME_AS_QUICK, upscale_checkpoint=nodes.SAME_AS_QUICK)[0]
    check("高质量" in status, f"状态行要按新命名播报,得到 {status}")
    check(settings.checkpoint("inpaint") == settings.RECOMMENDED_CHECKPOINT, "同 quick 的槽位要回落到 quick")
    forget_settings()


def check_server_surface() -> None:
    check(server.API_ROOT == "/cvp", "新接口根路径")
    check(server.LEGACY_ROOT == "/vibedraw/v1", "旧接口根路径")
    check(capabilities.API_ROOT == server.API_ROOT and capabilities.LEGACY_ROOT == server.LEGACY_ROOT,
          "两处路径常量必须同源")

    expected = {
        "unauthorized": 401, "bad_request": 400, "unsupported_capability": 400,
        "unsupported_size": 400, "unsupported_steps": 400, "bad_image": 400, "bad_mask": 400,
        "no_model": 409, "invalid_workflow": 400, "busy": 429, "not_found": 404, "internal": 500,
    }
    for code, status in expected.items():
        check(server.ERROR_STATUS.get(code) == status, f"{code} 的状态码要是 {status}")
        check(code in server.ERROR_MESSAGES, f"{code} 要有人看的文案")
    check(server.ERROR_STATUS.get("unsupported_task") == 400, "旧客户端用的错误码要留着")


def check_routes() -> None:
    """Every path the two documents promise must actually be registered.

    ComfyUI's own ``server`` module is stubbed for this one check, which is why
    it runs last: it is the only thing here that needs a PromptServer instance.
    """
    class FakeRoutes:
        def __init__(self) -> None:
            self.registered: dict[str, set[str]] = {"GET": set(), "POST": set()}

        def get(self, path: str):
            self.registered["GET"].add(path)
            return lambda handler: handler

        def post(self, path: str):
            self.registered["POST"].add(path)
            return lambda handler: handler

    class FakeServer:
        def __init__(self) -> None:
            self.routes = FakeRoutes()

    fake = FakeServer()
    module = types.ModuleType("server")
    module.PromptServer = type("PromptServer", (), {"instance": fake})
    sys.modules["server"] = module

    check(server.register_routes() is True, "路由注册必须成功")
    check(fake.routes.registered["GET"] == {
        "/cvp/info", "/cvp/jobs/{job_id}", "/cvp/jobs/{job_id}/progress",
        "/cvp/jobs/{job_id}/output/{index}",
        "/vibedraw/v1/plugins", "/vibedraw/v1/capabilities",
        "/vibedraw/v1/jobs/{job_id}", "/vibedraw/v1/jobs/{job_id}/output/{index}",
    }, f"GET 路由不对: {sorted(fake.routes.registered['GET'])}")
    check(fake.routes.registered["POST"] == {
        "/cvp/jobs", "/cvp/jobs/{job_id}/cancel", "/cvp/translate",
        "/vibedraw/v1/jobs", "/vibedraw/v1/jobs/{job_id}/cancel", "/vibedraw/v1/translate",
    }, f"POST 路由不对: {sorted(fake.routes.registered['POST'])}")

    # 文档里播报的端点必须与实际注册的一致(除了占位符写法)
    for path in capabilities.ENDPOINTS.values():
        check(path in fake.routes.registered["GET"] or path in fake.routes.registered["POST"],
              f"文档播报的端点 {path} 没有注册")


def check_legacy_projection() -> None:
    described = translate.describe()
    plugins = legacy.plugins_document(resolve=fake_models, authorized=True, auth_required=True,
                                      translation=described, checkpoints=["a.safetensors"])
    check(plugins["schema"] == "vibedraw-comfy/discovery/v1", "旧发现文档的 schema 不许变")
    check(plugins["api_schema"] == "vibedraw-comfy/v2", "作业 API 版本不许跟着发现文档一起动")
    check(plugins["checkpoints"] == ["a.safetensors"], "checkpoints 要原样带出")
    check(plugins["auth"]["required"] is True and plugins["auth"]["authorized"] is True, "auth 要如实反映传入值")

    ids = [entry["id"] for entry in plugins["plugins"]]
    check(ids == capabilities.ids(), f"旧清单也要每条能力都在,得到 {ids}")
    by_id = {entry["id"]: entry for entry in plugins["plugins"]}
    check(by_id["render"]["english_only"] is False, "render 的编码器读得懂中文")
    check(all(by_id[task]["english_only"] for task in ("quick", "inpaint", "upscale")), "checkpoint 三族只吃英文")
    check(by_id["quick"]["model_roles"] == ["checkpoint"], "quick 只要一个 checkpoint")
    check(by_id["render"]["model_roles"] == list(settings.MODEL_ROLES), "render 要三个槽位")
    check(by_id["render"]["schema"]["properties"]["task"]["const"] == "render", "旧 schema 的 const 用新 id")
    check(by_id["upscale"]["sizes"] == [[1024, 1024], [2048, 2048]], "画幅不许变")
    check(by_id["quick"]["steps"]["allowed"] == [2, 4, 6, 8] and by_id["quick"]["steps"]["default"] == 8,
          "步数不许变")
    check(by_id["inpaint"]["schema"]["required"] == ["task", "image_base64", "mask_base64"], "inpaint 必带蒙版")
    check("mask_base64" not in by_id["quick"]["schema"]["properties"], "quick 不该有蒙版字段")
    grow = [item for item in by_id["inpaint"]["params"] if item["id"] == "grow_mask_by"]
    check(len(grow) == 1 and grow[0]["maximum"] == 64, "蒙版外扩要有,上限 64")
    policy = plugins["prompt_policy"]
    check(policy["english_only_pipelines"] == ["quick", "inpaint", "upscale"], "要翻的就是这三条")
    check(policy["any_language_pipelines"] == ["render"], "render 不该进必翻名单")
    check(policy["translate_endpoint"] == "/vibedraw/v1/translate", "旧翻译端点")

    old = legacy.capabilities_document(resolve=fake_models, authorized=False, auth_required=True,
                                       translation=described, checkpoints=["a.safetensors"],
                                       limits={"max_body_bytes": 1, "max_pending_jobs": 2})
    check(old["schema"] == "vibedraw-comfy/v2", "旧能力文档的 schema 不许变")
    check([task["id"] for task in old["tasks"]] == capabilities.ids(), "旧 tasks[] 也要每条都在")
    for task in old["tasks"]:
        for key in ("id", "label", "description", "needs", "sizes", "steps", "params", "estimated_seconds", "model"):
            check(key in task, f"旧 tasks[] 缺字段 {key}")
    check(old["tasks"][0]["model"] == "quick-checkpoint.safetensors", "旧 model 字段要给出实际用的文件")
    check(old["auth"]["required"] is True, "旧文档只报要不要密码")
    check(set(old["auth"]) == {"required", "scheme", "header", "hint"},
          "旧 /capabilities 的 auth 就这四个键,多一个都不算旧形状")
    check(old["checkpoints"] == ["a.safetensors"], "checkpoints 要原样带出")
    check(old["translate"]["available"] is False, "翻译可用性要带出")

    json.dumps(plugins, ensure_ascii=False)
    json.dumps(old, ensure_ascii=False)


def main() -> None:
    check_information_document()
    check_capability_lookup()
    check_boundary_rules()
    check_translation_memory()
    check_settings()
    check_nodes_read_the_table()
    check_server_surface()
    check_legacy_projection()
    check_routes()

    document = capabilities.document(
        resolve=lambda name: fake_models(capabilities.spec_of(name)),
        authorized=True, auth_required=True, translation=translate.describe(),
    )
    print(f"test_spec.py: ok ({len(document['capabilities'])} 个能力,"
          f"{len(document['input_schemas'])} 份输入 schema,"
          f"{translate.memory_size()} 条翻译记忆,"
          f"旧文档 {len(legacy.plugins_document(resolve=fake_models, authorized=True, auth_required=True, translation=translate.describe(), checkpoints=[])['plugins'])} 条插件)")


if __name__ == "__main__":
    main()
