(function (app) {
  "use strict";

  var u = app.utils;
  var network = app.platform.hermit;
  var t = app.i18n && app.i18n.text || function (zh) { return zh; };
  var PROTOCOLS = [
    { id: "a1x-image", name: "A1X 图片任务", description: "DreamShaper8 LCM 实时槽位固定 512；Flux.2 渲染槽位固定 1024，均为 1:1。" },
    { id: "openai-images", name: "OpenAI Images 兼容", description: "兼容 /v1/images/generations 与 /v1/images/edits，适合云端与兼容网关。" },
    { id: "sd-webui", name: "SD WebUI / Forge", description: "兼容 /sdapi/v1/img2img，适合局域网 Stable Diffusion WebUI 或 Forge。" },
    { id: "comfyui", name: "ComfyUI Workflow", description: "上传草图并提交 API workflow，适合自定义本地工作流。" },
    { id: "stability", name: "Stability AI", description: "兼容 Stable Image v2beta 的 Control Sketch 与 Generate 接口。" }
  ];

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
      var image = u.dataUrlParts(input.imageDataUrl);
      fields.control_strength = String(u.clamp(input.strength, 0, 1));
      files.push({ name: "image", filename: "vibedraw.png", mime: image.mime, bytes: image.bytes });
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

  function a1xRoot(endpoint) {
    var value = u.stripSlash(endpoint), marker = value.indexOf("/api/a1x-h3");
    return marker >= 0 ? value.slice(0, marker) : value;
  }
  function a1xSeed(value) {
    var seed = Number(value);
    if (Number.isInteger(seed) && seed >= 0 && seed <= 9007199254740991) return seed;
    return Math.floor(Math.random() * 9007199254740991);
  }
  function a1xStageDeadline(promise, timeoutMs, label) {
    return new Promise(function (resolve, reject) {
      var settled = false;
      var timer = setTimeout(function () {
        if (settled) return;
        settled = true; reject(new Error(label + "超时"));
      }, timeoutMs);
      promise.then(function (value) {
        if (settled) return;
        settled = true; clearTimeout(timer); resolve(value);
      }, function (error) {
        if (settled) return;
        settled = true; clearTimeout(timer); reject(error);
      });
    });
  }
  function a1xTransient(error) { return !error || !error.status && /超时|timed?\s*out|timeout/i.test(String(error.message || error)); }
  async function a1xRetry(task, label, timeoutMs, attempts) {
    var maximum = Math.max(1, Number(attempts) || 2), lastError;
    for (var attempt = 0; attempt < maximum; attempt += 1) {
      try { return await a1xStageDeadline(task(), timeoutMs, label); }
      catch (error) {
        lastError = error;
        if (!a1xTransient(error) || attempt === maximum - 1) throw error;
        app.events.emit("generation:progress", t("网络未响应，正在重试“" + label + "”…", "Network did not respond. Retrying " + label + "…"));
        await u.sleep(350);
      }
    }
    throw lastError;
  }
  function a1xPayload(config, input, assetId) {
    var dream = config.model === "dreamshaper8_lcm_blended_img2img_sd15" || config.model === "dreamshaper8_lcm_scribble_sd15" || config.slot === "quick";
    var steps = [2, 4, 8].indexOf(Number(config.steps)) >= 0 ? Number(config.steps) : (dream ? 4 : 8);
    var referenceStrength = Number(input.strength);
    if (!Number.isFinite(referenceStrength)) referenceStrength = 0.8;
    var prompt = String(input.prompt || "").trim() || "Faithfully refine the reference image while preserving its composition and content.";
    var payload = {
      mode: "image_generate",
      prompt: prompt,
      negative_prompt: input.negativePrompt || "",
      engine_profile: dream ? "dreamshaper8_lcm_blended_img2img_sd15" : (steps === 8 ? "flux2_klein_4b_base_nvfp4" : "flux2_klein_4b_distilled_nvfp4"),
      sampling_steps: steps,
      guidance_scale: dream ? u.clamp(Number(config.guidanceScale) || 2, 1, 3) : 1,
      reference_strength: u.clamp(referenceStrength, 0, 2),
      inputs: { image_references: assetId ? [assetId] : [] },
      output: { aspect_ratio: "1:1", resolution_tier: dream ? "compact512" : "standard1024" },
      seed: a1xSeed(input.seed)
    };
    if (dream) {
      // Temporary single-path diagnostic: lightly mix one blurred copy over
      // the untouched canvas, then feed only that image to LCM img2img.
      // A higher UI sketch strength means less denoising and more preservation.
      payload.reference_strength = u.clamp(1.05 - (u.clamp(referenceStrength, 0, 2) * 0.65), 0.25, 0.85);
      payload.input_blur_radius = 3;
      payload.input_blur_sigma = 1.2;
      payload.input_blur_mix = 0.25;
    }
    if (!dream) payload.reference_megapixels = 1;
    return payload;
  }
  async function a1xUpload(config, input) {
    if (config.inputMode === "text") return "";
    var dimension = config.slot === "quality" ? 1024 : 512;
    app.events.emit("generation:progress", t("正在上传 " + dimension + " × " + dimension + " 参考图…", "Uploading the " + dimension + " × " + dimension + " reference…"));
    var image = u.dataUrlParts(input.imageDataUrl), extension = image.mime === "image/jpeg" ? ".jpg" : image.mime === "image/webp" ? ".webp" : ".png";
    var requestHeaders = headers(config, image.mime);
    var url = a1xRoot(config.endpoint) + "/api/a1x-h3/v2/assets?filename=" + encodeURIComponent("vibedraw-" + Date.now() + extension) + "&kind=image";
    var response = await a1xRetry(function () { return network.request({ url: url, method: "POST", headers: requestHeaders, bodyBytes: image.bytes, contentType: image.mime, timeoutMs: config.timeoutMs }); }, t("上传画布", "canvas upload"), 8000, 2);
    ensureOk(response, requestHeaders);
    var payload = u.parseJson(response.bodyText || "", null);
    if (!payload || !payload.asset_id) throw new Error("A1X 未返回参考图素材 ID");
    return payload.asset_id;
  }
  async function a1xGenerate(config, input) {
    var root = a1xRoot(config.endpoint), assetId = await a1xUpload(config, input);
    var requestHeaders = headers(config, "application/json");
    requestHeaders["Idempotency-Key"] = u.id("vibedraw");
    var requestBody = JSON.stringify(a1xPayload(config, input, assetId));
    var renderName = config.slot === "quality" ? "Flux.2" : "DreamShaper";
    app.events.emit("generation:progress", t("正在创建 " + renderName + " 任务…", "Starting the " + renderName + " task…"));
    var created = await a1xRetry(function () { return network.requestJson({
      url: root + "/api/a1x-h3/v2/jobs", method: "POST", headers: requestHeaders,
      bodyText: requestBody, timeoutMs: config.timeoutMs
    }); }, t("创建 A1X 任务", "A1X job creation"), 8000, 2);
    var job = created.data, jobId = job && job.job_id;
    if (!jobId) throw new Error("A1X 未返回任务 ID");
    var deadline = Date.now() + (Number(config.timeoutMs) || 180000);
    while (Date.now() < deadline && ["succeeded", "failed", "cancelled"].indexOf(job.state) < 0) {
      await u.sleep(700);
      app.events.emit("generation:progress", t(renderName + " 正在生成…", renderName + " is generating…"));
      var polled = await a1xRetry(function () { return network.requestJson({ url: root + "/api/a1x-h3/v2/jobs/" + encodeURIComponent(jobId), method: "GET", headers: headers(config), timeoutMs: 15000 }); }, t("查询 A1X 任务", "A1X job status"), 6000, 2);
      job = polled.data;
    }
    if (!job || job.state !== "succeeded") {
      if (job && job.state === "failed") {
        var detail = job.error && (job.error.message || job.error.error) || "A1X 图片任务执行失败";
        throw new Error(String(detail));
      }
      if (job && job.state === "cancelled") throw new Error("A1X 图片任务已取消");
      throw new Error("A1X 生成超时，任务可能仍在设备队列中");
    }
    var output = job.outputs && job.outputs[0];
    if (!output || !output.url) throw new Error("A1X 任务完成，但没有图片输出");
    app.events.emit("generation:progress", t("正在读取生成图片…", "Loading the generated image…"));
    var downloaded = await a1xRetry(function () { return network.request({ url: root + output.url, method: "GET", headers: headers(config), timeoutMs: 60000 }); }, t("下载 A1X 成图", "A1X image download"), 10000, 2);
    var result = await responseImage(downloaded, headers(config));
    result.metadata = job;
    return result;
  }

  function replaceWorkflow(value, replacements) {
    if (Array.isArray(value)) return value.map(function (item) { return replaceWorkflow(item, replacements); });
    if (value && Object.prototype.toString.call(value) === "[object Object]") {
      var result = {};
      Object.keys(value).forEach(function (key) { result[key] = replaceWorkflow(value[key], replacements); });
      return result;
    }
    if (typeof value !== "string") return value;
    if (Object.prototype.hasOwnProperty.call(replacements, value)) return replacements[value];
    var output = value;
    Object.keys(replacements).forEach(function (token) { output = output.split(token).join(String(replacements[token])); });
    return output;
  }
  function comfyRoot(endpoint) { return u.stripSlash(endpoint).replace(/\/(?:prompt|system_stats)$/i, ""); }
  async function comfyUpload(config, input) {
    var image = u.dataUrlParts(input.imageDataUrl);
    var body = u.multipart({ type: "input", overwrite: "true" }, [{ name: "image", filename: "vibedraw-" + Date.now() + ".png", mime: image.mime, bytes: image.bytes }]);
    var requestHeaders = headers(config, body.contentType);
    var response = await network.request({ url: comfyRoot(config.endpoint) + "/upload/image", method: "POST", headers: requestHeaders, bodyBytes: body.bytes, contentType: body.contentType, timeoutMs: config.timeoutMs });
    ensureOk(response, requestHeaders);
    var payload = u.parseJson(response.bodyText || "", null);
    if (!payload || !payload.name) throw new Error("ComfyUI 未返回上传图片名称");
    return payload.subfolder ? payload.subfolder + "/" + payload.name : payload.name;
  }
  function comfyOutput(history, promptId) {
    var entry = history && (history[promptId] || history), outputs = entry && entry.outputs || {};
    var nodeIds = Object.keys(outputs);
    for (var index = 0; index < nodeIds.length; index += 1) {
      var images = outputs[nodeIds[index]] && outputs[nodeIds[index]].images;
      if (images && images[0]) return images[0];
    }
    return null;
  }
  async function comfyGenerate(config, input) {
    var template = u.parseJson(config.workflow || "", null);
    if (!template || Object.prototype.toString.call(template) !== "[object Object]") throw new Error("ComfyUI 需要粘贴有效的 API workflow JSON");
    var uploaded = config.inputMode === "text" ? "" : await comfyUpload(config, input);
    var workflow = replaceWorkflow(template, {
      "{{prompt}}": input.prompt,
      "{{negative_prompt}}": input.negativePrompt,
      "{{image}}": uploaded,
      "{{seed}}": Number(input.seed) >= 0 ? Number(input.seed) : Math.floor(Math.random() * 2147483647),
      "{{steps}}": Number(config.steps) || 20,
      "{{width}}": Number(config.width) || 768,
      "{{height}}": Number(config.height) || 768,
      "{{denoise}}": u.clamp(Number(input.strength), 0, 1)
    });
    var root = comfyRoot(config.endpoint), requestHeaders = headers(config, "application/json"), clientId = u.id("vibedraw");
    var queued = await network.requestJson({ url: root + "/prompt", method: "POST", headers: requestHeaders, bodyText: JSON.stringify({ prompt: workflow, client_id: clientId }), timeoutMs: config.timeoutMs });
    var promptId = queued.data && queued.data.prompt_id;
    if (!promptId) throw new Error("ComfyUI 未返回任务 ID，请确认粘贴的是 API workflow");
    var deadline = Date.now() + (Number(config.timeoutMs) || 180000), output = null;
    while (Date.now() < deadline) {
      await u.sleep(800);
      var history = await network.requestJson({ url: root + "/history/" + encodeURIComponent(promptId), method: "GET", headers: headers(config), timeoutMs: 15000 });
      output = comfyOutput(history.data, promptId);
      if (output) break;
    }
    if (!output) throw new Error("ComfyUI 生成超时，任务可能仍在服务端队列中");
    var url = root + "/view?filename=" + encodeURIComponent(output.filename) + "&subfolder=" + encodeURIComponent(output.subfolder || "") + "&type=" + encodeURIComponent(output.type || "output");
    return responseImage(await network.request({ url: url, method: "GET", headers: headers(config), timeoutMs: 60000 }), headers(config));
  }

  async function generate(config, input) {
    validate(config);
    if (config.protocol === "a1x-image") return a1xGenerate(config, input);
    if (config.protocol === "openai-images") return openAiGenerate(config, input);
    if (config.protocol === "sd-webui") return sdWebuiGenerate(config, input);
    if (config.protocol === "comfyui") return comfyGenerate(config, input);
    if (config.protocol === "stability") return stabilityGenerate(config, input);
    throw new Error("不支持的图像接口协议：" + config.protocol);
  }
  function validate(config) {
    if (!config) throw new Error("模型配置不存在");
    u.validateEndpoint(config.endpoint);
    if (config.protocol === "stability" && !config.apiKey && !u.isPrivateHost(new URL(config.endpoint).hostname)) throw new Error(app.i18n ? app.i18n.text("请先填写 API Key", "Enter an API key first") : "请先填写 API Key");
    var a1xSize = config && config.slot === "quality" ? 1024 : 512;
    if (config.protocol === "a1x-image" && (Number(config.width) !== a1xSize || Number(config.height) !== a1xSize || [2, 4, 8].indexOf(Number(config.steps)) < 0)) throw new Error("A1X 图片模型要求实时 512 × 512、渲染 1024 × 1024，并支持 2 / 4 / 8 步");
    if (config.protocol === "openai-images" && !config.model) throw new Error("请填写图像模型 ID");
    if (config.protocol === "comfyui" && !u.parseJson(config.workflow || "", null)) throw new Error("请先粘贴 ComfyUI API workflow JSON");
    u.parseHeaders(config.customHeaders || "");
  }
  async function test(config) {
    validate(config);
    var root, url;
    if (config.protocol === "a1x-image") {
      root = a1xRoot(config.endpoint);
      var capabilityHeaders = headers(config);
      var capability = await network.requestJson({ url: root + "/api/a1x-h3/v2/capabilities", method: "GET", headers: capabilityHeaders, timeoutMs: Math.min(Number(config.timeoutMs) || 30000, 30000) });
      var profiles = capability.data && capability.data.profiles || {};
      var dream = config.model === "dreamshaper8_lcm_blended_img2img_sd15" || config.model === "dreamshaper8_lcm_scribble_sd15" || config.slot === "quick";
      var selectedProfiles, imageModel;
      if (dream) {
        var dreamProfile = profiles.dreamshaper8_lcm_blended_img2img_sd15;
        imageModel = capability.data && capability.data.image_models && capability.data.image_models.lcm_blended_img2img_sd15;
        if (!dreamProfile || !dreamProfile.qualification || dreamProfile.qualification.image_generate !== "qualified" || !imageModel || !Array.isArray(imageModel.allowed_steps) || [2, 4, 8].some(function (step) { return imageModel.allowed_steps.indexOf(step) < 0; }) || !Array.isArray(imageModel.allowed_resolution_tiers) || imageModel.allowed_resolution_tiers.indexOf("compact512") < 0) throw new Error("A1X 当前未开放 DreamShaper8 LCM 的 2 / 4 / 8 步与 compact512 能力");
        selectedProfiles = ["dreamshaper8_lcm_blended_img2img_sd15"];
      } else {
        var distilled = profiles.flux2_klein_4b_distilled_nvfp4, base = profiles.flux2_klein_4b_base_nvfp4;
        imageModel = capability.data && capability.data.image_models && capability.data.image_models.flux2;
        if (!distilled || !base || !distilled.qualification || distilled.qualification.image_generate !== "qualified" || !base.qualification || base.qualification.image_generate !== "qualified" || !imageModel || !Array.isArray(imageModel.allowed_steps) || [2, 4, 8].some(function (step) { return imageModel.allowed_steps.indexOf(step) < 0; }) || !Array.isArray(imageModel.allowed_resolution_tiers) || imageModel.allowed_resolution_tiers.indexOf("standard1024") < 0) throw new Error("A1X 当前未开放 Flux.2 Klein 4B 的 2 / 4 / 8 步与 standard1024 能力");
        selectedProfiles = ["flux2_klein_4b_distilled_nvfp4", "flux2_klein_4b_base_nvfp4"];
      }
      var jobs = await network.request({ url: root + "/api/a1x-h3/v2/jobs?limit=1", method: "GET", headers: capabilityHeaders, timeoutMs: Math.min(Number(config.timeoutMs) || 30000, 30000) });
      ensureOk(jobs, capabilityHeaders);
      return { ok: true, status: jobs.status, profiles: selectedProfiles };
    }
    if (config.protocol === "openai-images") { root = openAiRoot(config.endpoint); url = root + "/models"; }
    else if (config.protocol === "sd-webui") url = u.stripSlash(config.endpoint) + "/sdapi/v1/sd-models";
    else if (config.protocol === "comfyui") url = comfyRoot(config.endpoint) + "/system_stats";
    else {
      var parsed = new URL(stabilityEndpoint(config));
      url = parsed.origin + "/v1/user/account";
    }
    var requestHeaders = headers(config), response = await network.request({ url: url, method: "GET", headers: requestHeaders, timeoutMs: Math.min(Number(config.timeoutMs) || 30000, 30000) });
    ensureOk(response, requestHeaders);
    return { ok: true, status: response.status };
  }
  function preset(protocol, slot) {
    var value = u.copy(app.defaults[slot]);
    value.protocol = protocol;
    value.apiKey = "";
    value.customHeaders = "";
    value.workflow = "";
    if (protocol === "a1x-image") {
      value.endpoint = "http://192.168.124.31:8188";
      value.model = slot === "quick" ? "dreamshaper8_lcm_blended_img2img_sd15" : "flux2_klein_4b_base_nvfp4";
      value.inputMode = "sketch";
      value.width = value.height = slot === "quick" ? 512 : 1024;
      value.steps = slot === "quick" ? 4 : 8;
      value.guidanceScale = slot === "quick" ? 2 : 1;
      value.timeoutMs = slot === "quick" ? 90000 : 180000;
    } else if (protocol === "openai-images") {
      value.endpoint = "https://api.openai.com/v1";
      value.model = "gpt-image-1";
      value.inputMode = "sketch";
    } else if (protocol === "sd-webui") {
      value.endpoint = "http://192.168.1.2:7860";
      value.model = "";
      value.inputMode = "sketch";
    } else if (protocol === "comfyui") {
      value.endpoint = "http://192.168.1.2:8188";
      value.model = "由 workflow 决定";
      value.inputMode = "sketch";
    } else if (protocol === "stability") {
      value.endpoint = slot === "quick" ? "https://api.stability.ai/v2beta/stable-image/control/sketch" : "https://api.stability.ai/v2beta/stable-image/generate/ultra";
      value.model = "";
      value.inputMode = slot === "quick" ? "sketch" : "text";
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
      comfyRoot: comfyRoot,
      a1xRoot: a1xRoot,
      a1xPayload: a1xPayload,
      a1xRetry: a1xRetry,
      replaceWorkflow: replaceWorkflow,
      jsonImage: jsonImage,
      aspect: aspect
    }
  };
})(window.vibedraw);
