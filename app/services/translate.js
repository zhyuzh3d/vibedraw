(function (app) {
  "use strict";

  var network = app.platform.hermit;

  // No checkpoint the app drives pairs with a text encoder that reads Chinese
  // (DreamShaper8 LCM carries CLIP-L inside the checkpoint, FLUX.2 Klein pairs
  // with an English-trained Qwen3), so Chinese arriving at the sampler is noise.
  // The plugin owns that translation and this service is the only thing that
  // asks for it: nothing is translated while the user types, and nothing is
  // translated at submit time — saving a prompt is what triggers the request.
  var CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/;
  var STORAGE_COLLECTION = "vibedraw", STORAGE_KEY = "prompt-translations", SCHEMA = "vibedraw-translations/v1", CACHE_LIMIT = 120;
  var cache = {};

  // A translation outlives the page: an artwork keeps the prompt the user typed,
  // so without this the first redraw after a restart would submit Chinese again.
  // The last answers are kept, because those are what a redraw asks for.
  async function load() {
    var record = null;
    try { record = await app.platform.hermit.getData(STORAGE_COLLECTION, STORAGE_KEY); } catch (error) { return; }
    var value = record && record.value;
    if (!value || value.schema !== SCHEMA || !value.entries || typeof value.entries !== "object") return;
    Object.keys(value.entries).forEach(function (key) {
      var text = value.entries[key];
      if (key && typeof text === "string" && text) cache[key] = text;
    });
  }
  function persist() {
    var keys = Object.keys(cache), entries = {};
    keys.slice(Math.max(0, keys.length - CACHE_LIMIT)).forEach(function (key) { entries[key] = cache[key]; });
    try {
      app.platform.hermit.putData(STORAGE_COLLECTION, STORAGE_KEY, { schema: SCHEMA, target: "en", entries: entries });
    } catch (error) { /* a cache that cannot be written is still a working cache */ }
  }

  function hasCjk(text) { return CJK.test(String(text == null ? "" : text)); }
  function source(text) { return String(text == null ? "" : text).trim(); }

  // The translator belongs to the plugin, so any configured CVP task knows where
  // it is; the three tasks share one connection.
  function connection() {
    var order = ["quick", "inpaint", "upscale"], index, item;
    for (index = 0; index < order.length; index += 1) {
      item = app.config && app.config[order[index]];
      if (item && item.protocol === "cvp" && source(item.endpoint)) return item;
    }
    return null;
  }
  function url(item) { return app.services.providers.internals.cvpBase(item.endpoint) + "/vibedraw/v1/translate"; }
  function headers(item) {
    var output = app.utils.parseHeaders(item.customHeaders || "");
    output["Content-Type"] = "application/json";
    if (item.apiKey && !output.Authorization && !output.authorization) output.Authorization = "Bearer " + item.apiKey;
    return output;
  }
  function remember(items, sources) {
    (items || []).forEach(function (item, index) {
      var key = source(sources[index]), text = item && item.text;
      if (key && item && item.translated && text) cache[key] = String(text);
    });
  }
  // The plugin answers with one entry per text, in the order they were sent, and
  // never fails the request: an all-English text and an unreachable translator
  // both come back as the source string with translated=false. A null answer
  // means the request itself did not go through, and the caller says so.
  async function ask(item, texts) {
    var response;
    try {
      response = await network.request({ url: url(item), method: "POST", headers: headers(item),
        bodyText: JSON.stringify({ texts: texts, target: "en" }), timeoutMs: 40000 });
    } catch (error) { return null; }
    if (!(response.status >= 200 && response.status < 300)) return null;
    var payload = app.utils.parseJson(response.bodyText || "", null);
    if (!payload || !payload.results) return null;
    remember(payload.results, texts);
    return payload.results;
  }

  // What will actually be submitted: an English prompt is copied through
  // untouched and never reworded, a Chinese one turns into its translation once
  // a save has produced one.
  function english(text) {
    var key = source(text);
    if (!key || !hasCjk(key)) return key;
    return cache[key] || key;
  }
  function translated(text) { var key = source(text); return Boolean(key && cache[key]); }

  // The translation tab asks one question: does the translator behind this plugin
  // work? A Chinese probe has to come back English for the answer to be yes, so the
  // dialog can point at the address, the password or the model instead of leaving
  // the user to guess why every drawing submits Chinese.
  var PROBE_TEXT = "一只蓝色的水晶鸟";
  async function probe(config) {
    var item = { endpoint: config.endpoint, apiKey: config.apiKey || "", customHeaders: config.customHeaders || "" };
    if (!source(item.endpoint)) throw new Error("no endpoint");
    var response = await network.request({ url: url(item), method: "POST", headers: headers(item),
      bodyText: JSON.stringify({ texts: [PROBE_TEXT], target: "en" }), timeoutMs: 40000 });
    if (!(response.status >= 200 && response.status < 300)) throw new Error("HTTP " + response.status);
    var payload = app.utils.parseJson(response.bodyText || "", null);
    var entry = payload && payload.results && payload.results[0];
    if (!entry || !entry.translated || !source(entry.text) || hasCjk(entry.text)) throw new Error("not translated");
    return { engine: payload.engine || "", example: PROBE_TEXT, text: String(entry.text) };
  }

  // The one trigger. Called when a prompt is saved, so the redraws that follow
  // submit an English string without ever waiting on the translator.
  async function translate(texts) {
    var wanted = [], seen = {};
    (texts || []).map(source).forEach(function (value) {
      if (value && hasCjk(value) && !cache[value] && !seen[value]) { seen[value] = true; wanted.push(value); }
    });
    if (!wanted.length) return [];
    var item = connection();
    if (!item) return [];
    var results = await ask(item, wanted);
    persist();
    return results || [];
  }

  app.services.translate = {
    load: load, hasCjk: hasCjk, english: english, translated: translated, translate: translate, probe: probe,
    internals: { cache: cache, connection: connection, url: url, persist: persist }
  };
})(window.vibedraw);
