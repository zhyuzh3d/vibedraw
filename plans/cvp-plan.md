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
