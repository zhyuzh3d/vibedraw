# CVP 规范 v1

CVP 是一套**图像能力接口规范**, 面向"把画布交给后端重画"这一类客户端。它规定的是**输入输出格式**, 不规定后端用什么模型、什么节点、什么采样器。

当前唯一实现是 `comfyui-plugin/vibedraw_comfy`(ComfyUI 自定义节点), 它同时是**样板实现**: 里面绑定的模型名、采样参数、节点图都是针对特定模型的建议, 可以被替换而**不改变本规范**。

---

## 0. 三条设计原则

1. **规范只定对外契约。** 字段名、字段含义、取值范围、错误码属于规范; 用什么模型、怎么搭图、怎么加速属于实现。同一个字段在不同实现里可以用不同机制达成, 只要**方向与值域一致**。
2. **路径不版本化。** 协议版本号放在响应体里, 路径永久不变。客户端永远不需要"猜新版路径"。
3. **只加不删。** 同一个 `spec` 大版本内: 服务端只新增字段、新增能力; 不删字段、不改已有字段的含义、不改已发布能力的 `id` / `category` / `signature` / `input`。客户端**必须忽略**不认识的字段与不认识的能力。

---

## 1. 三类接口

| 类别 | 路径 | 鉴权 | 用途 |
|---|---|---|---|
| **信息** | `GET /cvp/info` | **公开** | 客户端开机第一件事: 这台后端有什么能力 |
| **生成** | `/cvp/jobs…` | Bearer | 提交作业、取结果、取消 |
| **进度** | `GET /cvp/jobs/{id}/progress` | Bearer | 高频轮询的轻量接口 |

分三类的目的: 客户端**先拿到能力列表再干活**; 高频轮询不碰结果解析; 信息接口可以自由被探测而不需要先配好密码。

### 1.1 信息接口 `GET /cvp/info`

**公开(不校验密码)**。密码错了也照常返回, 由 `auth.authorized` 说明。

```json
{
  "spec": "cvp/1",
  "plugin": { "id": "vibedraw_comfy", "version": "2.2.0",
              "label": { "zh": "ComfyUI VibeDraw 插件", "en": "ComfyUI VibeDraw Plugin" } },
  "auth": { "required": true, "authorized": false, "scheme": "Bearer",
            "header": "Authorization", "hint": "密码在 ComfyUI 的 VibeDraw 配置节点里设置。" },
  "endpoints": {
    "info":     "/cvp/info",
    "jobs":     "/cvp/jobs",
    "job":      "/cvp/jobs/{job_id}",
    "progress": "/cvp/jobs/{job_id}/progress",
    "output":   "/cvp/jobs/{job_id}/output/{index}",
    "cancel":   "/cvp/jobs/{job_id}/cancel",
    "translate":"/cvp/translate"
  },
  "input_schemas": { "txt-ref2img/v1": { "…": "见第 4 节" } },
  "capabilities": [ { "…": "见第 3 节" } ],
  "translation": { "…": "见第 5 节" },
  "models": { "available": { "checkpoint": ["…"], "unet": ["…"], "clip": ["…"], "vae": ["…"] } }
}
```

- `spec` 是**协议版本**, 是整份文档里唯一表示"你是哪一版规范"的字段。
- `endpoints` 里给的是**相对路径**。客户端必须从这里取, 不要自己拼路径 —— 这是"路径可以演进而客户端不用改"的唯一保证。实际上规范承诺路径不变, `endpoints` 是为了可读性与自描述。
- `auth.authorized` 让一次调用同时回答"地址通不通"和"密码对不对"。

### 1.2 生成接口

| 方法 | 路径 | 说明 |
|---|---|---|
| `POST` | `/cvp/jobs` | 提交 → `202` `{"job": {…}}` |
| `GET` | `/cvp/jobs/{id}` | 状态 + 结果 (较重, 完成后再调) |
| `GET` | `/cvp/jobs/{id}/output/{index}` | 取图, `image/png` 直出 |
| `POST` | `/cvp/jobs/{id}/cancel` | 取消排队中的作业 |

