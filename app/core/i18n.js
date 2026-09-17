(function (app) {
  "use strict";
  function language() { return app.config && app.config.preferences && app.config.preferences.language === "en" ? "en" : "zh"; }
  function text(zh, en) { return language() === "en" ? en || zh : zh; }
  function dom(root) {
    (root || document).querySelectorAll("[data-zh]").forEach(function (node) {
      var value = text(node.dataset.zh, node.dataset.en);
      if (node.dataset.i18nAttr) node.setAttribute(node.dataset.i18nAttr, value);
      else node.textContent = value;
    });
    document.documentElement.lang = language() === "en" ? "en" : "zh-CN";
  }
  function theme() {
    var preference = app.config && app.config.preferences && app.config.preferences.theme || "system";
    var dark = preference === "dark" || preference === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = dark ? "#17191d" : "#f4f5f7";
    if (app.platform.hermit && app.platform.hermit.current()) app.platform.hermit.current().appearance.reportTheme({ theme: dark ? "dark" : "light" }).catch(function () {});
  }
  function error(message) {
    if (language() !== "en") return message;
    var translations = {
      "服务地址必须是完整的 HTTP(S) URL": "Enter a complete HTTP(S) URL",
      "服务地址只能使用无账号信息的 HTTP(S) URL": "Use an HTTP(S) URL without embedded credentials or fragments",
      "公网服务必须使用 HTTPS；HTTP 仅允许可信局域网地址": "Public services require HTTPS. HTTP is supported on a trusted LAN",
      "自定义 Header 必须是 JSON 对象": "Custom headers must be a JSON object",
      "Header 名称不合法：": "Invalid header name: ",
      "模型已响应，但未找到可显示的图片": "The model responded without a displayable image",
      "ComfyUI 未返回上传图片名称": "ComfyUI did not return an uploaded image name",
      "ComfyUI 需要粘贴有效的 API workflow JSON": "Paste a valid ComfyUI API workflow JSON",
      "ComfyUI 未返回任务 ID，请确认粘贴的是 API workflow": "ComfyUI did not return a task ID. Check your API workflow",
      "ComfyUI 生成超时，任务可能仍在服务端队列中": "ComfyUI timed out. The task may still be queued on the server",
      "不支持的图像接口协议：": "Unsupported image API: ",
      "模型配置不存在": "Model settings are missing",
      "请填写图像模型 ID": "Enter an image model ID",
      "请先粘贴 ComfyUI API workflow JSON": "Paste a ComfyUI API workflow JSON first",
      "服务返回的不是有效 JSON": "The service returned invalid JSON",
      "无法读取所选图片": "Unable to read the selected image",
      "当前环境不能读取剪贴板，请长按输入框粘贴": "Clipboard access is unavailable. Long-press the input to paste",
      "画布图像格式异常": "Invalid canvas image format",
      "认证失败": "Authentication failed", "权限不足": "Permission denied", "额度或频率限制": "Rate or quota limit", "服务端错误": "Server error", "请求失败": "Request failed"
    };
    Object.keys(translations).forEach(function (key) { message = message.split(key).join(translations[key]); });
    return message;
  }
  app.i18n = { text: text, dom: dom, language: language, theme: theme, error: error };
})(window.vibedraw);
