import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// The gallery card is drawn from the artwork's cover: the last generated picture, held
// as a reference into Hermit's file store. Two things can silently lose it, and this
// test pins both: filing the picture has to happen when it arrives (not only at the next
// autosave), and cleanup has to treat the cover as a reference, or the card's chunks are
// reclaimed the first time anything else about the artwork changes.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = { console, Map, Set, WeakMap, Uint8Array, URL, setTimeout, clearTimeout, btoa, atob };
context.window = context;
vm.createContext(context);
function load(name) { vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name }); }
load("app/core/namespace.js"); load("app/core/utils.js"); load("app/core/runtime.js"); load("app/core/i18n.js");

const files = new Map(), deleted = [];
let failWrites = false;
const bridge = { files: {
  writeText: async ({ name, text }) => {
    if (failWrites) throw new Error("simulated file failure");
    const logicalFileId = "cover-" + (files.size + 1) + "-" + name;
    files.set(logicalFileId, text); return { logicalFileId };
  },
  readText: async ({ logicalFileId }) => ({ text: files.get(logicalFileId) }),
  delete: async ({ logicalFileId }) => { deleted.push(logicalFileId); files.delete(logicalFileId); return { deleted: true }; }
} };
context.vibedraw.platform.hermit = { current: () => bridge };
load("app/services/assets.js");
const assets = context.vibedraw.services.assets;
const plain = value => JSON.parse(JSON.stringify(value));

const picture = { src: "data:image/png;base64," + "A".repeat(400000), logicalFileId: "", slot: "quick", createdAt: 7 };
const cover = await assets.coverFrom(picture);
assert.ok(cover && cover.asset && cover.asset.parts.length === 3, "a generated picture must be filed the moment it arrives, not on the next autosave");
assert.equal(cover.createdAt, 7, "the cover must keep the moment its picture was generated");
assert.deepEqual(picture.asset, cover.asset, "the picture itself must carry the reference so the result shares one filing rather than writing the bytes twice");
assert.equal(await assets.resolve(cover.asset), picture.src, "the filed cover must be readable back as the picture");

const snapshot = { workId: "w1", objects: [], result: null, render: null, cover: cover };
const coverParts = cover.asset.parts.slice();
assert.deepEqual(assets.references(snapshot).sort(), coverParts.slice().sort(), "the cover's chunks must count as references of the artwork");

deleted.length = 0;
await assets.cleanup({ workId: "w0", objects: [], result: { asset: cover.asset, logicalFileId: "" }, render: null, cover: cover }, [snapshot]);
assert.deepEqual(deleted, [], "a surviving artwork's cover must keep its chunks when the references around it change");
await assets.cleanup({ workId: "w0", objects: [], result: null, render: null, cover: cover }, []);
assert.deepEqual(Array.from(deleted).sort(), Array.from(coverParts).sort(), "nothing is leaked either: a cover no surviving artwork shows is reclaimed");

const hosted = await assets.coverFrom({ src: "https://example.test/picture.png", logicalFileId: "lf-1", createdAt: 3 });
assert.deepEqual(plain(hosted), { asset: { url: "https://example.test/picture.png" }, logicalFileId: "lf-1", createdAt: 3 }, "a picture the model already filed must be reused rather than written again");

failWrites = true;
assert.equal(await assets.coverFrom({ src: "data:image/png;base64," + "B".repeat(400000), logicalFileId: "", createdAt: 4 }), null,
  "a filing failure must not hand back a reference that points at nothing; the caller keeps the previous cover instead of losing the card's image");
failWrites = false;
assert.equal(await assets.coverFrom(null), null, "no picture means no cover");
console.log("cover.test.mjs: ok (cover filed on arrival, referenced by the artwork, reclaimed only when nothing shows it)");
