(function (app) {
  "use strict";
  var root, stage, image, meta, zoom, current = null, scale = 1, offsetX = 0, offsetY = 0;
  var pointers = {}, gesture = null, previousOverflow = "";
  function point(event) { return { x: event.clientX, y: event.clientY }; }
  function pointerValues() { return Object.keys(pointers).map(function (key) { return pointers[key]; }); }
  function distance(a, b) { var x = a.x - b.x, y = a.y - b.y; return Math.sqrt(x * x + y * y); }
  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function clampOffset() {
    var side = Math.min(stage.clientWidth, stage.clientHeight), limit = Math.max(0, side * (scale - 1) / 2);
    offsetX = Math.max(-limit, Math.min(limit, offsetX)); offsetY = Math.max(-limit, Math.min(limit, offsetY));
  }
  function apply() {
    clampOffset(); image.style.transform = "translate(" + offsetX + "px," + offsetY + "px) scale(" + scale + ")";
    zoom.textContent = Math.round(scale * 100) + "%";
  }
  function reset() { scale = 1; offsetX = 0; offsetY = 0; pointers = {}; gesture = null; apply(); }
  function beginGesture() {
    var values = pointerValues();
    if (values.length >= 2) {
      var center = midpoint(values[0], values[1]), rect = stage.getBoundingClientRect();
      gesture = { type: "pinch", distance: Math.max(1, distance(values[0], values[1])), scale: scale, x: offsetX, y: offsetY,
        localX: (center.x - (rect.left + rect.width / 2) - offsetX) / scale, localY: (center.y - (rect.top + rect.height / 2) - offsetY) / scale };
    } else if (values.length === 1) gesture = { type: "pan", point: values[0], x: offsetX, y: offsetY };
  }
  function pointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault(); pointers[event.pointerId == null ? "mouse" : event.pointerId] = point(event);
    if (stage.setPointerCapture && event.pointerId !== undefined && event.isTrusted) stage.setPointerCapture(event.pointerId);
    beginGesture();
  }
  function pointerMove(event) {
    var key = event.pointerId == null ? "mouse" : event.pointerId; if (!pointers[key]) return;
    event.preventDefault(); pointers[key] = point(event); var values = pointerValues();
    if (values.length >= 2) {
      if (!gesture || gesture.type !== "pinch") beginGesture();
      var center = midpoint(values[0], values[1]), rect = stage.getBoundingClientRect();
      scale = Math.max(1, Math.min(8, gesture.scale * distance(values[0], values[1]) / gesture.distance));
      offsetX = center.x - (rect.left + rect.width / 2) - gesture.localX * scale;
      offsetY = center.y - (rect.top + rect.height / 2) - gesture.localY * scale;
    } else if (gesture && gesture.type === "pan") {
      offsetX = gesture.x + values[0].x - gesture.point.x; offsetY = gesture.y + values[0].y - gesture.point.y;
    }
    apply();
  }
  function pointerEnd(event) {
    delete pointers[event.pointerId == null ? "mouse" : event.pointerId]; beginGesture();
  }
  function init() {
    root = document.getElementById("render-preview"); stage = document.getElementById("render-preview-stage"); image = document.getElementById("render-preview-image");
    meta = document.getElementById("render-preview-meta"); zoom = document.getElementById("render-preview-zoom");
    stage.addEventListener("pointerdown", pointerDown); stage.addEventListener("pointermove", pointerMove); stage.addEventListener("pointerup", pointerEnd); stage.addEventListener("pointercancel", pointerEnd);
    stage.addEventListener("dblclick", reset);
    document.getElementById("render-preview-close").onclick = close;
    document.getElementById("render-preview-download").onclick = app.components.ui.action(async function () {
      if (!current) return; await app.components.canvas.exportSource(current.src, current.logicalFileId, "VibeDraw-render-1024");
      app.components.ui.toast(app.i18n.text("渲染大图已下载", "Render downloaded"));
    });
    image.onload = function () {
      var correct = image.naturalWidth === 1024 && image.naturalHeight === 1024;
      meta.textContent = image.naturalWidth + " × " + image.naturalHeight;
      meta.classList.toggle("is-warning", !correct);
    };
    document.addEventListener("keydown", function (event) { if (!root.hidden && event.key === "Escape") close(); });
  }
  function open(result) {
    if (!result || !result.src) return;
    current = result; previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    root.hidden = false; meta.textContent = "1024 × 1024"; meta.classList.remove("is-warning"); image.src = result.src; reset();
    document.getElementById("render-preview-close").focus({ preventScroll: true });
  }
  function close() { if (!root || root.hidden) return; root.hidden = true; document.body.style.overflow = previousOverflow; pointers = {}; gesture = null; }
  app.components.renderPreview = { init: init, open: open, close: close, reset: reset };
})(window.vibedraw);
