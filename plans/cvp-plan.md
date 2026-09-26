# CVP 开发计划

依据: [`cvp-spec.md`](./cvp-spec.md)(CVP 规范 v1)。
范围: **CVP 插件全面升级** + **A1X 上 ComfyUI 的 CVP 能力升级** + **Vibedraw 应用升级**。
**PoseGi 本轮不动** —— 但它的存量调用必须继续可用(见第 3.3 节)。

---

## 0. 约束(动手前先认下来)

- **收敛优先。** 不引入注册机制、不引入依赖、不做规范里第 8 节列出的"不做"清单。
- **插件是独立产物**, 不走 happ 打包链。`vibedraw_comfy/` 目录本身就是要拷到 ComfyUI 的东西。
- **只升插件的版本号**(`version.py`: `2.1.0` → `2.2.0`), 因为插件版本会通过 `plugin.version` 对外播报。
  **不升 happ 版本、不生成新的 happ 发布包**(`release/vibedraw-v0.4.38.zip` 之类) —— 那不是本次任务。
- 插件 zip 要照常生成一次(`tools/package-plugin.py`)并重新生成应用内嵌副本(`tools/embed-plugin.py`),
  因为应用的"下载插件"功能依赖它, 且内嵌副本与源码必须一致。
- **每一步做完立即做与该步直接相关的验证**, 不攒到最后一起来。

---

## 1. 阶段划分与验收判据

| 阶段 | 内容 | 验收判据(必须可执行) |
|---|---|---|
| P0 | 规范冻结 | `plans/cvp-spec.md` 落盘; 第 8 节"不做"清单确认 |
| P1 | 插件: 能力模型 + 信息接口 | `GET /cvp/info` 200, `spec == "cvp/1"`, 4 个能力, `input_schemas` 只有 1 份; 离线测试通过 |
| P2 | 插件: 家族拆分 | 两个家族模块独立; 生成图与拆分前**逐节点等价**; 离线测试通过 |
| P3 | 插件: 三类接口 | `/cvp/*` 七条路由全通; 旧 `/vibedraw/v1/*` 仍返回**旧形状**; `/progress` 轻量 |
| P4 | 插件: 自动翻译 + 记忆库 | 中文提示词提交 → `translated: true` 且出图; 重启进程后同一提示词命中缓存 |
| P5 | 插件: 去设备化 | 默认翻译地址为空; qwen 缓存参数进设置; 进度不再用 `estimated_seconds` 编造 |
| P6 | 插件: 离线测试 | `python3 tests/test_spec.py` 通过, 覆盖信息文档/签名/别名/记忆库/越界规则 |
| P7 | A1X 部署 | 两侧摘要一致; `/cvp/info` 200; 旧 `/vibedraw/v1/plugins` 仍 200; 真机中文单出图 |
| P8 | 应用: 去翻译 + 消费新接口 | `translate.js` 及引用全清; 测试连接读 `/cvp/info`; 不再硬编码画幅/步数 |
| P9 | 应用: 热更新到设备 | 设备上实测: 连接 → 出图 → 中文提示词自动译英提示 |

---

## 2. 阶段明细

### P1 插件: 能力模型与信息接口

**新增** `comfyui-plugin/vibedraw_comfy/capabilities.py`, 承担三件事:

1. `CAPABILITIES` —— 能力定义表(从 `workflows.TASK_SPECS` 迁移并重命名):

   | 旧 | 新 |
   |---|---|
   | `params[]` 里混着画幅/步数概念 | `values: {size, steps}` + `defaults: {size, steps, ref_strength}` |
   | `english_only` | `prompt: {language: "en" \| "any"}` |
   | `estimated_seconds` | `typical_seconds`(仅参考) |
   | 无 | `category[]` / `signature` / `input` / `output` / `ignores` / `aliases` |

   能力重命名: `qwen` → **`render`**, `aliases: ["qwen"]`。

2. `INPUT_SCHEMAS` —— 共享输入 schema。**所有 `txt-ref2img` 能力共用一份**。
   字段语义按规范第 4 节冻结; `ref_strength` 统一 `0.05–0.95`(upscale 原先声明 `0.30` 起, 收齐)。

3. `document(...)` —— 生成信息文档; `resolve(name)` —— 把 `id` 或 `aliases` 解析成能力;
   `validate_values(...)` —— 枚举校验(越界抛错), `clamp_ref_strength(...)` —— 连续量夹边。

