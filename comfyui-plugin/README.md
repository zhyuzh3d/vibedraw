# CVP — ComfyUI VibeDraw Plugin

VibeDraw 的**统一本地接口**。任何客户端（VibeDraw 本体、其他开发者的工具、只会发 curl 的脚本）只要认下面这一个 HTTP 契约，就能用你已经装好的 ComfyUI 出图，**不需要自己导出工作流 JSON** —— 四套图都内置在插件里。

- 规范标识：`cvp/1`（响应体里的 `spec`）
- 接口根路径：`/cvp`（**路径不版本化**，永久固定）
- 契约文本：[`plans/cvp-spec.md`](../plans/cvp-spec.md)；落地计划：[`plans/cvp-plan.md`](../plans/cvp-plan.md)
- 目录：把 `vibedraw_comfy/` 整个放进 ComfyUI 的 `custom_nodes/`

**新客户端第一步先调 `GET /cvp/info`**（公开，不要密码）：它一次给出这台机器上**有哪些能力、每个能力收什么请求体、背后是哪几个模型文件、这条能力的编码器认不认中文、以及你带的密码对不对**。

## 安装

1. 拷贝目录：

   ```bash
   cp -r vibedraw_comfy  <你的 ComfyUI>/custom_nodes/vibedraw_comfy
   ```

   容器部署时把这个目录挂进去即可（宿主路径 → 容器 `custom_nodes/vibedraw_comfy`），改完重启 ComfyUI。

2. **没有额外依赖**，只用 ComfyUI 自带的 `aiohttp` / `folder_paths` / `execution`；也不用改 `requirements.txt`。

3. 重启后在 ComfyUI 节点菜单里搜 **VibeDraw**，会看到三个节点：

   | 节点 | 用途 |
   |---|---|
   | **VibeDraw 配置 (Config)** | **用户唯一需要操作的节点**：设密码 + 选三套 checkpoint + 高质量生图那一路的三个槽位 + 翻译后端地址 |
   | VibeDraw 输入 / 输出 | 内置图里引用的两个节点类；插件**不再接受**用户自备的自定义工作流 |

4. 想确认装好了：

   ```bash
   curl -s http://127.0.0.1:8188/cvp/info
   ```

   返回 JSON，且 `spec` 为 `cvp/1`、`plugin.version` 是你期望的那一版（当前 **2.2.0**）、每个能力的 `ready` 为 `true`，即成功。

   信息端点**密码填错也照答**（此时 `auth.authorized` 为 `false`），所以"地址对不对"和"密码对不对"可以一次问清：能返回 JSON 说明地址通，`authorized` 说明密码。

   **插件版本只有一个出处**：`vibedraw_comfy/version.py` 的 `__version__`。发布包名（`tools/package-plugin.py`）与 App 内嵌副本（`tools/embed-plugin.py`）都读它，不会各自漂移。

## 配置（VibeDraw 配置节点）

| 字段 | 说明 |
|---|---|
| `password` | **访问密码**。填了就只有带对密码的请求能出图；**留空 = 不校验**。 |
| `quick_checkpoint` | 快速生图用的模型，默认 `DreamShaper8_LCM.safetensors` |
| `inpaint_checkpoint` | 局部重绘用的模型，可填 `(same as quick)` 复用上一个 |
| `upscale_checkpoint` | 图像放大用的模型，同样支持 `(same as quick)` |
| `qwen_unet` / `qwen_text_encoder` / `qwen_vae` | 高质量生图（`render`）那一路的**三个槽位**（diffusion model / 文本编码器 / VAE），与上面的 checkpoint 互不影响 |
| `translate_prompts` / `translator_url` | 是否启用自动翻译，以及翻译后端地址 |

`render` 那一路要三个文件都填齐才算 `ready`；只填一半时信息接口会把它标成 `ready: false` 并在 `models[].missing` 里点名缺哪个槽位。

