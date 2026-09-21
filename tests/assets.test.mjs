import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = { console, Map, Set, WeakMap, Uint8Array, URL, setTimeout, clearTimeout, btoa, atob };
context.window = context;
vm.createContext(context);
function load(name) { vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name }); }
load("app/core/namespace.js"); load("app/core/utils.js"); load("app/core/runtime.js"); load("app/core/i18n.js");

const files = new Map(), deleted = [];
let activeWrites = 0, maximumWrites = 0, writeCalls = 0, failPosition = -1;
const bridge = { files: {
  writeText: async ({ name, text }) => {
    const position = writeCalls++; activeWrites += 1; maximumWrites = Math.max(maximumWrites, activeWrites);
    await new Promise(resolve => setTimeout(resolve, 2)); activeWrites -= 1;
    if (position === failPosition) throw new Error("simulated file failure");
    const logicalFileId = "file-" + position + "-" + name; files.set(logicalFileId, text); return { logicalFileId };
  },
  readText: async ({ logicalFileId }) => ({ text: files.get(logicalFileId) }),
  delete: async ({ logicalFileId }) => { deleted.push(logicalFileId); files.delete(logicalFileId); return { deleted: true }; }
} };
context.vibedraw.platform.hermit = { current: () => bridge };
load("app/services/assets.js");
const assets = context.vibedraw.services.assets;

const source = "data:image/png;base64," + "A".repeat(900000);
const [first, duplicate] = await Promise.all([assets.persist(source), assets.persist(source)]);
assert.deepEqual(JSON.parse(JSON.stringify(first)), JSON.parse(JSON.stringify(duplicate)), "duplicate image persistence must share one in-flight operation");
assert.equal(first.parts.length, 5); assert.equal(writeCalls, 5); assert.equal(maximumWrites, 4, "file chunks must use bounded four-way concurrency");
assets.clearCache();
assert.equal(await assets.resolve(first), source, "parallel file reads must restore image chunks in original order");

const beforeFailure = new Set(files.keys());
failPosition = writeCalls + 1;
await assert.rejects(() => assets.persist("data:image/png;base64," + "B".repeat(800000)), /simulated file failure/);
const leaked = [...files.keys()].filter(id => !beforeFailure.has(id));
assert.deepEqual(leaked, [], "a partially failed parallel asset write must remove every successful sibling chunk");

assert.ok(assets.performance().cache.entries <= 10);
assert.equal(assets.performance().inFlight, 0);
console.log("assets.test.mjs: ok (coalesced persistence, bounded concurrency/cache, failure cleanup)");