**删除** `discovery.py`(职责被 `capabilities.py` 取代, 不留两份文档构建器)。

**判据**: `GET /cvp/info` 200 且 `spec == "cvp/1"`; `capabilities` 恰好 4 条且无 `qwen`;
`input_schemas` 恰好 1 份; `python3 tests/test_spec.py` 通过。

### P2 插件: 家族拆分

**新增** `families/` 子包:

- `families/checkpoint.py` —— SD1.5/LCM 家族: 模型槽位 `("checkpoint",)`; `denoise_from_reference()`;
  `build(...)` 产出原有那张图(CheckpointLoaderSimple → VAEEncode(+Inpaint) → KSampler)。
- `families/qwen_image.py` —— Qwen-Image 2.1 家族: 模型槽位 `("unet","clip","vae")`;
  `reference_fade()` / 参考图柔化; `build(...)` 产出原有那张图(UNETLoader + CLIPLoader + VAELoader +
  QwenImage21Cache + TextEncodeQwenImage21 + 空 latent 采样)。

`families/__init__.py` 只放一张显式映射表 `FAMILIES = {"checkpoint": checkpoint, "qwen_image_21": qwen_image}`。**不做注册机制、不做自动发现。**

`workflows.py` 缩成瘦派发层: `build()` 按能力声明的 `family` 取模块; `family()`、`validate()` 保留。
`QWEN_*` / `UPSCALE_ENCODE_MAX` 等常量随家族下沉, 不再污染通用层。

**判据**: 对同一组输入, 拆分前后 `build()` 产出的节点表**逐键等价**(用离线自检脚本对比两份输出)。

### P3 插件: 三类接口

`server.py` 注册七条新路由:

```
GET  /cvp/info
POST /cvp/jobs
GET  /cvp/jobs/{job_id}
GET  /cvp/jobs/{job_id}/progress
GET  /cvp/jobs/{job_id}/output/{index}
POST /cvp/jobs/{job_id}/cancel
POST /cvp/translate
```

要点:

- **`/progress` 轻量**: 只回 `{id, state, queue_position, progress}`, **不解析 outputs**。
- `progress` 可以为 `null`(**不再用 `estimated_seconds` 编百分比**); 新增 `queue_position`。
- `job` 对象新增 `capability`(旧 `task` 保留)、`queue_position`、`prompt`、`prompt_source`、
  `translated`、`ignored`、`typical_seconds`; `outputs[]` 每项加 `index` 与 `media_type`。
- `errors` 增 `unsupported_capability`(`unsupported_size` / `unsupported_steps` 保留)。
- **枚举越界报错; `ref_strength` 夹边并回显** —— 提交时把实际生效值回填进 `job`。

**兼容别名**(见 3.3): 旧路由**返回旧形状**, 不返回新文档。

**判据**: 七条新路由全部可调; 旧 `/vibedraw/v1/capabilities` 仍含 `schema: "vibedraw-comfy/v2"`、
`tasks[]`、`auth.required`; 旧 `/vibedraw/v1/plugins` 仍含 `plugins[]` 且每项有 `english_only`/`sizes`/`steps`。

### P4 插件: 自动翻译 + 持久化记忆库

`translate.py`:

- **判据换成 ASCII**: `needs_translation(text)` = 含**非 ASCII 可打印字符**。
  现在的 `CJK` 正则漏掉俄语/希腊语/阿拉伯语/泰语 —— 这个漏洞必须补。
- **记忆库落盘** `vibedraw_translations.json`(与设置同目录):
  - 键 `sha256(target + "\x00" + source)[:16]`;
  - 条目 `{source, target, text, engine, model, created}`;
  - 引擎/模型**不进键**(一条翻译是语言事实), 但**要记**(将来能筛出来用更好的引擎重刷);
  - 原子写(照抄 `settings.update` 的 `.tmp` + `replace`); 上限可配, 超出淘汰最旧; 失败不入库。
- **提交路径内的兜底** `ensure_english(text, target) -> (used, source, translated)`:
  `prompt.language == "en"` 且需要翻译 → 查库 → 命中用译文; 未命中调后端 → 成功存库用译文;
  失败/未启用 → 用原文。**任何情况都不让任务失败。**