提交体的字段定义见第 4 节。`202` 返回完整 `job` 对象(结构见 1.4)。

### 1.3 进度接口 `GET /cvp/jobs/{id}/progress`

高频轮询用, 只返回三个字段, 不做结果解析:

```json
{ "job": { "id": "…", "state": "running", "queue_position": 0, "progress": null } }
```

**`progress` 允许为 `null`, 而且经常就是 `null`。** 规范不要求后端能给出百分比 —— 编一个假的百分比比给 `null` 更糟。`null` 时客户端应显示"进行中"这类不确定态。

`queue_position` 是前面还有几个作业(自己在跑时为 `0`, 未知为 `null`)。这个数任何实现都算得出来, 是可靠的。

### 1.4 `job` 对象

```json
{
  "id": "8f3c…",
  "capability": "quick",
  "state": "queued | running | completed | failed | cancelled",
  "queue_position": 2,
  "progress": null,
  "created": 1758783600.12,
  "typical_seconds": 1.2,
  "prompt": "a cat on a sofa",
  "prompt_source": "一只猫在沙发上",
  "translated": true,
  "ignored": ["negative_prompt"],
  "outputs": [
    { "index": 0, "url": "/cvp/jobs/8f3c…/output/0",
      "media_type": "image/png", "filename": "vibedraw_00001_.png",
      "subfolder": "vibedraw/quick", "type": "output" }
  ],
  "error": "节点名: 原因"
}
```

- `typical_seconds` 只是**参考值**(样板实现的实测量级), 客户端不得据此推算进度。
- `prompt` 是**实际送进模型的那份**(可能是自动翻译的结果), `prompt_source` 是客户端给的原文, `translated` 表示两者是否不同。客户端把 `prompt_source` 显示给用户, 把 `prompt` 用于复现。
- `ignored` 列出本次请求里**被忽略的字段**。客户端据此提示用户, 而不是让用户以为自己设的参数生效了。
- `outputs[].url` 是绝对路径, 客户端**不要**再拼一次 base。

---

## 2. 模态签名

能力用**签名**声明"吃什么、吐什么"。签名是机器读的: 客户端据此判断"我能不能处理这个能力的输出"。

```
<签名> ::= <输入> "2" <输出>
<输入> ::= <模态> ("-" <模态>)*
<模态> ::= txt | img | mask | ref | refs
<输出> ::= img | glb | 3dgs | mesh
```

规则(必须遵守, 否则签名不可解析):

- **以最后一个 `2` 为界**, 左侧是输入、右侧是输出。
- **签名里除分隔符 `2` 以外不出现数字**(否则 `txt-ref23dgs` 就无法判断是 `ref2`+`3dgs` 还是 `ref`+`23dgs`)。
- `ref` = 恰好一张参考图; `refs` = 一张或多张。`refs` 涵盖 `ref`。
- `img` 指客户端的位图; `3dgs` 指高斯点云。

已知与规划中的签名:

| 签名 | 含义 | 状态 |
|---|---|---|
| `txt-ref2img` | 文本 + 一张参考图 → 图像 | 当前四个能力都用它 |
| `txt-refs2img` | 文本 + 多张参考图 → 图像 | 规划中 |
| `txt-ref2glb` | 文本 + 一张参考图 → glTF 模型 | 规划中 |
| `txt-ref23dgs` | 文本 + 一张参考图 → 3D 高斯点云 | 规划中 |

---

## 3. 能力 `capabilities[]`

