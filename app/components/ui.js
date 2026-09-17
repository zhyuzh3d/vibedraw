(function (app) {
  "use strict";
  var layer, content, actions, lastFocus, beforeClose, confirmResolve, confirmFocus;
  var t = app.i18n.text;
  function init() {
    layer = document.getElementById("modal-layer"); content = document.getElementById("modal-content"); actions = document.getElementById("modal-actions");
    document.addEventListener("keydown", function (event) { if (event.key === "Tab") document.body.classList.add("keyboard-focus"); });
    ["pointerdown", "mousedown", "touchstart"].forEach(function (name) { document.addEventListener(name, function () { document.body.classList.remove("keyboard-focus"); }, { passive: true }); });
    layer.querySelectorAll("[data-close-modal]").forEach(function (node) { node.addEventListener("click", requestClose); });
    document.getElementById("confirm-cancel").onclick = function () { resolveConfirm(false); };
    document.getElementById("confirm-ok").onclick = function () { resolveConfirm(true); };
    document.getElementById("confirm-layer").querySelector(".modal-backdrop").onclick = function () { resolveConfirm(false); };
    document.addEventListener("keydown", function (event) {
      var active = !document.getElementById("confirm-layer").hidden ? document.getElementById("confirm-layer") : !layer.hidden ? layer : null;
      if (!active) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); confirmResolve ? resolveConfirm(false) : requestClose(); }
      if (event.key === "Tab") {
        var nodes = Array.prototype.filter.call(active.querySelectorAll("button, input, textarea, select, [tabindex='0']"), function (node) { return !node.disabled && node.offsetParent !== null; });
        if (!nodes.length) { event.preventDefault(); return; }
        var first = nodes[0], last = nodes[nodes.length - 1];
        if (event.shiftKey && (document.activeElement === first || !active.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || !active.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
      }
    });
  }
  function open(options) {
    if (layer.hidden) lastFocus = document.activeElement;
    beforeClose = options.beforeClose || null;
    document.getElementById("modal-title").textContent = options.title || "";
    document.getElementById("modal-eyebrow").textContent = options.eyebrow || "";
    var sheet = layer.querySelector(".modal-sheet");
    sheet.className = "modal-sheet" + (options.mode === "center" ? " centered" : "") + (options.sheetClass ? " " + options.sheetClass : "");
    content.className = "modal-content" + (options.contentClass ? " " + options.contentClass : ""); content.innerHTML = options.html || ""; content.scrollTop = 0;
    actions.innerHTML = options.footerHtml || ""; actions.hidden = !options.footerHtml;
    app.i18n.dom(layer); layer.hidden = false; document.body.style.overflow = "hidden";
    sheet.focus({ preventScroll: true });
    return content;
  }
  async function requestClose() { if (!beforeClose || await beforeClose()) close(); }
  function close() {
    if (!layer || layer.hidden) return;
    layer.hidden = true; content.innerHTML = ""; actions.innerHTML = ""; actions.hidden = true; beforeClose = null;
    document.body.style.overflow = "";
    if (lastFocus && lastFocus.isConnected) lastFocus.focus({ preventScroll: true });
    lastFocus = null;
  }
  function confirm(options) {
    if (confirmResolve) resolveConfirm(false);
    var target = document.getElementById("confirm-layer");
    document.getElementById("confirm-title").textContent = options.title;
    document.getElementById("confirm-message").textContent = options.message || "";
    document.getElementById("confirm-cancel").textContent = options.cancel || t("取消", "Cancel");
    var ok = document.getElementById("confirm-ok");
    ok.textContent = options.ok || t("确定", "Confirm");
    ok.className = "button " + (options.danger ? "button-danger" : "button-primary");
    confirmFocus = document.activeElement; target.hidden = false;
    document.body.style.overflow = "hidden"; document.getElementById("confirm-cancel").focus();
    return new Promise(function (resolve) { confirmResolve = resolve; });
  }
  function resolveConfirm(value) {
    document.getElementById("confirm-layer").hidden = true;
    if (layer.hidden) document.body.style.overflow = "";
    var resolve = confirmResolve; confirmResolve = null;
    if (confirmFocus && confirmFocus.isConnected) confirmFocus.focus({ preventScroll: true });
    if (resolve) resolve(value);
  }
  function toast(message, type) {
    var stack = document.getElementById("toast-stack"), text = String(message || "");
    var existing = Array.prototype.find.call(stack.children, function (node) { return node.dataset.message === text; });
    if (existing) return;
    while (stack.children.length >= 2) stack.firstChild.remove();
    var node = document.createElement("div"); node.className = "toast" + (type === "error" ? " error" : "");
    node.dataset.message = text;
    node.innerHTML = '<i class="fa-solid fa-' + (type === "error" ? "circle-exclamation" : "circle-check") + '"></i><span></span><button aria-label="' + t("关闭", "Dismiss") + '">×</button>';
    node.querySelector("span").textContent = text; node.querySelector("button").onclick = function () { node.remove(); };
    stack.appendChild(node); setTimeout(function () { node.remove(); }, type === "error" ? 6500 : 2600);
  }
  function action(handler) {
    return async function (event) {
      var button = event && event.currentTarget, wasDisabled = button && button.disabled;
      if (button) button.disabled = true;
      try { return await handler(event); } catch (error) { toast(app.utils.cleanError(error), "error"); }
      finally { if (button && button.isConnected) button.disabled = Boolean(wasDisabled); }
    };
  }
  app.components.ui = { init: init, open: open, close: close, requestClose: requestClose, confirm: confirm, toast: toast, action: action };
})(window.vibedraw);
