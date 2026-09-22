# VibeDraw

VibeDraw 是一个可直接运行在 HermitApp 中的开源 AI 绘图 happ。它把手绘草稿、提示词和可选蒙版发送到用户自己配置的图像模型，不内置平台 API Key，也不依赖 fal.ai。

产品定位是「第一款真正实时的 AI 绘图工具」：画图不能只靠提示词，耗时的图生图也不够——VibeDraw 让人随手涂鸦、AI 实时成图，通常一秒内就能看到结果。作品与配置全部保存在本机，模型既能直接用 API Key 对接云端服务，也能接本地大模型。

## 安装与站点

VibeDraw 是 HermitApp 的 happ，不能脱离宿主单独安装。

1. 先安装 HermitApp：[下载页](https://hermit.airen.life/pages/download.html)（Android 10 及以上）。
2. 再添加 VibeDraw：在[应用广场](https://hermit.airen.life/pages/happs.html)扫描 VibeDraw 二维码，或直接打开官方安装清单 `https://hermit.airen.life/downloads/happs/com.zhyuzh.vibedraw/hermit-install.json`。

- 产品网站：<https://vibedraw.airen.life/>，包含实时生图、涂鸦工具、模型接入与上手流程的完整说明。
- happ id：`com.zhyuzh.vibedraw`，当前源码版本 `0.4.26`。
- 源码仓库：<https://github.com/zhyuzh3d/vibedraw>。
- 相关 happ：chataxi（<https://chataxi.airen.life/>）是同一宿主上的 AI 对话应用；两者互不依赖，只做相互推荐。

因为 VibeDraw 就运行在 Hermit 里，整个应用都是可读可改的原生 HTML、CSS、JavaScript 源码，用户可以在开发模式下自行定制。

## 主要能力

- 紧凑绘图工作台：左对齐品牌与版本、画布上方单行提示词、可切换的成图层顺序、独立生成操作区；点击主要操作后显示简短用途说明。
- 铅笔、涂色与擦除直接显示粗细和透明度滑竿，参数栏右端用带 BG 字样的圆形按钮设置背景；画布上方滑竿根据叠加状态控制成图层或元素层透明度。
- 作品级控制：绘制稿强度、可锁定随机种子、笔刷等待和“叠加生成”随历史快照保存；开启叠加时提交当前完整合成，关闭时忽略成图并以不透明元素和背景提交。
- 应用内紧凑颜色面板替代系统颜色选择器，画笔色和底色均使用直接呈现当前颜色的圆形触控按钮；所有滑杆使用统一的大圆形触点。
- 原生 Canvas 矢量笔触：铅笔、涂色、擦除、碰触式框选、对象成组/解组、单体/选区移动、复制、图层调整、局部蒙版、撤销和重做；选中后显示四角缩放手柄，同时支持双指捏合缩放与移动。
- 历史作品：自动保存、缩略图、搜索、继续编辑、创建副本、删除；恢复提示词、笔触、导入图片、生成结果与画面参数。
- 软件设置：浅色、深色、跟随系统；中文与英文。弹窗、确认、按钮和 Toast 使用同一组件体系。
- 两个模型槽位互相独立：A1X 快速配置只把实时槽位设为 DreamShaper8 LCM（512、2/4/8 步、CFG 2），不会自动配置或改写渲染槽位；渲染调用用户配置的高质量模型，原样提交当前可见画布并要求返回真实 1024 × 1024 图片，在支持双指缩放、拖动和下载的全屏窗口中预览。
- 支持 OpenAI Images 兼容接口、Stable Diffusion WebUI / Forge、ComfyUI API workflow、Stability AI v2beta。
- 支持可信局域网 HTTP 地址；公网服务要求 HTTPS。
- 模型配置和画布 JSON 保存于当前 happ 的隔离数据区，图片只存文件引用。服务返回的图片文件直接使用 Hermit 逻辑文件；内联图片通过当前公开文件接口编码为有界文件块，恢复时从文件读回，不把图片字节或 data URL 写入数据库。
- 新建作品前先保存旧作；生成时可继续绘图，快速操作合并排队。停止等待忽略返回结果，不保证取消服务端任务或计费。
- 导出：生成工具栏的下载按钮直接保存当前画布实际显示效果；渲染预览中的下载按钮单独保存模型返回的 1024 大图。普通浏览器导出 PNG；Hermit 当前没有任意二进制文件写入接口，因此内联合成画面导出为可打开的 SVG 预览，服务以文件返回的图片可原格式导出。
- 使用 Hermit 内置的本地 Font Awesome Free，不访问 CDN；源文件无需构建即可运行。
- 绘制热路径使用动画帧合并、离屏内容缓存和笔画边界缓存；历史缩略图按可视区域加载，图片解码与文件读写合并并设有容量上限，未变化画布不重复写入 Hermit 数据。

## 目录

```text
index.html                 页面骨架与脚本装配
hermit.json                happ 身份与版本
app/core/                  命名空间、状态和通用工具
app/platform/              Hermit Bridge 与浏览器降级
app/services/              作品存储、文件资产、模型协议适配、生成调度
app/components/            画布、统一弹层、设置与历史画廊
app/features/              页面用例编排
styles/                    设计令牌与组件样式
tests/                     无第三方依赖的协议单元测试
tools/verify.mjs           静态合同检查入口
tools/performance-benchmark.mjs  可重复的克隆与存储分块基准
docs/performance.md        HermitApp 性能设计与诊断不变量
```

## ComfyUI VibeDraw workflow

安装 `comfyui-plugin/`（或发布的 `release/vibedraw-comfyui-plugin-v1.0.0.zip`）后，在 ComfyUI 工作流中放置一个 `VibeDraw Input` 和一个 `VibeDraw Output` 节点。Input 输出 `prompt`、`negative_prompt`、参考图、蒙版、`seed`、`ref_strength`、`steps`、`width` 和 `height`；用户把它们接到自己的文本编码、采样、重绘或 ControlNet 节点。最终图片接到 `VibeDraw Output`。

插件包用 `python3 tools/package-plugin.py` 生成（`--check` 只校验不写入），产物是确定性 zip：固定时间戳、固定条目顺序，解压到 ComfyUI 的 `custom_nodes/` 即可使用。官网「应用广场 / VibeDraw 安装」卡片里的 **下载 ComfyUI 插件** 按钮直接指向这个 zip：

```
https://hermit.airen.life/downloads/vibedraw/vibedraw-comfyui-plugin-v1.0.0.zip
```

官网副本放在 `hermitweb/public/downloads/vibedraw/`，与仓库 `release/` 里的字节一致（sha256 `a98fdbb7…15adc9`）。

VibeDraw 将 API-format workflow 和当前输入提交到插件的 `/vibedraw/v1/jobs`，插件再调用 ComfyUI 原生队列。VibeDraw 轮询插件任务状态，并直接从 ComfyUI `/view` 读取输出图片；checkpoint、节点结构和具体模型仍由用户工作流控制。

## 验证

```sh
node tools/verify.mjs
```

在打包前使用 `node tools/verify.mjs --source-only`。准备发布时运行 `python3 tools/package.py`，随后运行完整校验。打包仅归档原生源文件，不执行编译。

性能架构与诊断入口见 [`docs/performance.md`](./docs/performance.md)，基准可运行 `node tools/performance-benchmark.mjs`。

DEV 副本的 `#self-test` 入口覆盖绘图、撤销/重做、对象操作、蒙版、图片文件读回、历史恢复、主题、语言与布局合同；测试后恢复原有作品和设置，并删除临时测试作品。稳定通道不会执行此入口。模型出图需要用户自行配置的服务与密钥，不能用协议测试替代真实出图验收。

## License

MIT，见 [LICENSE](./LICENSE)。