- `describe()` 供信息接口播报: `available` / `mode: "auto-on-submit"` / `target` / 后端模型 / 记忆库条数与上限 / 规则。

`POST /cvp/translate` 保留原响应形状(给想提前预热的客户端)。

**判据**: 中文提示词提交 `quick` → 返回 `translated: true`、`prompt_source` 是中文、`prompt` 是英文;
同提示词第二次提交 → `cached` 生效(日志/`memory.entries` 计数不增); 杀掉进程重启后仍命中。

### P5 插件: 去设备化

| 位置 | 现在 | 改成 |
|---|---|---|
| `settings.DEFAULT_TRANSLATE_URL` | `http://host.containers.internal:8022`(podman 专用) | **`""`(空 = 关闭)**, 必须显式配置 |
| `workflows.QWEN_CACHE_DEVICE/DTYPE` | 常量 `"auto"` / `"int8"`("memory-starved box") | 进设置, 通用默认 `"auto"` / `"default"`, 环境变量可覆盖 |
| `estimated_seconds` | 参与算 `progress` | `typical_seconds`, 只播报不参与计算 |
| 推荐模型名 | 散在 `settings.py` / `nodes.py` | 收成一处常量, 两处引用 |

`nodes.py`: 配置节点从 `capabilities` 读取值范围, 不再自己写一套(现在 `VibeDrawInput.ref_strength`
声明 `0–2.0`, 与 HTTP 侧 `0.05–0.95` 矛盾); 节点描述同步更新(删掉"仍接受自定义工作流"这句已失效的话)。

**判据**: 全仓搜不到 `host.containers.internal` 与 `estimated_seconds` 的进度用法;
`nodes.py` 的范围来自 `capabilities`。

### P6 插件: 离线测试

`tests/test_discovery.py` → `tests/test_spec.py`, 覆盖:

- 信息文档: `spec`、能力条数与 `id`、**恰好一份** `input_schemas`、`category`/`signature` 齐全;
- 签名语法: 用第 2 节的规则解析已知签名, 并验证 `txt-ref23dgs` 按"最后一个 `2`"切分;
- 别名: `qwen` 解析到 `render`;
- 越界规则: 枚举越界抛错、`ref_strength` 夹边;
- 记忆库: 离线往返(存 → 读 → 命中), 键不含引擎, 换引擎仍命中;
- 旧投影: 旧 `/capabilities` / `/plugins` 形状的关键字段存在。

**仍然不依赖 ComfyUI / aiohttp / 网络**(沿用现有 stub 手法)。

**判据**: `python3 tests/test_spec.py` 通过并打印条目数。

### P7 A1X 部署

按技能 `a1x-comfy-device` 第 4.1 节的闭环, 不重传整个目录只传改动文件:

1. 宿主侧备份: `cp -r vibedraw_comfy vibedraw_comfy.bak-<日期>`(或逐文件 `.bak-<日期>`)。
2. 传文件到 `/home/AOKZOE/AI/minimax-h3/custom_nodes/vibedraw_comfy/`(`ssh AOKZOE@192.168.124.31`,
   expect 送密码 `bazzite`; **不要用 heredoc 怼文件内容**)。
3. 更新 `vibedraw_settings.json`: 补 `translate.url`(指向设备上真实的翻译后端)与 qwen 缓存参数。
   **先确认 8022 到底有没有在跑 OpenAI 兼容的 chat 接口** —— 技能里只记了 8020/8021 是 TTS,
   没有 8022 的记录, 这条必须现场核实, 不能沿用旧默认值。
4. 两侧摘要逐一对照(`shasum -a 256 *.py` vs `sha256sum *.py` / `md5 -q` vs `md5sum`)。
5. `systemctl --user restart minimax-h3-comfy`, 约 45s 后轮询。
6. **验证判据**: `curl --noproxy '*' http://192.168.124.31:8189/cvp/info` 200;
   `http://192.168.124.31:8189/vibedraw/v1/plugins` 仍 200(**PoseGi 的存量路径**);
   404 才代表没加载。
7. 端到端: `POST /cvp/jobs` 用中文提示词提交 `quick` → 轮询到 `completed` → 取图确认 `image/png`,
   且响应 `translated: true`。

### P8 Vibedraw 应用: 去翻译 + 消费新接口

**删除**:

