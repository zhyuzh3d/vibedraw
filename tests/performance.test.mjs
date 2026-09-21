import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const frames = [];
const context = {
  console,
  Map,
  Set,
  WeakMap,
  setTimeout,
  clearTimeout,
  requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
  cancelAnimationFrame: () => {}
};
context.window = context;
vm.createContext(context);
function load(name) { vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name }); }
load("app/core/namespace.js"); load("app/core/utils.js"); load("app/core/runtime.js"); load("app/core/drawing.js");
const app = context.vibedraw;

const delivered = [];
const frameTask = app.runtime.createFrameTask(value => delivered.push(value));
for (let index = 0; index < 100; index += 1) frameTask.request(index);
assert.equal(frames.length, 1, "high-frequency work must schedule only one animation frame");
frames.shift()();
assert.deepEqual(delivered, [99], "the coalesced frame must receive the newest state");

const cache = app.runtime.createLru({ maxEntries: 2 });
cache.set("a", 1); cache.set("b", 2); cache.get("a"); cache.set("c", 3);
assert.equal(cache.has("a"), true); assert.equal(cache.has("b"), false); assert.equal(cache.has("c"), true);
assert.equal(cache.stats().entries, 2, "LRU cache must remain bounded");

const text = ("中文🙂\\\"/performance/".repeat(7000));
const chunks = app.utils.utf8Chunks(text, 30000);
assert.equal(chunks.join(""), text, "UTF-8 chunking must preserve Unicode and surrogate pairs");
assert.ok(chunks.every(value => app.utils.utf8Length(value) <= 30000), "each logical chunk must stay within its byte budget");
assert.ok(chunks.length < app.utils.utf8Chunks(text, 18000).length, "larger safe chunks must reduce Bridge record traffic");
assert.equal(app.utils.dataUrlByteLength("data:image/png;base64,YWJjZA=="), 4);

const source = [
  { id: "stroke", type: "stroke", width: 12, points: [{ x: 10, y: 20 }, { x: 50, y: 80 }], src: "data:image/png;base64,shared" },
  { id: "image", type: "image", x: 100, y: 120, width: 200, height: 160, src: "data:image/png;base64,shared", asset: { parts: ["file-1"] } }
];
const cloned = app.drawing.cloneObjects(source);
cloned[0].points[0].x = 999;
assert.equal(source[0].points[0].x, 10, "drawing clones must isolate mutable point arrays");
assert.equal(cloned[1].src, source[1].src, "immutable image strings must be reusable without byte decoding");
assert.deepEqual(JSON.parse(JSON.stringify(app.drawing.selectionBounds(source))), { x: -1, y: 9, width: 301, height: 271 });
const stored = app.drawing.storageObject(source[1]);
assert.equal("src" in stored, false); assert.deepEqual(JSON.parse(JSON.stringify(stored.asset)), { parts: ["file-1"] });
assert.ok(app.drawing.estimateWeight(source) > 0);

console.log("performance.test.mjs: ok (RAF coalescing, bounded LRU, UTF-8 chunks, drawing snapshots)");
