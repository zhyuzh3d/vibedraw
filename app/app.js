(function (app) {
  "use strict";

  async function start() {
    app.components.ui.init();
    app.events.on("error", function (error) { app.components.ui.toast(app.utils.cleanError(error), "error"); });
    app.components.settings.init();
    await app.services.store.loadConfig();
    // Translations are stored separately from the config, and a prompt keeps its
    // Chinese, so they have to come back before anything can render the English
    // that the last save produced.
    await app.services.translate.load();
    app.i18n.theme();
    app.state.negativePrompt = app.config.canvas.negativePrompt || "";
    ["resultBrightness", "resultContrast", "resultSaturation", "resultHue", "resultGlow", "resultClarity"].forEach(function (name) {
      if (Number.isFinite(Number(app.config.canvas[name]))) app.state[name] = Number(app.config.canvas[name]);
    });
    app.state.resultAdjustmentsEnabled = app.config.canvas.resultAdjustmentsEnabled !== false;
    app.state.overlayGenerate = false;
    app.state.autoDelayMs = Number(app.config.canvas.autoDelayMs) || 850;
    app.components.canvas.init();
    app.components.renderPreview.init();
    app.services.imageEngine.init(app.components.canvas);
    var saved = await app.services.store.loadCanvas();
    if (saved) app.components.canvas.load(saved);
    app.features.editor.init();
    app.platform.hermit.appReady();
    app.features.editor.status(app.features.editor.defaultStatus());
    var media = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
    if (media && media.addListener) media.addListener(app.i18n.theme);
    await app.features.selfTest.run();
  }

  window.addEventListener("error", function (event) {
    if (event.error) app.events.emit("error", event.error);
  });
  window.addEventListener("unhandledrejection", function (event) {
    app.events.emit("error", event.reason || new Error("异步操作失败"));
  });

  window.hermitDevState = {
    capture: function () {
      var resultImage = document.getElementById("result-image"), draftCanvas = document.getElementById("draft-canvas"), selectionCanvas = document.getElementById("selection-canvas");
      return {
        tool: app.state.tool,
        prompt: app.state.prompt,
        selectedId: app.state.selectedId,
        scrollY: window.scrollY,
        version: app.version,
        workId: app.state.workId,
        workCount: app.services.store.list().length,
        busy: app.state.busy,
        status: document.getElementById("status-line").textContent,
        theme: document.documentElement.dataset.theme,
        language: app.i18n.language(),
        resultDisplay: {
          present: Boolean(app.state.result && app.state.result.src),
          hidden: resultImage.hidden,
          complete: resultImage.complete,
          naturalWidth: resultImage.naturalWidth,
          opacity: resultImage.style.opacity,
          resultZ: getComputedStyle(resultImage).zIndex,
          draftZ: getComputedStyle(draftCanvas).zIndex,
          selectionZ: getComputedStyle(selectionCanvas).zIndex,
          pointerEvents: getComputedStyle(resultImage).pointerEvents
        },
        deviceGenerationTest: window.__deviceGenerationTest || null,
        selfTest: window.__vibedrawSelfTest || null,
        selfTestProgress: window.__vibedrawSelfTestProgress || "idle"
      };
    },
    restore: function (snapshot) {
      if (!snapshot || typeof snapshot !== "object") return;
      if (snapshot.tool) app.features.editor.setTool(snapshot.tool);
      if (typeof snapshot.prompt === "string") {
        app.state.prompt = snapshot.prompt;
        document.getElementById("prompt-display").textContent = snapshot.prompt;
      }
      app.state.selectedId = snapshot.selectedId || "";
      app.state.selectedIds = app.state.selectedId ? [app.state.selectedId] : [];
      app.components.canvas.render();
      requestAnimationFrame(function () { window.scrollTo(0, Number(snapshot.scrollY) || 0); });
    }
  };

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})(window.vibedraw);