- `app/services/translate.js`(整份)及 `index.html` 里的 script 标签;
- `app/components/settings.js` 里的翻译标签页(`TRANSLATE_TAB` / `wantsTranslateTab`)与探测 UI;
- 所有调用点(`english()` / `translated()` / `translate()` / `probe()` / `load()`)与相关文案。

客户端**不再翻译**: 提交时把用户原文交给 CVP, 由后端按第 5 节兜底。

**改造** `app/services/providers.js`:

- `test()`: 改打 `/cvp/info`, 一次回答 地址通不通 / 密码对不对 / 能力在不在 / 模型就绪没 /
  这条能力要不要英文。落到卡片上的信息取自能力的 `label` / `values` / `models` / `ready`。
- `cvpGenerate()`: 提交字段 `capability`(不传旧 `task`); **能力在 `ignores` 里声明了
  `negative_prompt` 就不发它**; 轮询改用 `/cvp/jobs/{id}/progress`, 完成后再取 `/jobs/{id}`。
- `progress` 为 `null` 时显示不确定态("生成中"), 不再画假百分比。
- 画幅/步数/默认值改由能力信息驱动(取不到时回落到现有默认)。

**改造** `app/components/settings.js`: 放大画幅按钮由能力的 `values.size` 驱动(取不到才回落 `[1024, 2048]`)。

**判据**: 全仓搜不到 `services.translate`; 测试连接在真机上读到 `render` 能力的
`prompt.language == "any"` 与 `quick` 的 `"en"`; 中文提示词直接提交能出图。

### P9 应用热更新到设备

按既有热更新路径推送到开发设备(走局域网 HTTP, **不碰 USB/adb**), 然后在设备上实测一遍:
连接测试 → 出图 → 中文提示词提交并在状态行看到"已自动译英"。

---

## 3. 兼容与风险

### 3.1 已知的对外变化

| 变化 | 影响 | 处置 |
|---|---|---|
| 能力 `qwen` → `render` | 用 `qwen` 提交的客户端 | `aliases` 接受 `qwen`, 功能不受影响 |
| 错误码 `unsupported_task` → `unsupported_capability` | 按错误码字符串分支的客户端 | 请求侧仍接受 `task` 字段; 错误码变化只影响提示文案。**PoseGi 的映射未核实**(其仓库不在本工作区) |
| 默认翻译地址改为空 | 未显式配置的部署翻译被关闭 | A1X 部署时显式写入; 规范明确禁止厂商写死默认地址 |
| `progress` 可能为 `null` | 画百分比进度的客户端 | 应用侧同步改成不确定态 |

### 3.2 不做的事(与规范第 8 节一致)

不做 OpenAPI 生成、不做 MCP 门面、不做推送/SSE、不做多目标语言、不做能力级版本号、
不做插件化家族注册、不做账号与配额。**不升 happ 版本、不生成新的 happ 发布包。**

### 3.3 PoseGi 存量路径(本轮不改它, 但也不许弄坏它)

已发布的 PoseGi 读的是 `/vibedraw/v1/plugins`(发现文档)与 `/vibedraw/v1/capabilities`。
因此这两个旧路由**继续返回旧形状**(由新能力表投影生成), 而不是返回新文档。
旧 `/vibedraw/v1/jobs*` 与 `/cvp/jobs*` 是**同一批处理函数**, 请求侧同时接受 `task` 与 `capability`。

**删除条件**: PoseGi 升级到读 `/cvp/info` 之后, 旧投影函数可整体删掉。

### 3.4 回滚

- 插件: 宿主侧 `.bak-<日期>` 目录/文件拷回 → 重启容器。**改前必留备份**。
- 应用: 热更新前的版本仍在设备上, 可直接回推上一版 happ。
- 数据: 记忆库与设置都是**新增文件**, 回滚时留着不影响旧码(旧码不读它们)。

---

## 4. 落地顺序

P0 → P1 → P2 → P3 → P4 → P5 → P6(每步之后都跑一次离线测试) → P7(A1X 真机) →
P8(应用) → P9(热更新到设备)。

P1–P5 都在本机完成并可离线自检; P6 通过后才首次触碰设备, 避免在设备上反复试错。

---

## 5. 第二轮(2026-09-27, 插件 2.2.0 → 2.3.0): 画幅不再锁死在清单上

