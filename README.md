# VibeDraw

VibeDraw 是一个可直接运行在 [Hermit](https://hermit.airen.life/) 宿主里的开源实时 AI 绘图 happ。它把手绘草稿,提示词和可选蒙版发送到你自己配置的图像模型,不内置任何平台 API Key,也不依赖 fal.ai。

产品定位是「第一款真正实时的 AI 绘图工具」：画图不能只靠提示词,耗时的图生图也不够——VibeDraw 让你随手涂鸦,AI 实时成图,通常一秒内就能看到结果。作品与配置全部保存在本机,模型既能用 API Key 对接云端服务,也能接本地大模型。

> 产品网站：<https://vibedraw.airen.life/> · 应用广场：<https://hermit.airen.life/pages/happs.html> · 源码仓库：<https://github.com/zhyuzh3d/vibedraw> · [GitHub Releases](https://github.com/zhyuzh3d/vibedraw/releases) · [MIT License](./LICENSE)

- happ id：`life.airen.vibedraw`
- 当前源码版本：`0.5.0`(versionCode `76`,见 `hermit.json`)
- 形态：HermitApp 的普通 happ,不能脱离宿主单独安装,纯原生 HTML / CSS / JavaScript,没有构建步骤

！[VibeDraw 画布](./device-current-canvas.png)

## 主要能力

- **紧凑绘图工作台**：左对齐品牌与版本,画布上方单行提示词,可切换的成图层顺序,独立生成操作区,点击主要操作后显示简短用途说明。
- **矢量笔触内核**：原生 Canvas 实现铅笔,涂色,擦除,碰触式框选,对象成组 / 解组,单体 / 选区移动,复制,图层调整,局部蒙版,撤销和重做。选中对象显示四角缩放手柄,支持双指捏合缩放与移动。
- **作品级控制**：绘制稿强度,可锁定随机种子,笔刷等待和「叠加生成」随历史快照保存,开启叠加时提交当前完整合成,关闭时忽略成图并以不透明元素和背景提交。
- **三个任务槽位互相独立**：快速生图 / 局部重绘 / 高清渲染。画幅,步数与参考图权重由所选接口的内置规格决定,高清渲染原样提交当前可见画布并要求返回真实 1024 × 1024 图片,在支持双指缩放,拖动和下载的全屏窗口中预览。
- **历史作品**：自动保存,缩略图,按可视区域加载,搜索,继续编辑,创建副本,删除,恢复提示词,笔触,导入图片,生成结果与画面参数。
- **四种接口模式**：ComfyUI VibeDraw Plugin(CVP,推荐),OpenAI Images 兼容,Stable Diffusion WebUI / Forge,Stability AI v2beta。支持可信局域网 HTTP 地址,公网服务要求 HTTPS。
- **本地优先**：模型配置和画布 JSON 保存在当前 happ 的隔离数据区,图片只存文件引用,服务返回的图片文件直接使用 Hermit 逻辑文件,内联图片通过当前公开文件接口编码为有界文件块,不把图片字节或 data URL 写入数据库。
- **导出**：生成工具栏的下载按钮保存当前画布实际显示效果,渲染预览中的下载按钮单独保存模型返回的 1024 大图。普通浏览器导出 PNG,Hermit 当前没有任意二进制文件写入接口,因此内联合成画面导出为可打开的 SVG 预览,服务以文件返回的图片可原格式导出。
- **外观与语言**：浅色,深色,跟随系统三种主题,中文与英文,弹窗,确认,按钮和 Toast 使用同一组件体系。内建本地 Font Awesome Free,不访问 CDN。
- **性能**：绘制热路径使用动画帧合并,离屏内容缓存和笔画边界缓存,历史缩略图按可视区域加载,图片解码与文件读写合并并设有容量上限,未变化画布不重复写入 Hermit 数据。

## 安装使用

VibeDraw 是 HermitApp 的 happ,**不能脱离宿主单独安装**。

1. 先安装 Hermit：[下载页](https://hermit.airen.life/pages/download.html)(Android 10 及以上),或到 [Releases](https://github.com/zhyuzh3d/hermitapp/releases) 取 APK。
2. 再添加 VibeDraw：打开 [应用广场](https://hermit.airen.life/pages/happs.html) 找到 VibeDraw,扫描二维码,或复制它的官方安装清单地址(形如 `https://hermit.airen.life/downloads/happs/<happId>/hermit-install.json`,`<happId>` 以应用广场页面显示的为准),回到 Hermit 点「从网址」粘贴。产品网站 <https://vibedraw.airen.life/> 也提供同一套二维码与安装地址。

因为 VibeDraw 就运行在 Hermit 里,整个应用都是可读可改的原生 HTML,CSS,JavaScript 源码,你可以在开发模式下自行定制。

## 快速上手

1. 打开 VibeDraw,在设置里选择一个接口模式并填入地址(公网用 HTTPS,可信局域网可用 HTTP)。
2. 选好模型与参数(CVP 模式下参数由插件按任务下发),回到画布。
3. 涂几笔,写一句提示词,点快速生图,想重画某块就切局部重绘并涂上蒙版,想要高清成品就点高清渲染。
4. 生成时可继续绘图,快速操作会合并排队,不满意可撤销或从历史作品里继续编辑。

## ComfyUI VibeDraw Plugin(CVP)

`comfyui-plugin/vibedraw_comfy/` 是 VibeDraw 推荐使用的**统一本地接口**：把它放进 ComfyUI 的 `custom_nodes/` 并重启,客户端**不需要导出任何工作流 JSON**,只报能力名和当前画布。

- 接口根路径 `/cvp`(不随版本变化),规范标识 `cvp/1`,新客户端第一步调公开的 `GET /cvp/info`,一次拿到能力清单,请求 schema,模型槽位与就绪状态。
- 四个能力：`quick`(快速生图),`inpaint`(局部重绘,白 = 要重画),`upscale`(放大绘制),`render`(用 Qwen-Image 出成品图)。画幅与步数由插件按能力声明校验,`ref_strength` 是唯一的参考图权重入口(值域 0.05–0.95)。
- 用户在 ComfyUI 里只需要操作一个节点 **VibeDraw 配置(Config)**：设访问密码,挑三套 checkpoint,以及高质量那一路的三个模型槽位。密码填错时请求在入队之前就返回 `401`,不会生图,密码留空则不校验。
- 完整 HTTP 契约,配置字段与离线自测见 [comfyui-plugin/README.md](./comfyui-plugin/README.md)。

插件版本只有一个出处：`comfyui-plugin/vibedraw_comfy/version.py` 的 `__version__`(当前 `2.2.0`)。仓库内构建发布包：

```sh
python3 tools/package-plugin.py          # 生成确定性 zip(固定时间戳与条目顺序)
python3 tools/package-plugin.py --check  # 只校验不写入
```

官网安装卡片提供可直接下载的插件包(已核实可用)：

```text
https://hermit.airen.life/downloads/vibedraw/vibedraw-comfyui-plugin-v2.0.1.zip
```

> 说明：线上当前发布到 `v2.0.1`,而本仓库插件源码已是 `v2.2.0`,想用最新源码请自行用上面的命令打包。

## 项目结构

```text
index.html                       页面骨架与脚本装配
hermit.json                      happ 身份与版本
app/core/                        命名空间,状态和通用工具
app/platform/                    Hermit Bridge 与浏览器降级
app/services/                    作品存储,文件资产,模型协议适配,生成调度
app/components/                  画布,统一弹层,设置与历史画廊
app/features/                    页面用例编排
styles/                          设计令牌与组件样式
comfyui-plugin/                  ComfyUI VibeDraw Plugin 源码与说明
tests/                           无第三方依赖的协议单元测试
tools/verify.mjs                 静态合同检查入口
tools/package.py                 运行包打包
tools/package-plugin.py          CVP 插件打包
tools/performance-benchmark.mjs  可重复的克隆与存储分块基准
docs/performance.md              HermitApp 性能设计与诊断不变量
```

运行包只包含 `index.html`,`hermit.json`,`guid.md`,`app/` 与 `styles/`,`tools/`,`tests/`,`docs/`,`release/`,`comfyui-plugin/` 不进运行包。

## 开发与验证

```sh
node tools/verify.mjs                # 完整自检
node tools/verify.mjs --source-only  # 打包前:只做源码侧检查
python3 tools/package.py             # 生成 release/vibedraw-v<版本>.zip 并同步 hermit-install.json
python3 tools/package.py --check     # 只校验不写入
node tools/performance-benchmark.mjs # 性能基准
```

打包仅归档原生源文件,不执行编译。DEV 副本的 `#self-test` 入口覆盖绘图,撤销 / 重做,对象操作,蒙版,图片文件读回,历史恢复,主题,语言与布局合同,测试后恢复原有作品和设置,并删除临时测试作品。稳定通道不会执行此入口。模型出图需要用户自行配置的服务与密钥,不能用协议测试替代真实出图验收。

性能架构与诊断入口见 [docs/performance.md](./docs/performance.md)。

## Hermit 家族

**Hermit 家族 —— 一个安卓宿主 + 若干可自由改造的应用**

- **Hermit**(宿主,先装这个)：<https://hermit.airen.life/> · <https://github.com/zhyuzh3d/hermitapp>
- **chataxi**(多角色 AI 群聊)：<https://chataxi.airen.life/> · <https://github.com/zhyuzh3d/chataxi>
- **VibeDraw**(实时 AI 绘图)：<https://vibedraw.airen.life/> · <https://github.com/zhyuzh3d/vibedraw> —— **本仓库**
- **PoseGi**(3D 摆姿生图)：<https://posegi.airen.life/> · <https://github.com/zhyuzh3d/PoseGi>

三个 happ 都必须先装 Hermit 宿主,再在[应用广场](https://hermit.airen.life/pages/happs.html)添加。VibeDraw 与 chataxi,PoseGi 互不依赖,只做相互推荐,PoseGi 也能复用本仓库的 CVP 插件接入方式。

## 贡献

欢迎提交 Issue 与 Pull Request。请先阅读 [CONTRIBUTING.md](./CONTRIBUTING.md)：其中说明了提 Issue / 提 PR 的流程,分支与提交信息风格,如何在本地跑起来与自检,代码风格与红线,以及不要提交哪些内容(API Key,用户图片,发布 ZIP 等)。

## License

本项目以 [MIT License](./LICENSE) 发布,Copyright (c) 2026 zhyuzh。

## 免责与支持

- VibeDraw 不内置任何平台密钥,生图接口由你自己填写并承担相应费用。
- 公网服务必须使用 HTTPS,HTTP 只允许可信局域网地址。
- 遇到问题请到 <https://github.com/zhyuzh3d/vibedraw/issues> 反馈。
