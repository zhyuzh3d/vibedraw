import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = {
  console,
  URL,
  Uint8Array,
  TextEncoder,
  setTimeout,
  clearTimeout,
  atob: value => Buffer.from(value, "base64").toString("binary"),
  btoa: value => Buffer.from(value, "binary").toString("base64")
};
context.window = context;
context.window.addEventListener = () => {};
vm.createContext(context);

function load(relative) {
  vm.runInContext(fs.readFileSync(path.join(root, relative), "utf8"), context, { filename: relative });
}

load("app/core/namespace.js");
load("app/core/utils.js");
context.vibedraw.platform.hermit = {};
load("app/services/providers.js");

const utils = context.vibedraw.utils;
const internals = context.vibedraw.services.providers.internals;

assert.equal(internals.openAiRoot("https://api.openai.com/v1/images/edits"), "https://api.openai.com/v1");
assert.equal(internals.comfyRoot("http://192.168.1.2:8188/prompt"), "http://192.168.1.2:8188");
assert.equal(internals.a1xRoot("http://192.168.124.31:8188/api/a1x-h3/v2/jobs"), "http://192.168.124.31:8188");
assert.equal(internals.aspect(1024, 1024), "1:1");
assert.equal(internals.aspect(1536, 768), "16:9");
assert.equal(internals.aspect(768, 1536), "9:16");

const replaced = internals.replaceWorkflow({
  "1": { inputs: { text: "{{prompt}}", seed: "{{seed}}", note: "size={{width}}x{{height}}" } }
}, { "{{prompt}}": "蓝色冰雕", "{{seed}}": 42, "{{width}}": 512, "{{height}}": 512 });
assert.equal(replaced["1"].inputs.text, "蓝色冰雕");
assert.equal(replaced["1"].inputs.seed, 42);
assert.equal(replaced["1"].inputs.note, "size=512x512");

const image = internals.jsonImage({ data: [{ b64_json: "YWJj" }], output_format: "png" });
assert.equal(image.src, "data:image/png;base64,YWJj");

