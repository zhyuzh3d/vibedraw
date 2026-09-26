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
assert.equal(internals.cvpBase("http://192.168.1.2:8188"), "http://192.168.1.2:8188");
assert.equal(internals.cvpBase("http://192.168.1.2:8188/vibedraw/v1"), "http://192.168.1.2:8188");
assert.equal(internals.cvpBase("http://192.168.1.2:8188/vibedraw/v1/jobs"), "http://192.168.1.2:8188");
assert.equal(internals.cvpBase("http://192.168.1.2:8188/cvp"), "http://192.168.1.2:8188");
assert.equal(internals.cvpBase("http://192.168.1.2:8188/cvp/jobs"), "http://192.168.1.2:8188");
assert.equal(internals.cvpBase("http://cvp-host.local:8188"), "http://cvp-host.local:8188", "a hostname that merely starts with cvp must survive");
assert.equal(internals.cvpTask({ slot: "inpaint" }), "inpaint");
assert.equal(internals.cvpTask({ capability: "upscale", slot: "quick" }), "upscale", "the capability field wins over the slot");
assert.equal(internals.cvpTask({ task: "upscale", slot: "quick" }), "upscale");
assert.equal(internals.cvpTask({ slot: "unexpected" }), "quick");
assert.equal(internals.cvpStrength({ refStrength: 0.55 }, 0.8), 0.55);
assert.ok(Math.abs(internals.cvpStrength({ refStrength: 0.3 }, 0.4) - 0.15) < 1e-9, "half the artwork setting must halve the reference weight");
assert.equal(internals.cvpStrength({ refStrength: 0.55 }, 1.6), 0.95, "the reference weight must clamp at the maximum");
assert.equal(internals.aspect(1024, 1024), "1:1");
assert.equal(internals.aspect(1536, 768), "16:9");
assert.equal(internals.aspect(768, 1536), "9:16");

// The one document the plugin publishes about itself. Everything the client
// knows about a capability — its sizes, its defaults, whether a model needs
// English, which fields do nothing — is read from here rather than assumed.
const infoDocument = {
  spec: "cvp/1",
  plugin: { id: "vibedraw_comfy", version: "2.2.0", label: { zh: "ComfyUI VibeDraw 插件", en: "ComfyUI VibeDraw Plugin" } },
  auth: { required: true, authorized: true, scheme: "Bearer", header: "Authorization" },
  endpoints: { info: "/cvp/info", jobs: "/cvp/jobs" },
  capabilities: [
    { id: "quick", aliases: [], prompt: { language: "en" }, ready: true, ignores: [],
      values: { size: [[512, 512]], steps: [2, 4, 6, 8] }, defaults: { size: [512, 512], steps: 8, ref_strength: 0.55 },
      models: [{ role: "checkpoint", name: "DreamShaper8_LCM.safetensors", ready: true }] },
    { id: "upscale", aliases: [], prompt: { language: "en" }, ready: true, ignores: [],
      values: { size: [[1024, 1024], [2048, 2048]], steps: [4, 8, 12, 16, 20] }, defaults: { size: [1024, 1024], steps: 8, ref_strength: 0.75 }, models: [] },
    { id: "render", aliases: ["qwen"], prompt: { language: "any" }, ready: true, ignores: ["negative_prompt"],
      values: { size: [[1024, 1024]], steps: [20] }, defaults: { size: [1024, 1024], steps: 20, ref_strength: 0.95 }, models: [] }
  ]
};
internals.cvpRemember(infoDocument);
assert.equal(internals.cvpCapability("render").prompt.language, "any", "a capability that reads Chinese must say so");
assert.equal(internals.cvpCapability("qwen").id, "render", "a capability must be found through its alias too");
assert.deepEqual(JSON.parse(JSON.stringify(internals.cvpSizes("upscale"))), [1024, 2048], "the sizes the plugin accepts must come from the document");
assert.deepEqual(JSON.parse(JSON.stringify(internals.cvpSizes("render"))), [1024]);
assert.equal(internals.cvpSizes("inpaint").length, 0, "an unknown capability offers nothing rather than a guess");
assert.equal(internals.cvpIgnores("render", "negative_prompt"), true);
assert.equal(internals.cvpIgnores("quick", "negative_prompt"), false);

const image = internals.jsonImage({ data: [{ b64_json: "YWJj" }], output_format: "png" });
assert.equal(image.src, "data:image/png;base64,YWJj");

const body = utils.multipart({ prompt: "hello" }, [{ name: "image", filename: "x.png", mime: "image/png", bytes: new Uint8Array([1, 2, 3]) }]);
assert.match(body.contentType, /^multipart\/form-data; boundary=----VibeDraw/);
assert.ok(body.bytes.length > 80);

