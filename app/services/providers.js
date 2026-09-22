(function (app) {
  "use strict";

  var u = app.utils;
  var network = app.platform.hermit;
  var t = app.i18n && app.i18n.text || function (zh) { return zh; };
  var PROTOCOLS = [
    { id: "cvp", name: "ComfyUI Vibedraw Plugin（推荐）", description: "连接装有 VibeDraw 插件的 ComfyUI。插件自带快速生图 / 局部重绘 / 放大绘制三套工作流，不需要导出工作流 JSON；密码在插件的配置节点里设置。" },
    { id: "openai-images", name: "OpenAI Images 兼容", description: "兼容 /v1/images/generations 与 /v1/images/edits，适合云端与兼容网关。" },
    { id: "sd-webui", name: "SD WebUI / Forge", description: "兼容 /sdapi/v1/img2img，适合局域网 Stable Diffusion WebUI 或 Forge。" },
    { id: "stability", name: "Stability AI", description: "兼容 Stable Image v2beta 的 Control Sketch 与 Generate 接口。" }
  ];

  //: Slot -> CVP task. The plugin owns the three built-in graphs, so the client
  //: only has to name the task and hand over the canvas.
  var CVP_TASKS = { quick: "quick", inpaint: "inpaint", upscale: "upscale" };

  function headers(config, contentType) {
    var output = u.parseHeaders(config.customHeaders || "");
    if (contentType) output["Content-Type"] = contentType;
    if (config.apiKey && !output.Authorization && !output.authorization) output.Authorization = "Bearer " + config.apiKey;
    return output;
  }
  function ensureOk(response, requestHeaders) {
    if (response.status >= 200 && response.status < 300) return response;
    var payload = u.parseJson(response.bodyText || "", null);
    throw network.httpError(response, payload, requestHeaders || {});
  }
  function dataUrl(mime, base64) { return "data:" + (mime || "image/png") + ";base64," + String(base64 || "").replace(/\s/g, ""); }
  function jsonImage(payload) {
    if (!payload) return null;
    var item = payload.data && payload.data[0] || null;
    if (item && item.b64_json) return { src: dataUrl(payload.output_format === "jpeg" ? "image/jpeg" : payload.output_format === "webp" ? "image/webp" : "image/png", item.b64_json), metadata: payload };
    if (item && item.url) return { remoteUrl: item.url, metadata: payload };
    if (payload.images && payload.images[0]) return { src: dataUrl("image/png", String(payload.images[0]).replace(/^data:image\/[^;]+;base64,/, "")), metadata: payload };
    if (payload.image && payload.image.base64) return { src: dataUrl(payload.image.mime || "image/png", payload.image.base64), metadata: payload };
    if (payload.artifacts && payload.artifacts[0] && payload.artifacts[0].base64) return { src: dataUrl("image/png", payload.artifacts[0].base64), metadata: payload };
    return null;
  }
  async function responseImage(response, requestHeaders) {
    ensureOk(response, requestHeaders);
    if (response.file && response.file.url) return { src: response.file.url, logicalFileId: response.file.logicalFileId || "", metadata: {} };
    if (response.bodyBase64) return { src: dataUrl(u.imageMimeFromHeaders(response.headers), response.bodyBase64), metadata: {} };
    var payload = u.parseJson(response.bodyText || "", null);
    var found = jsonImage(payload);
    if (!found) throw new Error("模型已响应，但未找到可显示的图片");
    if (!found.remoteUrl) return found;
    var downloaded = await network.request({ url: found.remoteUrl, method: "GET", timeoutMs: 120000 });
    var converted = await responseImage(downloaded, {});
    converted.metadata = found.metadata;
    return converted;
  }
  function openAiRoot(endpoint) {
    var value = u.stripSlash(endpoint);
    return value.replace(/\/images\/(?:generations|edits)$/i, "");
  }
  function size(config) { return String(config.width || 1024) + "x" + String(config.height || 1024); }

  async function openAiGenerate(config, input) {
    var root = openAiRoot(config.endpoint), useSketch = config.inputMode !== "text";
    var url = root + "/images/" + (useSketch ? "edits" : "generations");
    var requestHeaders, response;
    if (useSketch) {
      var image = u.dataUrlParts(input.imageDataUrl);
      var fields = {
        model: config.model,
        prompt: input.prompt,
        n: 1,
        size: size(config),
        quality: config.quality || (config.slot === "quick" ? "low" : "high"),
        output_format: "png"
      };
      var files = [{ name: "image", filename: "vibedraw.png", mime: image.mime, bytes: image.bytes }];
      if (input.openAiMaskDataUrl) {
        var mask = u.dataUrlParts(input.openAiMaskDataUrl);
        files.push({ name: "mask", filename: "vibedraw-mask.png", mime: mask.mime, bytes: mask.bytes });
      }
      var body = u.multipart(fields, files);
      requestHeaders = headers(config, body.contentType);
      response = await network.request({ url: url, method: "POST", headers: requestHeaders, bodyBytes: body.bytes, contentType: body.contentType, timeoutMs: config.timeoutMs });
    } else {
      requestHeaders = headers(config, "application/json");
      response = await network.request({
        url: url, method: "POST", headers: requestHeaders, timeoutMs: config.timeoutMs,
        bodyText: JSON.stringify({ model: config.model, prompt: input.prompt, n: 1, size: size(config), quality: config.quality || "auto", response_format: "b64_json" })
      });
    }
    return responseImage(response, requestHeaders);
  }

  async function sdWebuiGenerate(config, input) {
    var url = u.stripSlash(config.endpoint) + "/sdapi/v1/" + (config.inputMode === "text" ? "txt2img" : "img2img");
    var requestHeaders = headers(config, "application/json");
    var body = {
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      width: Number(config.width) || 512,
      height: Number(config.height) || 512,
      steps: Number(config.steps) || (config.slot === "quick" ? 6 : 28),
      seed: Number(input.seed),
      cfg_scale: config.slot === "quick" ? 2 : 6,
      batch_size: 1,
      n_iter: 1,
      send_images: true,
      save_images: false
    };
    if (config.inputMode !== "text") {
      body.init_images = [u.dataUrlParts(input.imageDataUrl).base64];
      body.denoising_strength = u.clamp(Number(input.strength), 0, 1);
      body.resize_mode = 0;
      if (input.maskDataUrl) {
        body.mask = u.dataUrlParts(input.maskDataUrl).base64;
        body.inpainting_fill = 1;
        body.inpaint_full_res = true;
        body.mask_blur = 4;
      }
    }
    if (config.model) body.override_settings = { sd_model_checkpoint: config.model };
    var response = await network.request({ url: url, method: "POST", headers: requestHeaders, bodyText: JSON.stringify(body), timeoutMs: config.timeoutMs });
    return responseImage(response, requestHeaders);
  }

  function stabilityEndpoint(config) {
    var endpoint = u.stripSlash(config.endpoint);
    if (/\/v2beta\//.test(endpoint)) return endpoint;
    return endpoint + (config.inputMode === "text" ? "/v2beta/stable-image/generate/core" : "/v2beta/stable-image/control/sketch");
  }
  async function stabilityGenerate(config, input) {
    var requestHeaders = headers(config, ""), fields = { prompt: input.prompt, output_format: "png" }, files = [];
    requestHeaders.Accept = "image/*";
    if (config.inputMode !== "text") {
      var image = u.dataUrlParts(input.imageDataUrl), extension = image.mime === "image/jpeg" ? "jpg" : image.mime === "image/webp" ? "webp" : "png";
      fields.control_strength = String(u.clamp(input.strength, 0, 1));
      files.push({ name: "image", filename: "vibedraw." + extension, mime: image.mime, bytes: image.bytes });
    } else {
      fields.aspect_ratio = aspect(config.width, config.height);
    }
    if (/\/sd3(?:$|\?)/.test(stabilityEndpoint(config)) && config.model) fields.model = config.model;
    if (input.negativePrompt) fields.negative_prompt = input.negativePrompt;
    if (Number(input.seed) >= 0) fields.seed = String(input.seed);
    var body = u.multipart(fields, files);
    requestHeaders["Content-Type"] = body.contentType;
    var response = await network.request({ url: stabilityEndpoint(config), method: "POST", headers: requestHeaders, bodyBytes: body.bytes, contentType: body.contentType, timeoutMs: config.timeoutMs });
    return responseImage(response, requestHeaders);
  }
  function aspect(width, height) {
    var ratio = (Number(width) || 1) / (Number(height) || 1);
    if (ratio > 1.35) return "16:9";
    if (ratio < 0.74) return "9:16";
    return "1:1";
  }

  // --------------------------------------------------------------------- //
  // CVP — the ComfyUI VibeDraw plugin (schema vibedraw-comfy/v2)
  //
  // One endpoint, three tasks. The plugin ships its own graphs, so the client
  // sends a task name plus the canvas and never an API workflow. The plugin
  // also serves the finished image itself, which keeps a single password for
  // both submitting and downloading.
  // --------------------------------------------------------------------- //

  function cvpBase(endpoint) {
    var value = u.stripSlash(endpoint), marker = value.indexOf("/vibedraw/");
    return marker >= 0 ? value.slice(0, marker) : value;
  }
  function cvpTask(config) { return CVP_TASKS[config && (config.task || config.slot)] || "quick"; }
  function cvpError(error) {
    var text = String(error && error.message || error || "");
    if (/unauthorized|401/.test(text)) return new Error(t("访问密码不正确，请在 ComfyUI 的 VibeDraw 配置节点里核对密码", "Wrong access password. Check the password set in the ComfyUI VibeDraw config node."));
    if (/no_model|模型/.test(text)) return new Error(t("插件没有可用模型，请先在 ComfyUI 的 VibeDraw 配置节点里选择 checkpoint", "The plugin has no model. Pick a checkpoint in the ComfyUI VibeDraw config node first."));
    if (/busy|429/.test(text)) return new Error(t("插件队列已满，请稍后再试", "The plugin queue is full. Try again shortly."));
    return error;
  }
  function cvpStrength(config, strength) {
    // The artwork slider runs 0–100% with 80% as the neutral point, so the
    // per-slot reference weight stays the default while the slider still lets
    // the user trade fidelity for freedom.
    var value = Number(strength), base = Number(config && config.refStrength);
    if (!Number.isFinite(value) || value <= 0) value = 0.8;
    if (!Number.isFinite(base) || base <= 0) base = 0.55;
    return u.clamp(base * (value / 0.8), 0.05, 0.95);
  }
  async function cvpGenerate(config, input) {
    var base = cvpBase(config.endpoint), api = base + "/vibedraw/v1", task = cvpTask(config);
    var requestHeaders = headers(config, "application/json");
    var body = {
      task: task,
      prompt: input.prompt,
      negative_prompt: input.negativePrompt,
      seed: Number(input.seed) >= 0 ? Number(input.seed) : Math.floor(Math.random() * 9007199254740991),
      size: [Number(config.width) || 512, Number(config.height) || 512],
      steps: Number(config.steps) || 8,
      ref_strength: cvpStrength(config, input.strength)
    };
    if (input.imageDataUrl) body.image_base64 = input.imageDataUrl;
    if (task === "inpaint") {
      if (!input.maskDataUrl) throw new Error(t("局部重绘缺少蒙版，请先用局部工具标记要改的区域", "Local redraw needs a mask. Mark the area with the mask tool first."));
      body.mask_base64 = input.maskDataUrl;
      body.grow_mask_by = u.clamp(Number(config.growMaskBy) || 8, 0, 64);
    }
    var label = task === "inpaint" ? t("局部重绘", "Local redraw") : task === "upscale" ? t("放大绘制", "Upscale") : t("快速生图", "Quick draw");
    app.events.emit("generation:progress", t("正在提交" + label + "任务…", "Submitting the " + label + " job…"));
    var submitted;
    try {
      submitted = await network.request({ url: api + "/jobs", method: "POST", headers: requestHeaders, bodyText: JSON.stringify(body), timeoutMs: config.timeoutMs });
      ensureOk(submitted, requestHeaders);
    } catch (error) { throw cvpError(error); }
    var accepted = u.parseJson(submitted.bodyText || "", null), jobId = accepted && accepted.job && accepted.job.id;
    if (!jobId) throw new Error(t("CVP 插件未返回任务 ID，请确认插件版本与地址", "The CVP plugin did not return a job id. Check the plugin version and address."));
    var deadline = Date.now() + (Number(config.timeoutMs) || 120000), detail = null;
    while (Date.now() < deadline) {
      await u.sleep(700);
      var polled;
      try {
        polled = await network.request({ url: api + "/jobs/" + encodeURIComponent(jobId), method: "GET", headers: headers(config), timeoutMs: 15000 });
        ensureOk(polled, headers(config));
      } catch (error) { throw cvpError(error); }
      var payload = u.parseJson(polled.bodyText || "", null);
      detail = payload && payload.job;
      if (!detail) continue;
      if (detail.state === "failed") throw new Error(t("CVP 工作流执行失败：", "CVP workflow failed: ") + String(detail.error || "unknown"));
      if (detail.state === "cancelled") throw new Error(t("CVP 任务已取消", "The CVP job was cancelled"));
      if (detail.state === "completed") break;
      if (detail.progress) app.events.emit("generation:progress", t(label + "进行中…", label + " in progress…"));
    }
    if (!detail || detail.state !== "completed") throw new Error(t("CVP 生成超时，任务可能仍在服务端队列中", "CVP timed out; the job may still be queued on the server"));
    var output = detail.outputs && detail.outputs[0];
    if (!output || !output.url) throw new Error(t("CVP 任务完成，但没有图片输出", "The CVP job finished without an image"));
    var imageUrl = /^https?:/i.test(output.url) ? output.url : base + output.url;
    app.events.emit("generation:progress", t("正在读取生成图片…", "Loading the generated image…"));
    var downloaded;
    try {
      downloaded = await network.request({ url: imageUrl, method: "GET", headers: headers(config), timeoutMs: 60000 });
      ensureOk(downloaded, headers(config));
    } catch (error) { throw cvpError(error); }
    var result = await responseImage(downloaded, headers(config));
    result.metadata = detail;
    return result;
  }

  async function generate(config, input) {
    validate(config);
    if (config.protocol === "cvp") return cvpGenerate(config, input);
    if (config.protocol === "openai-images") return openAiGenerate(config, input);
    if (config.protocol === "sd-webui") return sdWebuiGenerate(config, input);
    if (config.protocol === "stability") return stabilityGenerate(config, input);
    throw new Error("不支持的图像接口协议：" + config.protocol);
  }
  function validate(config) {
    if (!config) throw new Error("模型配置不存在");
    u.validateEndpoint(config.endpoint);
    if (config.protocol === "stability" && !config.apiKey && !u.isPrivateHost(new URL(config.endpoint).hostname)) throw new Error(app.i18n ? app.i18n.text("请先填写 API Key", "Enter an API key first") : "请先填写 API Key");
    if (config.protocol === "openai-images" && !config.model) throw new Error("请填写图像模型 ID");
    if (config.protocol === "cvp" && !(Number(config.width) >= 256 && Number(config.width) <= 2048 && Number(config.height) >= 256 && Number(config.height) <= 2048)) throw new Error(app.i18n ? app.i18n.text("画幅需为 256–2048", "Use a canvas size between 256 and 2048") : "画幅需为 256–2048");
    u.parseHeaders(config.customHeaders || "");
  }
  async function test(config) {
    validate(config);
    var root, url;
    if (config.protocol === "openai-images") { root = openAiRoot(config.endpoint); url = root + "/models"; }
    else if (config.protocol === "sd-webui") url = u.stripSlash(config.endpoint) + "/sdapi/v1/sd-models";
    else if (config.protocol === "cvp") url = cvpBase(config.endpoint) + "/vibedraw/v1/capabilities";
    else {
      var parsed = new URL(stabilityEndpoint(config));
      url = parsed.origin + "/v1/user/account";
    }
    var requestHeaders = headers(config), response = await network.request({ url: url, method: "GET", headers: requestHeaders, timeoutMs: Math.min(Number(config.timeoutMs) || 30000, 30000) });
    ensureOk(response, requestHeaders);
    if (config.protocol === "cvp") {
      var capabilities = u.parseJson(response.bodyText || "", null), tasks = capabilities && capabilities.tasks || [], wanted = cvpTask(config);
      var found = tasks.filter(function (item) { return item && item.id === wanted; })[0];
      if (!found) throw new Error(t("CVP 插件不支持“" + wanted + "”任务，请升级插件", "The CVP plugin does not offer the " + wanted + " task. Please update it."));
      if (!found.model) throw new Error(t("插件的" + wanted + "任务还没有选择模型，请在 ComfyUI 的 VibeDraw 配置节点里设置", "The plugin has no model for " + wanted + ". Set it in the ComfyUI VibeDraw config node."));
      return { ok: true, status: response.status, task: wanted, model: found.model, sizes: found.sizes || [], steps: found.steps || {}, authRequired: Boolean(capabilities.auth && capabilities.auth.required) };
    }
    return { ok: true, status: response.status };
  }
  function preset(protocol, slot) {
    var name = slot === "quality" ? "upscale" : (app.defaults[slot] ? slot : "quick");
    var value = u.copy(app.defaults[name]), rendered = name === "upscale";
    value.slot = name;
    value.task = name;
    value.protocol = protocol;
    value.apiKey = "";
    value.customHeaders = "";
    value.workflow = "";
    if (protocol === "cvp") {
      value.endpoint = "http://192.168.1.2:8188";
      value.model = "";
      value.inputMode = "sketch";
      value.width = value.height = rendered ? 1024 : 512;
      value.steps = name === "inpaint" ? 6 : 8;
      value.refStrength = name === "inpaint" ? 0.3 : rendered ? 0.75 : 0.55;
      value.growMaskBy = 8;
      value.timeoutMs = rendered ? 240000 : 60000;
    } else if (protocol === "openai-images") {
      value.endpoint = "https://api.openai.com/v1";
      value.model = "gpt-image-1";
      value.inputMode = "sketch";
      value.width = value.height = rendered ? 1024 : 512;
      value.quality = rendered ? "high" : "low";
      value.timeoutMs = rendered ? 180000 : 60000;
    } else if (protocol === "sd-webui") {
      value.endpoint = "http://192.168.1.2:7860";
      value.model = "";
      value.inputMode = "sketch";
      value.width = value.height = rendered ? 1024 : 512;
      value.steps = rendered ? 28 : 6;
      value.timeoutMs = rendered ? 180000 : 60000;
    } else if (protocol === "stability") {
      value.endpoint = rendered ? "https://api.stability.ai/v2beta/stable-image/generate/ultra" : "https://api.stability.ai/v2beta/stable-image/control/sketch";
      value.model = "";
      value.inputMode = rendered ? "text" : "sketch";
      value.width = value.height = rendered ? 1024 : 1024;
    }
    return value;
  }

  app.services.providers = {
    protocols: PROTOCOLS,
    generate: generate,
    test: test,
    validate: validate,
    preset: preset,
    internals: {
      openAiRoot: openAiRoot,
      cvpBase: cvpBase,
      cvpTask: cvpTask,
      cvpStrength: cvpStrength,
      jsonImage: jsonImage,
      aspect: aspect
    }
  };
})(window.vibedraw);
