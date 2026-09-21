import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = { console, Map, Set, WeakMap, setTimeout, clearTimeout };
context.window = context;
vm.createContext(context);
for (const name of ["app/core/namespace.js", "app/core/utils.js", "app/core/drawing.js"]) {
  vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name });
}
const app = context.vibedraw;
const largeImage = "data:image/jpeg;base64," + "a".repeat(500000);
const objects = Array.from({ length: 120 }, (_, objectIndex) => ({
  id: "stroke-" + objectIndex,
  type: "stroke",
  tool: "pencil",
  width: 6,
  opacity: 0.8,
  color: "#38a9e8",
  points: Array.from({ length: 200 }, (_, pointIndex) => ({ x: pointIndex * 3.4, y: (objectIndex * 7 + pointIndex) % 768 }))
}));
for (let imageIndex = 0; imageIndex < 3; imageIndex += 1) {
  objects.push({ id: "image-" + imageIndex, type: "image", x: imageIndex * 12, y: imageIndex * 12, width: 768, height: 768, src: largeImage });
}

function measure(operation, iterations) {
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) operation();
  return Math.round((performance.now() - start) * 100) / 100;
}

const iterations = 20;
const manualCloneMs = measure(() => app.drawing.cloneObjects(objects), iterations);
const jsonCloneMs = measure(() => JSON.parse(JSON.stringify(objects)), iterations);
const serialized = JSON.stringify({ objects });
const legacyChunks = app.utils.utf8Chunks(serialized, 18000).length;
const optimizedChunks = app.utils.utf8Chunks(serialized, 30000).length;
console.log(JSON.stringify({
  fixture: { objects: objects.length, points: 120 * 200, serializedBytes: app.utils.utf8Length(serialized), iterations },
  clone: { drawingCloneMs: manualCloneMs, jsonCloneMs },
  storage: { legacyChunks, optimizedChunks, reductionPercent: Math.round((1 - optimizedChunks / legacyChunks) * 1000) / 10 }
}, null, 2));
