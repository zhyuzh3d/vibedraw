(function (app) {
  "use strict";
  var timer = 0, running = false, queuedSlot = "", generation = 0, dismissed = false;
  var canvasInput = null;
  var t = app.i18n.text;
  // Rendering is not a fresh painting. It enlarges the picture already on the
  // canvas and repairs its detail, so the reference image is what carries the
  // content and the prompt only says how to treat it. The artwork description
  // follows as a hint at what the model is looking at, never as an instruction to
  // paint that description again; the render negatives push the same way.
  var RENDER_PROMPT = "high resolution upscale of this exact image, keep composition, colors and every element identical, repair detail only, no repaint";
  var RENDER_NEGATIVE = "repaint, redrawn, changed composition, different framing, extra elements, missing elements, restyled, altered colors";
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
        reject(new Error(t("生成等待超时，已结束本次等待；服务端任务可能仍在运行，请稍后重试", "Generation timed out and this wait was closed. The server job may still be running; try again shortly.")));
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
    // A local redraw states what the marked area should become. Submitting the
    // artwork-wide prompt as well would drag the whole composition into the
    // patched region, so only the local description travels with the mask.
    // A render leads with the fidelity instruction, so the artwork description can
    // never read as "paint this picture again", and it no longer needs one at all.
    // What leaves is the English of a saved prompt, because every text encoder here
    // reads Chinese as noise. Nothing is translated in this path — the cache is a
    // lookup, and saving the prompt is what fills it.
    var english = app.services.translate.english;
    var prompt = masking ? app.utils.composePrompt("", english(app.state.localPrompt))
      : slot === "upscale" ? app.utils.composePrompt(RENDER_PROMPT, english(app.state.prompt))
      : app.utils.composePrompt(english(app.state.prompt), "");
    var negativePrompt = slot === "upscale" ? app.utils.composePrompt(RENDER_NEGATIVE, english(app.state.negativePrompt)) : english(app.state.negativePrompt);
    // Whatever the reason, a prompt that is still Chinese will be read as noise by
    // every text encoder here, so each drawing says so instead of quietly producing
    // something unrelated. The toast repeats with the drawing, because the mistake
    // repeats with it; the wording points at the settings that can fix it.
    var untranslated = (masking ? [app.state.localPrompt] : [app.state.prompt, app.state.negativePrompt]).filter(function (value) { return app.services.translate.hasCjk(english(value)); });
    if (untranslated.length) app.components.ui.toast(t("提示词只能使用英文,请检查翻译大模型设置", "Prompts can only be in English. Check your translation model settings."), "error");
    var config = app.utils.copy(app.config[slot]);
    config.slot = slot; config.task = slot;
    if (slot === "upscale") config.inputMode = "sketch";
    if (masking && !String(app.state.localPrompt || "").trim()) {
      if (!automatic) app.events.emit("error", new Error(t("先点「描述」写清这一块要改成什么，再生成", "Describe what this area should become first")));
      return;
    }
    if (!prompt) {
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
      var maskDataUrl = null, openAiMaskDataUrl = null;
      if (masking) {
        if (config.protocol === "openai-images") openAiMaskDataUrl = canvasInput.composeMask(true);
        else if (config.protocol === "sd-webui" || config.protocol === "cvp") maskDataUrl = canvasInput.composeMask(false);
      }
      // The reference image still travels inline in the request body, so it is
      // encoded as a JPEG that fits what the mask left of the transport budget; a
      // full-size PNG would not fit. A local redraw has to reference the decorated
      // result instead of the sketch, and says so explicitly rather than relying
      // on the mask mode flag alone.
      var reserved = String(maskDataUrl || openAiMaskDataUrl || "").length + 8000;
      var referenceOptions = {
        mime: "image/jpeg",
        quality: 0.92,
        maxBytes: Math.max(40000, (app.platform.hermit.messageChars || 200000) - reserved)
      };
      if (masking) referenceOptions.withResult = true;
      if (slot === "upscale") referenceOptions.size = Number(config.width) || 1024;
      var input = { prompt: prompt, negativePrompt: negativePrompt, seed: app.state.seedLocked ? app.state.seed : -1, strength: app.state.strength, colorStrength: app.state.colorStrength,
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
