# 贡献指南

感谢你愿意为 **VibeDraw** 出力。VibeDraw 是运行在 Hermit 宿主里的原生页面 happ,还带一个 ComfyUI 插件(CVP)。本文件说明提 Issue,提 Pull Request,本地开发与自检,代码风格与红线。动手前请先读一遍,并顺带读一下仓库里的 `AGENTS.md` 与 `guid.md`。

## 提 Issue

- 到 <https://github.com/zhyuzh3d/vibedraw/issues> 新建 Issue,优先使用仓库提供的模板：`.github/ISSUE_TEMPLATE/bug_report.yml`(缺陷)与 `feature_request.yml`(功能建议)。
- 缺陷请写清：复现步骤,期望结果,实际结果,VibeDraw 版本(见 `hermit.json`),Hermit 版本,Android 与 WebView 版本,所用接口模式(CVP / OpenAI Images / SD WebUI / Stability)以及相关日志或截图。
- **不要**在 Issue 里粘贴真实 API Key,访问令牌或隐私图片,需要展示时请自行打码。

## 提 Pull Request

1. Fork 本仓库并从 `main` 切出特性分支。分支名建议 `fix/短描述`,`feat/短描述`,`doc/短描述`。
2. 一个 PR 只做一件事,只改与目标直接相关的文件。改动 ComfyUI 插件时请说明它对应 `comfyui-plugin/vibedraw_comfy/version.py` 的哪个版本。
3. 提交前跑与改动相称的自检(见下),在 PR 描述里写清：改了什么,为什么,怎么验证的。
4. 向 `main` 发起 PR,描述里关联相关 Issue(如 `Closes #12`)。

## 分支与提交信息风格

- 分支：从 `main` 切出,合并回 `main`。
- 提交信息参考仓库既有历史,推荐使用一句话主题行(可用半角前缀)：
  - `feat: 一句话说清新能力`
  - `fix: 一句话说清修了什么`
  - `doc:` / `chore:` / `refactor:` / `test:`
  - 也可以用中文直接描述,例如「局部重绘：蒙版退出后不再清除笔迹」。
- 主题行尽量控制在 72 字符以内,需要时在正文说明动机,影响面与验证方式。

## 本地跑起来

VibeDraw 是纯原生页面,**没有构建步骤**,源文件直接运行,直接用浏览器打开 `index.html` 可看界面(没有 Hermit Bridge 时 `app/platform/hermit.js` 会退回浏览器降级路径)。

需要真机热更新时(设备开发地址与密码见手机 Hermit 的「开发配置」)：

```sh
python3 ~/.workbuddy/skills/hermit-dev-plugin/hermit-agent.py develop-dir <目录> --quiet
```

ComfyUI 插件(本地出图链路)的安装与自测见 [comfyui-plugin/README.md](./comfyui-plugin/README.md)。

## 自检

按改动范围选择,验证强度与改动相称：

```sh
node tools/verify.mjs --source-only  # 打包前:含跨模块导出检查与静态断言
node tools/verify.mjs                # 完整自检
python3 tools/package.py --check     # 只在改动触及发布产物时:校验运行包
python3 tools/package-plugin.py --check  # 只在改动触及 CVP 插件时:校验插件包
node tools/performance-benchmark.mjs # 改动绘制热路径或存储时:性能基准
```

DEV 副本的 `#self-test` 入口覆盖绘图,撤销 / 重做,对象操作,蒙版,图片文件读回,历史恢复,主题,语言与布局合同,测试后会恢复原有作品与设置。模型出图需要你自己配置的服务与密钥,不能用协议测试替代真实出图验收。

## 代码风格与红线

- **依赖方向固定** `core → platform → services → components → features`,**所有模型请求必须经过 `app/platform/hermit.js`**,其余模块不得直接发网络请求或调用宿主。
- 使用可直接运行的原生 HTML / CSS / JavaScript,组件以 IIFE 注册到 `window.vibedraw`,**不引入**框架,构建器,包管理器,CDN 或远程字体。
- 兼容 Android 10 与旧厂商 WebView,避免无降级的新语法与新 Web API。
- 图片字节,Base64,data URL **禁止写入 `hermit.data`**：作品记录只存文件引用,用户导入的图片与服务返回的图片使用 Hermit 逻辑文件,内联图片通过公开文本文件接口保存为有界编码文件块,由 `services/assets.js` 统一恢复和清理。不要在 release 目录保存用户资产,也不要臆造宿主二进制写入接口。
- 接口模式与参数：画幅,步数,参考图权重由所选接口的内置规格决定,`ref_strength` 是唯一的参考图权重入口。CVP 的契约以 `comfyui-plugin/README.md` 为准。
- 提示词必须是英文,中文由 `services/translate.js` 译成英文再提交,生图路径只读翻译缓存,绝不触发网络。
- 运行包只包含 `index.html`,`hermit.json`,`guid.md`,`app/` 与 `styles/`,`tools/`,`tests/`,`docs/`,`release/`,`comfyui-plugin/` 不进运行包。插件版本只有一个出处：`comfyui-plugin/vibedraw_comfy/version.py`。

## 不要提交

- API Key,密码,访问令牌。
- 用户图片,作品数据或任何发布 ZIP 之外的本地产物。
- 与改动无关的大体积二进制文件。

## License

提交即表示你同意你的贡献以本仓库的 [MIT License](./LICENSE) 授权。