const body = utils.multipart({ prompt: "hello" }, [{ name: "image", filename: "x.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }]);
assert.match(body.contentType, /^multipart\/form-data; boundary=----VibeDraw/);
assert.ok(body.bytes.length > 80);

assert.equal(utils.validateEndpoint("http://192.168.1.9:7860"), "http://192.168.1.9:7860/");
assert.throws(() => utils.validateEndpoint("http://example.com/api"), /公网服务必须使用 HTTPS/);
assert.throws(() => utils.parseHeaders('["not-object"]'), /JSON 对象/);

const a1xPayload = internals.a1xPayload({ slot: "quick", model: "dreamshaper8_lcm_blended_img2img_sd15", width: 512, steps: 4, guidanceScale: 2 }, {
  prompt: "蓝色冰雕", negativePrompt: "文字", seed: 73, strength: 0.8, colorStrength: 0.3
}, "asset_ref");
assert.equal(a1xPayload.engine_profile, "dreamshaper8_lcm_blended_img2img_sd15");
assert.deepEqual(JSON.parse(JSON.stringify(a1xPayload.output)), { aspect_ratio: "1:1", resolution_tier: "compact512" });
assert.deepEqual(JSON.parse(JSON.stringify(a1xPayload.inputs.image_references)), ["asset_ref"]);
assert.equal("reference_megapixels" in a1xPayload, false);
assert.equal(a1xPayload.reference_strength, 0.53);
assert.equal(a1xPayload.input_blur_radius, 3);
assert.equal(a1xPayload.input_blur_sigma, 1.2);
assert.equal(a1xPayload.input_blur_mix, 0.25);
assert.equal("color_strength" in a1xPayload, false);
assert.equal("scribble_preprocessor" in a1xPayload, false);
assert.equal(a1xPayload.guidance_scale, 2);
assert.equal(a1xPayload.sampling_steps, 4);
const a1xQuality = internals.a1xPayload({ slot: "quality", model: "flux2_klein_4b_base_nvfp4", width: 1024, steps: 8 }, {
  prompt: "", negativePrompt: "", seed: -1, strength: 0.9
}, "asset_ref");
assert.equal(a1xQuality.engine_profile, "flux2_klein_4b_base_nvfp4");
assert.equal(a1xQuality.sampling_steps, 8);
assert.deepEqual(JSON.parse(JSON.stringify(a1xQuality.output)), { aspect_ratio: "1:1", resolution_tier: "standard1024" });
assert.equal(a1xQuality.reference_megapixels, 1);
assert.ok(a1xQuality.prompt.length > 0, "blank optional UI prompt must use an internal neutral A1X fallback");

const calls = [];
utils.sleep = async () => {};
let retryAttempts = 0;
const recovered = await internals.a1xRetry(() => {
  retryAttempts += 1;
  return retryAttempts === 1 ? new Promise(() => {}) : Promise.resolve("recovered");
}, "create", 5, 2);
assert.equal(recovered, "recovered");
assert.equal(retryAttempts, 2, "a hung A1X bridge request must be retried once");
context.vibedraw.platform.hermit.request = async options => {
  calls.push(options);
  if (options.url.includes("/assets?")) return { status: 201, bodyText: JSON.stringify({ asset_id: "asset_test" }) };
  if (options.url.includes("/files?")) return { status: 200, headers: { "Content-Type": "image/png" }, bodyBase64: "YWJj" };
  throw new Error("unexpected request " + options.url);
};
context.vibedraw.platform.hermit.requestJson = async options => {
  calls.push(options);
  if (options.method === "POST") return { data: { job_id: "job_test", state: "queued" } };
  return { data: { job_id: "job_test", state: "succeeded", outputs: [{ url: "/api/a1x-h3/v2/files?filename=test.png&type=output" }] } };
};
context.vibedraw.platform.hermit.httpError = (_response, payload) => new Error(payload?.error || "http error");
const generated = await context.vibedraw.services.providers.generate({
  slot: "quick", protocol: "a1x-image", endpoint: "http://192.168.124.31:8188", apiKey: "test-only",
  model: "dreamshaper8_lcm_blended_img2img_sd15", inputMode: "sketch", width: 512, height: 512, steps: 4, guidanceScale: 2,
  timeoutMs: 30000, customHeaders: ""
}, { prompt: "蓝色冰雕", negativePrompt: "", seed: 7, strength: 0.8, colorStrength: 0.3, imageDataUrl: "data:image/png;base64,YWJj" });
assert.equal(generated.src, "data:image/png;base64,YWJj");
assert.equal(calls[0].headers.Authorization, "Bearer test-only");
const submitted = JSON.parse(calls.find(call => call.method === "POST" && call.url.endsWith("/jobs")).bodyText);
assert.equal(submitted.engine_profile, "dreamshaper8_lcm_blended_img2img_sd15");
assert.equal("reference_megapixels" in submitted, false);
assert.equal(submitted.reference_strength, 0.53);
assert.equal(submitted.input_blur_radius, 3);
assert.equal(submitted.input_blur_sigma, 1.2);
assert.equal(submitted.input_blur_mix, 0.25);
assert.equal("color_strength" in submitted, false);
assert.equal("scribble_preprocessor" in submitted, false);
assert.equal(submitted.guidance_scale, 2);
assert.equal(submitted.output.resolution_tier, "compact512");
assert.equal(submitted.seed, 7);

const strongColor = internals.a1xPayload({ slot: "quick", model: "dreamshaper8_lcm_blended_img2img_sd15", width: 512, steps: 8, guidanceScale: 2 }, {
  prompt: "portrait", negativePrompt: "", seed: 9, strength: 1.2, colorStrength: 0.65
}, "asset_ref");
assert.equal(strongColor.reference_strength, 0.27, "120% sketch preservation must map to lower img2img denoise");
assert.equal("color_strength" in strongColor, false, "the single-path experiment must not send a separate color channel");

console.log("providers.test.mjs: ok");
