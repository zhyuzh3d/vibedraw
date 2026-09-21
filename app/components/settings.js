(function (app) {
  "use strict";
  var t = app.i18n.text, u = app.utils, ui, draft, original, slot = "quick";
  function init() { ui = app.components.ui; }
  function input(name, label, value, type, placeholder) {
    return '<label class="field"><span>' + label + '</span><input name="' + name + '" type="' + (type || "text") + '" value="' + u.escapeHtml(value == null ? "" : value) + '" placeholder="' + u.escapeHtml(placeholder || "") + '"></label>';
  }
  function textarea(name, label, value, placeholder, rows) {
    return '<label class="field"><span>' + label + '</span><textarea name="' + name + '"' + (rows ? ' rows="' + rows + '"' : '') + ' placeholder="' + u.escapeHtml(placeholder || "") + '">' + u.escapeHtml(value || "") + '</textarea></label>';
  }
  function select(name, label, value, choices) {
    var current = choices.filter(function (item) { return String(item[0]) === String(value); })[0] || choices[0];
    return '<div class="field choice-field"><span>' + label + '</span><input type="hidden" name="' + name + '" value="' + u.escapeHtml(value) + '"><button type="button" class="sheet-choice" data-choice="' + name + '" data-choice-label="' + u.escapeHtml(label) + '" data-choice-options="' + u.escapeHtml(JSON.stringify(choices)) + '"><span>' + u.escapeHtml(current[1]) + '</span><i class="fa-solid fa-chevron-down" aria-hidden="true"></i></button></div>';
  }
  function syncChoice(field) {
    var button = field.parentNode.querySelector("[data-choice]"), choices = u.parseJson(button && button.dataset.choiceOptions, []);
    if (!button) return;
    var current = choices.filter(function (item) { return String(item[0]) === String(field.value); })[0] || choices[0];
    if (current) button.querySelector("span").textContent = current[1];
  }
  function bindChoices(root) {
    root.querySelectorAll("[data-choice]").forEach(function (button) {
      button.onclick = function () {
        var field = root.querySelector('[name="' + button.dataset.choice + '"]'), choices = u.parseJson(button.dataset.choiceOptions, []);
        if (!field || !choices.length) return;
        ui.openChoice({ title: button.dataset.choiceLabel, choices: choices, value: field.value, onSelect: function (value) {
          field.value = value; syncChoice(field); field.dispatchEvent(new Event("change", { bubbles: true }));
        } });
      };
    });
  }
  function range(name, label, value, min, max, suffix, className) {
    return '<label class="field' + (className ? " " + className : "") + '"><span>' + label + ' <strong data-range-label="' + name + '">' + value + (suffix || "") + '</strong></span><input name="' + name + '" type="range" min="' + min + '" max="' + max + '" value="' + value + '" data-suffix="' + (suffix || "") + '"></label>';
  }
  function ranges(root) {
    root.querySelectorAll('input[type="range"]').forEach(function (field) {
      field.addEventListener("input", function () { root.querySelector('[data-range-label="' + field.name + '"]').textContent = field.value + field.dataset.suffix; });
    });
  }
  function footer(label) { return '<div class="button-row modal-footer"><button class="button button-secondary" data-cancel>' + t("取消", "Cancel") + '</button><button class="button button-primary" data-save>' + (label || t("保存设置", "Save settings")) + '</button></div>'; }
  async function discard() {
    if (JSON.stringify(draft) === original) return true;
    return ui.confirm({ title: t("放弃未保存的修改？", "Discard changes?"), message: t("模型设置尚未保存。", "Your model settings have not been saved."), ok: t("放弃修改", "Discard") });
  }
  function open(kind) {
    ui = app.components.ui;
    if (kind === "models") { draft = u.copy(app.config); original = JSON.stringify(draft); slot = "quick"; renderModels(); }
    else if (kind === "work" || kind === "canvas") workSettings();
    else if (kind === "preferences") preferences();
    else if (kind === "help") help();
    else about();
  }
  function renderModels() {
    var model = draft[slot], comfy = model.protocol === "comfyui", a1x = model.protocol === "a1x-image";
    var choices = app.services.providers.protocols.map(function (p) { return [p.id, p.name]; });
    var root = ui.open({ title: t("模型配置", "Models"), beforeClose: discard, html:
      '<button class="button button-secondary a1x-quick-setup" data-a1x-setup><i class="fa-solid fa-microchip"></i><span><strong>' + t("配置 A1X DreamShaper 实时模型", "Set up A1X DreamShaper preview") + '</strong><small>' + t("只设置实时槽位 · 512 × 512 · 默认 4 步", "Preview slot only · 512 × 512 · 4 steps by default") + '</small></span></button>' +
      '<div class="segmented model-tabs"><button data-slot-tab="quick" class="' + (slot === "quick" ? "is-active" : "") + '">' + t("实时快速", "Fast preview") + '</button><button data-slot-tab="quality" class="' + (slot === "quality" ? "is-active" : "") + '">' + t("高质量渲染", "Render") + '</button></div>' +
      '<div data-model-card="' + slot + '"><p class="model-intro">' + (slot === "quick" ? t("落笔后生成预览。选择快速、低步数模型。", "For previews after drawing. Choose a fast, low-step model.") : t("以画布当前实际显示效果为参考，生成并预览真实的 1024 × 1024 大图。", "Render a true 1024 × 1024 image from the canvas exactly as currently displayed.")) + '</p>' +
      '<div class="field-row">' + select("protocol", t("接口模式", "API format"), model.protocol, choices) + (slot === "quality" ? '<div class="field locked-field"><span>' + t("输入与画幅", "Input & aspect") + '</span><strong>' + t("当前画布 · 提示词可选 · 1:1", "Visible canvas · optional prompt · 1:1") + '</strong></div>' : (a1x ? '<div class="field locked-field"><span>' + t("输入与画幅", "Input & aspect") + '</span><strong>' + t("草图 · 提示词可选 · 1:1", "Sketch · optional prompt · 1:1") + '</strong></div>' : select("inputMode", t("输入方式", "Input"), model.inputMode, [["sketch", t("草图 + 描述", "Sketch + prompt")], ["text", t("仅描述", "Prompt only")]]))) + '</div>' +
      input("endpoint", t("服务地址", "Base URL"), model.endpoint, "url", "https://… / http://192.168.…") +
      '<label class="field"><span>' + (a1x ? t("A1X 访问密码", "A1X access password") : "API Key") + '</span><div class="secret-input"><input name="apiKey" type="password" autocomplete="off" value="' + u.escapeHtml(model.apiKey) + '" placeholder="' + t("免鉴权的本地服务可留空", "Optional for local services") + '"><button data-toggle-secret aria-label="' + t("显示密钥", "Show key") + '"><i class="fa-regular fa-eye"></i></button><button data-paste-secret aria-label="' + t("粘贴密钥", "Paste key") + '"><i class="fa-regular fa-paste"></i></button></div></label>' +
      (comfy || a1x ? '' : input("model", t("模型 ID", "Model ID"), model.model, "text", t("填写服务提供的模型名称", "Model name from your provider"))) +
      (comfy ? textarea("workflow", t("ComfyUI VibeDraw 工作流", "ComfyUI VibeDraw workflow"), model.workflow, "导出包含 VibeDraw Input / Output 节点的 API workflow JSON") : '') +
      (a1x ? '<div class="a1x-profile"><div><i class="fa-solid fa-microchip"></i><span><strong>' + (slot === "quick" ? "DreamShaper8 LCM " + t("单路混合重绘", "single-path redraw") : "Flux.2 Klein 4B") + '</strong><small>' + (slot === "quick" ? t("原稿叠加轻微模糊后直接进行 img2img；不使用轮廓或颜色双通道", "Direct img2img from the canvas mixed with a mild blur; no separate structure or color channels") : t("固定 1024 × 1024、1:1 与 1.0 MP 参考图编码；2 / 4 步使用 Distilled，8 步使用 Base", "Fixed at 1024 × 1024, 1:1 and 1.0 MP reference encoding; 2 / 4 steps use Distilled and 8 steps use Base")) + '</small></span></div><div class="field-row"><div class="field locked-field"><span>' + t("生成尺寸", "Output size") + '</span><strong>' + (slot === "quick" ? "512 × 512" : "1024 × 1024") + '</strong></div>' + select("steps", t("采样步数", "Sampling steps"), Number(model.steps), [[2, "2"], [4, "4"], [8, "8"]]) + '</div></div>' : '') +
      '<details class="advanced"><summary>' + t("高级参数", "Advanced options") + '</summary><div class="field-row">' + (a1x ? '' : (slot === "quality" ? '<div class="field locked-field"><span>' + t("渲染尺寸", "Render size") + '</span><strong>1024 × 1024</strong></div>' : input("width", t("宽度", "Width"), model.width, "number") + input("height", t("高度", "Height"), model.height, "number")) + input("steps", t("步数", "Steps"), model.steps, "number")) + input("timeoutMs", t("超时（毫秒）", "Timeout (ms)"), model.timeoutMs, "number") + '</div>' +
      (model.protocol === "openai-images" ? select("quality", t("生成质量", "Quality"), model.quality, [["low", t("快速", "Low")], ["medium", t("均衡", "Medium")], ["high", t("精细", "High")], ["auto", t("自动", "Auto")]]) : '') +
      textarea("customHeaders", t("自定义请求头 JSON", "Custom headers JSON"), model.customHeaders, '{"X-API-Key":"…"}') + '</details>' +
      '<p class="field-help">' + t("只向你配置的服务发送画面。局域网支持 HTTP；API Key 仅在保存后保存在当前应用。", "Images go only to your configured service. LAN HTTP is supported. Keys are stored locally when you save.") + '</p>' +
      '<button class="button button-secondary" data-test><i class="fa-solid fa-plug"></i>' + t("测试连接", "Test connection") + '</button><p class="connection-status" data-test-status></p></div>' + footer() });
    bindChoices(root);
    root.querySelector("[data-a1x-setup]").onclick = async function () {
      var hasExisting = Boolean(draft.quick.endpoint || draft.quick.apiKey || draft.quick.workflow);
      if (hasExisting) {
        var confirmed = await ui.confirm({ title: t("配置 DreamShaper 实时模型？", "Set up DreamShaper preview?"), message: t("只替换实时快速槽位，不会修改高质量模型，也不会立即保存。", "Only the preview slot is replaced. The quality model is unchanged, and nothing is saved yet."), ok: t("应用配置", "Apply preset") });
        if (!confirmed) return;
      }
      draft.quick = app.services.providers.preset("a1x-image", "quick");
      slot = "quick"; renderModels();
    };
    root.querySelectorAll("[data-slot-tab]").forEach(function (button) { button.onclick = function () { slot = button.dataset.slotTab; renderModels(); }; });
    root.querySelectorAll("[name]").forEach(function (field) {
      function update() {
        draft[slot][field.name] = ["width", "height", "steps", "timeoutMs"].indexOf(field.name) >= 0 ? Number(field.value) : field.value;
        if (a1x && field.name === "width") draft[slot].height = Number(field.value);
        if (a1x && field.name === "steps") draft[slot].model = slot === "quick" ? "dreamshaper8_lcm_blended_img2img_sd15" : (Number(field.value) === 8 ? "flux2_klein_4b_base_nvfp4" : "flux2_klein_4b_distilled_nvfp4");
      }
      if (field.name === "protocol") field.onchange = async function () {
        var previous = model.protocol, protocol = field.value;
        if (model.endpoint || model.apiKey || model.workflow) {
          var confirmed = await ui.confirm({ title: t("切换接口模式？", "Change API format?"), message: t("当前槽位的地址、密钥和接口参数会重置；另一个模型不受影响。", "This slot's URL, key and API options will reset. The other model stays unchanged."), ok: t("切换", "Change") });
          if (!confirmed) { field.value = previous; syncChoice(field); return; }
        }
        draft[slot] = app.services.providers.preset(protocol, slot); renderModels();
      };
      else { field.oninput = update; field.onchange = update; }
    });
    root.querySelector("[data-toggle-secret]").onclick = function (event) {
      var key = root.querySelector('[name="apiKey"]'), reveal = key.type === "password"; key.type = reveal ? "text" : "password";
      event.currentTarget.setAttribute("aria-label", reveal ? t("隐藏密钥", "Hide key") : t("显示密钥", "Show key"));
      event.currentTarget.innerHTML = '<i class="fa-regular fa-' + (reveal ? "eye-slash" : "eye") + '"></i>';
    };
    root.querySelector("[data-paste-secret]").onclick = ui.action(async function () {
      var key = root.querySelector('[name="apiKey"]'); key.value = String(await app.platform.hermit.clipboardRead()).trim();
      key.dispatchEvent(new Event("input", { bubbles: true }));
    });
    root.querySelector("[data-test]").onclick = ui.action(async function () {
      var status = root.querySelector("[data-test-status]"); status.textContent = t("连接中，不生成图片…", "Connecting without generating an image…");
      try { await app.services.providers.test(draft[slot]); status.textContent = a1x ? (slot === "quick" ? t("连接成功；DreamShaper8 LCM 的 2 / 4 / 8 步能力可用。", "Connected. DreamShaper8 LCM is available at 2 / 4 / 8 steps.") : t("连接成功；Flux.2 Klein 4B 的 2 / 4 / 8 步能力可用。", "Connected. Flux.2 Klein 4B is available at 2 / 4 / 8 steps.")) : t("连接成功；出图能力取决于所选模型。", "Connected. Image support depends on the selected model."); }
      catch (error) { status.textContent = t("连接失败，请检查地址与密钥。", "Connection failed. Check your URL and key."); throw error; }
    });
    root.querySelector("[data-cancel]").onclick = ui.requestClose;
    root.querySelector("[data-save]").onclick = ui.action(async function () {
      ["quick", "quality"].forEach(function (name) {
        var config = draft[name];
        if (!config.endpoint.trim()) return;
        u.validateEndpoint(config.endpoint); u.parseHeaders(config.customHeaders);
        if (name === "quality") { config.width = config.height = 1024; config.inputMode = "sketch"; }
        if (config.protocol === "a1x-image" && (Number(config.width) !== (name === "quick" ? 512 : 1024) || Number(config.height) !== (name === "quick" ? 512 : 1024) || [2, 4, 8].indexOf(Number(config.steps)) < 0)) throw new Error(t("A1X 图片模型要求实时 512 × 512、渲染 1024 × 1024，并支持 2 / 4 / 8 步", "A1X image models require 512 × 512 previews, 1024 × 1024 renders, and 2 / 4 / 8 steps"));
        if (config.protocol === "a1x-image") { config.width = config.height = name === "quick" ? 512 : 1024; config.guidanceScale = name === "quick" ? 2 : 1; config.model = name === "quick" ? "dreamshaper8_lcm_blended_img2img_sd15" : (Number(config.steps) === 8 ? "flux2_klein_4b_base_nvfp4" : "flux2_klein_4b_distilled_nvfp4"); }
        if (!(config.width >= 256 && config.width <= 2048 && config.height >= 256 && config.height <= 2048 && config.steps >= 1 && config.steps <= 150 && config.timeoutMs >= 5000 && config.timeoutMs <= 300000)) throw new Error(t("尺寸需为 256–2048，步数为 1–150，超时为 5–300 秒", "Use dimensions 256–2048, steps 1–150, and timeout 5–300 seconds"));
      });
      await app.services.store.saveConfig(draft); ui.close(); app.events.emit("config:changed"); ui.toast(t("模型设置已保存", "Model settings saved"));
    });
  }
  function workSettings() {
    var state = app.state;
    var quickA1x = app.config.quick.protocol === "a1x-image", a1x = quickA1x || app.config.quality.protocol === "a1x-image";
    var root = ui.open({ sheetClass: "work-settings-sheet", contentClass: "work-settings-content", title: t("作品设置", "Artwork settings"), footerHtml: footer(t("应用", "Apply")), html:
      textarea("prompt", t("简述你期望的画面内容（英文）", "Describe the image you expect (English)"), state.prompt, "For example: a blue crystal bird flying over snowy mountains", 3) +
      textarea("negativePrompt", t("不希望出现内容（英文）", "What to avoid (English)"), state.negativePrompt, "For example: blurry, distorted, text, watermark", 2) +
      range("strength", t("绘制稿保留强度", "Sketch preservation"), Math.round(state.strength * 100), 0, a1x ? 200 : 100, "%", "strength-field") +
      '<p class="field-help compact-help">' + t("设置100或更高可以让AI画图和手绘稿更一致；设置80或更低会让AI更有创造力；请随时根据需要来这里调整。", "Set 100 or higher to keep the AI image closer to your sketch; set 80 or lower to give the AI more creative freedom. Return here and adjust it whenever needed.") + '</p>' +
      '<div class="field-row">' + input("seed", t("随机种子", "Seed"), state.seed, "number", t("关闭锁定时由模型自动随机", "The model randomizes while unlocked")) + input("autoDelayMs", t("笔刷等待（毫秒）", "Brush wait (ms)"), state.autoDelayMs, "number") + '</div>' +
      '<label class="switch-row"><span><strong>' + t("锁定随机种子", "Lock random seed") + '</strong><small>' + t("开启后重复使用当前种子，便于稳定画风与构图", "Reuse the current seed for more consistent style and composition") + '</small></span><input class="toggle-switch" name="seedLocked" type="checkbox" role="switch"' + (state.seedLocked ? " checked" : "") + '></label>' +
      '<label class="switch-row"><span><strong>' + t("叠加生成", "Overlay generation") + '</strong><small>' + t("开启：提交画布当前真实显示的背景、成图和透明元素层；关闭：忽略成图，提交背景与完全不透明的元素层", "On: submit exactly what the canvas shows: background, result, and the translucent element layer. Off: omit the result and submit the background with a fully opaque element layer") + '</small></span><input class="toggle-switch" name="overlayGenerate" type="checkbox" role="switch"' + (state.overlayGenerate ? " checked" : "") + '></label>' });
    ranges(root);
    var seedField = root.querySelector('[name="seed"]'), seedLock = root.querySelector('[name="seedLocked"]');
    function syncSeedLock() {
      seedField.disabled = !seedLock.checked;
      if (!Number.isSafeInteger(Number(seedField.value)) || Number(seedField.value) < 0) seedField.value = String(Math.floor(Math.random() * 2147483647));
    }
    seedLock.onchange = syncSeedLock; syncSeedLock();
    var sheet = root.parentNode;
    sheet.querySelector("[data-cancel]").onclick = ui.close;
    sheet.querySelector("[data-save]").onclick = ui.action(async function () {
      var locked = seedLock.checked, seed = Number(seedField.value), delay = Number(root.querySelector('[name="autoDelayMs"]').value);
      if ((!Number.isSafeInteger(seed) || seed < 0 || seed > 9007199254740991) || delay < 400 || delay > 5000) throw new Error(t("随机种子需为 0 至 9007199254740991 的安全整数；笔刷等待为 400–5000 毫秒", "The seed must be a safe integer from 0 to 9007199254740991; brush wait must be 400–5000 ms"));
      state.prompt = root.querySelector('[name="prompt"]').value.trim(); state.negativePrompt = root.querySelector('[name="negativePrompt"]').value.trim();
      state.seed = seed; state.seedLocked = locked; state.strength = Number(root.querySelector('[name="strength"]').value) / 100; state.autoDelayMs = delay;
      var nextOverlayGenerate = root.querySelector('[name="overlayGenerate"]').checked;
      if (state.overlayGenerate !== nextOverlayGenerate) { state.resultOpacity = 0.66; state.layerOpacity = 0.66; }
      state.overlayGenerate = nextOverlayGenerate;
      app.services.store.scheduleCanvasSave(); app.services.imageEngine.schedule(); app.events.emit("result:filter"); app.events.emit("work:settings"); ui.close(); ui.toast(t("作品设置已应用", "Artwork settings applied"));
    });
  }
  function parseColor(value) {
    var match = /^#?([0-9a-f]{6})$/i.exec(String(value || "").trim());
    if (!match) return null;
    var number = parseInt(match[1], 16);
    return { r: number >> 16, g: number >> 8 & 255, b: number & 255 };
  }
  function hexColor(rgb) { return "#" + [rgb.r, rgb.g, rgb.b].map(function (value) { return ("0" + Math.max(0, Math.min(255, Number(value))).toString(16)).slice(-2); }).join(""); }
  function rgbToHsl(rgb) {
    var red = rgb.r / 255, green = rgb.g / 255, blue = rgb.b / 255;
    var maximum = Math.max(red, green, blue), minimum = Math.min(red, green, blue), delta = maximum - minimum;
    var hue = 0, lightness = (maximum + minimum) / 2;
    var saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));
    if (delta) {
      if (maximum === red) hue = 60 * (((green - blue) / delta) % 6);
      else if (maximum === green) hue = 60 * ((blue - red) / delta + 2);
      else hue = 60 * ((red - green) / delta + 4);
    }
    if (hue < 0) hue += 360;
    return { h: Math.round(hue), s: Math.round(saturation * 100), l: Math.round(lightness * 100) };
  }
  function hslToRgb(hsl) {
    var hue = ((hsl.h % 360) + 360) % 360, saturation = hsl.s / 100, lightness = hsl.l / 100;
    var chroma = (1 - Math.abs(2 * lightness - 1)) * saturation, section = hue / 60;
    var secondary = chroma * (1 - Math.abs(section % 2 - 1)), red = 0, green = 0, blue = 0;
    if (section < 1) { red = chroma; green = secondary; }
    else if (section < 2) { red = secondary; green = chroma; }
    else if (section < 3) { green = chroma; blue = secondary; }
    else if (section < 4) { green = secondary; blue = chroma; }
    else if (section < 5) { red = secondary; blue = chroma; }
    else { red = chroma; blue = secondary; }
    var match = lightness - chroma / 2;
    return { r: Math.round((red + match) * 255), g: Math.round((green + match) * 255), b: Math.round((blue + match) * 255) };
  }
  function openColor(target) {
    var isBackground = target === "background", isSelection = target === "selection";
    var selectedIds = (app.state.selectedIds && app.state.selectedIds.length ? app.state.selectedIds : app.state.selectedId ? [app.state.selectedId] : []).slice();
    var selectedStrokes = isSelection ? app.state.objects.filter(function (object) { return selectedIds.indexOf(object.id) >= 0 && object.type === "stroke"; }) : [];
    if (isSelection && !selectedStrokes.length) return;
    var current = isBackground ? app.state.background : isSelection ? selectedStrokes[0].color || app.state.color : app.state.color;
    var currentOpacity = isSelection ? Number(selectedStrokes[0].opacity) : Number(app.state.opacity);
    if (!isFinite(currentOpacity)) currentOpacity = 1;
    var rgb = parseColor(current) || { r: 56, g: 169, b: 232 }, hsl = rgbToHsl(rgb);
    var palette = ["#1f2937", "#ffffff", "#ef476f", "#ff9f1c", "#ffd166", "#2ec4b6", "#38a9e8", "#705ed7"];
    var root = ui.open({ mode: "center", title: isBackground ? t("画布底色", "Canvas background") : isSelection ? t("所选笔画颜色", "Selected stroke color") : t("画笔颜色", "Stroke color"), html:
      '<div class="color-picker-head"><span class="color-preview" data-color-preview></span><label class="field color-hex"><span>' + t("颜色值", "Color") + '</span><input name="colorHex" value="' + current + '" maxlength="7" autocapitalize="off" spellcheck="false"></label></div>' +
      '<div class="color-palette">' + palette.map(function (color, index) { return '<button type="button" class="palette-color palette-color-' + index + '" data-palette="' + color + '" aria-label="' + color + '"></button>'; }).join("") + '</div>' +
      '<div class="color-slider-stack">' + range("hue", t("色调", "Hue"), hsl.h, 0, 360, "°") + range("saturation", t("饱和度", "Saturation"), hsl.s, 0, 100, "%") + range("lightness", t("亮度", "Lightness"), hsl.l, 0, 100, "%") + (isBackground ? "" : range("colorOpacity", t("透明度", "Opacity"), Math.round(currentOpacity * 100), 5, 100, "%")) + '</div>' + footer(t("应用", "Apply")) });
    ranges(root);
    function syncPreviewOpacity() {
      root.querySelector("[data-color-preview]").style.opacity = isBackground ? "1" : String(Number(root.querySelector('[name="colorOpacity"]').value) / 100);
    }
    function syncPalette(value) {
      root.querySelectorAll("[data-palette]").forEach(function (button) { button.classList.toggle("is-selected", button.dataset.palette.toLowerCase() === String(value).toLowerCase()); });
    }
    function update(next) {
      if (!next) return;
      rgb = next; hsl = rgbToHsl(rgb); var hex = hexColor(rgb); root.querySelector('[name="colorHex"]').value = hex; root.querySelector("[data-color-preview]").style.backgroundColor = hex;
      [["hue", "h", "°"], ["saturation", "s", "%"], ["lightness", "l", "%"]].forEach(function (item) {
        root.querySelector('[name="' + item[0] + '"]').value = hsl[item[1]];
        root.querySelector('[data-range-label="' + item[0] + '"]').textContent = hsl[item[1]] + item[2];
      });
      syncPalette(hex);
    }
    root.querySelector("[data-color-preview]").style.backgroundColor = current;
    syncPreviewOpacity();
    syncPalette(current);
    root.querySelectorAll('[name="hue"],[name="saturation"],[name="lightness"]').forEach(function (field) { field.oninput = function () {
      hsl = { h: Number(root.querySelector('[name="hue"]').value), s: Number(root.querySelector('[name="saturation"]').value), l: Number(root.querySelector('[name="lightness"]').value) };
      rgb = hslToRgb(hsl); var hex = hexColor(rgb); root.querySelector('[name="colorHex"]').value = hex; root.querySelector("[data-color-preview]").style.backgroundColor = hex; syncPalette(hex);
    }; });
    root.querySelector('[name="colorHex"]').onchange = function (event) { var value = parseColor(event.target.value); if (value) update(value); else event.target.value = hexColor(rgb); };
    if (!isBackground) root.querySelector('[name="colorOpacity"]').addEventListener("input", syncPreviewOpacity);
    root.querySelector(".color-palette").onclick = function (event) {
      var button = event.target;
      if (!button || !button.hasAttribute("data-palette")) return;
      event.preventDefault(); update(parseColor(button.dataset.palette));
    };
    root.querySelector("[data-cancel]").onclick = ui.close;
    root.querySelector("[data-save]").onclick = function () {
      var value = parseColor(root.querySelector('[name="colorHex"]').value); if (!value) { ui.toast(t("请输入 6 位十六进制颜色", "Enter a 6-digit hex color"), "error"); return; }
      var opacity = isBackground ? 1 : Number(root.querySelector('[name="colorOpacity"]').value) / 100;
      if (isBackground) { app.state.background = hexColor(value); app.components.canvas.render(); app.components.canvas.commit(); }
      else if (isSelection) {
        selectedStrokes.forEach(function (object) { object.color = hexColor(value); object.opacity = opacity; });
        app.components.canvas.render(); app.components.canvas.commit();
      } else { app.state.color = hexColor(value); app.state.opacity = opacity; app.services.store.scheduleCanvasSave(); }
      app.events.emit("color:changed"); ui.close();
    };
  }
  function preferences() {
    var prefs = app.config.preferences;
    var root = ui.open({ title: t("软件设置", "Preferences"), html:
      '<div class="section-label">' + t("外观", "Appearance") + '</div>' + select("theme", t("主题", "Theme"), prefs.theme, [["system", t("跟随系统", "System")], ["light", t("浅色", "Light")], ["dark", t("深色", "Dark")]]) +
      '<div class="section-label">' + t("语言", "Language") + '</div>' + select("language", t("界面语言", "Interface language"), prefs.language, [["zh", "简体中文"], ["en", "English"]]) +
      '<p class="field-help">' + t("设置会保存在此设备，不影响作品的提示词与模型配置。", "Saved on this device. Artwork prompts and model settings stay the same.") + '</p>' + footer() });
    bindChoices(root);
    root.querySelector("[data-cancel]").onclick = ui.close;
    root.querySelector("[data-save]").onclick = ui.action(async function () {
      var next = u.copy(app.config); next.preferences = { theme: root.querySelector('[name="theme"]').value, language: root.querySelector('[name="language"]').value };
      await app.services.store.saveConfig(next); app.i18n.theme(); app.i18n.dom(); app.events.emit("preferences:changed"); ui.close(); ui.toast(t("软件设置已保存", "Preferences saved"));
    });
  }
  function help() {
    ui.open({ title: t("使用说明", "How to draw"), html: '<div class="help-copy"><h3>' + t("从草图到成图", "From sketch to artwork") + '</h3><ol><li>' +
      t("在顶部写下画面描述，使用铅笔勾轮廓、涂色笔铺色；图片工具可以导入参考图。", "Describe your idea above the canvas. Draw outlines with Pencil, add color with Brush, or import a reference image.") + '</li><li>' +
      t("先在右上角菜单配置模型。自动模式会在落笔后等待片刻再生成；生成期间可以继续画，最新画面会排队。", "Configure models in the menu. Auto mode waits briefly after a stroke. Keep drawing while a request runs; the latest sketch is queued.") + '</li><li>' +
      t("叠加生成关闭时，画布上方滑竿调整顶层成图透明度；开启后成图移到元素下方，滑竿改为调整元素层透明度。绘制稿强度在作品设置中统一调整。", "With overlay generation off, the slider above the canvas controls the top result layer. Turn overlay on to move the result below the elements and use the slider for element-layer opacity. Adjust shared sketch preservation in Artwork settings.") + '</li><li>' +
      t("作品会自动保存在历史中。打开历史可继续编辑或复制作品；新建时会先保存当前作品。", "Artwork is saved automatically. Continue or duplicate it from Your artwork. Creating a new work saves the current one first.") + '</li></ol><h3>' +
      t("局部与选择", "Mask & selection") + '</h3><p>' + t("局部工具用粉色标记重绘区域，仅支持有蒙版能力的 OpenAI Images 和 SD WebUI 接口。选择模式下，轻点元素会单选；从空白处拖出选择框，碰到的元素都会被选中。直接拖动单个元素只移动它，框选后再拖动选区内的元素或空隙会整体移动；点击成组后，轻点或框到组内任一元素都会选中整组。四角手柄与双指捏合用于等比缩放。", "The pink mask marks areas to repaint in supported OpenAI Images and SD WebUI APIs. In Select mode, tap an element to select only it, or drag a box from empty space; every touched element is selected. Drag one element to move only it; after a box selection, drag an element or empty space inside the selection to move the selection. After grouping, tapping or touching any member with the selection box selects the whole group. Use corner handles or a two-finger pinch to scale proportionally.") + '</p><h3>' +
      t("连接自己的模型", "Connect your model") + '</h3><p>' + t("两个模型独立配置。A1X 推荐使用 DreamShaper8 LCM 做 512 × 512 实时手绘，Flux.2 Klein 4B 做 1024 × 1024 渲染；两者均为 1:1，并支持 2 / 4 / 8 步。局域网地址支持 HTTP，公网需要 HTTPS。通用 ComfyUI 模式仍可导入带占位符的 API 工作流。", "Configure two independent models. The recommended A1X setup uses DreamShaper8 LCM for 512 × 512 realtime sketching and Flux.2 Klein 4B for 1024 × 1024 rendering. Both are 1:1 and support 2 / 4 / 8 steps. LAN HTTP is supported, while public services require HTTPS. Generic ComfyUI workflows remain available.") + '</p><h3>' +
      t("保存与导出", "Save & export") + '</h3><p>' + t("下载按钮保存当前画布的实际显示效果；渲染完成后会打开全屏大图预览，可双指缩放、拖动查看并单独下载 1024 大图。停止等待只忽略本次结果，不保证服务端取消或停止计费。", "Download saves the canvas exactly as displayed. Render opens a fullscreen image viewer with pinch zoom, panning, and a separate 1024 image download. Dismiss ignores a result; it does not guarantee server cancellation or stop billing.") + '</p></div>' });
  }
  function about() {
    ui.open({ mode: "center", title: t("软件信息", "About VibeDraw"), html: '<div class="about-brand"><span class="brand-mark">V</span><div><strong>VibeDraw</strong><div class="about-meta">v' + app.version + ' · MIT</div></div></div><p>' + t("画下灵感，与 AI 一起完成。", "Sketch an idea. Create with AI.") + '</p><p class="about-meta">' + t("原生 HTML / CSS / JavaScript 开源 happ。模型由你选择，作品保存在当前应用。", "An open-source HTML / CSS / JavaScript happ. Your models, your artwork, stored in this app.") + '</p><p class="about-meta">© 2026 zhyuzh · Font Awesome Free (Hermit)</p>' });
  }
  app.components.settings = { init: init, open: open, openColor: openColor };
})(window.vibedraw);
