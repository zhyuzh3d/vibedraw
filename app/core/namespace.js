(function (global) {
  "use strict";

  var app = global.vibedraw = global.vibedraw || {};
  var listeners = {};

  app.version = "0.4.25";
  app.events = {
    on: function (name, listener) {
      listeners[name] = listeners[name] || [];
      listeners[name].push(listener);
      return function () {
        listeners[name] = (listeners[name] || []).filter(function (item) { return item !== listener; });
      };
    },
    emit: function (name, detail) {
      (listeners[name] || []).slice().forEach(function (listener) {
        try { listener(detail); } catch (error) { setTimeout(function () { throw error; }, 0); }
      });
    }
  };

  app.state = {
    tool: "pencil",
    color: "#38a9e8",
    background: "#ffffff",
    size: 18,
    opacity: 0.72,
    resultOpacity: 0.9,
    layerOpacity: 1,
    resultVisible: true,
    resultBrightness: 100,
    resultContrast: 100,
    resultSaturation: 100,
    resultHue: 0,
    resultGlow: 0,
    resultClarity: 0,
    resultAdjustmentsEnabled: true,
    workId: "",
    workTitle: "",
    prompt: "",
    negativePrompt: "",
    seed: Math.floor(Math.random() * 2147483647),
    seedLocked: true,
    strength: 0.8,
    colorStrength: 0.3,
    autoDelayMs: 850,
    autoGenerate: true,
    overlayGenerate: false,
    selectedId: "",
    selectedIds: [],
    objects: [],
    result: null,
    renderResult: null,
    busy: false,
    history: [],
    future: []
  };

  app.defaults = {
    schema: 6,
    preferences: { theme: "system", language: "zh" },
    quick: {
      slot: "quick",
      name: "实时快速模型",
      protocol: "sd-webui",
      endpoint: "",
      apiKey: "",
      model: "",
      inputMode: "sketch",
      width: 512,
      height: 512,
      steps: 6,
      quality: "low",
      timeoutMs: 45000,
      customHeaders: "",
      workflow: "",
      guidanceScale: 2
    },
    quality: {
      slot: "quality",
      name: "高质量模型",
      protocol: "openai-images",
      endpoint: "",
      apiKey: "",
      model: "gpt-image-1",
      inputMode: "sketch",
      width: 1024,
      height: 1024,
      steps: 28,
      quality: "high",
      timeoutMs: 180000,
      customHeaders: "",
      workflow: "",
      guidanceScale: 1
    },
    canvas: {
      negativePrompt: "low quality, distorted, unfinished, artifacts",
      autoDelayMs: 850,
      resultBrightness: 100,
      resultContrast: 100,
      resultSaturation: 100,
      resultHue: 0,
      resultGlow: 0,
      resultClarity: 0,
      resultAdjustmentsEnabled: true
    }
  };

  app.config = null;
  app.platform = {};
  app.services = {};
  app.components = {};
  app.features = {};
})(window);
