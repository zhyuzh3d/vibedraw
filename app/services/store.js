(function (app) {
  "use strict";
  var revisions = {}, chunkManifests = {}, saveTimer = 0, queue = Promise.resolve(), index = [], paused = false, savePending = false;
  var lastCanvasFingerprint = "", lastPersistedSnapshot = null;
  var CHUNK_SCHEMA = "vibedraw-chunked/v1", DIRECT_LIMIT = 30000, CHUNK_BYTES = 30000, IO_CONCURRENCY = 4, MAX_BYTES = 8 * 1024 * 1024;
  var fields = ["prompt", "localPrompt", "negativePrompt", "background", "color", "size", "opacity", "strength", "colorStrength", "seed", "seedLocked", "autoDelayMs", "autoGenerate", "overlayGenerate", "resultOpacity", "layerOpacity", "resultVisible", "resultBrightness", "resultContrast", "resultSaturation", "resultHue", "resultGlow", "resultClarity", "resultAdjustmentsEnabled", "workId", "workTitle"];
  function serial(task) { var next = queue.then(task); queue = next.catch(function () {}); return next; }
  async function readRaw(key, fallback) {
    var record = await app.platform.hermit.getData("vibedraw", key);
    if (!record || record.value == null) return app.utils.copy(fallback);
    revisions[key] = record.revision; return record.value;
  }
  async function writeRaw(key, value) {
    var result = await app.platform.hermit.putData("vibedraw", key, value, revisions[key]);
    if (result && result.revision) revisions[key] = result.revision;
    return result;
  }
  function isChunkManifest(value) { return value && value.schema === CHUNK_SCHEMA && typeof value.generation === "string" && Number.isInteger(value.parts) && value.parts > 0 && value.parts <= 1000; }
  function chunkKey(key, manifest, part) { return key + "-chunk-" + manifest.generation + "-" + part; }
  async function cleanupChunks(key, manifest) {
    if (!isChunkManifest(manifest)) return;
    for (var start = 0; start < manifest.parts; start += IO_CONCURRENCY) {
      var tasks = [];
      for (var part = start; part < Math.min(manifest.parts, start + IO_CONCURRENCY); part += 1) {
        var name = chunkKey(key, manifest, part);
        tasks.push(app.platform.hermit.deleteData("vibedraw", name).catch(function () {})); delete revisions[name];
      }
      await Promise.all(tasks);
    }
  }
  async function read(key, fallback) {
    var value = await readRaw(key, fallback);
    if (!isChunkManifest(value)) { chunkManifests[key] = null; return value; }
    chunkManifests[key] = app.utils.copy(value);
    var pieces = new Array(value.parts);
    for (var start = 0; start < value.parts; start += IO_CONCURRENCY) {
      var tasks = [];
      for (var part = start; part < Math.min(value.parts, start + IO_CONCURRENCY); part += 1) {
        (function (position) { tasks.push(readRaw(chunkKey(key, value, position), null).then(function (piece) { pieces[position] = piece; })); })(part);
      }
      await Promise.all(tasks);
    }
    if (!pieces.every(function (piece) { return typeof piece === "string"; })) throw new Error(app.i18n.text("作品数据不完整，缺少存储分块", "Artwork data is incomplete: a storage chunk is missing"));
    var serialized = pieces.join("");
    if (app.utils.utf8Length(serialized) !== value.bytes) throw new Error(app.i18n.text("作品数据校验失败", "Artwork data failed its integrity check"));
    var parsed = app.utils.parseJson(serialized, null);
    if (parsed == null) throw new Error(app.i18n.text("作品数据格式损坏", "Artwork data is corrupted"));
    return parsed;
  }
  async function write(key, value) {
    var serialized = JSON.stringify(value), bytes = app.utils.utf8Length(serialized);
    if (bytes > MAX_BYTES) throw new Error(app.i18n.text("作品过于复杂，单件作品最多保存 8 MB 可编辑数据", "This artwork is too complex. Editable data is limited to 8 MB per artwork"));
    var oldManifest = chunkManifests[key];
    if (bytes <= DIRECT_LIMIT) {
      var directResult = await writeRaw(key, value);
      chunkManifests[key] = null;
      cleanupChunks(key, oldManifest).catch(function () {});
      return directResult;
    }
    var chunks = app.utils.utf8Chunks(serialized, CHUNK_BYTES);
    var manifest = { schema: CHUNK_SCHEMA, generation: app.utils.id("g"), parts: chunks.length, bytes: bytes };
    try {
      for (var start = 0; start < manifest.parts; start += IO_CONCURRENCY) {
        var tasks = [];
        for (var part = start; part < Math.min(manifest.parts, start + IO_CONCURRENCY); part += 1) {
          tasks.push(writeRaw(chunkKey(key, manifest, part), chunks[part]).then(function () { return null; }, function (error) { return error; }));
        }
        var errors = (await Promise.all(tasks)).filter(function (error) { return Boolean(error); });
        if (errors.length) throw errors[0];
      }
      var result = await writeRaw(key, manifest);
      chunkManifests[key] = manifest;
      cleanupChunks(key, oldManifest).catch(function () {});
      return result;
    } catch (error) {
      cleanupChunks(key, manifest).catch(function () {});
      throw error;
    }
  }
  async function deleteValue(key) {
    var manifest = chunkManifests[key];
    await app.platform.hermit.deleteData("vibedraw", key);
    delete revisions[key]; delete chunkManifests[key];
    cleanupChunks(key, manifest).catch(function () {});
  }
  function migrateConfig(stored) {
    var previousSchema = Number(stored && stored.schema) || 0;
    var original = app.utils.merge(app.defaults, stored || {});
    var value = app.utils.copy(original), changed = previousSchema < 7;
    if (previousSchema < 7) {
      // Schema 7 split the two-model setup into the three CVP tasks: the old
      // "quality" slot becomes the upscale task, and local redraw gains a slot
      // of its own. A new install simply keeps the defaults.
      value.upscale = app.utils.merge(app.utils.copy(app.defaults.upscale), stored && stored.quality || {});
      delete value.quality;
      if (!(stored && stored.inpaint)) {
        value.inpaint = app.utils.merge(app.utils.copy(app.defaults.inpaint), {
          protocol: value.quick.protocol, endpoint: value.quick.endpoint, apiKey: value.quick.apiKey
        });
      }
    }
    ["quick", "inpaint", "upscale"].forEach(function (name) {
      var model = value[name];
      if (!model) return;
      if (model.protocol === "a1x-flux") model.protocol = "a1x-image";
      // The generic ComfyUI workflow contract was replaced by the plugin's own
      // task API, so an old workflow slot becomes a CVP slot.
      if (model.protocol === "comfyui") model.protocol = "cvp";
      model.slot = name; model.task = name;
      if (!Number.isFinite(Number(model.refStrength)) || Number(model.refStrength) <= 0) model.refStrength = app.defaults[name].refStrength;
      if (!Number.isFinite(Number(model.growMaskBy))) model.growMaskBy = 8;
      if (model.protocol === "a1x-image") {
        if (previousSchema < 4 || [2, 4, 8].indexOf(Number(model.steps)) < 0) model.steps = name === "upscale" ? 8 : 4;
        model.width = model.height = name === "upscale" ? 1024 : 512;
        model.inputMode = "sketch";
        model.guidanceScale = name === "upscale" ? 1 : 2;
        model.model = name === "upscale" ? (Number(model.steps) === 8 ? "flux2_klein_4b_base_nvfp4" : "flux2_klein_4b_distilled_nvfp4") : "dreamshaper8_lcm_blended_img2img_sd15";
      }
    });
    value.canvas = value.canvas || {};
    delete value.canvas.overlayGenerate; delete value.canvas.includeResult; delete value.canvas.resultOpacity;
    value.schema = 7;
    return { value: value, changed: changed || JSON.stringify(value) !== JSON.stringify(original), migrateWorkTitles: previousSchema < 6 };
  }
  function isUntitledTitle(title) { return /^(?:未命名作品\d+|Untitled artwork\s+\d+)$/.test(String(title || "")); }
  function nextUntitledTitle() {
    var english = app.i18n.language() === "en", prefix = english ? "Untitled artwork " : "未命名作品";
    var pattern = english ? /^Untitled artwork\s+(\d+)$/ : /^未命名作品(\d+)$/, highest = 0;
    index.forEach(function (item) { var match = pattern.exec(String(item.title || "")); if (match) highest = Math.max(highest, Number(match[1]) || 0); });
    return prefix + (highest + 1);
  }
  function untitledTitleFor(id) {
    var item = index.find(function (value) { return value.id === id; });
    return item && isUntitledTitle(item.title) ? item.title : "";
  }
  async function migrateWorkTitles() {
    var changed = false;
    for (var position = index.length - 1; position >= 0; position -= 1) {
      var item = index[position], saved = await get(item.id);
      if (!saved || String(saved.workTitle || "").trim()) continue;
      var title = isUntitledTitle(item.title) ? item.title : nextUntitledTitle();
      saved.workTitle = title; item.title = title; await write("work-" + item.id, saved); changed = true;
    }
    if (changed) await write("works", index);
  }
  async function loadConfig() {
    var stored = await read("config", app.defaults), migrated = migrateConfig(stored);
    app.config = migrated.value; index = await read("works", []);
    if (migrated.migrateWorkTitles) await migrateWorkTitles();
    if (migrated.changed) await write("config", migrated.value);
    return app.config;
  }
  async function saveConfig(config) {
    var value = app.utils.merge(app.defaults, config);
    await serial(function () { return write("config", value); }); app.config = value;
    return value;
  }
  function serializeCanvas() {
    var snapshot = { schema: 9, objects: [], result: null, savedAt: Date.now() };
    fields.forEach(function (name) { snapshot[name] = app.state[name]; });
    snapshot.objects = app.state.objects.map(function (object) {
      return app.drawing.storageObject(object);
    });
    if (app.state.result) {
      var result = app.state.result;
      snapshot.result = { asset: result.asset || null, logicalFileId: result.logicalFileId || "", slot: result.slot, prompt: result.prompt, createdAt: result.createdAt };
      if (!snapshot.result.asset && result.src && !/^(data:|blob:)/.test(result.src)) snapshot.result.asset = { url: result.src };
    }
    return snapshot;
  }
  function fingerprint(snapshot) {
    if (!snapshot) return "";
    var savedAt = snapshot.savedAt; snapshot.savedAt = 0;
    var value = JSON.stringify(snapshot); snapshot.savedAt = savedAt;
    var first = 2166136261, second = 2246822519;
    for (var index = 0; index < value.length; index += 1) {
      var code = value.charCodeAt(index);
      first ^= code; first = Math.imul(first, 16777619);
      second ^= code + index; second = Math.imul(second, 3266489917);
    }
    return value.length + ":" + (first >>> 0).toString(36) + ":" + (second >>> 0).toString(36);
  }
  function assetSnapshot(snapshot) {
    return {
      workId: snapshot && snapshot.workId || "",
      objects: (snapshot && snapshot.objects || []).filter(function (object) { return Boolean(object.asset || object.logicalFileId); }).map(function (object) { return { asset: object.asset || null, logicalFileId: object.logicalFileId || "" }; }),
      result: snapshot && snapshot.result ? { asset: snapshot.result.asset || null, logicalFileId: snapshot.result.logicalFileId || "" } : null
    };
  }
  async function persistImages() {
    var objects = app.state.objects.slice(), result = app.state.result;
    for (var object of objects) {
      if (object.type !== "image" || object.asset) continue;
      object.asset = await app.services.assets.persist(object.src || object.url, null);
    }
    if (result && !result.asset) result.asset = await app.services.assets.persist(result.src, null);
  }
  function meaningfulObjects() { return app.state.objects.some(function (object) { return !(object.type === "stroke" && object.tool === "mask"); }); }
  function meaningful() { return Boolean(meaningfulObjects() || app.state.result || String(app.state.prompt).trim() || String(app.state.workTitle).trim()); }
  async function saveNow() {
    if (paused) return;
    app.events.emit("save", "saving");
    await persistImages();
    var snapshot = serializeCanvas();
    var previous = null, completedFingerprint = "";
    if (meaningful() || app.state.workId) {
      if (!app.state.workId) app.state.workId = app.utils.id("work");
      snapshot.workId = app.state.workId;
      if (!String(snapshot.workTitle || "").trim()) { snapshot.workTitle = untitledTitleFor(snapshot.workId) || nextUntitledTitle(); app.state.workTitle = snapshot.workTitle; }
      var item = index.find(function (value) { return value.id === snapshot.workId; });
      var nextFingerprint = fingerprint(snapshot);
      if (nextFingerprint === lastCanvasFingerprint) { savePending = false; app.events.emit("save", "saved"); return snapshot; }
      var nextItem = { id: snapshot.workId, title: snapshot.workTitle, createdAt: item ? item.createdAt : Date.now(), updatedAt: Date.now(), hasResult: Boolean(snapshot.result) };
      if (item) previous = lastPersistedSnapshot && lastPersistedSnapshot.workId === snapshot.workId ? lastPersistedSnapshot : await read("work-" + snapshot.workId, null);
      await write("work-" + snapshot.workId, snapshot);
      index = index.filter(function (value) { return value.id !== snapshot.workId; });
      index.unshift(nextItem);
      await write("works", index);
      completedFingerprint = nextFingerprint;
    } else {
      var blankFingerprint = fingerprint(snapshot);
      if (blankFingerprint === lastCanvasFingerprint) { savePending = false; app.events.emit("save", "saved"); return snapshot; }
      completedFingerprint = blankFingerprint;
    }
    await write("canvas", snapshot);
    lastCanvasFingerprint = completedFingerprint; lastPersistedSnapshot = assetSnapshot(snapshot);
    if (previous && JSON.stringify(app.services.assets.references(previous)) !== JSON.stringify(app.services.assets.references(snapshot))) {
      var surviving = [snapshot];
      for (var work of index) if (work.id !== snapshot.workId) { var saved = await get(work.id); if (saved) surviving.push(saved); }
      await app.services.assets.cleanup(previous, surviving).catch(function () {});
    }
    savePending = false; app.events.emit("save", "saved"); app.events.emit("works:changed", index.length);
    return snapshot;
  }
  function scheduleCanvasSave() {
    if (paused) return;
    clearTimeout(saveTimer);
    if (!savePending) { savePending = true; app.events.emit("save", "pending"); }
    saveTimer = setTimeout(function () { flush().catch(saveError); }, 650);
  }
  function saveError(error) { savePending = false; app.events.emit("save", "error"); app.events.emit("error", error); }
  function flush() { clearTimeout(saveTimer); return serial(saveNow); }
  async function hydrate(snapshot) {
    if (!snapshot) return null;
    var copy = app.utils.copy(snapshot);
    if (Number(copy.schema) < 5) {
      copy.seedLocked = copy.seedLocked === undefined ? Number(copy.seed) >= 0 : Boolean(copy.seedLocked);
      copy.overlayGenerate = copy.overlayGenerate === undefined ? Boolean(copy.includeResult) : Boolean(copy.overlayGenerate);
      if (copy.strength === undefined || Number(copy.strength) === 0.55) copy.strength = 0.8;
    }
    if (Number(copy.schema) < 6) {
      copy.resultOpacity = 1;
      copy.resultVisible = true;
    }
    if (Number(copy.schema) < 7 || !Number.isFinite(Number(copy.colorStrength))) copy.colorStrength = 0.3;
    if (Number(copy.schema) < 8 || copy.resultAdjustmentsEnabled === undefined) copy.resultAdjustmentsEnabled = true;
    if (Number(copy.schema) < 9) { copy.layerOpacity = 1; copy.resultOpacity = copy.overlayGenerate ? 1 : 0.9; }
    if (!Number.isFinite(Number(copy.layerOpacity))) copy.layerOpacity = 1;
    delete copy.includeResult; delete copy.referenceStrength; copy.schema = 9;
    var missing = false;
    for (var object of copy.objects || []) {
      if (object.type === "image") {
        try { object.src = object.asset ? await app.services.assets.resolve(object.asset) : object.url || ""; }
        catch (_) { object.src = ""; missing = true; }
      }
    }
    if (copy.result && copy.result.asset) {
      try { copy.result.src = await app.services.assets.resolve(copy.result.asset); }
      catch (_) { copy.result.src = ""; missing = true; }
    }
    if (missing) app.events.emit("error", new Error(app.i18n.text("部分历史图片无法读取，草稿与描述仍可编辑", "Some saved images are unavailable. Your sketch and prompt remain editable")));
    return copy;
  }
  async function loadCanvas() {
    var stored = await read("canvas", null), hydrated = await hydrate(stored);
    if (stored && Number(stored.schema) >= 9) { lastCanvasFingerprint = fingerprint(stored); lastPersistedSnapshot = assetSnapshot(stored); }
    return hydrated;
  }
  function list() { return index.map(function (item) { return { id: item.id, title: item.title, createdAt: item.createdAt, updatedAt: item.updatedAt, hasResult: item.hasResult }; }); }
  async function get(id) { return read("work-" + id, null); }
  async function restoreWork(id, duplicate) {
    await flush();
    var saved = await get(id);
    if (!saved) throw new Error(app.i18n.text("找不到这件作品", "Artwork not found"));
    var copy = await hydrate(saved);
    if (duplicate) { copy.workId = app.utils.id("work"); copy.workTitle = (copy.workTitle || nextUntitledTitle()) + app.i18n.text(" · 副本", " · copy"); }
    return copy;
  }
  async function remove(id) {
    await flush();
    return serial(async function () {
      var removed = await get(id), remaining = [];
      var nextIndex = index.filter(function (item) { return item.id !== id; });
      for (var item of nextIndex) { var record = await get(item.id); if (record) remaining.push(record); }
      await write("works", nextIndex); index = nextIndex;
      await deleteValue("work-" + id);
      if (app.state.workId !== id) remaining.push(serializeCanvas());
      if (removed) await app.services.assets.cleanup(removed, remaining).catch(function () {});
      app.events.emit("works:changed", index.length);
    });
  }
  function pause(value) { paused = value; if (value) clearTimeout(saveTimer); }
  app.services.store = { loadConfig: loadConfig, saveConfig: saveConfig, loadCanvas: loadCanvas, scheduleCanvasSave: scheduleCanvasSave, serializeCanvas: serializeCanvas, flush: flush, list: list, get: get, hydrate: hydrate, restoreWork: restoreWork, remove: remove, meaningful: meaningful, nextUntitledTitle: nextUntitledTitle, untitledTitleFor: untitledTitleFor, pause: pause };
})(window.vibedraw);
