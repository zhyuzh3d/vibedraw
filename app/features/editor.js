(function (app) {
  "use strict";
  var t = app.i18n.text, ui, canvas, initial, imageSource = "", resizeTask, canvasSyncTask, opacityAnimationFrame = 0, resultOpacityAnimationFrame = 0, renderResultPresent = false, canvasPanX = 0, promptDrag = null, maskMode = false;
  var fullscreenPan = { timer: 0, active: false, moved: false, suppressClick: false, startX: 0, startPan: 0, wasCollapsed: false };
  var adjustmentNames = ["resultBrightness", "resultContrast", "resultSaturation", "resultHue", "resultGlow", "resultClarity"];
  var neutralAdjustments = { resultBrightness: 100, resultContrast: 100, resultSaturation: 100, resultHue: 0, resultGlow: 0, resultClarity: 0 };
  function node(id) { return document.getElementById(id); }
  function randomSeed() { return Math.floor(Math.random() * 2147483647); }
  function configuredAdjustment(name) { var value = Number(app.config.canvas[name]); return Number.isFinite(value) ? value : neutralAdjustments[name]; }
  function init() {
    ui = app.components.ui; canvas = app.components.canvas; resizeTask = app.runtime.createFrameTask(resizeStage); canvasSyncTask = app.runtime.createFrameTask(syncCanvas);
    app.components.gallery.init({ newWork: newWork, resetWork: resetWork, syncAll: syncAll });
    initial = { objects: [], result: null, prompt: "", localPrompt: "", workId: "", workTitle: "", background: "#ffffff", negativePrompt: app.config.canvas.negativePrompt || "", seed: randomSeed(), seedLocked: true, strength: 0.8, colorStrength: 0.3, autoDelayMs: Number(app.config.canvas.autoDelayMs) || 850, overlayGenerate: false, resultOpacity: 0.9, layerOpacity: 1, resultVisible: true, resultBrightness: configuredAdjustment("resultBrightness"), resultContrast: configuredAdjustment("resultContrast"), resultSaturation: configuredAdjustment("resultSaturation"), resultHue: configuredAdjustment("resultHue"), resultGlow: configuredAdjustment("resultGlow"), resultClarity: configuredAdjustment("resultClarity"), resultAdjustmentsEnabled: app.config.canvas.resultAdjustmentsEnabled !== false };
    node("app-version").textContent = "v" + app.version;
    bindMenu(); bindTools(); bindOptions(); bindActions(); bindGeneration(); bindPromptControls(); bindActionHelp();
    app.events.on("canvas:rendered", syncCanvas);
    app.events.on("selection", syncSelection);
    app.events.on("tool", setTool);
    app.events.on("history", function (value) { node("undo").disabled = !value.undo; node("redo").disabled = !value.redo; });
    app.events.on("save", function (value) {
      node("save-state").textContent = value === "error" ? t("保存失败", "Save failed") : value === "saved" ? t("已保存", "Saved") : t("保存中…", "Saving…");
      syncTitle();
    });
    app.events.on("works:changed", function (count) { node("history-count").textContent = count; });
    app.events.on("preferences:changed", function () { syncAll(); status(defaultStatus()); });
    app.events.on("config:changed", function () { status(defaultStatus()); });
    app.events.on("result:filter", syncCanvas);
    app.events.on("work:settings", syncAll);
    app.events.on("color:changed", syncColors);
    app.events.on("canvas:interaction", function (active) {
      document.body.classList.toggle("canvas-interacting", Boolean(active) && document.body.classList.contains("canvas-fullscreen"));
      if (active && app.state.overlayGenerate && Number(app.state.layerOpacity) < 0.2) {
        app.state.layerOpacity = 0.2;
        syncCanvas();
        app.services.store.scheduleCanvasSave();
        status(t("绘制元素可见度已自动恢复到20%", "Drawing layer visibility was restored to 20%"));
      }
    });
    syncAll(); resizeStage(); window.addEventListener("resize", function () { resizeTask.request(); });
    window.addEventListener("pagehide", function () { app.services.store.flush().catch(function () {}); });
    document.addEventListener("visibilitychange", function () { if (document.hidden) app.services.store.flush().catch(function () {}); });
  }
  function resizeStage() {
    if (document.body.classList.contains("canvas-fullscreen")) {
      document.documentElement.style.setProperty("--fullscreen-height", Math.max(320, window.innerHeight) + "px");
      setCanvasPan(canvasPanX);
      return;
    }
    if (/INPUT|TEXTAREA/.test(document.activeElement.tagName)) return;
    var frame = node("stage-frame"), available = frame.parentNode.clientWidth;
    var side = Math.min(available, 510, Math.max(220, window.innerHeight - 326));
    frame.style.width = side + "px"; frame.style.height = side + "px";
  }
  function closeMenu() { node("app-menu").hidden = true; node("open-menu").setAttribute("aria-expanded", "false"); }
  function bindMenu() {
    node("open-menu").onclick = function (event) {
      event.stopPropagation(); var show = node("app-menu").hidden;
      node("app-menu").hidden = !show; node("open-menu").setAttribute("aria-expanded", String(show));
      if (show) node("app-menu").querySelector("button").focus({ preventScroll: true });
    };
    document.addEventListener("click", function (event) { if (!node("app-menu").contains(event.target) && !node("open-menu").contains(event.target)) closeMenu(); });
    node("app-menu").addEventListener("keydown", function (event) {
      var buttons = Array.prototype.slice.call(node("app-menu").querySelectorAll("button")), index = buttons.indexOf(document.activeElement);
      if (event.key === "Escape") { closeMenu(); node("open-menu").focus(); }
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault(); buttons[(index + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length].focus();
      }
    });
    node("app-menu").querySelectorAll("[data-menu]").forEach(function (button) {
      button.onclick = ui.action(async function () { closeMenu(); if (button.dataset.menu === "new") await newWork(); else if (button.dataset.menu === "history") await app.components.gallery.open(); else app.components.settings.open(button.dataset.menu); });
    });
  }
  function bindTools() {
    document.querySelectorAll("[data-tool]").forEach(function (button) {
      button.onclick = function () { if (button.dataset.tool === "mask") requestMaskTool(); else setTool(button.dataset.tool); };
    });
    node("add-image").onclick = ui.action(async function () {
      var file = await app.platform.hermit.pickImage();
      if (file) { if (!file.cancelled) await canvas.addImage(file); }
      else node("fallback-file").click();
    });
    node("fallback-file").onchange = function (event) {
      var file = event.target.files && event.target.files[0]; event.target.value = "";
      if (!file) return;
      if (!/^image\/(png|jpeg|webp)$/.test(file.type) || file.size > 12 * 1024 * 1024) { ui.toast(t("请选择 12 MB 以内的 PNG、JPEG 或 WebP", "Choose PNG, JPEG or WebP up to 12 MB"), "error"); return; }
      var reader = new FileReader(); reader.onload = function () { canvas.addImage({ url: reader.result, name: file.name }).catch(function (error) { app.events.emit("error", error); }); };
      reader.readAsDataURL(file);
    };
  }
  function setTool(tool, keepView) {
    if (["pencil", "brush", "eraser", "select", "mask"].indexOf(tool) < 0) return;
    if (tool === "mask") enterMaskMode();
    else if (maskMode) exitMaskMode();
    app.state.tool = tool;
    if (tool !== "select") { app.state.selectedId = ""; app.state.selectedIds = []; }
    document.querySelectorAll("[data-tool]").forEach(function (button) {
      button.classList.toggle("is-active", button.dataset.tool === tool); button.setAttribute("aria-pressed", String(button.dataset.tool === tool));
    });
    node("draft-canvas").style.cursor = tool === "select" ? "grab" : "crosshair";
    node("draw-options").hidden = tool === "select"; node("selection-options").hidden = tool !== "select";
    node("stroke-color").hidden = tool === "eraser" || tool === "mask"; node("stroke-opacity-control").hidden = tool === "eraser" || tool === "mask";
    node("background-color").hidden = maskMode;
    node("size-label").textContent = tool === "mask" ? t("区域", "Area") : tool === "eraser" ? t("范围", "Size") : t("粗细", "Size");
    node("draw-options").classList.toggle("is-eraser", tool === "eraser");
    syncMaskUi(); syncSelection(); canvas.refresh();
  }
  function hasResultImage() { return Boolean(app.state.result && app.state.result.src); }
  function enterMaskMode() {
    if (maskMode) return true;
    if (!hasResultImage()) return false;
    maskMode = true; app.state.maskMode = true;
    app.services.imageEngine.stopAuto();
    status(t("局部模式：涂红要改的区域，再点「描述」写这一块要改成什么", "Local mode: mark the area in red, then describe what it should become"));
    return true;
  }
  function exitMaskMode() {
    if (!maskMode) { app.state.maskMode = false; return; }
    maskMode = false; app.state.maskMode = false;
    if (canvas.hasMask()) status(t("已退出局部模式：红色标记已隐藏并保留，下次进入局部会继续显示，也不再参与生成", "Left local mode. Red marks are hidden but kept for your next local edit, and no longer affect generation"));
    syncMaskUi();
  }
  function requestMaskTool() {
    if (!hasResultImage()) { status(t("先用「快速」或随机按钮生成成图，再标记要改的局部", "Generate a result with Fast or the dice first, then mark the area to change")); ui.toast(t("还没有成图，不能使用局部", "No result yet. Local mode is unavailable"), "error"); return; }
    setTool("mask");
  }
  function syncMaskUi() {
    var masking = Boolean(maskMode);
    node("draw-options").classList.toggle("is-mask", masking);
    node("mask-clear").hidden = !masking;
    node("local-prompt-options").hidden = !masking;
    node("auto-toggle").disabled = masking;
    node("overlay-toggle").disabled = masking;
    syncLocalPrompt();
    syncMaskAvailability();
  }
  function syncMaskAvailability() {
    var button = document.querySelector('[data-tool="mask"]'), available = hasResultImage();
    if (!button) return;
    button.classList.toggle("is-disabled", !available);
    button.setAttribute("aria-disabled", String(!available));
    button.setAttribute("aria-label", available ? t("局部重绘：标记要改的区域", "Local redraw: mark the area to change") : t("需要先有一张成图", "A generated result is required first"));
  }
  function localPromptValue() { return String(app.state.localPrompt || "").trim(); }
  function syncLocalPrompt() {
    var localPrompt = localPromptValue(), summary = node("local-prompt-summary");
    if (!summary) return;
    summary.textContent = localPrompt || t("描述这块要改成什么", "Describe this area");
    node("local-prompt").classList.toggle("is-placeholder", !localPrompt);
  }
  function editLocalPrompt() {
    var root = ui.open({ mode: "center", title: t("局部重绘描述", "Local change description"), html: '<label class="field"><span>' + t("这一块要改成什么", "What should this area become") + '</span><textarea id="local-prompt-input" rows="3" maxlength="400"></textarea></label><p class="field-help">' + t("提交给模型时会与顶部画面描述拼接：整体描述 + 局部改动。", "The model receives the artwork description joined with this local change.") + '</p><p class="field-help" id="local-prompt-preview"></p><div class="button-row"><button class="button button-secondary" data-cancel>' + t("取消", "Cancel") + '</button><button class="button button-primary" data-save>' + t("保存", "Save") + '</button></div>' });
    var input = root.querySelector("#local-prompt-input"), preview = root.querySelector("#local-prompt-preview");
    input.value = String(app.state.localPrompt || "");
    input.placeholder = t("例如：把这里改成一只白色的猫", "e.g. turn this area into a white cat");
    function refreshPreview() { preview.textContent = t("将会提交：", "Will submit: ") + (app.utils.composePrompt(app.state.prompt, input.value) || t("（空）", "(empty)")); }
    input.addEventListener("input", refreshPreview); refreshPreview();
    root.querySelector("[data-cancel]").onclick = ui.close;
    root.querySelector("[data-save]").onclick = ui.action(async function () {
      app.state.localPrompt = input.value.trim();
      syncLocalPrompt(); app.services.store.scheduleCanvasSave(); ui.close();
      status(app.state.localPrompt ? t("局部描述已保存，点「快速」或随机按钮重绘这块区域", "Local description saved. Use Fast or the dice to redraw this area") : t("局部描述已清空", "Local description cleared"));
    });
  }
  function bindOptions() {
    node("stroke-color").onclick = function () { app.components.settings.openColor("stroke"); };
    node("brush-size").oninput = function (event) { app.state.size = Number(event.target.value); node("brush-size-value").textContent = event.target.value; app.services.store.scheduleCanvasSave(); };
    node("stroke-opacity").oninput = function (event) { app.state.opacity = Number(event.target.value) / 100; node("stroke-opacity-value").textContent = event.target.value + "%"; app.services.store.scheduleCanvasSave(); };
    node("background-color").onclick = function () { app.components.settings.openColor("background"); };
    node("local-prompt").onclick = editLocalPrompt;
    node("local-prompt-edit").onclick = editLocalPrompt;
    node("mask-clear").onclick = ui.action(async function () {
      var removed = canvas.clearMask();
      syncCanvas(); app.services.store.scheduleCanvasSave();
      status(removed ? t("局部标记已清除，可以重新涂出要改的区域", "Local marks cleared. Mark the area again") : t("当前没有局部标记", "No local marks to clear"));
    });
    node("result-opacity").oninput = function (event) {
      var value = Number(event.target.value) / 100;
      if (app.state.overlayGenerate) app.state.layerOpacity = value; else app.state.resultOpacity = value;
      canvasSyncTask.request(); app.services.store.scheduleCanvasSave(); if (app.state.overlayGenerate) app.services.imageEngine.schedule();
    };
    node("result-visibility").onclick = function () { app.state.resultVisible = app.state.resultVisible === false; syncCanvas(); app.services.store.scheduleCanvasSave(); };
    document.querySelectorAll("[data-adjust]").forEach(function (field) {
      field.oninput = function () {
        app.state[field.dataset.adjust] = Number(field.value);
        node("color-adjust-panel").querySelector('[data-adjust-output="' + field.dataset.adjust + '"]').textContent = field.value + field.dataset.suffix;
        canvasSyncTask.request(); app.services.store.scheduleCanvasSave();
      };
    });
    node("color-adjust-reset").onclick = function () { applyAdjustments(neutralAdjustments); ui.toast(t("调色参数已重置", "Color adjustments reset")); };
    node("color-adjust-close").onclick = closeAdjustments;
    node("color-adjust-enabled").onclick = function () {
      app.state.resultAdjustmentsEnabled = app.state.resultAdjustmentsEnabled === false;
      syncAdjustments(); syncCanvas(); app.services.store.scheduleCanvasSave();
      ui.toast(app.state.resultAdjustmentsEnabled ? t("调色效果已开启", "Color effects enabled") : t("调色效果已关闭", "Color effects disabled"));
    };
    node("color-adjust-default").onclick = ui.action(async function () {
      var config = app.utils.copy(app.config);
      adjustmentNames.forEach(function (name) { config.canvas[name] = Number(app.state[name]); initial[name] = Number(app.state[name]); });
      config.canvas.resultAdjustmentsEnabled = app.state.resultAdjustmentsEnabled !== false; initial.resultAdjustmentsEnabled = config.canvas.resultAdjustmentsEnabled;
      await app.services.store.saveConfig(config); ui.toast(t("已设为新作品的默认调色", "Saved as the default for new artwork"));
    });
  }
  function bindActions() {
    node("undo").onclick = canvas.undo; node("redo").onclick = canvas.redo;
    node("delete-selected").onclick = canvas.removeSelected; node("duplicate-selected").onclick = canvas.duplicateSelected;
    node("group-selected").onclick = canvas.groupSelected; node("ungroup-selected").onclick = canvas.ungroupSelected;
    node("selection-color").onclick = function () { app.components.settings.openColor("selection"); };
    node("layer-down").onclick = function () { canvas.moveLayer(-1); }; node("layer-up").onclick = function () { canvas.moveLayer(1); };
    node("scale-down").onclick = function () { canvas.scaleSelected(0.9); }; node("scale-up").onclick = function () { canvas.scaleSelected(1.1); };
    node("clear-canvas").onclick = ui.action(async function () {
      if (!app.state.objects.length) return;
      if (await ui.confirm({ title: t("清空草稿？", "Clear sketch?"), message: t("删除所有笔触与参考图，成图会保留。之后可以撤销。", "Remove strokes and reference images. The result stays. You can undo this."), ok: t("清空草稿", "Clear sketch"), danger: true })) canvas.clear();
    });
    node("auto-toggle").onclick = function () {
      app.state.autoGenerate = !app.state.autoGenerate;
      if (!app.state.autoGenerate) app.services.imageEngine.stopAuto();
      syncAuto(); app.services.store.scheduleCanvasSave();
      status(app.state.autoGenerate ? t("落笔后自动生成，费用由模型服务计算", "Auto-generate after drawing; provider charges may apply") : t("自动已关闭，点击生成按钮出图", "Auto is off. Tap Generate when ready."));
    };
    node("seed-lock").onclick = function () {
      app.state.seed = randomSeed(); app.state.seedLocked = true;
      syncSeedLock(); app.services.store.scheduleCanvasSave();
      status(t("已更换并锁定随机数 ", "New seed locked: ") + app.state.seed);
      node("generate-quick").click();
    };
    node("generate-quick").onclick = function () { app.services.imageEngine.run("quick", false); };
    node("generate-quality").onclick = function () { app.services.imageEngine.run("upscale", false); };
    node("render-result-trigger").onclick = openRenderPreview;
    node("overlay-toggle").onclick = function () {
      setOverlayGenerate(!app.state.overlayGenerate, true); app.services.store.scheduleCanvasSave(); app.services.imageEngine.schedule();
      status(app.state.overlayGenerate ? t("叠加生成已开启", "Overlay generation enabled") : t("叠加生成已关闭", "Overlay generation disabled"));
    };
    node("snapshot-canvas").onclick = ui.action(async function () {
      await canvas.snapshotVisible(); status(t("当前显示效果已复制为可选择、移动和缩放的图片元素", "Visible canvas copied as a selectable, movable, resizable image")); ui.toast(t("当前画面已复制为可编辑图片", "Visible canvas copied as an editable image"));
    });
    node("cancel-generation").onclick = function () { app.services.imageEngine.cancel(); status(t("已停止等待；服务端任务可能仍在运行", "Dismissed; the server task may still be running")); };
    node("work-settings").onclick = function () { app.components.settings.open("work"); };
    node("canvas-fullscreen").onclick = function () { setCanvasFullscreen(!document.body.classList.contains("canvas-fullscreen")); };
    bindFullscreenPanToggle();
    node("color-adjust").onclick = toggleAdjustments;
    node("rename-work").onclick = rename;
    node("export-image").onclick = ui.action(async function () {
      status(t("正在下载当前画布实际显示效果…", "Downloading the visible canvas exactly as shown…"));
      var response = await canvas.exportVisibleCanvas();
      if (!response || !response.cancelled) { status(t("当前画布已下载", "Visible canvas downloaded")); ui.toast(t("当前画布已下载", "Visible canvas downloaded")); }
    });
    document.addEventListener("keydown", function (event) {
      if (!node("modal-layer").hidden || !node("confirm-layer").hidden || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || document.activeElement.isContentEditable) return;
      var key = String(event.key).toLowerCase(), modifier = event.ctrlKey || event.metaKey;
      if (modifier && key === "z") { event.preventDefault(); event.shiftKey ? canvas.redo() : canvas.undo(); return; }
      if (modifier && key === "y") { event.preventDefault(); canvas.redo(); return; }
      if ((key === "delete" || key === "backspace") && app.state.tool === "select") { event.preventDefault(); canvas.removeSelected(); return; }
      if (key === "escape" && document.body.classList.contains("canvas-fullscreen")) { event.preventDefault(); setCanvasFullscreen(false); return; }
      if (modifier) return;
      var tool = { p: "pencil", b: "brush", e: "eraser", v: "select" }[key];
      if (key === "m") { requestMaskTool(); return; }
      if (tool) setTool(tool);
    });
  }
  function bindGeneration() {
    node("result-image").onload = function () {
      if (!app.state.result || node("result-image").getAttribute("src") !== app.state.result.src) return;
      node("result-image").hidden = app.state.resultVisible === false;
      status(app.state.resultVisible === false ? t("成图已生成，当前保持隐藏", "Result generated and currently hidden") : t("成图已显示，可继续在画布上操作", "Result visible · keep working on the canvas"));
    };
    node("result-image").onerror = function () {
      if (!app.state.result || node("result-image").getAttribute("src") !== app.state.result.src) return;
      node("result-image").hidden = true; node("result-glow-image").hidden = true;
      status(t("成图已返回，但图片加载失败", "The result arrived but could not be displayed"));
      app.events.emit("error", new Error(t("模型已生成图片，但设备无法读取返回的图片数据", "The model generated an image, but the device could not read the returned image data")));
    };
    app.events.on("generation:start", function (detail) {
      node("stage-busy").hidden = false;
      node("busy-label").textContent = detail.slot === "upscale" ? t("正在渲染高清大图，仍可继续画", "Rendering a high-resolution image · keep drawing") : t("生成中，仍可继续画", "Generating · keep drawing");
      node("generate-quick").disabled = true; node("generate-quality").disabled = true;
      status(t("正在处理当前画面…", "Processing your sketch…"));
    });
    app.events.on("generation:done", function (result) {
      syncCanvas();
      if (result && result.slot === "upscale") { app.state.renderResult = result; syncRenderResult(true); status(t("高清渲染完成，可在画布右下角查看", "High-resolution render complete. View it from the diamond on the canvas.")); }
      else { animateResultOpacityFloor(); status(t("成图已返回，正在显示…", "Result received · displaying…")); }
    });
    app.events.on("generation:progress", function (message) { node("busy-label").textContent = String(message || ""); status(message); });
    app.events.on("generation:error", function (error) { status(t("生成失败，可修改设置后重试", "Generation failed. Adjust settings and retry.")); app.events.emit("error", error); });
    app.events.on("render:clear", clearRenderResult);
    app.events.on("generation:idle", function () { node("stage-busy").hidden = true; node("generate-quick").disabled = false; node("generate-quality").disabled = false; });
    app.events.on("needs-config", function () { app.components.settings.open("models"); });
    app.events.on("status", status);
  }
  function openRenderPreview() { if (app.state.renderResult) app.components.renderPreview.open(app.state.renderResult); }
  function clearRenderResult() {
    var hadResult = Boolean(app.state.renderResult);
    app.components.renderPreview.close(); app.state.renderResult = null; syncRenderResult();
    if (hadResult) status(t("高清渲染已清除", "High-resolution render cleared"));
  }
  var renderResultAnimationToken = 0;
  function syncRenderResult(forceAnimate) {
    var present = Boolean(app.state.renderResult && app.state.renderResult.src), trigger = node("render-result-trigger");
    renderResultAnimationToken += 1;
    var token = renderResultAnimationToken;
    trigger.hidden = !present;
    if (present && forceAnimate && renderResultPresent) {
      trigger.hidden = true; trigger.classList.remove("is-ready");
      window.setTimeout(function () {
        if (token !== renderResultAnimationToken || !app.state.renderResult) return;
        trigger.hidden = false; trigger.offsetWidth; trigger.classList.add("is-ready");
      }, 70);
    } else if (present && !renderResultPresent) {
      trigger.classList.remove("is-ready");
      trigger.offsetWidth;
      trigger.classList.add("is-ready");
    }
    if (!present) trigger.classList.remove("is-ready");
    renderResultPresent = present;
  }
  function bindActionHelp() {
    document.addEventListener("click", function (event) {
      var button = event.target;
      while (button && button !== document.body && button.tagName !== "BUTTON") button = button.parentNode;
      if (!button || button === document.body || !button.dataset.helpZh) return;
      status(t(button.dataset.helpZh, button.dataset.helpEn));
    });
  }
  function syncSelection() {
    var ids = app.state.selectedIds && app.state.selectedIds.length ? app.state.selectedIds : app.state.selectedId ? [app.state.selectedId] : [];
    var selected = ids.length === 1 ? app.state.objects.findIndex(function (object) { return object.id === ids[0]; }) : -1;
    var selectedObjects = app.state.objects.filter(function (object) { return ids.indexOf(object.id) >= 0; });
    var groupedObjects = selectedObjects.filter(function (object) { return Boolean(object.groupId); });
    var groupIds = groupedObjects.map(function (object) { return object.groupId; }).filter(function (id, index, values) { return values.indexOf(id) === index; });
    var alreadyOneGroup = ids.length > 1 && groupedObjects.length === ids.length && groupIds.length === 1;
    var selectedStrokes = selectedObjects.filter(function (object) { return object.type === "stroke"; });
    var strokeColors = selectedStrokes.map(function (object) { return object.color || app.state.color; }).filter(function (color, index, values) { return values.indexOf(color) === index; });
    var colorButton = node("selection-color"), colorSwatch = colorButton.querySelector(".selection-color-swatch");
    node("selection-hint").hidden = ids.length > 0; node("selection-actions").hidden = ids.length === 0;
    node("selection-hint").textContent = t("轻点单选 · 空白拖框多选 · 拖动选区移动", "Tap one · drag empty space to select several");
    node("selection-color-label").textContent = t("变色", "Color"); colorButton.disabled = selectedStrokes.length === 0;
    colorSwatch.style.backgroundColor = strokeColors.length ? strokeColors[0] : "";
    colorSwatch.style.backgroundImage = strokeColors.length > 1 ? "linear-gradient(135deg,#ee4f85 0 50%,#38a9e8 50%)" : "none";
    node("group-selected").disabled = ids.length < 2 || alreadyOneGroup; node("ungroup-selected").disabled = groupedObjects.length === 0;
    node("layer-down").disabled = ids.length !== 1 || selected <= 0; node("layer-up").disabled = ids.length !== 1 || selected < 0 || selected === app.state.objects.length - 1;
    node("duplicate-selected").setAttribute("aria-label", ids.length > 1 ? t("复制所选元素", "Duplicate selection") : t("复制对象", "Duplicate"));
    node("delete-selected").setAttribute("aria-label", ids.length > 1 ? t("删除所选元素", "Delete selection") : t("删除对象", "Delete object"));
  }
  function syncCanvas() {
    var state = app.state, image = node("result-image"), glow = node("result-glow-image"), hasResult = Boolean(state.result && state.result.src);
    if (hasResult && state.result.src !== imageSource) { imageSource = state.result.src; image.src = imageSource; glow.src = imageSource; }
    if (!hasResult && imageSource) { imageSource = ""; image.removeAttribute("src"); glow.removeAttribute("src"); }
    var masking = Boolean(maskMode);
    var resultVisible = masking ? true : state.resultVisible !== false, overlay = masking ? false : Boolean(state.overlayGenerate);
    var resultOpacity = masking ? 1 : Math.max(0, Math.min(1, Number(state.resultOpacity == null ? 0.9 : state.resultOpacity)));
    var layerOpacity = Math.max(0, Math.min(1, Number(state.layerOpacity == null ? 1 : state.layerOpacity)));
    canvas.syncSharpenFilter(); image.hidden = !hasResult || !resultVisible; image.style.filter = canvas.resultFilter(); image.style.opacity = String(resultOpacity);
    glow.hidden = !hasResult || !resultVisible || state.resultAdjustmentsEnabled === false || Number(state.resultGlow) <= 0; glow.style.filter = canvas.resultGlowFilter(); glow.style.opacity = String(resultOpacity * Math.min(0.62, Number(state.resultGlow) / 150));
    image.style.zIndex = overlay ? "1" : "4"; glow.style.zIndex = overlay ? "1" : "5";
    node("draft-canvas").hidden = false; node("draft-canvas").style.opacity = String(masking ? 0 : overlay ? layerOpacity : 1);
    node("stage-empty").hidden = canvas.contentCount() > 0 || hasResult;
    node("clear-canvas").disabled = canvas.contentCount() === 0;
    node("export-image").disabled = false;
    var activeOpacity = masking ? 1 : overlay ? layerOpacity : resultOpacity;
    node("result-opacity").value = String(Math.round(activeOpacity * 100));
    node("result-opacity-value").textContent = node("result-opacity").value + "%";
    node("result-opacity").disabled = masking ? true : overlay ? canvas.contentCount() === 0 : !hasResult;
    node("opacity-target-label").textContent = masking ? t("局部模式：成图固定不透明", "Local mode: result stays opaque") : overlay ? t("元素容器透明度", "Element layer opacity") : t("成图透明度", "Result opacity");
    var visibility = node("result-visibility"); visibility.disabled = masking || !hasResult; visibility.setAttribute("aria-pressed", String(resultVisible));
    visibility.setAttribute("aria-label", resultVisible ? t("隐藏成图", "Hide result") : t("显示成图", "Show result"));
    visibility.querySelector("i").className = "fa-solid " + (resultVisible ? "fa-eye" : "fa-eye-slash");
  }
  function syncAuto() {
    var button = node("auto-toggle"); button.setAttribute("aria-pressed", String(app.state.autoGenerate));
    button.querySelector("span").textContent = app.state.autoGenerate ? t("自动", "Auto") : t("手动", "Manual");
  }
  function syncOverlayGenerate() {
    var button = node("overlay-toggle"), enabled = Boolean(app.state.overlayGenerate);
    button.setAttribute("aria-checked", String(enabled)); button.classList.toggle("is-active", enabled);
  }
  function animateActiveOpacity(target) {
    var property = app.state.overlayGenerate ? "layerOpacity" : "resultOpacity", control = node("result-opacity"), output = node("result-opacity-value");
    var from = Number(app.state[property]);
    if (!Number.isFinite(from)) from = 1;
    target = Math.max(0, Math.min(1, Number(target)));
    if (opacityAnimationFrame) (window.cancelAnimationFrame || window.clearTimeout)(opacityAnimationFrame);
    var requestFrame = window.requestAnimationFrame || function (callback) { return window.setTimeout(function () { callback(Date.now()); }, 16); };
    var start = null, duration = 180;
    function step(timestamp) {
      if (start === null) start = Number(timestamp);
      var progress = Math.max(0, Math.min(1, (Number(timestamp) - start) / duration));
      var eased = 1 - Math.pow(1 - progress, 3), value = from + (target - from) * eased;
      app.state[property] = value; control.value = String(Math.round(value * 100)); output.textContent = control.value + "%"; canvasSyncTask.request();
      if (progress < 1) opacityAnimationFrame = requestFrame(step);
      else { app.state[property] = target; control.value = String(Math.round(target * 100)); output.textContent = control.value + "%"; opacityAnimationFrame = 0; app.services.store.scheduleCanvasSave(); canvasSyncTask.request(); }
    }
    opacityAnimationFrame = requestFrame(step);
  }
  function animateResultOpacityFloor() {
    var target = 0.2, from = Number(app.state.resultOpacity);
    if (!Number.isFinite(from) || from >= target) return;
    if (resultOpacityAnimationFrame) (window.cancelAnimationFrame || window.clearTimeout)(resultOpacityAnimationFrame);
    var requestFrame = window.requestAnimationFrame || function (callback) { return window.setTimeout(function () { callback(Date.now()); }, 16); };
    var start = null, duration = 500;
    function step(timestamp) {
      if (start === null) start = Number(timestamp);
      var progress = Math.max(0, Math.min(1, (Number(timestamp) - start) / duration)), eased = 1 - Math.pow(1 - progress, 3);
      app.state.resultOpacity = from + (target - from) * eased;
      canvasSyncTask.request();
      if (progress < 1) resultOpacityAnimationFrame = requestFrame(step);
      else { app.state.resultOpacity = target; resultOpacityAnimationFrame = 0; app.services.store.scheduleCanvasSave(); canvasSyncTask.request(); }
    }
    resultOpacityAnimationFrame = requestFrame(step);
  }
  function setOverlayGenerate(enabled, animateOpacity) {
    app.state.overlayGenerate = Boolean(enabled);
    if (!Number.isFinite(Number(app.state.layerOpacity))) app.state.layerOpacity = 1;
    syncOverlayGenerate(); syncCanvas();
    if (animateOpacity) animateActiveOpacity(0.66);
  }
  function syncSeedLock() {
    if (!Number.isSafeInteger(Number(app.state.seed)) || Number(app.state.seed) < 0) app.state.seed = randomSeed();
    var button = node("seed-lock"), raw = String(app.state.seed), display = raw.length < 5 ? raw : ".." + raw.slice(-2);
    node("seed-value").textContent = display;
    button.setAttribute("aria-label", t("更换随机数并快速生成，当前 ", "Roll a new seed and generate fast. Current: ") + app.state.seed);
    button.classList.toggle("is-unlocked", !app.state.seedLocked);
  }
  function toggleAdjustments() {
    var panel = node("color-adjust-panel"), opening = panel.hidden;
    panel.hidden = !opening; node("color-adjust").classList.toggle("is-active", opening); node("color-adjust").setAttribute("aria-expanded", String(opening));
    if (opening) syncAdjustments();
  }
  function closeAdjustments() {
    node("color-adjust-panel").hidden = true; node("color-adjust").classList.remove("is-active"); node("color-adjust").setAttribute("aria-expanded", "false");
  }
  function setCanvasFullscreen(enabled) {
    var button = node("canvas-fullscreen");
    document.body.classList.remove("canvas-interacting");
    canvasPanX = 0; document.documentElement.style.setProperty("--fullscreen-pan-x", "0px");
    fullscreenPan.active = false; fullscreenPan.moved = false; fullscreenPan.suppressClick = false; clearTimeout(fullscreenPan.timer);
    node("fullscreen-tools-toggle").classList.remove("is-pan-scrollbar");
    setFullscreenToolsCollapsed(false);
    document.body.classList.toggle("canvas-fullscreen", enabled); button.classList.toggle("is-active", enabled); button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute("aria-label", enabled ? t("退出全屏画布", "Exit fullscreen canvas") : t("全屏画布", "Fullscreen canvas"));
    button.querySelector("i").className = "fa-solid " + (enabled ? "fa-compress" : "fa-expand");
    if (!enabled) document.documentElement.style.removeProperty("--fullscreen-height");
    resizeStage();
  }
  function setFullscreenToolsCollapsed(collapsed) {
    var button = node("fullscreen-tools-toggle");
    document.body.classList.toggle("fullscreen-tools-collapsed", Boolean(collapsed));
    button.setAttribute("aria-expanded", String(!collapsed));
    button.setAttribute("aria-label", collapsed ? t("展开底部工具", "Expand bottom tools") : t("收起底部工具", "Collapse bottom tools"));
    button.querySelector("i").className = "fa-solid " + (collapsed ? "fa-caret-up" : "fa-caret-down");
  }
  function canvasPanLimit() {
    var frame = node("stage-frame"), side = frame ? frame.getBoundingClientRect().width : 0;
    return Math.max(0, (side - window.innerWidth) / 2);
  }
  function updatePanThumb() {
    var button = node("fullscreen-tools-toggle"), thumb = button.querySelector(".fullscreen-pan-thumb");
    if (!fullscreenPan.active || !thumb) return;
    var limit = canvasPanLimit(), travel = Math.max(0, button.clientWidth - thumb.offsetWidth - 8), ratio = limit ? (canvasPanX + limit) / (limit * 2) : 0.5;
    thumb.style.transform = "translateX(" + Math.round(travel * ratio) + "px)";
  }
  function setCanvasPan(value) {
    var limit = canvasPanLimit(); canvasPanX = Math.max(-limit, Math.min(limit, Number(value) || 0));
    document.documentElement.style.setProperty("--fullscreen-pan-x", canvasPanX + "px"); updatePanThumb();
  }
  function enterPanScrollbar() {
    if (!document.body.classList.contains("canvas-fullscreen")) return;
    var button = node("fullscreen-tools-toggle"); fullscreenPan.active = true; button.classList.add("is-pan-scrollbar");
    button.setAttribute("aria-label", t("左右拖动画布", "Drag horizontally to move canvas")); updatePanThumb();
  }
  function bindFullscreenPanToggle() {
    var button = node("fullscreen-tools-toggle");
    button.onclick = function (event) {
      if (fullscreenPan.suppressClick) { fullscreenPan.suppressClick = false; event.preventDefault(); return; }
      setFullscreenToolsCollapsed(!document.body.classList.contains("fullscreen-tools-collapsed"));
    };
    button.addEventListener("pointerdown", function (event) {
      if (!document.body.classList.contains("canvas-fullscreen") || (event.button !== undefined && event.button !== 0)) return;
      fullscreenPan.startX = event.clientX; fullscreenPan.startPan = canvasPanX; fullscreenPan.moved = false; fullscreenPan.suppressClick = false;
      fullscreenPan.wasCollapsed = document.body.classList.contains("fullscreen-tools-collapsed");
      clearTimeout(fullscreenPan.timer); fullscreenPan.timer = window.setTimeout(enterPanScrollbar, 450);
      if (button.setPointerCapture && event.pointerId !== undefined && event.isTrusted) button.setPointerCapture(event.pointerId);
    });
    button.addEventListener("pointermove", function (event) {
      var delta = event.clientX - fullscreenPan.startX;
      if (!fullscreenPan.active && !fullscreenPan.timer) return;
      if (!fullscreenPan.active && Math.abs(delta) > 8) { clearTimeout(fullscreenPan.timer); fullscreenPan.timer = 0; fullscreenPan.moved = true; fullscreenPan.suppressClick = true; return; }
      if (!fullscreenPan.active) return;
      event.preventDefault(); fullscreenPan.moved = true;
      var thumb = button.querySelector(".fullscreen-pan-thumb"), travel = Math.max(1, button.clientWidth - (thumb ? thumb.offsetWidth : 56) - 8), limit = canvasPanLimit();
      setCanvasPan(fullscreenPan.startPan + delta * (limit * 2 / travel));
    });
    function end(event) {
      clearTimeout(fullscreenPan.timer); fullscreenPan.timer = 0;
      if (fullscreenPan.active) { fullscreenPan.active = false; button.classList.remove("is-pan-scrollbar"); fullscreenPan.suppressClick = true; setFullscreenToolsCollapsed(fullscreenPan.wasCollapsed); }
      else if (fullscreenPan.moved) fullscreenPan.suppressClick = true;
      if (event && event.pointerId !== undefined && button.releasePointerCapture && event.isTrusted) button.releasePointerCapture(event.pointerId);
    }
    button.addEventListener("pointerup", end); button.addEventListener("pointercancel", end);
  }
  function syncAdjustments() {
    adjustmentNames.forEach(function (name) {
      var field = document.querySelector('[data-adjust="' + name + '"]');
      field.value = String(app.state[name]); node("color-adjust-panel").querySelector('[data-adjust-output="' + name + '"]').textContent = field.value + field.dataset.suffix;
    });
    var enabled = app.state.resultAdjustmentsEnabled !== false, button = node("color-adjust-enabled");
    button.setAttribute("aria-pressed", String(enabled)); button.querySelector("span").textContent = enabled ? t("效果开", "Effects on") : t("效果关", "Effects off");
    button.setAttribute("aria-label", enabled ? t("关闭调色效果", "Disable color effects") : t("开启调色效果", "Enable color effects"));
    node("color-adjust-panel").classList.toggle("effects-disabled", !enabled);
  }
  function applyAdjustments(values) {
    adjustmentNames.forEach(function (name) { app.state[name] = Number(values[name]); });
    syncAdjustments(); syncCanvas(); app.services.store.scheduleCanvasSave();
  }
  function ensureWorkTitle() {
    if (!String(app.state.workTitle || "").trim()) app.state.workTitle = app.services.store.untitledTitleFor(app.state.workId) || app.services.store.nextUntitledTitle();
    return app.state.workTitle;
  }
  function syncTitle() { node("work-title").textContent = ensureWorkTitle(); }
  function syncColors() {
    node("stroke-color").style.backgroundColor = app.state.color; node("background-color").style.backgroundColor = app.state.background;
    node("stroke-opacity").value = String(Math.round(app.state.opacity * 100)); node("stroke-opacity-value").textContent = node("stroke-opacity").value + "%";
  }
  function syncPromptStrength() {
    var value = Math.max(40, Math.min(120, Math.round(Number(app.state.strength || 0.8) * 100)));
    node("prompt-strength").value = String(value); node("prompt-strength-value").textContent = value + "%";
  }
  function setPromptStrength(value) {
    value = Math.max(40, Math.min(120, Number(value) || 80));
    app.state.strength = value / 100;
    node("prompt-strength").value = String(value); node("prompt-strength-value").textContent = value + "%";
    app.services.store.scheduleCanvasSave();
  }
  function bindPromptControls() {
    var display = node("prompt-display"), strength = node("prompt-strength");
    display.addEventListener("pointerdown", function (event) {
      if (event.button !== undefined && event.button !== 0) return;
      promptDrag = { id: event.pointerId, x: event.clientX, scrollLeft: display.scrollLeft, moved: false };
      if (display.setPointerCapture && event.pointerId !== undefined && event.isTrusted) display.setPointerCapture(event.pointerId);
    });
    display.addEventListener("pointermove", function (event) {
      if (!promptDrag || promptDrag.id !== event.pointerId) return;
      var delta = event.clientX - promptDrag.x;
      if (Math.abs(delta) > 2) promptDrag.moved = true;
      if (!promptDrag.moved) return;
      event.preventDefault();
      display.scrollLeft = promptDrag.scrollLeft - delta;
    });
    display.addEventListener("pointerup", function () { promptDrag = null; });
    display.addEventListener("pointercancel", function () { promptDrag = null; });
    strength.addEventListener("input", function () { setPromptStrength(strength.value); });
    node("prompt-strength-default").onclick = function () { setPromptStrength(80); };
  }
  function syncAll() {
    app.i18n.dom(); syncTitle();
    syncColors(); node("brush-size").value = app.state.size; node("brush-size-value").textContent = app.state.size;
    var promptDisplay = node("prompt-display"), promptText = String(app.state.prompt || "").trim();
    promptDisplay.textContent = promptText || t("在作品设置中填写画面描述", "Add an image description in Artwork settings"); promptDisplay.classList.toggle("is-placeholder", !promptText); syncPromptStrength();
    node("history-count").textContent = app.services.store.list().length;
    node("save-state").textContent = app.services.store.meaningful() ? t("已保存", "Saved") : t("自动保存", "Autosave");
    syncAuto(); syncOverlayGenerate(); syncSeedLock(); syncAdjustments(); syncCanvas(); syncRenderResult(); syncMaskUi(); setTool(app.state.tool, true); setFullscreenToolsCollapsed(document.body.classList.contains("fullscreen-tools-collapsed")); resizeStage();
  }
  function resetWork() { var next = app.utils.copy(initial); next.seed = randomSeed(); next.seedLocked = true; canvas.load(next); app.state.renderResult = null; app.state.tool = "pencil"; syncAll(); }
  function nextUntitledTitle() {
    return app.services.store.nextUntitledTitle();
  }
  async function newWork() {
    app.services.imageEngine.cancel(); await app.services.store.flush(); resetWork(); app.state.workTitle = nextUntitledTitle(); await app.services.store.flush(); ui.close(); syncTitle(); status(defaultStatus());
    ui.toast(t("新画布已就绪，旧作已保存在历史中", "New canvas ready. Previous work is in Your artwork."));
  }
  function rename() {
    var root = ui.open({ mode: "center", title: t("作品名称", "Artwork title"), html: '<label class="field"><span>' + t("名称", "Title") + '</span><input id="work-name-input" maxlength="64" value="' + app.utils.escapeHtml(ensureWorkTitle()) + '" placeholder="' + t("未命名作品", "Untitled artwork") + '"></label><div class="button-row"><button class="button button-secondary" data-cancel>' + t("取消", "Cancel") + '</button><button class="button button-primary" data-save>' + t("保存", "Save") + '</button></div>' });
    root.querySelector("[data-cancel]").onclick = ui.close;
    root.querySelector("[data-save]").onclick = ui.action(async function () { app.state.workTitle = root.querySelector("input").value.trim(); await app.services.store.flush(); syncTitle(); ui.close(); });
  }
  function status(message) { node("status-line").textContent = String(message || ""); }
  function defaultStatus() { return app.services.imageEngine.configured("quick") ? t("画下轮廓，让灵感成形", "Sketch a shape. Bring your idea to life.") : t("先画也可以 · 在右上角菜单配置模型", "Start sketching · configure models in the menu"); }
  app.features.editor = { init: init, syncAll: syncAll, setTool: setTool, status: status, defaultStatus: defaultStatus, newWork: newWork, resetWork: resetWork, syncCanvas: syncCanvas, nextUntitledTitle: nextUntitledTitle };
})(window.vibedraw);
