# VibeDraw 开发约束

VibeDraw 是 HermitApp 中运行的普通 happ，不拥有宿主管理权限。

- 运行包只包含 `index.html`、`hermit.json`、`app/` 与 `styles/`。
- 使用可直接运行的原生 HTML、CSS、JavaScript，不引入框架、构建器、包管理器、CDN 或远程字体。
- 组件以 IIFE 注册到 `window.vibedraw`；依赖方向保持为 core → platform → services → components → features。
- API Key 只在用户明确保存后写入本 happ 的隔离数据，界面始终默认遮罩，不写入源码、日志、文档或测试。
- 所有模型网络请求统一经过 `app/platform/hermit.js`。公网服务必须使用 HTTPS；HTTP 只允许可信局域网地址。
- 图片字节、Base64 和 data URL 禁止写入 `hermit.data`，作品记录只保存文件引用。用户导入的图片与服务返回的图片文件使用 `hermit.files` 逻辑文件；内联模型图片通过公开的文本文件接口保存为有界编码文件块，由 `services/assets.js` 统一恢复和清理。不可在 release 目录保存用户资产，也不可臆造宿主二进制写入接口。
- 兼容 Android 10 与旧厂商 WebView，避免无降级的新语法和新 Web API。
- 修改后运行 `node tools/verify.mjs`。设备验收分别记录 DEV 同步、页面渲染、稳定包安装和真实模型出图结果。
- 版本规则：每次任务完成默认递增补丁版本号的第三位（例如 `0.4.0` → `0.4.1`）；只有用户明确指定版本策略或目标版本时，才按用户要求调整其他位数。
- 发布规则：每次任务产生修改后，先递增补丁版本、运行 `node tools/verify.mjs`，再优先使用 Hermit 智能体开发模式同步到设备；同步后必须等待 DEV render 确认并读取设备页面状态，确认版本号与页面已启动。只有用户明确要求稳定包安装时，才构建或安装 APK；智能体开发模式发布不替代稳定包发布。