### 5.1 起因(业主两条原则)

> CVP 插件应该不锁定具体分辨率, 只枚举 ComfyUI 能够输出的模型支持的分辨率。
> CVP 提供分辨率, happ 根据实际情况选用。

`2.2.0` 的 `render` 只公布九个方形(512²…1024²), 客户端要一张 9:16 竖幅只能拿到方图。根因是**画幅被写成了手写清单**。

### 5.2 改法: 约束算枚举, 校验按约束

每个能力新增 `size` 域, 声明**模型的约束**:

| 字段 | 含义 |
|---|---|
| `step` | 对齐步长(latent 8× × VAE 8×, 取 64 作安全上界) |
| `min_short_edge` / `max_long_edge` | 最短边 / 最长边 |
| `max_pixels` | 单次生成的像素预算 |
| `budgets` | 推荐枚举要覆盖的预算档(如放大目标的 1MP / 4MP) |
| `aspects` | 模型能接受的比例 |

- `capabilities.sizes(capability)` 按「预算 × 比例 → 两条边各自 `sqrt` 再向下对齐」**算出**推荐枚举;
- `capabilities.fits(size, domain)` 按域判上下界与对齐;
- 广播给客户端的 `values.size` 只是**推荐枚举**, 不是唯一可选值; 能力条目另播报 `size_domain` 让客户端自己算;
- `validate_values` 改成按域判(不走清单)。

**关键取舍: 枚举要保住历史纹理。** 老客户端只读 `values.size`, 而 vibedraw 应用当时还只取 `sizes[0]`, 所以 `quick`/`inpaint` 首项仍是 512²、`upscale` 仍是 `[[1024,1024],[2048,2048]]`、`render` 首项仍是 1:1 的 1024²。

`render` 实际公布的枚举: `[[1024,1024],[768,1344],[1344,768],[832,1152],[1152,832],[832,1216],[1216,832],[1536,640]]`。

### 5.3 另外两项

- **`render.needs.image = false`**: 带参考图 = 参考图编辑, 不带 = 纯文生图。依据是核心节点 `TextEncodeQwenImage21` 的 `images` 参数本身就是 `io.Autogrow.Input(..., min=0)` —— 不带参考图是模型明确支持的路径, 不是"漏了参数"。`server.py` 相应改成"判带了没带"。
- **新增家族选项 `reference_edge`**(参考图送进编码器前缩到多大)。默认 **1024 = 核心节点的默认值** —— 出厂默认不带部署选择, 某台机器的权宜值只写设备设置文件。**它不影响出图画幅**。

### 5.4 应用侧的连带修复(同一个方形假定)

画幅不再是单一数字之后, 三处"只认一个边"的代码会**静默**把插件给的竖幅改成方图(不报错, 只是形状错):

| 位置 | 原状 | 现状 |
|---|---|---|
| `app/services/providers.js` `cvpSizes()` | 只返回 `pair[0]` | 返回整对 `[width, height]`, 过滤掉非正数 |
| 同上 `preset()` | `value.width = value.height = sizes[0]` | 取 `sizes[0]` 的**两个**边分别赋给 width / height |
| `app/components/settings.js` | 按钮 `data-aspect-size`(单值)且标签硬写 `1:1`; 点击时 `width = height = value` | 按钮带 `data-aspect-width` / `data-aspect-height`; 标签用 `providers.aspect(w, h)` 算 |

`aspect()` 一并从 `internals` 提到公开面(它本来就是纯函数), 免得设置面板再抄一份比例阈值。
`app/services/image-engine.js` 的渲染结果校验本来就同时比 width 与 height, 不用改。

`tools/verify.mjs` 新增 5 条源码门禁把这条不变量钉住: 画幅必须成对携带、preset 必须取两个边、按钮必须存两个数、锁定行不许再出现写死的 `1:1`。

### 5.5 验证与部署