assert.equal(utils.validateEndpoint("http://192.168.1.9:7860"), "http://192.168.1.9:7860/");
assert.throws(() => utils.validateEndpoint("http://example.com/api"), /公网服务必须使用 HTTPS/);
assert.throws(() => utils.parseHeaders('["not-object"]'), /JSON 对象/);

utils.sleep = async () => {};
context.vibedraw.platform.hermit.httpError = (_response, payload) => new Error(payload?.error || "http error");

// Testing the connection reads the public information document, which is what
// answers address, password, capability and model in one call. It answers 200
// even with the wrong password — auth.authorized is what says which it was —
// so the mock does the same thing the plugin does.
context.vibedraw.platform.hermit.request = async options => {
  if (!options.url.endsWith("/cvp/info")) throw new Error("unexpected request " + options.url);
  const document = JSON.parse(JSON.stringify(infoDocument));
  document.auth.authorized = String(options.headers.Authorization || "") === "Bearer cvp-secret";
  return { status: 200, bodyText: JSON.stringify(document) };
};
const cvpTest = await context.vibedraw.services.providers.test({
  slot: "quick", protocol: "cvp", endpoint: "http://192.168.1.2:8188/cvp", apiKey: "cvp-secret",
  width: 512, height: 512, timeoutMs: 30000, customHeaders: ""
});
assert.equal(cvpTest.spec, "cvp/1");
assert.equal(cvpTest.capability, "quick");
assert.equal(cvpTest.promptLanguage, "en", "the card must read whether this capability needs English");
assert.deepEqual(JSON.parse(JSON.stringify(cvpTest.sizes)), [512]);
assert.equal(cvpTest.authorized, true);
await assert.rejects(() => context.vibedraw.services.providers.test({
  slot: "quick", protocol: "cvp", endpoint: "http://192.168.1.2:8188", apiKey: "wrong",
  width: 512, height: 512, timeoutMs: 30000, customHeaders: ""
}), /访问密码不正确/, "a wrong password must be told apart from a wrong address");

const cvpCalls = [];
let cvpPolls = 0;
context.vibedraw.platform.hermit.request = async options => {
  cvpCalls.push(options);
  if (options.method === "POST" && options.url.endsWith("/cvp/jobs")) {
    return { status: 202, bodyText: JSON.stringify({ job: { id: "job_cvp", capability: "inpaint", state: "queued", queue_position: 0, progress: null, outputs: [] } }) };
  }
  if (/\/cvp\/jobs\/job_cvp\/progress$/.test(options.url)) {
    cvpPolls += 1;
    return { status: 200, bodyText: JSON.stringify({ job: { id: "job_cvp", state: cvpPolls === 1 ? "running" : "completed", queue_position: cvpPolls === 1 ? 2 : null, progress: null } }) };
  }
  if (/\/cvp\/jobs\/job_cvp$/.test(options.url)) {
    return { status: 200, bodyText: JSON.stringify({ job: {
      id: "job_cvp", capability: "inpaint", state: "completed", queue_position: null, progress: null,
      prompt: "a golden crown", prompt_source: "a golden crown", translated: false, ignored: [],
      outputs: [{ index: 0, filename: "inpaint_00001_.png", subfolder: "vibedraw", type: "output", media_type: "image/png", url: "/cvp/jobs/job_cvp/output/0" }]
    } }) };
  }
  if (options.url.endsWith("/cvp/jobs/job_cvp/output/0")) return { status: 200, headers: { "Content-Type": "image/png" }, bodyBase64: "YWJj" };
  throw new Error("unexpected CVP request " + options.url);
};
const cvpResult = await context.vibedraw.services.providers.generate({
  slot: "inpaint", task: "inpaint", capability: "inpaint", protocol: "cvp", endpoint: "http://192.168.1.2:8188/cvp",
  apiKey: "cvp-secret", model: "", inputMode: "sketch", width: 512, height: 512, steps: 6,
  refStrength: 0.55, growMaskBy: 12, timeoutMs: 30000, customHeaders: ""
}, {
  prompt: "a golden crown", negativePrompt: "blur", seed: 42, strength: 0.8,
  imageDataUrl: "data:image/png;base64,YWJj", maskDataUrl: "data:image/png;base64,ZEZn"
});
assert.equal(cvpResult.src, "data:image/png;base64,YWJj");
assert.equal(cvpCalls[0].headers.Authorization, "Bearer cvp-secret", "the CVP password must travel as a bearer token");
const cvpSubmission = JSON.parse(cvpCalls.find(call => call.method === "POST").bodyText);
assert.equal(cvpSubmission.capability, "inpaint", "a job must name the capability, not a model");
assert.equal("task" in cvpSubmission, false, "the retired task field must not be sent");
assert.deepEqual(JSON.parse(JSON.stringify(cvpSubmission.size)), [512, 512]);
assert.equal(cvpSubmission.steps, 6);
assert.equal(cvpSubmission.ref_strength, 0.55, "the artwork slider at 80% must keep the per-capability reference weight");
assert.equal(cvpSubmission.negative_prompt, "blur", "a capability that keeps the negative prompt must be sent it");
assert.equal(cvpSubmission.image_base64, "data:image/png;base64,YWJj");
assert.equal(cvpSubmission.mask_base64, "data:image/png;base64,ZEZn");
assert.equal(cvpSubmission.grow_mask_by, 12);
assert.equal("workflow" in cvpSubmission, false, "the plugin ships its own graphs, so no workflow is ever uploaded");
// Waiting is two calls, not one: the light one is polled and carries no
// results to parse, and the full one is read exactly once, at the end.
assert.equal(cvpPolls, 2);
assert.ok(cvpCalls.filter(call => /\/progress$/.test(call.url)).length === 2, "the wait must poll the progress endpoint");
assert.equal(cvpCalls.filter(call => /\/cvp\/jobs\/job_cvp$/.test(call.url)).length, 1, "the full status must be read once, after the light call reported completion");