```json
{
  "id": "quick",
  "aliases": [],
  "category": ["realtime"],
  "signature": "txt-ref2img",
  "input": "txt-ref2img/v1",
  "output": { "modality": "img", "media_type": "image/png", "delivery": "url" },
  "label": { "zh": "快速生图", "en": "Quick draw" },
  "description": { "zh": "…", "en": "…" },
  "prompt": { "language": "en" },
  "needs": { "prompt": true, "image": true, "mask": false },
  "ignores": [],
  "values":   { "size": [[512,512]], "steps": [2,4,6,8] },
  "defaults": { "size": [512,512], "steps": 8, "ref_strength": 0.55 },
  "models": [ { "role": "checkpoint", "name": "DreamShaper8_LCM.safetensors",
                "ready": true, "missing": [] } ],
  "ready": true,
  "typical_seconds": 1.2
}
```

| 字段 | 含义 |
|---|---|
| `id` | **稳定标识**, 永不复用、永不改。取语义名, **不许取模型名** —— 换模型不许改 `id`。 |
| `aliases` | 历史名或旧客户端用名, 提交时等价于 `id`。用于重命名时不断掉老客户端。 |
| `category` | **功能类别**, 数组, 见下。客户端用它分组筛选, 不必认识 `id`。 |
| `signature` | 模态签名, 见第 2 节。 |
| `input` | 指向 `input_schemas` 里的键。同一签名共用一份 schema。 |
| `output` | 输出模态与媒体类型。 |
| `prompt.language` | `"en"` = 文本编码器只吃英文(触发第 5 节的自动翻译); `"any"` = 能读中文。 |
| `needs` | 哪些输入是必需的, 决定第 4 节里哪些字段必填。 |
| `ignores` | **本能力声明了但不会生效的字段**。客户端不应发送; 若发送, 服务器忽略并在 `job.ignored` 回显。 |
| `values` | 该能力允许的**枚举值**(画幅、步数)。同一字段在能力之间只有允许集合不同, 含义不变。 |
| `defaults` | 客户端不传时的取值。 |
| `models` | **实现挂载点**: 每个角色一个条目。这就是"对内可替换"的接口 —— 客户端只看到"哪个角色、什么文件、装了没"。 |
| `ready` | 所有角色都就绪。`false` 时提交会得到 `no_model`。 |
| `typical_seconds` | 参考耗时, 非承诺。 |

### 3.1 功能类别

类别是**开放集合**; 客户端必须忽略不认识的类别。

| `category` | 含义 |
|---|---|
| `realtime` | 一两秒内出图, 适合边画边看 |
| `edit` | 在已有画面上做局部修改 |
| `upscale` | 放大并补细节, 尽量不改构图 |
| `render` | 重画成成品图, 对参考图的跟随度低于 `edit` |

### 3.2 当前能力清单(样板实现)

| `id` | `category` | `prompt.language` | 画幅 | 步数 | 参考图权重默认 |
|---|---|---|---|---|---|
| `quick` | `["realtime"]` | `en` | 512² | 2/4/6/8 | 0.55 |
| `inpaint` | `["edit"]` | `en` | 512² | 4/6/8/12 | 0.30 |
| `upscale` | `["upscale"]` | `en` | 1024²,2048² | 4/8/12/16/20 | 0.75 |
| `render` | `["render"]` | `any` | 512²…1024²(步进64) | 12/16/20/25/30/40 | 0.95 |

`render` 的 `aliases` 为 `["qwen"]` —— 它**曾经**用模型名当 id, 那是错的示范, 保留别名只为不断掉老客户端。

---

## 4. 共享输入 schema: `txt-ref2img/v1`

同一签名的能力**共用一份 schema**。能力只在自己的 `values` / `defaults` 里收窄允许值。这样客户端写一次调用逻辑就能调所有 `txt-ref2img` 能力。