配置写在 `custom_nodes/vibedraw_comfy/vibedraw_settings.json`（原子写、可手工编辑）；也可以直接用环境变量 `VIBEDRAW_PASSWORD` 覆盖密码（适合容器/CI）。

**部署调参（手工编辑设置文件）**：`families.qwen_image_21.cache_device` / `cache_dtype` 控制 Qwen 的 KV 缓存（默认 `auto` / `default`，即模型作者的建议值）。**显存吃紧的机器**在设置文件里改成 `cache_dtype: "int8"` —— 插件不会替某台机器做这个假设，环境变量 `VIBEDRAW_TRANSLATE_URL` / `VIBEDRAW_TRANSLATE_MODEL` / `VIBEDRAW_TRANSLATE_DISABLED` 同理。

**密码错了会怎样**：请求在**入队之前**就被拦下，返回 `401 unauthorized`，**不会生图**。客户端拿到的是一句可读的中文提示，而不是一张画错的图。

## 四个能力

能力 id 是**语义名**（`render`，不是 `qwen`），模型换了 id 不变。客户端只报 `capability`，画幅/步数由插件按能力声明校验，超出枚举直接 `400`：

| `capability` | `category` | 画幅 | 步数 | 参考图权重默认 | 提示词语言 | 说明 |
|---|---|---|---|---|---|---|
| `quick` | `realtime` | 512×512 | 2 / 4 / 6 / 8 | 0.55 | **只认英文** | 把画布当参考图重绘一张速写稿 |
| `inpaint` | `edit` | 512×512 | 4 / 6 / 8 / 12 | 0.30（另有 `grow_mask_by` 0–64 默认 8） | **只认英文** | **只重画白色蒙版区域**，其余原样保留 |
| `upscale` | `upscale` | 1024×1024 或 2048×2048 | 4 / 8 / 12 / 16 / 20 | 0.75 | **只认英文** | 参考图按**原分辨率**（上限 1024）直接编码；只有目标大于上限时才 latent 放大。**不要退回"先缩到 512 再放大"**——那等于在采样器看到参考图之前先模糊它一轮，渲染出来会发软、像被重新演绎过。 |
| `render` | `render` | 512–1024 见方，按 64 步进（9 档） | 12 / 16 / 20 / 25 / 30 / 40 | 0.95 | **中英文都行** | 用 Qwen-Image 2.1（官方 INT8）出 1024 以内的成品图。它**按参考图作画**而不是在画布上做图生图，构图由参考图本身带来；比草图模型重得多，单张约 45 秒；模型是 unet + clip + vae 三元组。它声明 `ignores: ["negative_prompt"]`（按 cfg 1 采样，反向提示词没有作用面）。 |

`render` 的 `aliases` 是 `["qwen"]`：它**曾经**拿模型名当 id，那是个错误示范，留别名只为不断掉已经发出去的客户端。

**推荐模型**：DreamShaper8 LCM 系列（512 分辨率通常 1 秒左右出图）。`quick` / `inpaint` 建议就用它，不必换；`upscale` 用能接受 512 参考图、输出 1024/2048 的模型即可。`render` 走 Qwen-Image 那一族，与前三套的 checkpoint 完全独立。

### 语言：谁认中文，由能力自己报

`quick` / `inpaint` / `upscale` 是 **SD1.5 + CLIP-L** 结构，文本编码器只吃英文；`render` 的编码器是 **Qwen3-VL**，中文是它的母语。这不是猜的，是两条独立证据：

- 官方口径：Qwen-Image 系支持中英双语提示词，SD1.5 / SDXL 那套 CLIP-L 不支持。
- 真机实测：固定 seed 与参考图，只换提示词跑四单 `render`，比较逐像素平均差。**中文 vs 它的英文译文 12.38，中文 vs 无关提示词 21.40，中文 vs 空提示词 27.73**——中文把画面带到了它英文译文去的地方，噪声做不到这件事。

于是每个能力的 `prompt.language` 是 `"en"` 或 `"any"`，客户端**不要自己写死**。

