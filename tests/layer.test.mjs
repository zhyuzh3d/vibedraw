import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

// Layering is pure array order, so it can be proved here without a browser: canvas.js only
// touches the DOM inside init(), and render() short-circuits while there is no context.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const context = { console, Map, Set, WeakMap, Promise, setTimeout, clearTimeout, Uint8Array, TextEncoder };
context.window = context;
vm.createContext(context);
function load(name) { vm.runInContext(fs.readFileSync(path.join(root, name), "utf8"), context, { filename: name }); }
["app/core/namespace.js", "app/core/utils.js", "app/core/runtime.js", "app/core/drawing.js"].forEach(load);

const app = context.vibedraw;
let scheduleCalls = 0, saveCalls = 0;
app.services.imageEngine = { schedule: () => { scheduleCalls += 1; } };
app.services.store = { scheduleCanvasSave: () => { saveCalls += 1; } };
load("app/components/canvas.js");
const canvas = app.components.canvas;

// Earlier in the array means further back: an entry paints over the ones before it.
const order = () => app.state.objects.map(object => object.id).join(",");
const stroke = (id, groupId) => {
  const object = { id, type: "stroke", color: "#111111", width: 8, points: [{ x: 0, y: 0 }, { x: 10, y: 10 }] };
  if (groupId) object.groupId = groupId;
  return object;
};
// `selectedIds` is exactly what tapping a member produces: setSelection expands the tap to
// every member of that group, so a group always reaches moveLayer as all of its members.
function scene(objects, selectedIds) {
  app.state.objects = objects;
  app.state.result = null;
  app.state.history = [];
  app.state.future = [];
  app.state.selectedIds = selectedIds.slice();
  app.state.selectedId = selectedIds.length ? selectedIds[selectedIds.length - 1] : "";
  return order();
}
function step(direction) { canvas.moveLayer(direction); return order(); }

// 1. A single object still behaves exactly as before.
scene([stroke("a"), stroke("b"), stroke("c")], ["b"]);
assert.equal(step(1), "a,c,b", "one object must still step one layer forward");
assert.equal(step(-1), "a,b,c", "and one layer back again");

// 2. The case the old guard refused outright: a two-object group. `selectionIds().length
//    !== 1` used to return before touching the array, so both buttons were dead on a group.
scene([stroke("a"), stroke("g1", "g"), stroke("g2", "g"), stroke("b")], ["g1", "g2"]);
assert.equal(step(1), "a,b,g1,g2", "a contiguous group must pass the object above it as one block");

// 3. At the front there is nowhere left to go, and pressing again must change nothing.
const front = order();
assert.equal(step(1), front, "a group already in front must not move");
assert.equal(app.state.history.length, 1, "a move that changes nothing must not add an undo step");

// 4. Members are not required to sit next to each other in the array: the block still
//    advances exactly one layer and never leapfrogs its own members.
scene([stroke("a"), stroke("g1", "g"), stroke("b"), stroke("g2", "g")], ["g1", "g2"]);
assert.equal(step(1), "a,b,g1,g2", "a scattered group must still close up and advance as one block");

// 5. Moving back is the mirror image, and internal order survives it.
scene([stroke("a"), stroke("g1", "g"), stroke("g2", "g")], ["g1", "g2"]);
assert.equal(step(-1), "g1,g2,a", "a group must pass the object below it as one block");
scene([stroke("g1", "g"), stroke("g2", "g"), stroke("a")], ["g1", "g2"]);
assert.equal(step(-1), "g1,g2,a", "a group already behind everything must not move");

// 6. Selecting two unrelated objects (no group) layers both, each by one step. The old
//    code could only ever move the single object whose id happened to be selectedId.
scene([stroke("a"), stroke("b"), stroke("c")], ["a", "c"]);
assert.equal(step(1), "b,a,c", "every selected object must advance one step where the room allows");

// 7. The move must reach the journal, not just the live array: one undo step whose stored
//    order equals what is on screen is the difference between "moved" and "moved for good".
scene([stroke("a"), stroke("g1", "g"), stroke("g2", "g"), stroke("b")], ["g1", "g2"]);
const before = app.state.history.length;
step(1);
assert.equal(app.state.history.length, before + 1, "a real move must journal exactly one undo step");
assert.equal(app.state.history[app.state.history.length - 1].objects.map(object => object.id).join(","), order(),
  "the journalled order must match the order on screen");
assert.equal(app.state.history[app.state.history.length - 1]._kind, "canvas", "a layer move is a canvas edit, not a result step");

// 8. An empty selection is a no-op rather than a crash.
scene([stroke("a")], []);
assert.equal(step(1), "a", "layering with nothing selected must do nothing");
assert.equal(app.state.history.length, 0, "and must not journal anything");

// 9. The arrows are driven by the same predicate the mutator obeys, so a live arrow is never
//    a dud. Both directions are checked: "dead at the front" would also pass if the
//    predicate were simply stuck at false, so the same question must come back true again
//    once the block steps away from the front.
scene([stroke("a"), stroke("g1", "g"), stroke("g2", "g"), stroke("b")], ["g1", "g2"]);
assert.equal(canvas.canMoveLayer(1), true, "a group with an object above it must offer forward");
assert.equal(canvas.canMoveLayer(-1), true, "and with one below it, backward as well");
step(1); step(1);
assert.equal(order(), "a,b,g1,g2", "the group ends up in front");
assert.equal(canvas.canMoveLayer(1), false, "in front of everything the forward arrow must be dead");
assert.equal(step(1), "a,b,g1,g2", "and the mutator must agree with that by moving nothing");
assert.equal(canvas.canMoveLayer(-1), true, "while backward still has somewhere to go");
step(-1);
assert.equal(canvas.canMoveLayer(1), true, "stepping back must revive the forward arrow, so the answer tracks the real order rather than staying stuck");

// 10. A lone object keeps the old front/back arming exactly as it was.
scene([stroke("a")], ["a"]);
assert.equal(canvas.canMoveLayer(1), false, "a single object with nothing above it cannot go forward");
assert.equal(canvas.canMoveLayer(-1), false, "nor backward");
scene([stroke("a"), stroke("b")], ["a"]);
assert.equal(canvas.canMoveLayer(1), true, "with something above it forward is live");
assert.equal(canvas.canMoveLayer(-1), false, "and backward is not");

assert.ok(scheduleCalls > 0 && saveCalls > 0, "a completed move must request a redraw and a save");
console.log("layer.test.mjs: ok (group block layering, scattered members, front/back limits, journal)");
