# VibeDraw 0.2.2 交付记录

日期：2026-09-17

## 图片选择与变换

- 选择模式选中图片后显示四个圆形角手柄。
- 单指拖动任意角手柄进行等比缩放，对角固定，不拉伸图片比例。
- 支持双指捏合缩放；捏合中心移动时图片同步平移。
- 手柄视觉半径为 16 画布像素，实际触控命中半径扩大到 36 画布像素。
- 图片最小尺寸限制为 48 画布像素，最大尺寸限制为 2304 画布像素。
- 一次拖动或捏合只提交一个历史快照，支持完整撤销与重做。

## 验证与部署

- `node tools/verify.mjs --source-only`：通过。
- `python3 tools/package.py`：通过。
- `node tools/verify.mjs`：通过，20 个运行文件与发布包逐文件一致。
- Android 11 / Chrome WebView 83 的 DEV revision 18 完成 45 项自检，新增检查覆盖四角手柄、角点等比缩放、缩放撤销、缩放重做和双指捏合。
- 稳定 release `45eb0150-8538-49d5-a72e-74e098e03b96` 已安装，稳定树摘要 `551e4378909a527f63730189625b351ad7185cdb475cf20d23860f08c7e8282c`。
- 安装后状态：`launchChannel=stable`、`runtimeMode=local`、`isDevelopmentCopy=false`，开发模式关闭。

## 发布物

- `release/vibedraw-v0.2.2.zip`
- SHA-256：`34d1a8b86e096747fc2cd3d7a587ec8e9050e929cd601148242c9c49034bd725`
