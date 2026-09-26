(function (app) {
  "use strict";
  var t = app.i18n.text, u = app.utils, ui, draft, original, slot = "quick";
  var SLOTS = ["quick", "inpaint", "upscale"];
  var SLOT_TABS = [["quick", "快速生图", "Quick draw"], ["inpaint", "局部重绘", "Local redraw"], ["upscale", "高清渲染", "Render"]];
  var SLOT_INTRO = {
    quick: ["请使用 1 秒以内成图 512 分辨率的模型，推荐 LCM 模型。", "Use a model that finishes a 512 image within about a second. An LCM model is recommended."],
    inpaint: ["用蒙版标出要改的地方，只重画这一块，其余保持原样；同样推荐 LCM 模型。", "Mark the area to change. Only that area is repainted and everything else is kept. An LCM model is recommended."],
    upscale: ["把 512 的手绘稿放大并补充细节。模型只要能接受 512 参考图、输出大图即可。", "Upscale the 512 sketch and add detail. Any model that accepts a 512 reference and outputs a larger image works."]
  };
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
  // A happ cannot read its own bundled files (the host serves documents with
  // connect-src 'none'), so the plugin archive travels as bytes generated into
  // app/assets/comfyui-plugin.js at packaging time. Writing them out through the
  // host and handing the stored file to the export flow gives the user exactly the
  // archive that release/vibedraw-comfyui-plugin-v*.zip holds.
  async function downloadPlugin() {
    var bundle = app.comfyuiPlugin, bridge = app.platform.hermit.current();
    if (!bundle || !bundle.base64) throw new Error(t("这个版本没有内置插件包，请到官网下载", "This build ships no plugin package; download it from the site"));
    if (!bridge) throw new Error(t("保存插件需要 Hermit 宿主环境", "Saving the plugin needs the Hermit host"));
    var writeId = "", stored = null;
    try {
      var write = await bridge.files.beginWrite({ name: bundle.name, mime: "application/zip" });
      writeId = write.writeId;
      // One append carries at most maxChunkBytes of decoded data, and base64 spends
      // four characters per three bytes, so the character cap is that byte cap
      // rounded down to a whole three-byte group and re-expanded.
      var cap = Number(write.maxChunkBytes) || 65536;
      var chunk = Math.max(3072, Math.floor(cap / 3) * 4);
      for (var offset = 0; offset < bundle.base64.length; offset += chunk) {
        await bridge.files.appendBytes({ writeId: writeId, chunkBase64: bundle.base64.slice(offset, offset + chunk) });
      }
      stored = await bridge.files.finishWrite({ writeId: writeId }); writeId = "";
      // export() opens the system save dialog: the user picks a folder and the host
      // copies the stored bytes there. Nothing leaves the device or the network.
      var exported = await bridge.files.export({ logicalFileId: stored.logicalFileId });
      if (exported && exported.cancelled) return;
      ui.toast(t("插件包已保存", "Plugin package saved"));
    } finally {
      if (writeId) await bridge.files.abortWrite({ writeId: writeId }).catch(function () {});
      if (stored) await bridge.files.delete({ logicalFileId: stored.logicalFileId }).catch(function () {});
    }
  }
  function open(kind) {
    ui = app.components.ui;
    if (kind === "models") { draft = u.copy(app.config); original = JSON.stringify(draft); slot = "quick"; renderModels(); }
    else if (kind === "work" || kind === "canvas") workSettings();
    else if (kind === "preferences") preferences();
    else if (kind === "help") help();
    else about();
  }
  function aspectField(model, name) {
    // The aspect and step count come from the plugin's capability specification,
    // so they are shown but never edited here. Only the upscale capability lets
    // the user pick between its output sizes, and which those are is the
    // plugin's answer, not this file's: the last /cvp/info is asked first and
    // the familiar pair is only the fallback for a plugin never yet contacted.
    var known = name === "upscale" ? app.services.providers.capabilitySizes(name) : [];
    var choices = known.length ? known : (name === "upscale" ? [1024, 2048] : []);
    var sizes = name === "upscale"
      ? '<span class="aspect-sizes">' + choices.map(function (value) {
        return '<button type="button" data-aspect-size="' + value + '" class="' + (Number(model.width) === value ? "is-active" : "") + '">' + value + " × " + value + '</button>';
      }).join("") + '</span>'
      : '<strong>' + model.width + " × " + model.height + '</strong>';
    return '<div class="field locked-field aspect-field"><span>' + t("输入与画幅", "Input & aspect") + '</span><div class="aspect-value"><strong>1:1</strong>' + sizes + '<strong>' + t("步数 ", "steps ") + model.steps + '</strong></div></div>';
  }
  function renderModels() {
    var model = draft[slot] || draft.quick, protocol = model.protocol, cvp = protocol === "cvp";
    // The three CVP capabilities share one address, password and header set, so the
    // form reads and writes that single object instead of this task's own copy.
    // Switching capabilities therefore shows the same connection, and the store
    // re-derives each one from it when the settings are saved.
    var shared = draft.connection || (draft.connection = { endpoint: "", apiKey: "", customHeaders: "" });
    var choices = app.services.providers.protocols.map(function (p) { return [p.id, p.name]; });
    var tabs = SLOT_TABS.map(function (entry) {
      return '<button data-slot-tab="' + entry[0] + '" class="' + (slot === entry[0] ? "is-active" : "") + '">' + t(entry[1], entry[2]) + '</button>';
    }).join("");
    var secretLabel = cvp ? t("访问密码", "Access password") : "API Key";
    var secretHint = cvp
      ? t("在 ComfyUI 的 VibeDraw 配置节点里设置；留空表示插件没有启用密码", "Set it in the ComfyUI VibeDraw config node; leave empty when the plugin has no password")
      : t("免鉴权的本地服务可留空", "Optional for local services");
    var secretField = '<label class="field"><span>' + secretLabel + '</span><div class="secret-input"><input name="apiKey" type="password" autocomplete="off" value="' + u.escapeHtml(cvp ? shared.apiKey : model.apiKey) + '" placeholder="' + u.escapeHtml(secretHint) + '"><button data-toggle-secret aria-label="' + t("显示密钥", "Show key") + '"><i class="fa-regular fa-eye"></i></button><button data-paste-secret aria-label="' + t("粘贴密钥", "Paste key") + '"><i class="fa-regular fa-paste"></i></button></div></label>';
    var sharedHelp = '<p class="field-help">' + t("三个任务的 CVP 地址与密码是同一套：在这里改，三个任务一起改。", "The three tasks share one CVP address and password: change it here and all three change together.") + '</p>';
    var card = '<div data-model-card="' + slot + '"><p class="model-intro">' + t(SLOT_INTRO[slot][0], SLOT_INTRO[slot][1]) + '</p>' +
        select("protocol", t("接口模式", "API format"), protocol, choices) +
        aspectField(model, slot) +
        input("endpoint", t("服务器地址", "Server address"), cvp ? shared.endpoint : model.endpoint, "url", cvp ? "http://192.168.1.2:8188" : "https://…") +
        secretField +
        (cvp ? sharedHelp : '') +
        (!cvp ? input("model", t("模型 ID", "Model ID"), model.model, "text", t("填写服务提供的模型名称", "Model name from your provider")) : '') +
        (cvp ? '<p class="field-help">' + t("画幅、步数和参考图权重由插件内置的工作流决定；点下方按钮可以直接读取插件当前的模型与能力。中文提示词由插件负责译成英文。", "Aspect, steps and reference weight come from the plugin's built-in workflows. The button below reads the plugin's current models and capabilities. The plugin translates a Chinese prompt itself.") + '</p>' : '') +
        '<details class="advanced"><summary>' + t("高级参数", "Advanced options") + '</summary><div class="field-row">' + input("timeoutMs", t("超时（毫秒）", "Timeout (ms)"), model.timeoutMs, "number") + (cvp ? input("refStrength", t("参考图权重基准", "Reference weight"), model.refStrength, "number") : '') + '</div>' +
        (cvp ? '<div class="field-row">' + input("growMaskBy", t("蒙版外扩（像素）", "Mask grow (px)"), model.growMaskBy, "number") + '</div>' : '') +
        (protocol === "openai-images" ? select("quality", t("生成质量", "Quality"), model.quality, [["low", t("快速", "Low")], ["medium", t("均衡", "Medium")], ["high", t("精细", "High")], ["auto", t("自动", "Auto")]]) : '') +
        textarea("customHeaders", t("自定义请求头 JSON", "Custom headers JSON"), cvp ? shared.customHeaders : model.customHeaders, '{"X-API-Key":"…"}') + '</details>' +
        '<p class="field-help">' + t("只向你配置的服务发送画面。局域网支持 HTTP；访问密码仅在保存后保存在当前应用。", "Images go only to your configured service. LAN HTTP is supported. Passwords are stored locally when you save.") + '</p>' +
        '<button class="button button-secondary" data-test><i class="fa-solid fa-plug"></i>' + t("测试连接", "Test connection") + '</button><p class="connection-status" data-test-status></p>' +
        (cvp ? '<button class="button button-secondary" data-plugin-download><i class="fa-solid fa-download"></i>' + t("下载 ComfyUI 插件", "Download ComfyUI plugin") + '</button>' +
          '<p class="field-help">' + t("插件包随本应用一起提供。解压到 ComfyUI 的 custom_nodes 目录后重启 ComfyUI，再在 VibeDraw 配置节点里填同样的密码。", "The plugin package ships with this app. Unzip it into ComfyUI's custom_nodes directory, restart ComfyUI, then set the same password in the VibeDraw config node.") + '</p>' : '') + '</div>';
    var root = ui.open({ title: t("模型配置", "Models"), beforeClose: discard, html:
      '<div class="segmented model-tabs">' + tabs + '</div>' + card + footer() });
    bindChoices(root);
    root.querySelectorAll("[data-slot-tab]").forEach(function (button) { button.onclick = function () { slot = button.dataset.slotTab; renderModels(); }; });
    root.querySelectorAll("[data-aspect-size]").forEach(function (button) {
      button.onclick = function () {
        var value = Number(button.dataset.aspectSize);
        draft[slot].width = value; draft[slot].height = value; renderModels();
      };
    });
    root.querySelectorAll("[name]").forEach(function (field) {
      var numeric = ["width", "height", "steps", "timeoutMs", "refStrength", "growMaskBy"].indexOf(field.name) >= 0;
      // These three are the shared CVP connection, so they are written to the one
      // object as well as to this capability's copy (the copy keeps the test
      // button and the request path reading real values before the settings are
      // saved).
      var sharedField = cvp && ["endpoint", "apiKey", "customHeaders"].indexOf(field.name) >= 0;
      function update() {
        var value = field.name === "apiKey" || field.name === "customHeaders" ? field.value : numeric ? Number(field.value) : field.value;
        if (sharedField) shared[field.name] = value;
        draft[slot][field.name] = value;
      }
      if (field.name === "protocol") field.onchange = async function () {
        var previous = model.protocol, protocol = field.value;
        if (model.endpoint || model.apiKey) {
          var confirmed = await ui.confirm({ title: t("切换接口模式？", "Change API format?"), message: t("这个任务会改用该接口默认的地址与密码；CVP 的公共连接设置会留给其他任务。", "This task falls back to that format's own address and password. The shared CVP connection stays for the other tasks."), ok: t("切换", "Change") });
          if (!confirmed) { field.value = previous; syncChoice(field); return; }
        }
        var next = app.services.providers.preset(protocol, slot);
        // Choosing CVP adopts the shared connection; when nothing is configured yet the
        // preset's example address becomes that connection instead of being dropped.
        if (protocol === "cvp" && !String(shared.endpoint || "").trim() && !String(shared.apiKey || "").trim()) {
          shared.endpoint = next.endpoint; shared.apiKey = next.apiKey || ""; shared.customHeaders = next.customHeaders || "";
        }
        draft[slot] = next; renderModels();
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
    var testButton = root.querySelector("[data-test]");
    if (testButton) testButton.onclick = ui.action(async function () {
      var status = root.querySelector("[data-test-status]");
      status.textContent = t("连接中，不生成图片…", "Connecting without generating an image…");
      try {
        var result = await app.services.providers.test(draft[slot]);
        // One call to the plugin's public information endpoint answers all of it:
        // the address resolves, the password was right, the capability exists,
        // its models are installed. The card then says which model it will
        // actually run and whether the user should type Chinese or English,
        // both read from what the plugin reported rather than assumed here.
        if (result && result.capability) {
          var label = (result.label && (app.i18n.language() === "zh" ? result.label.zh : result.label.en)) || result.capability;
          var files = (result.models || []).map(function (item) { return String(item.name || "").trim(); }).filter(function (name) { return name; }).join(" + ");
          var language = result.promptLanguage === "en"
            ? t("中文提示词会在提交时由插件译成英文。", "A Chinese prompt is translated by the plugin when the job is submitted.")
            : t("可以直接写中文，提示词会原样交给模型。", "Chinese can be written as-is; the prompt reaches the model unchanged.");
          status.textContent = t("连接成功：", "Connected: ") + label + (files ? " · " + files : "") + "。" + language;
        } else status.textContent = t("连接成功；出图能力取决于所选模型。", "Connected. Image support depends on the selected model.");
      } catch (error) {
        status.textContent = t("连接失败，请检查地址与密码。", "Connection failed. Check your URL and password.");
        throw error;
      }
    });
    var pluginButton = root.querySelector("[data-plugin-download]");
    if (pluginButton) pluginButton.onclick = ui.action(downloadPlugin);
    root.querySelector("[data-cancel]").onclick = ui.requestClose;
    root.querySelector("[data-save]").onclick = ui.action(async function () {
      SLOTS.forEach(function (name) {
        var config = draft[name];
        if (!config) return;
        if (!String(config.endpoint || "").trim()) return;
        u.validateEndpoint(config.endpoint); u.parseHeaders(config.customHeaders);
        if (!(Number(config.timeoutMs) >= 5000 && Number(config.timeoutMs) <= 300000)) throw new Error(t("超时需为 5–300 秒", "Use a timeout between 5 and 300 seconds"));
        if (config.protocol === "cvp" && !(Number(config.refStrength) > 0 && Number(config.refStrength) <= 1)) throw new Error(t("参考图权重需为 0–1", "Reference weight must be between 0 and 1"));
      });
      await app.services.store.saveConfig(draft); ui.close(); app.events.emit("config:changed"); ui.toast(t("模型设置已保存", "Model settings saved"));
    });
  }
  function workSettings() {
    var state = app.state;
    var root = ui.open({ sheetClass: "work-settings-sheet", contentClass: "work-settings-content", title: t("作品设置", "Artwork settings"), footerHtml: footer(t("应用", "Apply")), html:
      textarea("prompt", t("简述你期望的画面内容（中英文都行）", "Describe the image you expect (Chinese or English)"), state.prompt, "例如:一只蓝色的水晶鸟飞过雪山,清晨的光", 3) +
      textarea("negativePrompt", t("不希望出现内容（中英文都行）", "What to avoid (Chinese or English)"), state.negativePrompt, "例如:模糊,变形,水印", 2) +
      range("strength", t("绘制稿保留强度", "Sketch preservation"), Math.round(state.strength * 100), 0, 100, "%", "strength-field") +
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
      app.services.store.scheduleCanvasSave(); app.services.imageEngine.schedule(); app.events.emit("result:filter"); app.events.emit("work:settings"); ui.close();
      // Nothing is translated here, and nothing has to be: the prompt is stored
      // exactly as it was written. The plugin translates on submit when a model
      // needs English, and says so in the job it answers with.
      ui.toast(t("作品设置已应用", "Artwork settings applied"));
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
  // The repository this happ is developed in. The about sheet links straight to it, and
  // the link must stay a same-frame navigation: the app WebView has no window handler, so
  // target="_blank" would silently do nothing, while a same-frame jump to another origin
  // is exactly what the host turns into the system browser.
  var PROJECT_URL = "https://github.com/zhyuzh3d/vibedraw";
  function glyph(style, name) { return '<i class="' + style + ' fa-' + name + '" aria-hidden="true"></i>'; }
  // One help line = the tool's own icon, its name, and one sentence. The icon is the
  // point: it lets the sheet be read as a map of the toolbars instead of as prose.
  function helpLine(inner, title, detail) {
    return '<div class="help-line"><span class="help-icon" aria-hidden="true">' + inner + '</span><div><strong>' + title + '</strong><p>' + detail + '</p></div></div>';
  }
  function helpSection(title, rows) { return "<h3>" + title + '</h3><div class="help-list">' + rows.join("") + "</div>"; }
  function help() {
    var fa = glyph, line = helpLine;
    ui.open({ title: t("使用说明", "How to draw"), html: '<div class="help-copy">' +
      helpSection(t("快速上手", "Quick start"), [
        line(fa("fa-solid", "gear"), t("① 写提示词（中英文都行）", "1 · Describe it"), t("点画布上方的齿轮打开「作品设置」,在第一个框里写画面内容,中英文都行。接 CVP 插件时,只认英文的模型由插件在提交那一刻自动把中文译成英文;写英文就原样提交。越具体越准。", "Tap the gear above the canvas to open Artwork settings and write the scene in the first field. Chinese or English both work: with the CVP plugin, a model that only reads English gets a translation the plugin makes at submit time, and an English prompt is submitted exactly as written. The more specific, the better.")),
        line(fa("fa-solid", "pencil"), t("② 自由绘制", "2 · Draw freely"), t("铅笔勾轮廓，涂色铺色，也可以用「图片」导入参考。", "Sketch with Pencil, color with Brush, or import a reference with Image.")),
        line(fa("fa-solid", "wand-magic-sparkles") + fa("fa-solid", "dice"), t("③ 快速生成 / 随机创意", "3 · Fast or roll a seed"), t("点「快速」出实时预览；点骰子换一个随机数再生一次，换个构图。", "Tap Fast for a live preview, or the dice to roll a seed and generate again for a different take.")),
        line(fa("fa-regular", "gem"), t("④ 渲染大图", "4 · Render"), t("点「渲染」得到 1024 高清图；画布右下角钻石可全屏查看、单独下载。", "Tap Render for a 1024 image; the diamond on the canvas opens it fullscreen with its own download."))
      ]) +
      helpSection(t("作品设置", "Artwork settings"), [
        line(fa("fa-solid", "gear"), t("提示词（重点）", "Description (key)"), t("齿轮是它唯一的入口。第一个框写画面内容,第二个框写不希望出现的东西,中英文都行,原样提交。写中文时由后台负责译成英文(CVP 插件自带翻译和缓存),应用不参与翻译,也不会改动你写的字；局部重绘用的是另一套单独的描述，两者不混用。", "The gear is the only way in. The first field is the scene, the second what to avoid, in Chinese or English, submitted as written. A Chinese prompt is translated by the backend — the CVP plugin ships its own translator and cache — so the app takes no part in it and never rewrites your words. Local redraw keeps its own separate description.")),
        line(fa("fa-regular", "image"), t("图像权重（重点）", "Image weight (key)"), t("提示条上的滑竿：80% 为中性；调高更贴手绘稿，调低模型更自由。点左边的图片图标一键回到 80%。作品设置里的「绘制稿保留强度」就是这个值。", "The slider on the prompt bar: 80% is neutral. Higher sticks closer to your sketch, lower frees the model. The image icon on its left snaps back to 80%. Artwork settings exposes the same value as Sketch preservation."))
      ]) +
      helpSection(t("画布工具栏", "Canvas toolbar"), [
        line(fa("fa-solid", "expand"), t("全屏画布（重点）", "Fullscreen (key)"), t("画布铺满屏幕，绘制与选择都更宽裕；全屏后底部小箭头可收起工具条。", "The canvas fills the screen for more drawing and selection room; the small arrow below collapses the toolbars.")),
        line(fa("fa-solid", "palette"), t("调色（重点）", "Color (key)"), t("亮度、对比度、饱和度、色相、梦幻辉光、清晰度实时预览；「设为默认」记住这套效果。", "Brightness, contrast, saturation, hue, dream glow and sharpness, previewed live. Save default keeps the set.")),
        line(fa("fa-solid", "eye"), t("成图层", "Result layer"), t("眼睛隐藏或显示成图，右侧滑竿调成图透明度，不动草稿元素。", "The eye hides or shows the result; the slider beside it sets result opacity without touching your elements.")),
        line(fa("fa-solid", "rotate-left") + fa("fa-solid", "rotate-right"), t("撤销 / 重做", "Undo / redo"), t("成图切换也进撤销栈，最多回退 120 张。", "Result changes join the undo journal too, up to 120 steps back."))
      ]) +
      helpSection(t("工具箱", "Toolbox"), [
        line(fa("fa-solid", "arrow-pointer"), t("选择（重点）", "Select (key)"), t("轻点单选；从空白处拖出选框可多选。拖单个元素只移动它，框选后拖动区内任意位置整体移动；四角手柄或双指捏合等比缩放。", "Tap to select one; drag a box from empty space to select several. Dragging one element moves only it; after a box selection, drag anywhere inside to move the whole selection. Corner handles or a two-finger pinch scale proportionally.")),
        line(fa("fa-solid", "object-group") + fa("fa-solid", "object-ungroup"), t("成组（重点）", "Group (key)"), t("选中多个后「成组」，之后轻点组内任一元素即选中整组；「取消成组」可拆开。", "Group several selected objects, then tapping any member selects the whole group. Ungroup splits it again.")),
        line(fa("fa-solid", "minus") + fa("fa-solid", "plus"), t("放缩（重点）", "Scale (key)"), t("「放大 / 缩小」等比缩放所选对象，与四角手柄、双指捏合同一效果。", "Enlarge and Shrink scale the selection proportionally, same as the corner handles and a two-finger pinch.")),
        line(fa("fa-solid", "pencil") + fa("fa-solid", "paintbrush") + fa("fa-solid", "eraser") + fa("fa-regular", "image"), t("绘制与图片", "Draw & image"), t("铅笔勾线、涂色铺色，粗细与透明度在同一行调；擦除擦掉元素内容；图片导入参考图。", "Pencil sketches, Brush fills; size and opacity sit on the same row. Eraser removes element content; Image imports a reference.")),
        line(fa("fa-solid", "mask-face") + fa("fa-solid", "keyboard"), t("局部重绘（重点）", "Local redraw (key)"), t("① 用「局部」涂红要改的区域 → ② 点键盘图标写这块要改成什么 → ③ 点「快速」生成。只提交这句局部描述。", "Mark the area red with Mask, write what it should become with the keyboard icon, then tap Fast. Only that local description is submitted.")),
        line(fa("fa-solid", "eraser"), t("清除标记", "Clear marks"), t("局部模式下出现，擦掉全部红色标记重新开始。", "Appears in local mode to wipe every red mark and start over."))
      ]) +
      helpSection(t("生图工具栏", "Generation bar"), [
        line(fa("fa-solid", "bolt"), t("自动 / 手动", "Auto / Manual"), t("按钮开着叫「自动」，关掉叫「手动」；开着时落笔停一会儿自动调用快速模型。", "The button reads Auto when it is on and Manual when it is off; while on, a quick model runs by itself a moment after you stop drawing.")),
        line(fa("fa-solid", "wand-magic-sparkles"), t("快速", "Fast"), t("用实时模型按当前画面生成预览。", "Generates a preview of the current picture with the realtime model.")),
        line(fa("fa-solid", "dice"), t("骰子", "Dice"), t("换一个随机数并立刻快速生成一次，用来试构图。", "Rolls a new seed and runs Fast immediately, for trying a different composition.")),
        line(fa("fa-regular", "gem"), t("渲染", "Render"), t("把当前实际画面交给高质量模型，输出 1024 大图。", "Sends the visible canvas to the high-quality model for a 1024 render.")),
        line('<span class="mini-switch"></span>', t("叠加生成", "Overlay"), t("开启：成图移到元素下方，并作为下一次参考的一部分。", "On: the result drops below your elements and joins the next reference.")),
        line(fa("fa-solid", "camera"), t("快照", "Snapshot"), t("把当前显示效果压平成一张可编辑图片元素。", "Flattens what is on screen into one editable image element.")),
        line(fa("fa-solid", "download"), t("下载", "Download"), t("保存当前画布的实际显示效果。", "Saves the canvas exactly as displayed."))
      ]) +
      helpSection(t("模型", "Models"), [
        line(fa("fa-solid", "cubes"), t("接上自己的模型", "Connect a model"), t("菜单里的「模型配置」按快速生图 / 局部重绘 / 高清渲染分三套，共享同一套地址与密码。推荐在本地 ComfyUI 装 VibeDraw 插件（CVP），密码在插件的配置节点里设置。", "Models are set per task: quick draw, local redraw and render, sharing one address and password. Installing the VibeDraw plugin (CVP) on a local ComfyUI is recommended; set its password in the plugin's config node."))
      ]) +
      '</div>' });
  }
  function about() {
    ui.open({ mode: "center", title: t("软件信息", "About VibeDraw"), html: '<div class="about-brand"><span class="brand-mark">V</span><div><strong>VibeDraw</strong><div class="about-meta">v' + app.version + ' · MIT</div></div></div><p>' + t("画下灵感，与 AI 一起完成。", "Sketch an idea. Create with AI.") + '</p><p class="about-meta">' + t("原生 HTML / CSS / JavaScript 开源 happ。模型由你选择，作品保存在当前应用。", "An open-source HTML / CSS / JavaScript happ. Your models, your artwork, stored in this app.") + '</p><a class="button button-secondary about-link" href="' + PROJECT_URL + '">' + glyph("fa-brands", "github") + t("GitHub 项目", "GitHub project") + '</a><p class="about-meta">© 2026 zhyuzh · Font Awesome Free (Hermit)</p>' });
  }
  app.components.settings = { init: init, open: open, openColor: openColor };
})(window.vibedraw);