- `node tools/verify.mjs --source-only` ✅ —— `providers.test.mjs`(含新的成对断言) / `workspace` / `performance` / `assets` 四套全 ok, 24 个运行期文件;
- **`tools/package.py --check` 会红**(`release content mismatch: app/components/settings.js`)—— 这条门禁要求发布包与源码逐字节一致, 而按既定纪律**改代码不发版**: 不升 happ 版本、不生成新的 happ 发布包(见 §3.2)。所以它保持在"等下一次发版"的状态, 不是回归;
- 插件侧离线测试 `python3 comfyui-plugin/tests/test_spec.py` ✅(`ok (4 个能力,1 份输入 schema,1 条翻译记忆,旧文档 4 条插件)`);
- A1X 部署: 备份到 `custom_nodes/vibedraw_comfy/.bak-20260927/` → 传 6 个文件 → 设备设置 `families.qwen_image_21.reference_edge = "512"` → `systemctl --user restart minimax-h3-comfy` → `curl --noproxy '*' http://192.168.124.31:8189/cvp/info` 验收 `plugin.version 2.3.0` / `render.needs.image=false` / `render` 含 `[768,1344]` / 四个能力都有 `size_domain`;
- 应用热更新: `sync-dir` → VibeDraw devRev **181 → 182**, `commitState: committed`; 回读设备端 `app/components/settings.js` 确认 `data-aspect-width` / `data-aspect-height` 在场且写死的 `<strong>1:1</strong>` 已消失。

### 5.7 参考图被压扁：`ImageScale` 是强制拉伸, 参考图只能按面积缩（2026-09-27 第六批）

业主在 chataxi 上报「画出来的照片比例不太对」, 追下来根因在**本插件**（不在应用侧）:

- 2.3.0 新加的预缩节点 `graph.scale` = `ImageScale` + **`crop:"disabled"`** ⇒ 把源图**压/拉**进给定的 `width × height`, **不裁切**。只要目标框比例与源图不符, 图就被拉变形 —— 而画幅仍然是对的, 从成图上极难发现。
- `reference_box(width, height, edge)` 又拿**画幅的比例**算框 ⇒ 3:4 的定妆照被压进当时那张方画幅的框里。
- 反证: 2.2.0 的 `families/qwen_image.py` 共 156 行且**完全没有参考图这条路径**（`git show 2705ef0:…`）⇒ 这是 2.3.0 新引入的缺陷。核心节点自己用的是 `ratio = samples.shape[3] / samples.shape[2]`（参考图**自身**比例）+ `comfy.utils.common_upscale(..., "disabled")`, 本来就是保比例的, **是预缩破坏了它**。

**修法**:

- 新增 `graph.scale_to_pixels(source, megapixels, step=32)` → `ImageScaleToTotalPixels`（吃**面积预算**, 比例永远是源图自己的, 再对齐到 32）。
- `reference_box(width, height, edge)` → `reference_megapixels(edge)`（`edge² / 1048576`）; 随之删掉 `import math`。
- 判据: **参考图 / 输入图一律按面积缩**; 只有 img2img 那种必须与采样 latent 对齐的才用硬目标框（`checkpoint.py` 的 `graph.scale` 保持不动）。
- A1X 上实测该节点可用: `/object_info/ImageScaleToTotalPixels` 的 `required = [image, megapixels, resolution_steps, upscale_method]`,`megapixels` FLOAT 0.01–16,`resolution_steps` INT 1–256; 容器内源码确认它走 `common_upscale(..., "disabled")`。
- 数值自洽: 9:16 参考图 + `resolution=512` ⇒ 384×672, 与画幅 768×1344 同比例; `resolution=1024` ⇒ 768×1344, **恰好等于画幅**。
- 离线测试同步: `tests/test_spec.py` 的 `check_render_accepts_no_reference` 改成断言节点 "11" 的 `class_type == "ImageScaleToTotalPixels"` / `megapixels == reference_megapixels(512)` / `resolution_steps == 32`。
- A1X 部署: 备份 `.bak-20260927b/`（含设置文件）→ 传 `families/graph.py` 与 `families/qwen_image.py` → 清 `__pycache__` → `systemctl --user restart minimax-h3-comfy` → `/cvp/info` 复验。设备设置 `reference_edge` 同时由 `512` 提到 `1024`（业主直接定, 代价是参考图 latent token 约 4×, 且已有的 0.59MP 定妆照会被放大到约 1MP 预算 —— 要吃满 1MP 得同时把定妆照提到 768×1344 并改走 `bodyLogicalFileId` 传输）。

### 5.6 回滚

插件照 §3.4(备份目录 `.bak-20260927/` 拷回 + 重启容器)。应用侧热更新前的版本仍在设备上, 可直接回推。
