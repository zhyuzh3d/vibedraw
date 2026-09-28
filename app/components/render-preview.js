(function (app) {
  "use strict";
  var root, stage, image, surface, zoom, adjustmentsPanel, transformTask, surfaceTask;
  var current = null, scale = 1, offsetX = 0, offsetY = 0;
  var pointers = {}, gesture = null, previousOverflow = "", stageRect = null, sourceReady = false;
  // Brightness and contrast are not offered here, so the preview always draws with
  // them neutral: the shared filter builder must receive numbers, and the four
  // sliders this panel does own are the ones worth carrying.
  var NEUTRAL = { resultBrightness: 100, resultContrast: 100 };
  var adjustments = { resultSaturation: 100, resultHue: 0, resultGlow: 0, resultClarity: 0 };
  var adjustmentKeys = ["resultSaturation", "resultHue", "resultGlow", "resultClarity"];
  //: Whether the adjustments reach the picture at all. It is part of the same draft
  //: as the sliders' values: it starts from the saved render default, governs this
  //: preview only, and is written where the other values are written — the
  //: save-default button.
  var adjustmentsEnabled = true;

  function point(event) { return { x: event.clientX, y: event.clientY }; }
  function pointerValues() { return Object.keys(pointers).map(function (key) { return pointers[key]; }); }
  function distance(a, b) { var x = a.x - b.x, y = a.y - b.y; return Math.sqrt(x * x + y * y); }
  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function clampOffset() {
    var width = surface && surface.clientWidth || stage.clientWidth, height = surface && surface.clientHeight || stage.clientHeight;
    var limitX = Math.max(0, (width * scale - stage.clientWidth) / 2), limitY = Math.max(0, (height * scale - stage.clientHeight) / 2);
    offsetX = Math.max(-limitX, Math.min(limitX, offsetX)); offsetY = Math.max(-limitY, Math.min(limitY, offsetY));
  }
  function apply() {
    clampOffset();
    if (surface) surface.style.transform = "translate(" + offsetX + "px," + offsetY + "px) scale(" + scale + ")";
    if (zoom) zoom.textContent = Math.round(scale * 100) + "%";
  }
  function reset() { scale = 1; offsetX = 0; offsetY = 0; pointers = {}; gesture = null; apply(); }
  function beginGesture() {
    var values = pointerValues();
    if (values.length >= 2) {
      var center = midpoint(values[0], values[1]), rect = stageRect || stage.getBoundingClientRect();
      gesture = { type: "pinch", distance: Math.max(1, distance(values[0], values[1])), scale: scale,
        localX: (center.x - (rect.left + rect.width / 2) - offsetX) / scale, localY: (center.y - (rect.top + rect.height / 2) - offsetY) / scale };
    } else if (values.length === 1) gesture = { type: "pan", point: values[0], x: offsetX, y: offsetY };
  }
  function pointerDown(event) {
    if (event.button !== undefined && event.button !== 0) return;
    event.preventDefault(); stageRect = stage.getBoundingClientRect(); pointers[event.pointerId == null ? "mouse" : event.pointerId] = point(event);
    if (stage.setPointerCapture && event.pointerId !== undefined && event.isTrusted) stage.setPointerCapture(event.pointerId);
    beginGesture();
  }
  function pointerMove(event) {
    var key = event.pointerId == null ? "mouse" : event.pointerId; if (!pointers[key]) return;
    event.preventDefault(); pointers[key] = point(event); var values = pointerValues();
    if (values.length >= 2) {
      if (!gesture || gesture.type !== "pinch") beginGesture();
      var center = midpoint(values[0], values[1]), rect = stageRect || stage.getBoundingClientRect();
      scale = Math.max(1, Math.min(8, gesture.scale * distance(values[0], values[1]) / gesture.distance));
      offsetX = center.x - (rect.left + rect.width / 2) - gesture.localX * scale;
      offsetY = center.y - (rect.top + rect.height / 2) - gesture.localY * scale;
    } else if (gesture && gesture.type === "pan") {
      offsetX = gesture.x + values[0].x - gesture.point.x; offsetY = gesture.y + values[0].y - gesture.point.y;
    }
    transformTask.request();
  }
  function pointerEnd(event) {
    delete pointers[event.pointerId == null ? "mouse" : event.pointerId]; if (!pointerValues().length) stageRect = null; beginGesture();
  }
  function syncAdjustments() {
    adjustmentKeys.forEach(function (key) {
      var input = document.querySelector('[data-render-adjust="' + key + '"]'), output = document.querySelector('[data-render-adjust-output="' + key + '"]');
      if (!input) return;
      input.value = String(adjustments[key]);
      if (output) output.textContent = String(adjustments[key]) + (input.dataset.suffix || "");
    });
  }
  function configuredAdjustments() {
    var result = {};
    adjustmentKeys.forEach(function (key) {
      var value = Number(app.config && app.config.canvas && app.config.canvas[key]);
      result[key] = Number.isFinite(value) ? value : ({ resultSaturation: 100, resultHue: 0, resultGlow: 0, resultClarity: 0 }[key]);
    });
    return result;
  }
  function configuredEffects() { return !(app.config && app.config.canvas && app.config.canvas.resultAdjustmentsEnabled === false); }
  function resetAdjustments() { adjustments = { resultSaturation: 100, resultHue: 0, resultGlow: 0, resultClarity: 0 }; syncAdjustments(); surfaceTask.request(); }
  function closeAdjustments() { adjustmentsPanel.hidden = true; document.getElementById("render-preview-adjust").setAttribute("aria-expanded", "false"); }
  async function saveAdjustmentsDefault() {
    var config = app.utils.copy(app.config);
    adjustmentKeys.forEach(function (key) { config.canvas[key] = Number(adjustments[key]); });
    config.canvas.resultAdjustmentsEnabled = adjustmentsEnabled !== false;
    await app.services.store.saveConfig(config);
    app.components.ui.toast(app.i18n.text("已保存为渲染图默认调色", "Saved as the render color default"));
  }
  function drawSurface() {
    if (!sourceReady || !surface || !image.naturalWidth || !image.naturalHeight) return;
    if (surface.width !== image.naturalWidth) surface.width = image.naturalWidth;
    if (surface.height !== image.naturalHeight) surface.height = image.naturalHeight;
    var context = surface.getContext("2d");
    context.clearRect(0, 0, surface.width, surface.height);
    app.components.canvas.drawResult(context, image, surface.width, surface.height, false, {
      // The switch is what makes the panel reversible: with it off the preview draws
      // the plain render, which is the only way to see what the sliders did.
      resultAdjustmentsEnabled: adjustmentsEnabled !== false,
      resultBrightness: NEUTRAL.resultBrightness,
      resultContrast: NEUTRAL.resultContrast,
      resultSaturation: adjustments.resultSaturation,
      resultHue: adjustments.resultHue,
      resultGlow: adjustments.resultGlow,
      resultClarity: adjustments.resultClarity
    });
    surface.hidden = false;
    apply();
  }
  function syncEffects() {
    var toggle = document.getElementById("render-preview-adjust-enabled");
    if (toggle) toggle.checked = adjustmentsEnabled !== false;
  }
  function toggleAdjustments() {
    var button = document.getElementById("render-preview-adjust");
    adjustmentsPanel.hidden = !adjustmentsPanel.hidden;
    button.setAttribute("aria-expanded", String(!adjustmentsPanel.hidden));
  }
  function init() {
    root = document.getElementById("render-preview"); stage = document.getElementById("render-preview-stage"); image = document.getElementById("render-preview-image"); surface = document.getElementById("render-preview-surface");
    transformTask = app.runtime.createFrameTask(apply); surfaceTask = app.runtime.createFrameTask(drawSurface);
    zoom = document.getElementById("render-preview-zoom"); adjustmentsPanel = document.getElementById("render-preview-adjustments");
    stage.addEventListener("pointerdown", pointerDown); stage.addEventListener("pointermove", pointerMove); stage.addEventListener("pointerup", pointerEnd); stage.addEventListener("pointercancel", pointerEnd);
    stage.addEventListener("dblclick", reset);
    document.getElementById("render-preview-close").onclick = close;
    document.getElementById("render-preview-adjust").onclick = toggleAdjustments;
    document.getElementById("render-preview-download").onclick = app.components.ui.action(function () { return download(); });
    document.getElementById("render-preview-reset").onclick = reset;
    document.getElementById("render-preview-clear").onclick = function () { app.events.emit("render:clear"); };
    document.getElementById("render-preview-adjust-close").onclick = closeAdjustments;
    document.getElementById("render-preview-adjust-reset").onclick = resetAdjustments;
    document.getElementById("render-preview-adjust-default").onclick = app.components.ui.action(saveAdjustmentsDefault);
    var effectsToggle = document.getElementById("render-preview-adjust-enabled");
    if (effectsToggle) effectsToggle.onchange = function () { adjustmentsEnabled = effectsToggle.checked; surfaceTask.request(); };
    adjustmentKeys.forEach(function (key) {
      var input = document.querySelector('[data-render-adjust="' + key + '"]');
      if (!input) return;
      input.addEventListener("input", function () {
        adjustments[key] = Number(input.value);
        var output = document.querySelector('[data-render-adjust-output="' + key + '"]'); if (output) output.textContent = input.value + (input.dataset.suffix || "");
        surfaceTask.request();
      });
    });
    image.onload = function () { if (!current || image.getAttribute("src") !== current.src) return; sourceReady = true; image.hidden = true; drawSurface(); reset(); };
    image.onerror = function () { if (!current || image.getAttribute("src") !== current.src) return; sourceReady = false; surface.hidden = true; image.hidden = true; };
    document.addEventListener("keydown", function (event) { if (!root.hidden && event.key === "Escape") close(); });
  }
  function open(result) {
    if (!result || !result.src) return;
    current = result; adjustments = configuredAdjustments(); adjustmentsEnabled = configuredEffects(); syncAdjustments(); syncEffects();
    previousOverflow = document.body.style.overflow; document.body.style.overflow = "hidden";
    root.hidden = false; root.classList.add("is-open"); adjustmentsPanel.hidden = true; document.getElementById("render-preview-adjust").setAttribute("aria-expanded", "false");
    sourceReady = false; image.hidden = true; surface.hidden = true; image.removeAttribute("src"); surface.style.transform = ""; reset(); image.src = result.src;
    document.getElementById("render-preview-close").focus({ preventScroll: true });
  }
  function close() {
    if (!root || root.hidden) return;
    root.hidden = true; root.classList.remove("is-open"); document.body.style.overflow = previousOverflow; pointers = {}; gesture = null; stageRect = null; sourceReady = false; transformTask.cancel(); surfaceTask.cancel(); image.hidden = true; surface.hidden = true; image.removeAttribute("src"); current = null;
  }
  async function download(result) {
    result = result || current;
    if (!result || !result.src || !sourceReady) return;
    var src;
    try { src = surface.toDataURL("image/png"); }
    catch (_) { app.components.ui.toast(app.i18n.text("无法读取调色后的像素，请重新打开渲染图后重试", "The adjusted pixels could not be read. Reopen the render and try again."), "error"); return; }
    await app.components.canvas.exportSource(src, "", "VibeDraw-render-adjusted");
    app.components.ui.toast(app.i18n.text("已下载调色后的渲染图", "Adjusted render downloaded"));
  }
  app.components.renderPreview = { init: init, open: open, close: close, reset: reset, download: download };
})(window.vibedraw);
