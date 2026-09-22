# CVP — ComfyUI VibeDraw Plugin

VibeDraw 的**统一本地接口**。任何客户端（VibeDraw 本体、其他开发者的工具）只要认下面这一个 HTTP 契约，就能用你已经装好的 ComfyUI 出图，**不需要自己导出工作流 JSON**——三套图都内置在插件里。

- 协议标识：`vibedraw-comfy/v2`
- 路由前缀：`/vibedraw/v1/`
- 目录：把 `vibedraw_comfy/` 整个放进 ComfyUI 的 `custom_nodes/`

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
   | **VibeDraw 配置 (Config)** | **用户唯一需要操作的节点**：设密码 + 选三套 checkpoint |
   | VibeDraw 输入 / 输出 | 只在你自己搭自定义工作流时用；内置三套图用不到 |

4. 想确认装好了：

   ```bash
   curl -s http://127.0.0.1:8188/vibedraw/v1/capabilities
   ```

   返回 JSON 且 `schema` 为 `vibedraw-comfy/v2` 即成功（ComfyUI 没开鉴权时；开了鉴权见下）。

## 配置（VibeDraw 配置节点）

| 字段 | 说明 |
|---|---|
| `password` | **访问密码**。填了就只有带对密码的请求能出图；**留空 = 不校验**。 |
| `quick_checkpoint` | 快速绘制用的模型，默认 `DreamShaper8_LCM.safetensors` |
| `inpaint_checkpoint` | 局部重绘用的模型，可填 `(same as quick)` 复用上一个 |
| `upscale_checkpoint` | 放大绘制用的模型，同样支持 `(same as quick)` |

配置写在 `custom_nodes/vibedraw_comfy/vibedraw_settings.json`（原子写、可手工编辑）；也可以直接用环境变量 `VIBEDRAW_PASSWORD` 覆盖密码（适合容器/CI）。

**密码错了会怎样**：请求在**入队之前**就被拦下，返回 `401 unauthorized`，**不会生图**。客户端拿到的是一句可读的中文提示，而不是一张画错的图。

## 三套内置工作流

客户端只报任务名，尺寸/步数由插件按规格校验，超范围的参数直接 `400`：

| 任务 `task` | 画幅 | 步数 | 特有参数 | 说明 |
|---|---|---|---|---|
| `quick` | 512×512 | 2 / 4 / 6 / 8 | `ref_strength` 默认 0.55 | 把画布当参考图重绘一张速写稿 |
| `inpaint` | 512×512 | 4 / 6 / 8 / 12 | `ref_strength` 默认 0.30、`grow_mask_by` 0–64 默认 8 | **只重画白色蒙版区域**，其余原样保留 |
| `upscale` | 1024×1024 或 2048×2048 | 4 / 8 / 12 / 16 / 20 | `ref_strength` 默认 0.75 | 放大重绘：参考图按**原分辨率**（上限 1024）直接编码；只有目标大于上限时才 latent 放大。**不要退回"先缩到 512 再放大"**——那等于在采样器看到参考图之前先模糊它一轮，渲染出来会发软、像被重新演绎过。 |

**推荐模型**：DreamShaper8 LCM 系列（512 分辨率通常 1 秒左右出图）。`quick` / `inpaint` 建议就用它，不必换；`upscale` 用能接受 512 参考图、输出 1024/2048 的模型即可。

### `ref_strength` 是唯一的权重入口

它是"**参考图权重**"：越高越贴近你画的原稿，越低越放手重画。插件内部换算成 denoise 后钳制：

```
denoise = clamp(1 - ref_strength, 0.05, 1.0)
```

所以 `1.0` 几乎照着原稿描、`0.05` 近乎完全重画，两端都不会出现"毫无效果"的假参数。**客户端若用别的滑杆口径，请自行映射到这个 0.05–0.95 的区间再发过来。**

## HTTP 契约

| 方法 | 路径 | 说明 |
|---|---|---|
| `GET` | `/vibedraw/v1/capabilities` | 能力自描述：任务、画幅、步数、参数、当前选中的模型、是否需要密码 |
| `POST` | `/vibedraw/v1/jobs` | 提交任务 → **202** `{"job":{"id":…,"state":"queued"}}` |
| `GET` | `/vibedraw/v1/jobs/{id}` | 轮询状态：`state ∈ queued / running / completed / failed / cancelled`，含 `progress` 与 `outputs` |
| `GET` | `/vibedraw/v1/jobs/{id}/output/{n}` | 取成图（直接返回 PNG，**复用同一把密码**） |
| `POST` | `/vibedraw/v1/jobs/{id}/cancel` | 取消排队中的任务 |

提交体：

```json
{
  "task": "quick",
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

- `image_base64`：参考图（画布）。`inpaint` 必带 `mask_base64`（**白 = 要重画**）。
- 图片可直接给 data URL，插件自己解码；请求体上限 32 MB。
- 鉴权：`Authorization: Bearer <password>`（也接受 Basic 或 `X-VibeDraw-Password`）。密码为空时不需要。
- 完成后的 `outputs[n].url` 已经是 `/vibedraw/v1/...` 绝对路径，**客户端直接拼服务器地址去下就行，不要再拼一层**。

错误码（全部带中英双语文案）：`unauthorized(401)` / `bad_request` / `unsupported_task` / `unsupported_size` / `unsupported_steps` / `bad_image` / `bad_mask` / `no_model(409)` / `busy(429)` / `not_found(404)` / `internal(500)`。

## 自测

```bash
# 1. 能力
curl -s -H 'Authorization: Bearer <password>' http://<host>:8188/vibedraw/v1/capabilities

# 2. 快速绘制
curl -s -X POST http://<host>:8188/vibedraw/v1/jobs \
  -H 'Authorization: Bearer <password>' -H 'Content-Type: application/json' \
  -d '{"task":"quick","prompt":"a red fox","seed":1,"size":[512,512],"steps":8,"ref_strength":0.55}'

# 3. 轮询 / 取图
curl -s -H 'Authorization: Bearer <password>' http://<host>:8188/vibedraw/v1/jobs/<id>
curl -s -H 'Authorization: Bearer <password>' -o out.png http://<host>:8188/vibedraw/v1/jobs/<id>/output/0
```

- **第一次请求会慢**（模型加载，约十几秒），之后同模型重跑约 1 秒；别用首单判断"模型太慢"。
- 在 VibeDraw App 里对接：设置 → 模型配置 → 接口模式选「CVP 插件（推荐）」，服务器地址填 `http://<host>:<port>`，访问密码填节点里设的那个。三个 tab（快速生图 / 局部重绘 / 高清渲染）各自独立配置。