### 翻译：推荐流程，不是规则

`prompt.language` 为 `"en"` 的能力，如果提示词**含非 ASCII 可打印字符**（中文、俄语、希腊语、阿拉伯语、泰语都算），插件在**提交时自己翻**：

```
提交 → 需要翻? ─否→ 用原文建图
              └是→ 查翻译记忆库 ─命中→ 用译文
                              └未命中→ 调翻译后端 → 成功则存库并用译文
                                                    └失败→ 用原文建图(任务不失败)
```

- 客户端**可以**先调 `POST /cvp/translate` 把译文显示给用户，也可以什么都不做 —— 什么都不做也不会把中文喂进只认英文的编码器。
- **判据是"是不是全 ASCII"**，不是"有没有中文"：CLIP-L 对西里尔/希腊字母一样两眼一抹黑，只看中日韩会让它们原样过去变成噪声。
- 记忆库落盘在插件目录的 `vibedraw_translations.json`，重装、重启都不丢。**键 = 原文 + 目标语言**：一条翻译是语言事实，与哪个引擎翻的无关；引擎与提示词版本作为旁注记下来（将来换更好的引擎重刷时按它筛），不进键。
- 后端只要求 **OpenAI 兼容的 `POST {url}/v1/chat/completions`**（llama.cpp / vLLM / Ollama / 各家云 API 都行）。**默认地址是空的，也就是关闭** —— 插件不替任何部署写死一个地址。

### `ref_strength` 是唯一的权重入口

它是"**参考图权重**"：越高越贴近你画的原稿，越低越放手重画，值域 **0.05–0.95**（越界会被夹到边界并在 `job.ref_strength` 回显，不报错）。至于实现怎么做到，是各家族自己的事：

- 图生图家族（`checkpoint`）把它换算成去噪强度：`denoise = clamp(1 - ref_strength, 0.05, 1.0)`；
- 参考条件生成家族（`qwen_image_21`）没有可保留的初始 latent，改成**把参考图本身柔化**：越高越原样交给编码器，越低肢体轮廓越发散。

两种机制都满足"越大越贴近"，所以都合规，客户端滑杆逻辑完全一样。

## HTTP 契约

| 方法 | 路径 | 鉴权 | 说明 |
|---|---|---|---|
| `GET` | `/cvp/info` | **公开** | 信息文档：能力清单 + 共享请求 schema + 每个能力的模型槽位与就绪状态 + 翻译可用性。密码错了也照答，由 `auth.authorized` 说明 |
| `POST` | `/cvp/jobs` | Bearer | 提交作业 → **202** `{"job": {…}}` |
| `GET` | `/cvp/jobs/{id}` | Bearer | 状态 + 提示词 + `outputs`（较重，完成后再调） |
| `GET` | `/cvp/jobs/{id}/progress` | Bearer | **高频轮询用**：只回 `{id, state, queue_position, progress}`，不解析结果 |
| `GET` | `/cvp/jobs/{id}/output/{n}` | Bearer | 取成图（直接返回 PNG） |
| `POST` | `/cvp/jobs/{id}/cancel` | Bearer | 取消排队中的作业 |
| `POST` | `/cvp/translate` | Bearer | 提前翻译（可选，用于把译文显示给用户） |

**`progress` 允许为 `null`，而且经常就是 `null`。** 编一个假百分比比给 `null` 更糟；`queue_position`（前面还有几个作业，自己在跑时为 0）是任何实现都算得出来的可靠数字，客户端用不确定态 + 队列位置就够了。

### 提交体（`txt-ref2img/v1`，四个能力共用一份）

```json
{
  "capability": "quick",
  "prompt": "a red fox",
  "negative_prompt": "",
  "seed": 12345,
  "size": [512, 512],
  "steps": 8,
  "ref_strength": 0.55,
  "image_base64": "data:image/png;base64,...",
  "mask_base64": "data:image/png;base64,...",
  "grow_mask_by": 8
}
```

