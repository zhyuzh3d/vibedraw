(function (global) {
  "use strict";

  var app = global.vibedraw = global.vibedraw || {};
  var listeners = {};

  app.version = "0.5.0";
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
    maskVisible: true,
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
    schema: 8,
    preferences: { theme: "system", language: "zh" },
    // One ComfyUI plugin serves all three tasks, so they share one connection:
    // address, password and custom headers live here and are copied into every CVP
    // task on load and on save. Selecting CVP in another task adopts this; editing it
    // anywhere edits all three. The task-specific settings stay per task.
    connection: { endpoint: "", apiKey: "", customHeaders: "" },
    quick: {
      slot: "quick",
      task: "quick",
      name: "快速生图",
      protocol: "cvp",
      endpoint: "",
      apiKey: "",
      model: "",
      inputMode: "sketch",
      width: 512,
      height: 512,
      steps: 8,
      refStrength: 0.55,
      growMaskBy: 8,
      quality: "low",
      timeoutMs: 60000,
      customHeaders: "",
      workflow: "",
      guidanceScale: 2
    },
    inpaint: {
      slot: "inpaint",
      task: "inpaint",
      name: "局部重绘",
      protocol: "cvp",
      endpoint: "",
      apiKey: "",
      model: "",
      inputMode: "sketch",
      width: 512,
      height: 512,
      steps: 6,
      refStrength: 0.3,
      growMaskBy: 8,
      quality: "low",
      timeoutMs: 90000,
      customHeaders: "",
      workflow: "",
      guidanceScale: 2
    },
    upscale: {
      slot: "upscale",
      task: "upscale",
      name: "高清渲染",
      protocol: "cvp",
      endpoint: "",
      apiKey: "",
      model: "",
      inputMode: "sketch",
      width: 1024,
      height: 1024,
      steps: 8,
      refStrength: 0.75,
      growMaskBy: 8,
      quality: "high",
      timeoutMs: 240000,
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