// A capability that declares a field ignored is not sent it: the user would
// otherwise believe a control worked on a model that never reads it. Which
// fields those are is read from the document every time, never hard-coded, so a
// plugin that one day declares it for quick draw is obeyed with no new client.
cvpCalls.length = 0; cvpPolls = 0;
const ignoresDocument = JSON.parse(JSON.stringify(infoDocument));
ignoresDocument.capabilities.filter(item => item.id === "quick")[0].ignores = ["negative_prompt"];
internals.cvpRemember(ignoresDocument);
await context.vibedraw.services.providers.generate({
  slot: "quick", capability: "quick", protocol: "cvp", endpoint: "http://192.168.1.2:8188", apiKey: "",
  width: 512, height: 512, steps: 8, refStrength: 0.55, timeoutMs: 30000, customHeaders: ""
}, { prompt: "一只猫", negativePrompt: "blur", seed: 1, strength: 0.8, imageDataUrl: "data:image/png;base64,YWJj" });
const ignoredSubmission = JSON.parse(cvpCalls.find(call => call.method === "POST").bodyText);
assert.equal(ignoredSubmission.capability, "quick");
assert.equal("negative_prompt" in ignoredSubmission, false, "a capability that ignores the negative prompt must not be sent one");
assert.equal(ignoredSubmission.prompt, "一只猫", "the prompt must travel exactly as written; translating it is the plugin's job");
internals.cvpRemember(infoDocument);

cvpCalls.length = 0; cvpPolls = 0;
await context.vibedraw.services.providers.generate({
  slot: "quick", task: "quick", protocol: "cvp", endpoint: "http://192.168.1.2:8188", apiKey: "",
  width: 512, height: 512, steps: 8, refStrength: 0.55, timeoutMs: 30000, customHeaders: ""
}, { prompt: "a fox", negativePrompt: "", seed: 1, strength: 1.6, imageDataUrl: "data:image/png;base64,YWJj" });
const quickSubmission = JSON.parse(cvpCalls.find(call => call.method === "POST").bodyText);
assert.equal(quickSubmission.capability, "quick");
assert.equal(quickSubmission.ref_strength, 0.95, "a stronger artwork setting must raise fidelity and clamp at the maximum");
assert.equal("mask_base64" in quickSubmission, false, "quick draw never sends a mask");

context.vibedraw.platform.hermit.request = async () => ({ status: 401, bodyText: JSON.stringify({ error: "unauthorized", message: "bad password" }) });
await assert.rejects(() => context.vibedraw.services.providers.generate({
  slot: "quick", task: "quick", protocol: "cvp", endpoint: "http://192.168.1.2:8188", apiKey: "wrong",
  width: 512, height: 512, steps: 8, refStrength: 0.55, timeoutMs: 30000, customHeaders: ""
}, { prompt: "a fox", negativePrompt: "", seed: 1, strength: 0.8, imageDataUrl: "data:image/png;base64,YWJj" }), /访问密码不正确/, "a wrong password must surface as a readable password error");

console.log("providers.test.mjs: ok");
