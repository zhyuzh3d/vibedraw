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
Object.assign(legacyConfig.quick, { protocol: "a1x-flux", endpoint: "http://192.168.124.31:8188", apiKey: "kept-secret", width: 256, height: 256, steps: 1, model: "flux2_klein_4b_distilled_nvfp4" });
Object.assign(legacyConfig.quality, { protocol: "a1x-flux", endpoint: "http://192.168.124.31:8188", apiKey: "kept-secret", width: 512, height: 512, steps: 4, model: "flux2_klein_4b_distilled_nvfp4" });
records.set("config", { value: legacyConfig, revision: "seed-config" });
await store.loadConfig();
assert.equal(app.config.schema, 6);
assert.equal(app.config.quick.protocol, "a1x-image");
assert.equal(app.config.quick.width, 512);
assert.equal(app.config.quick.steps, 4);
assert.equal(app.config.quick.model, "dreamshaper8_lcm_blended_img2img_sd15");
assert.equal(app.config.quick.guidanceScale, 2);
assert.equal(app.config.canvas.resultBrightness, 100, "global color defaults must be migrated into config");
assert.equal(app.config.quality.steps, 8);
assert.equal(app.config.quality.model, "flux2_klein_4b_base_nvfp4");
assert.equal(Object.prototype.hasOwnProperty.call(app.config.canvas, "overlayGenerate"), false, "overlay generation is an artwork setting and must not become a global default");
assert.equal(app.config.quick.apiKey, "kept-secret", "A1X migration must preserve the saved credential");
Object.assign(app.state, {
  prompt: "Original", objects: [{ id: "stroke-1", type: "stroke", points: Array.from({ length: 5000 }, (_, index) => ({ x: index % 768, y: Math.floor(index / 8) % 768 })) }, { id: "image-1", type: "image", src: "data:image/png;base64,abc", url: "data:image/png;base64,abc" }],
  autoDelayMs: 1320, strength: 1.35, colorStrength: 0.47, resultOpacity: 0.42, layerOpacity: 0.37, resultVisible: false, overlayGenerate: true, seed: 73, seedLocked: true, resultGlow: 38, resultClarity: 24, resultAdjustmentsEnabled: false,
  result: { src: "data:image/png;base64,result", slot: "quick", createdAt: 1, metadata: { data: "never persist" } }
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
load("app/services/image-engine.js");
app.services.imageEngine.init(app.components.canvas);
await assert.rejects(() => app.services.imageEngine.internals.withDeadline(new Promise(() => {}), 5), /生成等待超时/);
assert.equal(app.services.imageEngine.internals.overallTimeout({ timeoutMs: 90000 }), 105000, "overall watchdog must outlive the provider deadline without allowing an infinite wait");
Object.assign(app.config.quick, { endpoint: "http://192.168.124.31:8188", protocol: "a1x-image", model: "dreamshaper8_lcm_blended_img2img_sd15", inputMode: "sketch", width: 512, height: 512, steps: 4 });
app.state.prompt = "";
const first = app.services.imageEngine.run("quick", false);
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(pending.length, 1, "A1X must accept an optional blank prompt and ignore an unsupported local mask");
assert.equal(composeMethod, "image", "DreamShaper realtime must submit the actual canvas composition without rewriting its contrast or colors");
assert.deepEqual(JSON.parse(JSON.stringify(composeOptions)), { size: 512, mime: "image/jpeg", quality: 0.82, maxBytes: 512000 }, "A1X must receive the current 512 reference image on every request");
assert.equal(inputs[0].seed, 73, "locked seed must be submitted unchanged");
assert.equal(inputs[0].colorStrength, 0.47, "the artwork color strength must reach the provider request unchanged");
assert.equal(maskCompositions, 0, "A1X must not encode masks that its request contract does not consume");
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
Object.assign(app.config.quality, { endpoint: "https://images.example.test/v1", protocol: "openai-images", model: "quality-model", inputMode: "text", width: 512, height: 512 });
const render = app.services.imageEngine.run("quality", false);
await new Promise(resolve => setTimeout(resolve, 5));
assert.equal(composeMethod, "visible", "Render must submit the current visible canvas rather than the generation-mode composition");
assert.deepEqual(JSON.parse(JSON.stringify(visibleComposeOptions)), { size: 1024, mime: "image/png" });
assert.equal(generationConfigs.at(-1).width, 1024); assert.equal(generationConfigs.at(-1).height, 1024); assert.equal(generationConfigs.at(-1).inputMode, "sketch");
assert.equal(inputs.at(-1).maskDataUrl, null); assert.equal(inputs.at(-1).openAiMaskDataUrl, null);
pending.shift()({ src: "render-1024" }); await render;
assert.equal(events.at(-1).slot, "quality", "a validated render must be delivered as the quality result");
console.log("workspace.test.mjs: ok (64 KiB chunking, migration, history, restore, watchdog, cancel, generation queue)");