- `capability` 也可以用旧名 `task`（等价，两者同时出现时以 `capability` 为准）。
- `image_base64`：参考图（画布）。`inpaint` 必带 `mask_base64`（**白 = 要重画**）。图片可直接给 data URL，插件自己解码；请求体上限 32 MB。
- **两条统一规则**：枚举值（`size` / `steps`）越界 → `400`；连续量（`ref_strength`）越界 → 夹到边界并在 `job` 回显。
- 鉴权：`Authorization: Bearer <password>`（也接受 Basic 或 `X-VibeDraw-Password`）。密码为空时不需要。
- 能力若在 `ignores` 里声明了某字段（如 `render` 的 `negative_prompt`），**不要发**；发了也会被忽略，并在 `job.ignored` 里回显，好让客户端提示用户而不是让人以为参数生效了。
- 完成后的 `outputs[n].url` 已经是 `/cvp/jobs/...` 绝对路径，**客户端直接拼服务器地址去下就行，不要再拼一层**。

`job` 对象里三个字段回答"提示词到底发生了什么"：`prompt_source` 是客户端给的原文、`prompt` 是实际送进模型的那份、`translated` 表示两者是否不同。

错误码：`unauthorized(401)` / `bad_request` / `unsupported_capability` / `unsupported_size` / `unsupported_steps` / `bad_image` / `bad_mask` / `no_model(409)` / `invalid_workflow` / `busy(429)` / `not_found(404)` / `internal(500)`，全部带可读中文文案。

### 旧路径（兼容，别再用）

已发出的客户端（含 PoseGi）读的是 `/vibedraw/v1/plugins` 与 `/vibedraw/v1/capabilities`。这些路径**继续返回旧的文档形状**（由同一张能力表投影生成），`/vibedraw/v1/jobs*` 与 `/cvp/jobs*` 是**同一批处理函数**，请求侧 `task` / `capability` 都认。旧路由仍用旧错误码 `unsupported_task`，并继续给 `job.progress` 一个估算百分比（新路径给 `null`）。

这些兼容层是**临时的**，集中在 `vibedraw_comfy/legacy.py` 一个文件里；等 PoseGi 改读 `/cvp/info` 之后整份删除。

## 自测

```bash
# 0. 离线自检（不需要 ComfyUI、不需要网络）
python3 tests/test_spec.py

# 1. 信息接口：有哪些能力、各自收什么、谁只认英文、模型就绪没
curl -s http://<host>:8188/cvp/info

# 2. 提交 + 轮询 + 取图
curl -s -X POST http://<host>:8188/cvp/jobs \
  -H 'Authorization: Bearer <password>' -H 'Content-Type: application/json' \
  -d '{"capability":"quick","prompt":"a red fox","seed":1,"size":[512,512],"steps":8,"ref_strength":0.55}'

curl -s -H 'Authorization: Bearer <password>' http://<host>:8188/cvp/jobs/<id>/progress
curl -s -H 'Authorization: Bearer <password>' -o out.png http://<host>:8188/cvp/jobs/<id>/output/0

# 3. 中文提示词（quick 只认英文，插件会自动译英，响应里 translated: true）
curl -s -X POST http://<host>:8188/cvp/jobs \
  -H 'Authorization: Bearer <password>' -H 'Content-Type: application/json' \
  -d '{"capability":"quick","prompt":"一只红色的狐狸","image_base64":"data:image/png;base64,..."}'
```

用 `python3 -m json.tool` 过一遍第 1 步的返回，重点确认三件事：`spec` 是 `cvp/1`、`capabilities` 有你预期的四条且 `ready` 为 `true`、`input_schemas` 只有一份。

- **第一次请求会慢**（模型加载，约十几秒），之后同模型重跑约 1 秒；别用首单判断"模型太慢"。
- 在 VibeDraw App 里对接：设置 → 模型配置 → 接口模式选「CVP 插件（推荐）」，服务器地址填 `http://<host>:<port>`，访问密码填节点里设的那个。
