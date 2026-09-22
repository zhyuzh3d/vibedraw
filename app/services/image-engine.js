(function (app) {
  "use strict";
  var timer = 0, running = false, queuedSlot = "", generation = 0, dismissed = false;
  var canvasInput = null;
  var t = app.i18n.text;
  function configured(slot) {
    var config = app.config && app.config[slot];
    return Boolean(config && config.endpoint);
  }
  function schedule() {
    clearTimeout(timer);
    if (app.state.maskMode || !app.state.autoGenerate || !configured("quick")) return;
    timer = setTimeout(function () { run("quick", true); }, Number(app.state.autoDelayMs) || 850);
  }
  function stopAuto() { clearTimeout(timer); queuedSlot = ""; }
  function cancel() {
    clearTimeout(timer); generation += 1; queuedSlot = ""; dismissed = true; running = false; app.state.busy = false;
    app.events.emit("generation:idle");
  }
  function withDeadline(promise, timeoutMs) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timerId = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error(t("生成等待超时，已结束本次等待；A1X 任务可能仍在设备端运行，请稍后重试", "Generation timed out and this wait was closed. The A1X job may still be running; try again shortly.")));
      }, timeoutMs);
      promise.then(function (value) {
        if (settled) return;
        settled = true; clearTimeout(timerId); resolve(value);
      }, function (error) {
        if (settled) return;
        settled = true; clearTimeout(timerId); reject(error);
      });
    });
  }
  function overallTimeout(config) {
    var configured = Number(config && config.timeoutMs) || 90000;
    return Math.max(15000, Math.min(330000, configured + 15000));
  }
  async function run(requested, automatic) {
    clearTimeout(timer);
    var masking = Boolean(app.state.maskMode) && canvasInput.hasMask();
    // A masked canvas always means "local redraw"; the quick button becomes the
    // local-redraw button while the mask tool is open.
    var slot = masking && (requested === "quick" || !requested) ? "inpaint" : requested === "quality" ? "upscale" : requested;
    if (["quick", "inpaint", "upscale"].indexOf(slot) < 0) slot = "quick";
    if (running) {
      queuedSlot = slot;
      app.events.emit("status", t("最新画面已排队，当前请求完成后继续", "Latest sketch queued until the current request finishes"));
      return;
    }
    if (!configured(slot)) {
      if (!automatic) app.events.emit("needs-config", slot);
      return;
    }
    var prompt = app.utils.composePrompt(app.state.prompt, masking ? app.state.localPrompt : "");
    var config = app.utils.copy(app.config[slot]);
    config.slot = slot; config.task = slot;
    if (slot === "upscale") config.inputMode = "sketch";
    if (masking && !String(app.state.localPrompt || "").trim()) {
      if (!automatic) app.events.emit("error", new Error(t("先点「描述」写清这一块要改成什么，再生成", "Describe what this area should become first")));
      return;
    }
    if (!prompt && config.protocol !== "a1x-image") {
      if (!automatic) app.events.emit("error", new Error(t("先在画布上方描述你想画什么", "Describe your idea above the canvas first")));
      return;
    }
    if (masking && (requested === "upscale" || requested === "quality")) {
      if (!automatic) app.events.emit("error", new Error(t("局部模式下请点生成按钮重绘蒙版区域；要渲染大图请先关闭局部工具", "In mask mode use Generate to repaint the masked area. Close the mask tool first to render a large image.")));
      return;
    }
    if (masking && config.inputMode === "text") {
      if (!automatic) app.events.emit("error", new Error(t("当前模型是纯文字模式，不支持局部蒙版", "This model is prompt-only and cannot use a mask")));
      return;
    }
    if (masking && ["openai-images", "sd-webui", "cvp"].indexOf(config.protocol) < 0) {
      if (!automatic) app.events.emit("error", new Error(t("当前模型不支持局部蒙版，请使用 CVP 插件、OpenAI Images 或 SD WebUI", "Masks need the CVP plugin, OpenAI Images, or SD WebUI")));
      return;
    }
    running = true; queuedSlot = ""; dismissed = false;
    var token = ++generation;
    var succeeded = false;
    app.state.busy = true; app.events.emit("generation:start", { slot: slot });
    try {
      var a1xReference = config.protocol === "a1x-image" ? { size: slot === "upscale" ? 1024 : 512, mime: "image/jpeg", quality: 0.82, maxBytes: 500 * 1024 } : null;
      var referenceOptions = a1xReference || (slot === "upscale" ? { size: Number(config.width) || 1024, mime: "image/png" } : null);
      var maskDataUrl = null, openAiMaskDataUrl = null;
      if (masking) {
        if (config.protocol === "openai-images") openAiMaskDataUrl = canvasInput.composeMask(true);
        else if (config.protocol === "sd-webui" || config.protocol === "cvp") maskDataUrl = canvasInput.composeMask(false);
      }
      var input = { prompt: prompt, negativePrompt: app.state.negativePrompt, seed: app.state.seedLocked ? app.state.seed : -1, strength: app.state.strength, colorStrength: app.state.colorStrength,
        imageDataUrl: slot === "upscale" ? await canvasInput.composeVisibleInput(referenceOptions) : await canvasInput.composeInput(referenceOptions),
        maskDataUrl: maskDataUrl, openAiMaskDataUrl: openAiMaskDataUrl };
      var result = await withDeadline(app.services.providers.generate(config, input), overallTimeout(config));
      if (token !== generation) return;
      if (slot === "upscale") {
        var dimensions = await canvasInput.imageDimensions(result.src);
        var wantWidth = Number(config.width) || 1024, wantHeight = Number(config.height) || 1024;
        if (dimensions.width !== wantWidth || dimensions.height !== wantHeight) throw new Error(t("渲染接口返回了 " + dimensions.width + " × " + dimensions.height + "，需要 " + wantWidth + " × " + wantHeight, "The render API returned " + dimensions.width + " × " + dimensions.height + "; " + wantWidth + " × " + wantHeight + " is required"));
      }
      var generated = { src: result.src, logicalFileId: result.logicalFileId || "", slot: slot, prompt: prompt, createdAt: Date.now() };
      if (slot === "upscale") app.state.renderResult = generated; else app.state.result = generated;
      succeeded = true;
      app.events.emit("generation:done", generated);
      if (slot !== "upscale") app.services.store.scheduleCanvasSave();
    } catch (error) {
      if (token === generation) app.events.emit("generation:error", error);
    } finally {
      if (token !== generation) return;
      running = false; app.state.busy = false;
      if (!dismissed) app.events.emit("generation:idle");
      var next = succeeded ? queuedSlot : ""; queuedSlot = "";
      if (next) setTimeout(function () { run(next, true); }, 60);
    }
  }
  app.services.imageEngine = { init: function (input) { canvasInput = input; }, schedule: schedule, run: run, configured: configured, cancel: cancel, stopAuto: stopAuto,
    internals: { withDeadline: withDeadline, overallTimeout: overallTimeout } };
})(window.vibedraw);
