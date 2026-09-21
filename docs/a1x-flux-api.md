# VibeDraw × A1X 图片任务最小接口合同

VibeDraw 使用 A1X 的稳定任务 API，不直接依赖 ComfyUI 节点名或 workflow JSON。服务地址示例为 `http://192.168.124.31:8188`，实际地址由用户在模型配置中填写。

## 鉴权

VibeDraw 在用户保存访问密码后发送 `Authorization: Bearer <password>`。未启用鉴权的可信局域网服务可以留空。错误响应应使用对应 HTTP 状态码和 JSON，例如 `{"error":"authentication_required"}`；不得以 HTTP 200 包装失败。

## 能力检查

`GET /api/a1x-h3/v2/capabilities` 必须提供 `profiles.dreamshaper8_lcm_blended_img2img_sd15`、`profiles.flux2_klein_4b_distilled_nvfp4` 与 `profiles.flux2_klein_4b_base_nvfp4`：

- `qualification.image_generate` 为 `qualified`；
- `image_models.lcm_blended_img2img_sd15.allowed_steps` 和 `image_models.flux2.allowed_steps` 都至少包含 `2`、`4`、`8`；
- `image_resolutions.compact512.1:1` 必须是 `[512, 512]`，`image_resolutions.native.1:1` 必须是 `[1024, 1024]`；旧服务也可通过模型的 `allowed_resolution_tiers` 字段声明这两个档位；
- 最多参考图数量不小于 1。

连接测试还会读取 `GET /api/a1x-h3/v2/jobs?limit=1`，用来确认鉴权有效。

## 上传参考图

`POST /api/a1x-h3/v2/assets?filename=vibedraw-<timestamp>.png&kind=image`

请求体是原始 PNG、JPEG 或 WebP 字节，响应状态为 201，JSON 至少包含字符串字段 `asset_id`。VibeDraw 画布本身为方形；`reference_megapixels: 1` 表示服务端把参考图编码到约 1 百万像素，不表示 1 MB 码率。

## 创建任务

`POST /api/a1x-h3/v2/jobs` 接收 JSON：

```json
{
  "mode": "image_generate",
  "prompt": "用户提示词",
  "negative_prompt": "可选负面提示词",
  "engine_profile": "flux2_klein_4b_distilled_nvfp4",
  "sampling_steps": 4,
  "guidance_scale": 1,
  "reference_strength": 0.8,
  "reference_megapixels": 1,
  "inputs": { "image_references": ["asset_id"] },
  "output": { "aspect_ratio": "1:1", "resolution_tier": "native" },
  "seed": 73
}
```

约束如下：

- `sampling_steps` 只能为 2、4、8；实时槽位固定使用 DreamShaper8 LCM profile，高质量槽位的 2/4 步使用 Flux.2 Distilled、8 步使用 Flux.2 Base；
- 实时槽位使用 `compact512` 并输出 512×512；高质量“渲染”槽位使用 `native` 并输出真实的 1024×1024。客户端会检查返回图片尺寸，不会把 512 图片在手机端放大伪装成高清结果；
- DreamShaper8 LCM 的 `guidance_scale` 固定为 2，并只走单路 img2img。客户端发送 `input_blur_radius: 3`、`input_blur_sigma: 1.2`、`input_blur_mix: 0.25`，服务端应先把轻微模糊副本与原图混合，再使用 `reference_strength` 作为去噪强度；编辑器 30–120% 的“绘制稿强度”映射为 0.85–0.27 的去噪值，强度越大越忠于原稿。Flux.2 的 `guidance_scale` 固定为 1，并额外发送 `reference_megapixels: 1`；
- 页面提示词可以留空。由于当前 A1X 服务合同仍要求非空 `prompt`，VibeDraw 只在请求层填入中性的保真指令，作品中仍保存为空提示词；
- VibeDraw 原样提交画布实际显示内容，不改写颜色、透明度、对比度或构图。高质量“渲染”始终提交包含当前背景、可见成图层、元素透明度和调色效果的 1024×1024 参考图。DreamShaper 实时槽位读取同一张彩色参考图；颜色笔迹必须覆盖足够面积，细线只表达结构时，模型无法可靠判断它是物体表面色还是标注线，精确的对象颜色仍应在提示词中说明；
- `seed` 为非负整数。VibeDraw 的 `-1` 只在手机端表示每次随机，发送前会换成实际 seed；
- 请求带 8–128 字符的 `Idempotency-Key`，相同键与相同请求必须避免重复创建任务。

成功响应状态为 202，至少包含 `job_id` 和 `state`。

## 查询与下载

`GET /api/a1x-h3/v2/jobs/{job_id}` 返回 `queued`、`running`、`succeeded`、`failed` 或 `cancelled`。成功任务的 `outputs[0].url` 必须是同一服务下可鉴权读取的相对 URL；VibeDraw 随后 GET 该 URL，并要求响应体为图片字节以及正确的 `Content-Type`。

失败任务应在 `error.error` 或 `error.message` 返回可读原因。任务状态和输出 URL在服务重启后仍应可查询。

## 生产建议

当前合同已经足够完成 VibeDraw 出图。长期运行时，A1X 还应为上传素材提供自动过期策略，或补充 `DELETE /api/a1x-h3/v2/assets/{asset_id}`；否则每次实时生成上传的画布会持续占用设备存储。该清理能力不应影响已提交任务。