| 字段 | 类型 | 必填 | 语义(冻结) | 越界处理 |
|---|---|---|---|---|
| `capability` | string | 是 | 能力 `id` 或它的 `aliases` | 不认 → `400 unsupported_capability` |
| `prompt` | string | 否 | 画面描述。是否先译英由 `prompt.language` 决定(第 5 节) | — |
| `negative_prompt` | string | 否 | 不想出现的内容。能力在 `ignores` 里声明了则忽略并回显 | — |
| `image_base64` | string | 看 `needs.image` | 参考图, base64 PNG/JPEG, 允许带 `data:` 前缀 | `400 bad_image` |
| `mask_base64` | string | 看 `needs.mask` | 蒙版, **黑底白区, 白 = 要重画** | `400 bad_mask` |
| `size` | [int, int] | 否 | 输出画幅。**必须是本能力 `values.size` 里的值** | `400 unsupported_size` |
| `steps` | int | 否 | 采样步数。**必须是本能力 `values.steps` 里的值** | `400 unsupported_steps` |
| `seed` | int | 否 | `0` = 每次不同; 同一个值可复现 | 负数 → `400 bad_request` |
| `ref_strength` | number | 否 | **0.05–0.95, 越大越贴近参考图** | 夹到边界并在 `job` 回显 |

两条统一规则, 全规范只写一次:

1. **枚举值越界 = 报错**(`size` / `steps`)。
2. **连续量越界 = 夹到边界并回显**(`ref_strength`)。

### 4.1 `ref_strength` 为什么要这样定

它只声明**方向**(越大越贴近参考图)和**值域**(0.05–0.95)。至于实现怎么做到:

- 在 img2img 家族里可能是"降低去噪强度"(`denoise = 1 − ref_strength`);
- 在参考条件生成家族里可能是"把参考图柔化"(它没有可保留的初始 latent, 靠模糊表达"别抄得那么紧");

两种机制都满足"越大越贴近", 因此**都合规**。客户端的滑竿、文案、默认值处理逻辑完全一样。**同一字段在不同实现里含义相同、机制不同, 这正是规范与实现的分界线。**

### 4.2 `capability` 与历史别名

请求里也接受 `task`, 等价于 `capability`(旧客户端仍在用)。两者同时出现时以 `capability` 为准。

---

## 5. 翻译: 推荐流程

**这是推荐流程, 不是规则。** 客户端可以自己先翻译、可以把译文展示给用户; 后端在提交时兜底, 只是为了"客户端什么都不做也不会做错"。

### 5.1 触发条件(两个都满足才翻)

1. 该能力的 `prompt.language == "en"`;
2. `prompt` **含非 ASCII 可打印字符**。

第 2 条刻意不是"含中日韩文"。俄语、希腊语、阿拉伯语、泰语同样会让只认英文的文本编码器变成噪声 —— 判据必须是"**是不是全 ASCII**", 而不是"有没有中文"。

### 5.2 流程

```
提交 → 需要翻? ─否→ 用原文建图
              └是→ 查翻译记忆库 ─命中→ 用译文的
                              └未命中→ 调翻译后端 → 成功则存库并用译文
                                                    └失败→ 用原文建图(任务不失败)
```

无论走哪条路, 响应里的 `prompt` / `prompt_source` / `translated` 三个字段都会如实告诉你发生了什么。

### 5.3 翻译记忆库

- 落盘在同目录 `vibedraw_translations.json`, 重装插件、重启进程都不丢。
- **键 = 原文 + 目标语言。**
  一条翻译是**语言事实**: "一只猫在沙发上 → a cat on a sofa" 对不对, 与哪个引擎翻的无关, 也与源语言是什么无关(原文自己就确定了它)。所以引擎、模型、提示词版本**都不进键**。
- 引擎与时间作为**旁注**存在条目里 `{source, target, text, engine, model, created}` —— 不进键, 但留着。将来想用更好的引擎把整库重刷一遍时, 靠它筛。
- 失败不入库。上限可配, 超出按最旧淘汰。
- 记忆库存在**后端**而不是客户端, 意义在于: 任何客户端(包括只会发 curl 的第三方工具)都自动共享同一份成果。

