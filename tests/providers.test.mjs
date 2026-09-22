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
assert.equal(internals.cvpTask({ slot: "inpaint" }), "inpaint");
assert.equal(internals.cvpTask({ task: "upscale", slot: "quick" }), "upscale");
assert.equal(internals.cvpTask({ slot: "unexpected" }), "quick");
assert.equal(internals.cvpStrength({ refStrength: 0.55 }, 0.8), 0.55);
assert.ok(Math.abs(internals.cvpStrength({ refStrength: 0.3 }, 0.4) - 0.15) < 1e-9, "half the artwork setting must halve the reference weight");
assert.equal(internals.cvpStrength({ refStrength: 0.55 }, 1.6), 0.95, "the reference weight must clamp at the maximum");
assert.equal(internals.aspect(1024, 1024), "1:1");
assert.equal(internals.aspect(1536, 768), "16:9");
assert.equal(internals.aspect(768, 1536), "9:16");

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

const cvpCalls = [];
let cvpPolls = 0;
context.vibedraw.platform.hermit.request = async options => {
  cvpCalls.push(options);
  if (options.method === "POST" && options.url.endsWith("/vibedraw/v1/jobs")) {
    return { status: 202, bodyText: JSON.stringify({ job: { id: "job_cvp", task: "inpaint", state: "queued", progress: 0, outputs: [] } }) };
  }
  if (/\/vibedraw\/v1\/jobs\/job_cvp$/.test(options.url)) {
    cvpPolls += 1;
    return { status: 200, bodyText: JSON.stringify({ job: cvpPolls === 1
      ? { id: "job_cvp", task: "inpaint", state: "running", progress: 0.4, outputs: [] }
      : { id: "job_cvp", task: "inpaint", state: "completed", progress: 1, outputs: [{ filename: "inpaint_00001_.png", subfolder: "vibedraw", type: "output", url: "/vibedraw/v1/jobs/job_cvp/output/0" }] } }) };
  }
  if (options.url.endsWith("/vibedraw/v1/jobs/job_cvp/output/0")) return { status: 200, headers: { "Content-Type": "image/png" }, bodyBase64: "YWJj" };
  throw new Error("unexpected CVP request " + options.url);
};
const cvpResult = await context.vibedraw.services.providers.generate({
  slot: "inpaint", task: "inpaint", protocol: "cvp", endpoint: "http://192.168.1.2:8188/vibedraw/v1",
  apiKey: "cvp-secret", model: "", inputMode: "sketch", width: 512, height: 512, steps: 6,
  refStrength: 0.55, growMaskBy: 12, timeoutMs: 30000, customHeaders: ""
}, {
  prompt: "a golden crown", negativePrompt: "blur", seed: 42, strength: 0.8,
  imageDataUrl: "data:image/png;base64,YWJj", maskDataUrl: "data:image/png;base64,ZEZn"
});
assert.equal(cvpResult.src, "data:image/png;base64,YWJj");
assert.equal(cvpCalls[0].headers.Authorization, "Bearer cvp-secret", "the CVP password must travel as a bearer token");
const cvpSubmission = JSON.parse(cvpCalls.find(call => call.method === "POST").bodyText);
assert.equal(cvpSubmission.task, "inpaint");
assert.deepEqual(JSON.parse(JSON.stringify(cvpSubmission.size)), [512, 512]);
assert.equal(cvpSubmission.steps, 6);
assert.equal(cvpSubmission.ref_strength, 0.55, "the artwork slider at 80% must keep the per-task reference weight");
assert.equal(cvpSubmission.image_base64, "data:image/png;base64,YWJj");
assert.equal(cvpSubmission.mask_base64, "data:image/png;base64,ZEZn");
assert.equal(cvpSubmission.grow_mask_by, 12);
assert.equal("workflow" in cvpSubmission, false, "the plugin ships its own graphs, so no workflow is ever uploaded");
assert.match(cvpCalls.find(call => call.url.includes("/vibedraw/v1/jobs/job_cvp")).url, /job_cvp$/);

cvpCalls.length = 0;
await context.vibedraw.services.providers.generate({
  slot: "quick", task: "quick", protocol: "cvp", endpoint: "http://192.168.1.2:8188", apiKey: "",
  width: 512, height: 512, steps: 8, refStrength: 0.55, timeoutMs: 30000, customHeaders: ""
}, { prompt: "a fox", negativePrompt: "", seed: 1, strength: 1.6, imageDataUrl: "data:image/png;base64,YWJj" });
const quickSubmission = JSON.parse(cvpCalls.find(call => call.method === "POST").bodyText);
assert.equal(quickSubmission.task, "quick");
assert.equal(quickSubmission.ref_strength, 0.95, "a stronger artwork setting must raise fidelity and clamp at the maximum");
assert.equal("mask_base64" in quickSubmission, false, "quick draw never sends a mask");

context.vibedraw.platform.hermit.request = async () => ({ status: 401, bodyText: JSON.stringify({ error: "unauthorized", message: "bad password" }) });
await assert.rejects(() => context.vibedraw.services.providers.generate({
  slot: "quick", task: "quick", protocol: "cvp", endpoint: "http://192.168.1.2:8188", apiKey: "wrong",
  width: 512, height: 512, steps: 8, refStrength: 0.55, timeoutMs: 30000, customHeaders: ""
}, { prompt: "a fox", negativePrompt: "", seed: 1, strength: 0.8, imageDataUrl: "data:image/png;base64,YWJj" }), /访问密码不正确/, "a wrong password must surface as a readable password error");

console.log("providers.test.mjs: ok");
