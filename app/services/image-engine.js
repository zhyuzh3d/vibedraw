(function (app) {
  "use strict";
  var timer = 0, running = false, queuedSlot = "", generation = 0, dismissed = false;
  var canvasInput = null;
  var t = app.i18n.text;
  function configured(slot) {
    var config = app.config && app.config[slot];
    if (!config || !config.endpoint) return false;
    if (config.protocol === "comfyui" && !config.workflow) return false;
    return true;
  }
  function schedule() {
    clearTimeout(timer);
    if (!app.state.autoGenerate || !configured("quick")) return;
    timer = setTimeout(function () { run("quick", true); }, Number(app.state.autoDelayMs) || 850);
  }
  function stopAuto() { clearTimeout(timer); if (queuedSlot === "quick") queuedSlot = ""; }
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
  async function run(slot, automatic) {
    clearTimeout(timer);
    if (running) {
      queuedSlot = slot === "quality" ? "quality" : queuedSlot || "quick";
      app.events.emit("status", t("最新画面已排队，当前请求完成后继续", "Latest sketch queued until the current request finishes"));
      return;
    }
    if (!configured(slot)) {
      if (!automatic) app.events.emit("needs-config", slot);
      return;
    }
    var prompt = String(app.state.prompt || "").trim();
    var config = app.utils.copy(app.config[slot]);
    if (slot === "quality") { config.width = 1024; config.height = 1024; config.inputMode = "sketch"; }
    if (!prompt && config.protocol !== "a1x-image") {
      if (!automatic) app.events.emit("error", new Error(t("先在画布上方描述你想画什么", "Describe your idea above the canvas first")));
      return;
    }
    if (slot !== "quality" && canvasInput.hasMask() && config.protocol !== "a1x-image" && (config.inputMode === "text" || ["openai-images", "sd-webui"].indexOf(config.protocol) < 0)) {
      if (!automatic) app.events.emit("error", new Error(t("当前模型不支持局部蒙版，请使用 OpenAI Images 或 SD WebUI 的草图模式", "Masks require an OpenAI Images or SD WebUI model in sketch mode")));
      return;
    }
    running = true; queuedSlot = ""; dismissed = false;
    var token = ++generation;
    var succeeded = false;
    app.state.busy = true; app.events.emit("generation:start", { slot: slot });
    try {
      var a1xReference = config.protocol === "a1x-image" ? { size: slot === "quality" ? 1024 : 512, mime: "image/jpeg", quality: 0.82, maxBytes: 500 * 1024 } : null;
      var referenceOptions = a1xReference || (slot === "quality" ? { size: 1024, mime: "image/png" } : null);
      var input = { prompt: prompt, negativePrompt: app.state.negativePrompt, seed: app.state.seedLocked ? app.state.seed : -1, strength: app.state.strength, colorStrength: app.state.colorStrength,
        imageDataUrl: slot === "quality" ? await canvasInput.composeVisibleInput(referenceOptions) : await canvasInput.composeInput(referenceOptions),
        maskDataUrl: slot === "quality" ? null : canvasInput.composeMask(false), openAiMaskDataUrl: slot === "quality" ? null : canvasInput.composeMask(true) };
      var result = await withDeadline(app.services.providers.generate(config, input), overallTimeout(config));
      if (token !== generation) return;
      if (slot === "quality") {
        var dimensions = await canvasInput.imageDimensions(result.src);
        if (dimensions.width !== 1024 || dimensions.height !== 1024) throw new Error(t("高质量模型返回了 " + dimensions.width + " × " + dimensions.height + "，渲染接口必须输出 1024 × 1024", "The high-quality model returned " + dimensions.width + " × " + dimensions.height + "; Render requires 1024 × 1024 output"));
      }
      app.state.result = { src: result.src, logicalFileId: result.logicalFileId || "", slot: slot, prompt: prompt, createdAt: Date.now() };
      succeeded = true;
      app.events.emit("generation:done", app.state.result);
      app.services.store.scheduleCanvasSave();
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
