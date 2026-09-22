import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = { console, URL, Uint8Array, TextEncoder, setTimeout, clearTimeout };
context.window = context; vm.createContext(context);
function load(name) { vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name }); }
load("app/core/namespace.js"); load("app/core/utils.js"); load("app/core/runtime.js"); load("app/core/drawing.js"); load("app/core/i18n.js");
const app = context.vibedraw, records = new Map();
let rev = 0, failWrite = false, failKey = "", putCount = 0;
const copy = x => JSON.parse(JSON.stringify(x));
app.platform.hermit = {
  getData: async (_, key) => records.has(key) ? copy(records.get(key)) : null,
  putData: async (_, key, value, expected) => {
    if (failWrite || key === failKey) throw new Error("disk full");
    putCount += 1;
    assert.ok(Buffer.byteLength(JSON.stringify({ value })) <= 64 * 1024, "each physical record must respect the Hermit 64 KiB limit");
    const old = records.get(key);
    if (old && expected) assert.equal(expected, old.revision, "writes must use the newest revision");
    const revision = "r" + ++rev;
    records.set(key, { value: copy(value), revision }); return { revision };
  },
  deleteData: async (_, key) => records.delete(key)
};
app.services.assets = {
  persist: async src => ({ parts: ["file-" + src.length], mime: "image/png" }),
  resolve: async asset => asset.url || "data:image/png;base64,restored",
  references: () => [],
  cleanup: async () => {}
};
load("app/services/store.js");
const store = app.services.store;
const legacyConfig = copy(app.defaults);
legacyConfig.schema = 1;
delete legacyConfig.inpaint;
delete legacyConfig.upscale;
legacyConfig.quality = {
  slot: "quality", name: "高质量模型", protocol: "a1x-flux", endpoint: "http://192.168.124.31:8188",
  apiKey: "kept-secret", model: "flux2_klein_4b_distilled_nvfp4", inputMode: "sketch", width: 512, height: 512,
  steps: 4, quality: "high", timeoutMs: 180000, customHeaders: "", workflow: "", guidanceScale: 1
};
Object.assign(legacyConfig.quick, { protocol: "a1x-flux", endpoint: "http://192.168.124.31:8188", apiKey: "kept-secret", width: 256, height: 256, steps: 1, model: "flux2_klein_4b_distilled_nvfp4" });
records.set("config", { value: legacyConfig, revision: "seed-config" });
await store.loadConfig();
assert.equal(app.config.schema, 8);
assert.equal(app.config.quick.protocol, "cvp", "a retired A1X slot must become a CVP slot");
assert.equal(app.config.quick.width, 512);
assert.equal(app.config.quick.steps, 8, "a retired slot must fall back to the CVP step default");
assert.equal(app.config.quick.model, "", "CVP picks its own checkpoint, so the old model id must be cleared");
assert.equal(app.config.quick.guidanceScale, 1);
assert.equal(app.config.canvas.resultBrightness, 100, "global color defaults must be migrated into config");
assert.equal(app.config.upscale.protocol, "cvp");
assert.equal(app.config.upscale.width, 1024);
assert.equal(app.config.upscale.steps, 8);
assert.equal(app.config.upscale.model, "");
assert.equal(app.config.upscale.endpoint, "http://192.168.124.31:8188", "the retired quality slot must become the upscale task with its connection intact");
assert.equal(app.config.inpaint.endpoint, "http://192.168.124.31:8188", "local redraw must inherit the quick connection on migration");
assert.equal(Object.prototype.hasOwnProperty.call(app.config, "quality"), false, "the retired quality slot must not survive migration");
assert.equal(Object.prototype.hasOwnProperty.call(app.config.canvas, "overlayGenerate"), false, "overlay generation is an artwork setting and must not become a global default");
assert.equal(app.config.quick.apiKey, "kept-secret", "migration must preserve the saved credential");
// Schema 8 keeps one CVP connection for all three tasks: the address a configured
// task already had becomes that connection, and every CVP task follows it.
assert.equal(app.config.connection.endpoint, "http://192.168.124.31:8188", "a configured CVP task must donate its address to the shared connection");
assert.equal(app.config.connection.apiKey, "kept-secret", "the shared connection must carry the saved password");
["quick", "inpaint", "upscale"].forEach(name => {
  assert.equal(app.config[name].endpoint, app.config.connection.endpoint, name + " must read the shared CVP address");
  assert.equal(app.config[name].apiKey, app.config.connection.apiKey, name + " must read the shared CVP password");
});
const shared = await store.saveConfig({ ...app.config, connection: { endpoint: "http://10.0.0.5:8188", apiKey: "one", customHeaders: "" } });
["quick", "inpaint", "upscale"].forEach(name => {
  assert.equal(shared[name].endpoint, "http://10.0.0.5:8188", name + " must follow an edited shared address");
  assert.equal(shared[name].apiKey, "one", name + " must follow an edited shared password");
});
assert.equal(shared.connection.endpoint, "http://10.0.0.5:8188", "the saved config must keep the shared connection itself");
const mixed = await store.saveConfig({ ...shared, quick: { ...shared.quick, protocol: "openai-images", endpoint: "https://api.example.com" }, connection: shared.connection });
assert.equal(mixed.quick.endpoint, "https://api.example.com", "a non-CVP task must keep its own address");
assert.equal(mixed.inpaint.endpoint, "http://10.0.0.5:8188", "a non-CVP task must not disturb the shared CVP connection");
Object.assign(app.state, {
  prompt: "Original", objects: [{ id: "stroke-1", type: "stroke", points: Array.from({ length: 5000 }, (_, index) => ({ x: index % 768, y: Math.floor(index / 8) % 768 })) }, { id: "image-1", type: "image", src: "data:image/png;base64,abc", url: "data:image/png;base64,abc" }],
  autoDelayMs: 1320, strength: 1.35, colorStrength: 0.47, resultOpacity: 0.42, layerOpacity: 0.37, resultVisible: false, overlayGenerate: true, seed: 73, seedLocked: true, resultGlow: 38, resultClarity: 24, resultAdjustmentsEnabled: false,
  result: { src: "data:image/png;base64,result", slot: "quick", createdAt: 1, metadata: { data: "never persist" } },
  // The undo journal is in-memory only: an older image held by a step must never
  // reach a Hermit record.
  renderResult: { src: "data:image/png;base64,render", slot: "upscale", createdAt: 2, metadata: { data: "never persist" } },
  history: [{ objects: [], background: "#ffffff", result: { src: "data:image/png;base64,undone", slot: "quick", createdAt: 0 } }], future: []
});
await store.flush();
const originalId = app.state.workId;
assert.equal(app.state.workTitle, "未命名作品1", "an untitled artwork must receive the next numbered title");
assert.equal(store.list()[0].title, "未命名作品1", "history must use the numbered artwork title instead of the prompt");
assert.equal(store.nextUntitledTitle(), "未命名作品2", "numbered artwork titles must increase from history");
assert.equal(store.list().length, 1);
assert.equal(records.get("work-" + originalId).value.schema, "vibedraw-chunked/v1", "large editable artworks must use chunked storage");
assert.ok([...records.keys()].some(key => key.startsWith("work-" + originalId + "-chunk-")), "large artwork chunks must be persisted separately");
const saved = await store.get(originalId);
assert.equal(saved.objects.length, 2);
assert.equal(JSON.stringify(saved).includes("data:image"), false, "binary image data must never enter records");
assert.equal("metadata" in saved.result, false);
assert.equal(saved.render.slot, "upscale", "the last render must be stored with the artwork");
assert.equal("metadata" in saved.render, false);
assert.equal("history" in saved, false, "the undo journal must never be persisted with the artwork");
assert.equal("future" in saved, false, "the redo stack must never be persisted with the artwork");
assert.equal(saved.autoDelayMs, 1320, "brush wait must be stored with the artwork");
assert.equal(saved.strength, 1.35, "shared sketch strength must be stored with the artwork");
assert.equal(saved.colorStrength, 0.47, "A1X LCM color strength must be stored with the artwork");
assert.equal(saved.resultOpacity, 0.42, "result opacity must be stored with the artwork");
assert.equal(saved.layerOpacity, 0.37, "element-layer opacity must be stored with the artwork");
assert.equal(saved.resultVisible, false, "result visibility must be stored with the artwork");
assert.equal(saved.overlayGenerate, true, "overlay generation mode must be stored with the artwork");
assert.equal(saved.seedLocked, true, "seed lock must be stored with the artwork");
assert.equal(saved.resultGlow, 38, "glow must be stored with the artwork");
assert.equal(saved.resultClarity, 24, "clarity must be stored with the artwork");
assert.equal(saved.resultAdjustmentsEnabled, false, "color-effect enablement must be stored with the artwork");
app.state.prompt = "Changed";
await Promise.all([store.flush(), store.flush()]);
assert.equal(store.list().length, 1, "autosaving must update the work, not duplicate it");
assert.equal((await store.get(originalId)).prompt, "Changed");
const unchangedPutCount = putCount;
await store.flush();
assert.equal(putCount, unchangedPutCount, "an unchanged canvas flush must not rewrite Hermit records");
const restored = await store.restoreWork(originalId, false);
assert.equal(restored.objects[1].src, "data:image/png;base64,restored");
assert.equal(restored.result.src, "data:image/png;base64,restored");
assert.equal(restored.autoDelayMs, 1320);
assert.equal(restored.strength, 1.35);
assert.equal(restored.colorStrength, 0.47);
assert.equal(restored.resultOpacity, 0.42);
assert.equal(restored.layerOpacity, 0.37);
assert.equal(restored.resultVisible, false);
assert.equal(restored.overlayGenerate, true);
assert.equal(restored.seedLocked, true);
assert.equal(restored.resultGlow, 38);
assert.equal(restored.resultClarity, 24);
assert.equal(restored.resultAdjustmentsEnabled, false);
const duplicate = await store.restoreWork(originalId, true);
assert.notEqual(duplicate.workId, originalId);
Object.assign(app.state, duplicate);
await store.flush();
assert.equal(store.list().length, 2);
Object.assign(app.state, restored);
await store.remove(duplicate.workId);
assert.equal(store.list().length, 1);
assert.equal((await store.get(originalId)).objects.length, 2, "removing a copy must preserve the original");
const previousConfig = JSON.stringify(app.config);
failWrite = true;
const modified = copy(app.config); modified.preferences.language = "en";
await assert.rejects(() => store.saveConfig(modified), /disk full/);
assert.equal(JSON.stringify(app.config), previousConfig, "failed save must not claim new preferences");
failWrite = false;
app.state.prompt = "Retry after canvas write failure";
failKey = "canvas";
await assert.rejects(() => store.flush(), /disk full/);
failKey = "";
await store.flush();
assert.equal((await store.loadCanvas()).prompt, "Retry after canvas write failure", "a failed canvas write must remain retryable instead of poisoning the save fingerprint");
// Generation must keep one physical request in flight, coalesce updates, and ignore dismissed results.
const pending = [], inputs = [], events = [], generationConfigs = [];
let composeOptions = null, visibleComposeOptions = null, composeMethod = "", maskCompositions = 0;
app.events.on("generation:done", value => events.push(value));
app.components.canvas = {
  composeInput: async options => { composeMethod = "image"; composeOptions = options; return "data:image/png;base64,x"; },
  composeVisibleInput: async options => { composeMethod = "visible"; visibleComposeOptions = options; return "data:image/png;base64,visible"; },
  imageDimensions: async () => ({ width: 1024, height: 1024 }),
  composeMask: () => { maskCompositions += 1; return "data:image/png;base64,mask"; }, hasMask: () => true
};
app.services.providers = { generate: (config, input) => { generationConfigs.push(config); inputs.push(input); return new Promise(resolve => pending.push(resolve)); } };
app.services.store.scheduleCanvasSave = () => {};
load("app/services/translate.js");
load("app/services/image-engine.js");
app.services.imageEngine.init(app.components.canvas);
await assert.rejects(() => app.services.imageEngine.internals.withDeadline(new Promise(() => {}), 5), /生成等待超时/);
assert.equal(app.services.imageEngine.internals.overallTimeout({ timeoutMs: 90000 }), 105000, "overall watchdog must outlive the provider deadline without allowing an infinite wait");
app.platform.hermit.messageChars = 200000;
Object.assign(app.config.quick, { endpoint: "http://192.168.124.31:8188", protocol: "cvp", model: "", inputMode: "sketch", width: 512, height: 512, steps: 8 });
app.state.prompt = "a fox";
const first = app.services.imageEngine.run("quick", false);
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(pending.length, 1, "Fast must submit one request once a prompt exists");
assert.equal(composeMethod, "image", "Fast must submit the actual canvas composition without rewriting its contrast or colors");
assert.deepEqual(JSON.parse(JSON.stringify(composeOptions)), { mime: "image/jpeg", quality: 0.92, maxBytes: 192000 }, "the reference image must be encoded as a JPEG that fits the host message budget");
assert.ok(composeOptions.maxBytes < app.platform.hermit.messageChars, "the reference image must leave the host message budget room for the mask and the RPC envelope");
assert.equal(inputs[0].seed, 73, "locked seed must be submitted unchanged");
assert.equal(inputs[0].colorStrength, 0.47, "the artwork color strength must reach the provider request unchanged");
assert.equal(maskCompositions, 0, "Fast without marks must not encode an unused mask");
app.state.prompt = "latest";
await app.services.imageEngine.run("quick", true);
await app.services.imageEngine.run("quick", true);
assert.equal(pending.length, 1);
pending.shift()({ src: "first" }); await first;
await new Promise(resolve => setTimeout(resolve, 85));
assert.equal(pending.length, 1, "multiple updates should coalesce to one next request");
app.services.imageEngine.cancel(); pending.shift()({ src: "ignored" });
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(events.length, 1, "dismissed result must not overwrite another artwork");
const afterCancel = app.services.imageEngine.run("quick", false);
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(pending.length, 1, "cancel must release the internal running lock even if the detached request has not settled");
pending.shift()({ src: "after-cancel" }); await afterCancel;
assert.equal(events.length, 2, "a new request after cancel must be able to complete normally");
// Local redraw compresses the reference into whatever the mask left of the
// transport budget; a reference that overshoots it would be dropped in silence.
app.state.maskMode = true;
app.state.localPrompt = "a golden crown";
app.state.prompt = "a fox holding a crown";
Object.assign(app.config.inpaint, { endpoint: "http://192.168.1.2:8188", protocol: "cvp", model: "", inputMode: "sketch", width: 512, height: 512, steps: 6 });
maskCompositions = 0;
const redraw = app.services.imageEngine.run("quick", false);
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(generationConfigs.at(-1).slot, "inpaint", "an active mask must switch Fast to the local-redraw task");
assert.equal(maskCompositions, 1, "local redraw must submit exactly one mask");
assert.equal(inputs.at(-1).maskDataUrl, "data:image/png;base64,mask");
assert.equal(composeMethod, "image", "local redraw must reference the canvas composition, not the visible snapshot");
assert.equal(composeOptions.maxBytes, app.platform.hermit.messageChars - ("data:image/png;base64,mask".length + 8000), "the mask must be subtracted from the reference image budget");
assert.ok(composeOptions.maxBytes + "data:image/png;base64,mask".length < app.platform.hermit.messageChars, "reference plus mask must stay inside one host message");
assert.equal(inputs.at(-1).localPrompt, undefined, "the local description must be submitted as the prompt instead of adding a field");
assert.equal(inputs.at(-1).prompt, "a golden crown", "a local redraw must submit the local description alone instead of joining the artwork-wide prompt");
pending.shift()({ src: "redraw" }); await redraw;
app.state.maskMode = false;
app.state.localPrompt = "";
Object.assign(app.config.upscale, { endpoint: "https://images.example.test/v1", protocol: "openai-images", model: "quality-model", inputMode: "text", width: 1024, height: 1024 });
const render = app.services.imageEngine.run("upscale", false);
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(composeMethod, "visible", "Render must submit the current visible canvas rather than the generation-mode composition");
assert.deepEqual(JSON.parse(JSON.stringify(visibleComposeOptions)), { mime: "image/jpeg", quality: 0.92, maxBytes: 192000, size: 1024 }, "Render must upload a budgeted JPEG of the visible canvas");
assert.equal(generationConfigs.at(-1).width, 1024); assert.equal(generationConfigs.at(-1).height, 1024); assert.equal(generationConfigs.at(-1).inputMode, "sketch");
assert.equal(inputs.at(-1).maskDataUrl, null); assert.equal(inputs.at(-1).openAiMaskDataUrl, null);
pending.shift()({ src: "render-1024" }); await render;
assert.equal(events.at(-1).slot, "upscale", "a validated render must be delivered as the upscale result");
// No checkpoint here carries a text encoder that reads Chinese, so the string
// that leaves is the English of the last saved prompt. The cache is a lookup:
// this path never asks the translator for anything, and an English prompt is
// handed over exactly as the user wrote it.
Object.assign(app.config.quick, { endpoint: "http://192.168.1.2:8188", protocol: "cvp", model: "", inputMode: "sketch", width: 512, height: 512, steps: 8 });
const translate = app.services.translate;
assert.ok(translate.hasCjk("一只蓝色的水晶鸟") && !translate.hasCjk("a fox in snow"), "only a prompt with CJK characters needs a translation");
translate.internals.cache["一只蓝色的水晶鸟"] = "a blue crystal bird";
translate.internals.cache["模糊、变形"] = "blurry, distorted";
app.state.prompt = "一只蓝色的水晶鸟"; app.state.negativePrompt = "模糊、变形";
const translatedRun = app.services.imageEngine.run("quick", false);
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(inputs.at(-1).prompt, "a blue crystal bird", "a Chinese prompt must be submitted as the English of its last translation");
assert.equal(inputs.at(-1).negativePrompt, "blurry, distorted", "the negative prompt must be translated as well");
pending.shift()({ src: "translated" }); await translatedRun;
app.state.prompt = "a fox in snow"; app.state.negativePrompt = "";
const englishRun = app.services.imageEngine.run("quick", false);
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(inputs.at(-1).prompt, "a fox in snow", "an English prompt must be submitted verbatim, never reworded");
pending.shift()({ src: "english" }); await englishRun;
const toasts = [];
app.components.ui = { toast: (message, type) => toasts.push([String(message), String(type || "")]) };
app.state.prompt = "一只还没译过的猫";
const untranslatedRun = app.services.imageEngine.run("quick", false);
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(inputs.at(-1).prompt, "一只还没译过的猫", "an untranslated prompt must still submit instead of blocking the user");
assert.equal(toasts.length, 1, "every drawing with Chinese in its prompt must warn once");
assert.match(toasts[0][0], /提示词只能使用英文,请检查翻译大模型设置/, "the warning must name the English-only rule and the settings that fix it");
assert.equal(toasts[0][1], "error", "the warning must be the error style rather than the success check mark");
pending.shift()({ src: "untranslated" }); await untranslatedRun;
app.state.prompt = "a fox again";
const quietRun = app.services.imageEngine.run("quick", false);
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(toasts.length, 1, "a drawing with an English prompt must not warn at all");
pending.shift()({ src: "quiet" }); await quietRun;
console.log("workspace.test.mjs: ok (64 KiB chunking, migration, history, restore, watchdog, cancel, generation queue, prompt translation)");