### 5.4 `POST /cvp/translate`

给"想提前预热"或"想给用户看译文"的客户端用, 不是必需步骤。

请求 `{ "texts": ["…"], "target": "en" }` →
`{ "engine": "…", "target": "en", "available": true,
   "results": [ { "source": "…", "text": "…", "translated": true, "cached": true } ] }`

- 纯 ASCII 的文本原样返回, `translated: false`, `reason: "not_needed"`。
- 任何失败都返回原文, 绝不丢用户写的内容。

### 5.5 后端

翻译后端只要求一条: 提供 **OpenAI 兼容的 `POST {url}/v1/chat/completions`**。这一条覆盖 llama.cpp、vLLM、Ollama、各家云 API。**后端地址没有默认值** —— 默认是空的, 也就是关闭。规范不允许厂商把某一个部署的地址写进默认值。

---

## 6. 错误

```json
{ "error": "no_model", "message": "…", "detail": { … } }
```

| `error` | HTTP | 含义 |
|---|---|---|
| `unauthorized` | 401 | 密码不对, 未入队 |
| `bad_request` | 400 | 请求体不是合法 JSON / 字段类型不对 |
| `unsupported_capability` | 400 | 不认识这个能力 |
| `unsupported_size` | 400 | 画幅不在该能力的 `values.size` 里 |
| `unsupported_steps` | 400 | 步数不在该能力的 `values.steps` 里 |
| `bad_image` | 400 | 参考图不是合法 base64 PNG/JPEG |
| `bad_mask` | 400 | 需要蒙版但没给 / 不合法 |
| `no_model` | 409 | 能力声明的模型角色没配齐 |
| `invalid_workflow` | 400 | 生成图校验失败(多为节点或模型缺失) |
| `busy` | 429 | 队列已满 |
| `not_found` | 404 | 作业不存在 / 已过期 |
| `internal` | 500 | 后端内部错误 |

`message` 是给人看的, 客户端可以直接显示; `detail` 是给程序看的, 结构随 `error` 而变。

---

## 7. 与其他规范的取舍

**借了 MCP 的三样思想**:

- `capabilities[]` 的形状对应 MCP 的 tool descriptor(`name` / `title` / `description` / `inputSchema`);
- `input_schemas` 用完整 JSON Schema, 而不是"表单够用的子集";
- `spec` 字段对应 MCP `initialize` 的协议版本协商 —— 都靠"版本在消息里"而不是"版本在路径里"。

**没有采用 MCP 的传输层**, 原因有三: MCP 没有标准化的图片上传通道(而本规范的请求体要内联最多几十 MB 的 base64 图); MCP 客户端是有状态机(会话 ID、SSE), 而这里的客户端很多只是一个 WebView 里的几十行 HTTP 调用; 作业模型是"提交 → 轮询 → 取图", 而轮询对"切后台 / 断网重连"比长连接更稳。

**将来若需要**让 LLM 代理直接调用, 可以再挂一个 `/mcp` 门面, 由**同一份**能力定义生成 —— 那是第二个投影, 不是重写。

---

## 8. 明确不做(收敛清单)

以下都是**有意不做**, 不是遗漏:

- 不做 OpenAPI 文档生成。
- 不做 MCP / JSON-RPC 门面(留作将来的第二个投影)。
- 不做推送、SSE、Webhook(轮询够用且更稳)。
- 不做多目标语言的翻译(`target` 只有 `en`; 记忆库的键留了位置)。
- 不做能力级独立版本号(签名 + `input` 已经足够)。
- 不做插件化的家族注册机制(样板实现里两个家族, 两个普通模块就够)。
- 不做账号、配额、计费、权限分级(一把密码已经够)。
- 不做 `deprecated` 之类的字段 —— **不定义用不到的东西**。真需要下线能力时按第 0 节第 3 条走。
