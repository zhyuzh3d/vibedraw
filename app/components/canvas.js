(function (app) {
  "use strict";

  var state = app.state;
  var canvas, context, contentCanvas, contentContext, selectionCanvas, selectionContext, maskCanvas, maskContext, maskContentCanvas, maskContentContext, frameTask, selectionTask;
  var drawingObject = null;
  var dragging = null;
  var resizing = null;
  var pinching = null;
  var selectionGesture = null;
  var selectionMarquee = null;
  var activePointers = {}, inputRect = null;
  var imageCache = app.runtime.createLru({ maxEntries: 16, maxWeight: 48 * 1024 * 1024, weight: function (image) { return Math.max(1, Number(image.naturalWidth) * Number(image.naturalHeight) * 4); } }), imageLoads = new Map(), imageRefresh = new Set(), resultLayerCache = new WeakMap();
  var boundsCache = new WeakMap(), contentDirty = true, lastRenderMeta = "", lastBackgroundStyle = "", lastOpacityStyle = "";
  var performance = { frames: 0, contentRebuilds: 0, objectsDrawn: 0 };
  var WIDTH = 768;
  var HANDLE_DRAW_RADIUS = 16;
  var HANDLE_HIT_RADIUS = 36;
  var MIN_IMAGE_SIZE = 48;
  var MAX_IMAGE_SIZE = WIDTH * 3;
  var MIN_STROKE_SIZE = 3;
  var GESTURE_THRESHOLD = 12;
  var HISTORY_MAX_ENTRIES = 60;
  var HISTORY_MAX_WEIGHT = 12 * 1024 * 1024;

  function resultColorFilter(settings) {
    settings = settings || state;
    if (settings.resultAdjustmentsEnabled === false) return "none";
    return "brightness(" + Math.max(20, Number(settings.resultBrightness)) + "%) contrast(" + Math.max(20, Number(settings.resultContrast)) + "%) saturate(" + Math.max(0, Number(settings.resultSaturation)) + "%) hue-rotate(" + Number(settings.resultHue) + "deg)";
  }
  function sharpenAmount(settings) { settings = settings || state; return settings.resultAdjustmentsEnabled === false ? 0 : Math.max(0, Math.min(100, Number(settings.resultClarity) || 0)) / 100 * 0.8; }
  function syncSharpenFilter(settings) {
    var matrix = document.getElementById("vibedraw-sharpen-matrix"); if (!matrix) return;
    var amount = sharpenAmount(settings), center = 1 + amount * 4;
    matrix.setAttribute("kernelMatrix", "0 " + (-amount) + " 0 " + (-amount) + " " + center + " " + (-amount) + " 0 " + (-amount) + " 0");
  }
  function resultFilter(settings) {
    settings = settings || state;
    if (settings.resultAdjustmentsEnabled === false) return "none";
    return (sharpenAmount(settings) > 0 ? "url(#vibedraw-sharpen) " : "") + resultColorFilter(settings);
  }
  function resultGlowFilter(settings) {
    settings = settings || state;
    var glow = settings.resultAdjustmentsEnabled === false ? 0 : Number(settings.resultGlow) || 0;
    return resultColorFilter(settings) + " blur(" + (1 + glow * 0.1) + "px) brightness(" + (108 + glow * 0.45) + "%) saturate(" + (105 + glow * 0.35) + "%)";
  }
  function sharpenCanvas(target, settings) {
    var amount = sharpenAmount(settings); if (!amount) return;
    var targetContext = target.getContext("2d"), width = target.width, height = target.height, source;
    try { source = targetContext.getImageData(0, 0, width, height); } catch (_) { return; }
    var input = source.data, output = new Uint8ClampedArray(input), stride = width * 4;
    for (var y = 1; y < height - 1; y += 1) {
      for (var x = 1; x < width - 1; x += 1) {
        var offset = y * stride + x * 4;
        for (var channel = 0; channel < 3; channel += 1) {
          output[offset + channel] = input[offset + channel] * (1 + amount * 4) - amount * (input[offset - 4 + channel] + input[offset + 4 + channel] + input[offset - stride + channel] + input[offset + stride + channel]);
        }
      }
    }
    source.data.set(output); targetContext.putImageData(source, 0, 0);
  }
  function drawResult(ctx, image, width, height, contained, settings) {
    settings = settings || state;
    var alpha = ctx.globalAlpha;
    function paint(targetContext) { if (contained) drawContained(targetContext, image, width, height); else targetContext.drawImage(image, 0, 0, width, height); }
    var key = [width, height, contained ? 1 : 0, settings.resultAdjustmentsEnabled === false ? 0 : 1, settings.resultBrightness, settings.resultContrast, settings.resultSaturation, settings.resultHue, settings.resultClarity].join("|");
    var cachedLayer = resultLayerCache.get(image), layer = cachedLayer && cachedLayer.key === key ? cachedLayer.canvas : null;
    if (!layer) {
      layer = document.createElement("canvas"); layer.width = width; layer.height = height;
      var layerContext = layer.getContext("2d"); layerContext.filter = resultColorFilter(settings); paint(layerContext); sharpenCanvas(layer, settings);
      resultLayerCache.set(image, { key: key, canvas: layer });
    }
    ctx.drawImage(layer, 0, 0);
    var glow = settings.resultAdjustmentsEnabled === false ? 0 : Number(settings.resultGlow) || 0;
    if (glow > 0) {
      ctx.save(); ctx.globalCompositeOperation = "screen"; ctx.globalAlpha = alpha * Math.min(0.62, glow / 150); ctx.filter = resultGlowFilter(settings); paint(ctx); ctx.restore();
    }
  }

  function init() {
    canvas = document.getElementById("draft-canvas");
    context = canvas.getContext("2d");
    selectionCanvas = document.getElementById("selection-canvas");
    selectionContext = selectionCanvas.getContext("2d");
    contentCanvas = document.createElement("canvas"); contentCanvas.width = WIDTH; contentCanvas.height = WIDTH; contentContext = contentCanvas.getContext("2d");
    maskCanvas = document.getElementById("mask-canvas");
    maskContext = maskCanvas ? maskCanvas.getContext("2d") : null;
    maskContentCanvas = document.createElement("canvas"); maskContentCanvas.width = WIDTH; maskContentCanvas.height = WIDTH; maskContentContext = maskContentCanvas.getContext("2d");
    frameTask = app.runtime.createFrameTask(paintFrame);
    selectionTask = app.runtime.createFrameTask(function (ids) { app.events.emit("selection", ids); });
    bindInput();
    render();
    resetHistory();
  }
  function bindInput() {
    if (window.PointerEvent) {
      canvas.addEventListener("pointerdown", start);
      canvas.addEventListener("pointermove", move);
      canvas.addEventListener("pointerup", end);
      canvas.addEventListener("pointercancel", end);
    } else {
      canvas.addEventListener("mousedown", start);
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", end);
      canvas.addEventListener("touchstart", start, { passive: false });
      canvas.addEventListener("touchmove", move, { passive: false });
      canvas.addEventListener("touchend", end, { passive: false });
    }
  }
  function setInteractionActive(active) { if (!active) inputRect = null; app.events.emit("canvas:interaction", Boolean(active)); }
  function pointFromSource(source) {
    var rect = inputRect || canvas.getBoundingClientRect();
    return { x: (source.clientX - rect.left) * WIDTH / rect.width, y: (source.clientY - rect.top) * WIDTH / rect.height };
  }
  function point(event) { return pointFromSource(event.touches && event.touches[0] || event.changedTouches && event.changedTouches[0] || event); }
  function touchPair(event) {
    if (!event.touches || event.touches.length < 2) return null;
    return [pointFromSource(event.touches[0]), pointFromSource(event.touches[1])];
  }
  function start(event) {
    if (event.button !== undefined && event.button !== 0) return;
    if (state.tool !== "select" && event.isPrimary === false) return;
    inputRect = canvas.getBoundingClientRect(); setInteractionActive(true);
    event.preventDefault();
    if (event.pointerId !== undefined && canvas.setPointerCapture && event.isTrusted) canvas.setPointerCapture(event.pointerId);
    var p = point(event);
    if (state.tool === "select") {
      if (event.pointerId !== undefined) activePointers[event.pointerId] = p;
      var pair = event.pointerId === undefined ? touchPair(event) : pointerPair();
      var current = selectedObjects();
      if (pair && current.length && insideSelection(pair[0], current, HANDLE_HIT_RADIUS) && insideSelection(pair[1], current, HANDLE_HIT_RADIUS)) {
        selectionGesture = null; selectionMarquee = null; beginPinch(current, pair); scheduleRender(false); return;
      }
      if (event.pointerId !== undefined && Object.keys(activePointers).length > 1) { selectionGesture = null; return; }
      var handle = current.length ? hitHandle(p, current) : null;
      if (handle) {
        resizing = beginResize(current, handle, event.pointerId); dragging = null; selectionGesture = null;
        canvas.style.cursor = handle.key === "nw" || handle.key === "se" ? "nwse-resize" : "nesw-resize";
        scheduleRender(false); return;
      }
      var hit = hitTest(p), ids = selectionIds(), moveIds = [], hitIds = hit ? objectSelectionIds(hit) : [];
      var modified = Boolean(event.shiftKey || event.ctrlKey || event.metaKey);
      if (hit) {
        if (ids.indexOf(hit.id) >= 0 && ids.length > 1) moveIds = ids.slice();
        else if (modified && ids.indexOf(hit.id) < 0) moveIds = ids.concat(hitIds);
        else moveIds = hitIds;
      } else if (current.length && insideSelection(p, current, 0)) moveIds = ids.slice();
      var hitAlreadySelected = hitIds.length && hitIds.every(function (id) { return ids.indexOf(id) >= 0; });
      selectionGesture = { start: p, hit: hit, initialIds: ids, moveIds: moveIds, modified: modified, pointerId: event.pointerId,
        marqueeOnDrag: Boolean(hit && hit.type === "image" && !hitAlreadySelected) };
      dragging = null; selectionMarquee = null;
      return;
    }
    setSelection([]);
    drawingObject = {
      id: app.utils.id("stroke"),
      type: "stroke",
      tool: state.tool,
      color: state.tool === "mask" ? "#e5484d" : state.color,
      width: state.tool === "pencil" ? Math.max(1, Math.round(state.size / 3)) : state.tool === "eraser" ? Math.max(8, state.size * 1.6) : state.size,
      opacity: state.tool === "mask" ? 0.55 : state.tool === "eraser" ? 1 : state.opacity,
      points: [p]
    };
    state.objects.push(drawingObject);
    scheduleRender(false);
  }
  function move(event) {
    if (event.pointerId !== undefined && activePointers[event.pointerId]) activePointers[event.pointerId] = point(event);
    if (pinching) {
      var pair = event.pointerId === undefined ? touchPair(event) : pointerPair();
      if (pair) { event.preventDefault(); applyPinch(pair); scheduleRender(true); }
      return;
    }
    if (selectionGesture) {
      if (selectionGesture.pointerId !== undefined && event.pointerId !== selectionGesture.pointerId) return;
      var gesturePoint = point(event);
      if (distance(selectionGesture.start, gesturePoint) < GESTURE_THRESHOLD) return;
      event.preventDefault();
      if (selectionGesture.moveIds.length && !selectionGesture.marqueeOnDrag) {
        setSelection(selectionGesture.moveIds);
        dragging = { objects: selectedObjects(), x: selectionGesture.start.x, y: selectionGesture.start.y, moved: false, pointerId: selectionGesture.pointerId };
        selectionGesture = null; emitSelection(); canvas.style.cursor = "grabbing";
        moveDraggingTo(gesturePoint); scheduleRender(true);
      } else {
        selectionMarquee = { start: selectionGesture.start, current: gesturePoint, initialIds: selectionGesture.initialIds, modified: selectionGesture.modified, pointerId: selectionGesture.pointerId };
        selectionGesture = null; canvas.style.cursor = "crosshair";
        updateMarqueeSelection(); scheduleRender(false); emitSelection();
      }
      return;
    }
    if (selectionMarquee) {
      if (selectionMarquee.pointerId !== undefined && event.pointerId !== selectionMarquee.pointerId) return;
      event.preventDefault(); selectionMarquee.current = point(event); updateMarqueeSelection(); scheduleRender(false); emitSelection(); return;
    }
    if (!drawingObject && !dragging && !resizing) return;
    event.preventDefault();
    var p = point(event);
    if (drawingObject) {
      var points = drawingObject.points, last = points[points.length - 1];
      if (distance(last, p) >= 1.5) { points.push(p); invalidateBounds(drawingObject); }
      scheduleRender(false);
      return;
    }
    if (resizing) {
      if (resizing.pointerId !== undefined && event.pointerId !== resizing.pointerId) return;
      resizeTo(p); scheduleRender(true); return;
    }
    if (dragging.pointerId !== undefined && event.pointerId !== dragging.pointerId) return;
    moveDraggingTo(p); scheduleRender(true);
  }
  function end(event) {
    if (event && event.pointerId !== undefined) delete activePointers[event.pointerId];
    if (pinching) {
      if (event && event.preventDefault) event.preventDefault();
      var pinchChanged = pinching.changed; pinching = null; dragging = null; resizing = null; activePointers = {};
      canvas.style.cursor = "grab";
      if (pinchChanged) commit();
      setInteractionActive(false);
      return;
    }
    if (event && event.preventDefault && (drawingObject || dragging || resizing || selectionGesture || selectionMarquee)) event.preventDefault();
    if (resizing && resizing.pointerId !== undefined && event && event.pointerId !== undefined && event.pointerId !== resizing.pointerId) return;
    if (dragging && dragging.pointerId !== undefined && event && event.pointerId !== undefined && event.pointerId !== dragging.pointerId) return;
    if (selectionMarquee && selectionMarquee.pointerId !== undefined && event && event.pointerId !== undefined && event.pointerId !== selectionMarquee.pointerId) return;
    if (selectionGesture && selectionGesture.pointerId !== undefined && event && event.pointerId !== undefined && event.pointerId !== selectionGesture.pointerId) return;
    if (selectionMarquee) {
      selectionMarquee = null; selectionGesture = null; canvas.style.cursor = "grab"; scheduleRender(false); emitSelection(); setInteractionActive(false); return;
    }
    if (selectionGesture) {
      var gesture = selectionGesture; selectionGesture = null;
      if (event && /cancel$/.test(event.type)) setSelection(gesture.initialIds);
      else if (gesture.hit) {
        if (gesture.modified) {
          var gestureHitIds = objectSelectionIds(gesture.hit), alreadyIncluded = gestureHitIds.every(function (id) { return gesture.initialIds.indexOf(id) >= 0; });
          var toggled = gesture.initialIds.filter(function (id) { return gestureHitIds.indexOf(id) < 0; });
          if (!alreadyIncluded) toggled = toggled.concat(gestureHitIds);
          setSelection(toggled);
        } else setSelection(objectSelectionIds(gesture.hit));
      } else setSelection([]);
      canvas.style.cursor = "grab"; scheduleRender(false); emitSelection(); setInteractionActive(false); return;
    }
    var changed = Boolean(drawingObject || dragging && dragging.moved || resizing && resizing.changed);
    var finishedDrawing = Boolean(drawingObject); drawingObject = null;
    dragging = null;
    resizing = null;
    if (state.tool === "select") canvas.style.cursor = "grab";
    if (finishedDrawing) render();
    else if (frameTask && frameTask.pending()) frameTask.flush();
    if (changed) commit();
    setInteractionActive(false);
  }
  function moveDraggingTo(p) {
    var dx = p.x - dragging.x, dy = p.y - dragging.y;
    if (Math.abs(dx) + Math.abs(dy) < 0.25) return;
    dragging.objects.forEach(function (object) { translate(object, dx, dy); });
    dragging.x = p.x; dragging.y = p.y; dragging.moved = true;
  }
  function translate(object, dx, dy) {
    if (object.type === "stroke") object.points.forEach(function (p) { p.x += dx; p.y += dy; });
    else { object.x += dx; object.y += dy; }
    invalidateBounds(object);
  }
  function distance(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
  function midpoint(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }
  function pointerPair() {
    var ids = Object.keys(activePointers);
    return ids.length >= 2 ? [activePointers[ids[0]], activePointers[ids[1]]] : null;
  }
  function selectionIds() {
    var ids = Array.isArray(state.selectedIds) ? state.selectedIds.slice() : [];
    if (!ids.length && state.selectedId) ids.push(state.selectedId);
    var existing = new Set(), unique = [];
    state.objects.forEach(function (object) { existing.add(object.id); });
    ids.forEach(function (id) { if (id && existing.has(id) && unique.indexOf(id) < 0) unique.push(id); });
    return unique;
  }
  function setSelection(ids) {
    var expanded = [];
    (ids || []).forEach(function (id) {
      var object = state.objects.find(function (item) { return item.id === id; });
      if (!object) return;
      objectSelectionIds(object).forEach(function (memberId) { if (expanded.indexOf(memberId) < 0) expanded.push(memberId); });
    });
    state.selectedIds = expanded;
    state.selectedId = state.selectedIds.length ? state.selectedIds[state.selectedIds.length - 1] : "";
  }
  function objectSelectionIds(object) {
    if (!object || !object.groupId) return object ? [object.id] : [];
    return state.objects.filter(function (item) { return item.groupId === object.groupId; }).map(function (item) { return item.id; });
  }
  function emitSelection() { if (selectionTask) selectionTask.request(selectionIds()); }
  function selectedObjects() {
    var ids = new Set(selectionIds());
    return state.objects.filter(function (object) { return ids.has(object.id); });
  }
  function normalizedRect(a, b) {
    return { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.abs(a.x - b.x), height: Math.abs(a.y - b.y) };
  }
  function boxesIntersect(a, b) {
    return a.x <= b.x + b.width && a.x + a.width >= b.x && a.y <= b.y + b.height && a.y + a.height >= b.y;
  }
  function pointInsideRect(p, rect) {
    return p.x >= rect.x && p.x <= rect.x + rect.width && p.y >= rect.y && p.y <= rect.y + rect.height;
  }
  function direction(a, b, c) { return (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x); }
  function linesIntersect(a, b, c, d) {
    if (Math.max(a.x, b.x) < Math.min(c.x, d.x) || Math.max(c.x, d.x) < Math.min(a.x, b.x) || Math.max(a.y, b.y) < Math.min(c.y, d.y) || Math.max(c.y, d.y) < Math.min(a.y, b.y)) return false;
    var abC = direction(a, b, c), abD = direction(a, b, d), cdA = direction(c, d, a), cdB = direction(c, d, b);
    return ((abC <= 0 && abD >= 0) || (abC >= 0 && abD <= 0)) && ((cdA <= 0 && cdB >= 0) || (cdA >= 0 && cdB <= 0));
  }
  function segmentIntersectsRect(a, b, rect) {
    if (pointInsideRect(a, rect) || pointInsideRect(b, rect)) return true;
    var topLeft = { x: rect.x, y: rect.y }, topRight = { x: rect.x + rect.width, y: rect.y };
    var bottomLeft = { x: rect.x, y: rect.y + rect.height }, bottomRight = { x: rect.x + rect.width, y: rect.y + rect.height };
    return linesIntersect(a, b, topLeft, topRight) || linesIntersect(a, b, topRight, bottomRight) || linesIntersect(a, b, bottomRight, bottomLeft) || linesIntersect(a, b, bottomLeft, topLeft);
  }
  function objectIntersectsRect(object, rect) {
    if (!boxesIntersect(bounds(object), rect)) return false;
    if (object.type === "image") return true;
    var padding = object.width / 2 + 5;
    var expanded = { x: rect.x - padding, y: rect.y - padding, width: rect.width + padding * 2, height: rect.height + padding * 2 };
    if (object.points.length === 1) return pointInsideRect(object.points[0], expanded);
    for (var index = 1; index < object.points.length; index += 1) {
      if (segmentIntersectsRect(object.points[index - 1], object.points[index], expanded)) return true;
    }
    return false;
  }
  function updateMarqueeSelection() {
    var rect = normalizedRect(selectionMarquee.start, selectionMarquee.current);
    var matched = [], seen = new Set();
    state.objects.forEach(function (object) {
      if (!objectIntersectsRect(object, rect)) return;
      objectSelectionIds(object).forEach(function (id) { if (!seen.has(id)) { seen.add(id); matched.push(id); } });
    });
    if (selectionMarquee.modified) matched = selectionMarquee.initialIds.concat(matched);
    setSelection(matched);
  }
  function selectionBounds(objects) {
    return app.drawing.selectionBounds(objects, bounds);
  }
  function insideSelection(p, objects, padding) {
    var box = selectionBounds(objects); if (!box) return false;
    return p.x >= box.x - padding && p.x <= box.x + box.width + padding && p.y >= box.y - padding && p.y <= box.y + box.height + padding;
  }
  function selectionHandles(objects) {
    var box = Array.isArray(objects) ? selectionBounds(objects) : objects ? bounds(objects) : null;
    if (!box) return [];
    return [
      { key: "nw", x: box.x, y: box.y }, { key: "ne", x: box.x + box.width, y: box.y },
      { key: "sw", x: box.x, y: box.y + box.height }, { key: "se", x: box.x + box.width, y: box.y + box.height }
    ];
  }
  function hitHandle(p, objects) {
    var handles = selectionHandles(objects);
    for (var index = 0; index < handles.length; index += 1) if (distance(p, handles[index]) <= HANDLE_HIT_RADIUS) return handles[index];
    return null;
  }
  function transformLimits(objects) {
    var minimum = 0.02, maximum = 100;
    objects.forEach(function (object) {
      var box = bounds(object), shortest = Math.max(1, Math.min(box.width, box.height));
      minimum = Math.max(minimum, (object.type === "image" ? MIN_IMAGE_SIZE : MIN_STROKE_SIZE) / shortest);
      maximum = Math.min(maximum, MAX_IMAGE_SIZE / Math.max(1, box.width, box.height));
    });
    return { minimum: minimum, maximum: maximum };
  }
  function snapshotObjects(objects) { return app.drawing.cloneObjects(objects); }
  function scaleSnapshots(objects, originals, anchor, factor) {
    objects.forEach(function (object, index) {
      var original = originals[index];
      if (object.type === "stroke") {
        object.points = original.points.map(function (p) { return { x: anchor.x + (p.x - anchor.x) * factor, y: anchor.y + (p.y - anchor.y) * factor }; });
        object.width = original.width * factor;
      } else {
        object.x = anchor.x + (original.x - anchor.x) * factor; object.y = anchor.y + (original.y - anchor.y) * factor;
        object.width = original.width * factor; object.height = original.height * factor;
      }
      invalidateBounds(object);
    });
  }
  function beginResize(objects, handle, pointerId) {
    var box = selectionBounds(objects);
    var opposite = { x: handle.key.indexOf("w") >= 0 ? box.x + box.width : box.x, y: handle.key.indexOf("n") >= 0 ? box.y + box.height : box.y };
    var vector = { x: handle.x - opposite.x, y: handle.y - opposite.y };
    var limits = transformLimits(objects);
    return { objects: objects, originals: snapshotObjects(objects), opposite: opposite, vector: vector, squared: vector.x * vector.x + vector.y * vector.y,
      minimum: limits.minimum, maximum: limits.maximum, pointerId: pointerId, changed: false };
  }
  function resizeTo(p) {
    var transform = resizing, vector = transform.vector;
    var factor = ((p.x - transform.opposite.x) * vector.x + (p.y - transform.opposite.y) * vector.y) / Math.max(1, transform.squared);
    factor = Math.max(transform.minimum, Math.min(transform.maximum, factor));
    scaleSnapshots(transform.objects, transform.originals, transform.opposite, factor);
    transform.changed = Math.abs(factor - 1) > 0.002;
  }
  function beginPinch(objects, pair) {
    var center = midpoint(pair[0], pair[1]);
    var limits = transformLimits(objects);
    pinching = { objects: objects, originals: snapshotObjects(objects), distance: Math.max(1, distance(pair[0], pair[1])), center: center,
      minimum: limits.minimum, maximum: limits.maximum, changed: false };
    dragging = null; resizing = null; selectionGesture = null; selectionMarquee = null;
  }
  function applyPinch(pair) {
    var transform = pinching, center = midpoint(pair[0], pair[1]);
    var factor = distance(pair[0], pair[1]) / transform.distance;
    factor = Math.max(transform.minimum, Math.min(transform.maximum, factor));
    scaleSnapshots(transform.objects, transform.originals, transform.center, factor);
    var dx = center.x - transform.center.x, dy = center.y - transform.center.y;
    transform.objects.forEach(function (object) { translate(object, dx, dy); });
    transform.changed = Math.abs(factor - 1) > 0.002 || distance(center, transform.center) > 0.5;
  }
  function segmentDistance(pointValue, a, b) {
    var dx = b.x - a.x, dy = b.y - a.y;
    if (!dx && !dy) return distance(pointValue, a);
    var t = ((pointValue.x - a.x) * dx + (pointValue.y - a.y) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    return distance(pointValue, { x: a.x + t * dx, y: a.y + t * dy });
  }
  function hitTest(p) {
    for (var index = state.objects.length - 1; index >= 0; index -= 1) {
      var object = state.objects[index];
      var box = bounds(object), padding = object.type === "image" ? 0 : 12;
      if (p.x < box.x - padding || p.x > box.x + box.width + padding || p.y < box.y - padding || p.y > box.y + box.height + padding) continue;
      if (object.type === "image") {
        if (p.x >= object.x && p.x <= object.x + object.width && p.y >= object.y && p.y <= object.y + object.height) return object;
      } else {
        if (object.points.length === 1 && distance(p, object.points[0]) <= object.width / 2 + 12) return object;
        for (var pointIndex = 1; pointIndex < object.points.length; pointIndex += 1) {
          if (segmentDistance(p, object.points[pointIndex - 1], object.points[pointIndex]) <= object.width / 2 + 12) return object;
        }
      }
    }
    return null;
  }
  function bounds(object) {
    if (object.type === "image") return app.drawing.bounds(object);
    var cached = boundsCache.get(object);
    if (cached) return cached;
    cached = app.drawing.bounds(object); boundsCache.set(object, cached); return cached;
  }
  function invalidateBounds(object) { if (object && object.type === "stroke") boundsCache.delete(object); }
  function drawStroke(ctx, object, maskPreview) {
    if (!object.points.length) return;
    ctx.save();
    ctx.globalCompositeOperation = object.tool === "eraser" ? "destination-out" : "source-over";
    ctx.globalAlpha = object.opacity;
    ctx.strokeStyle = object.tool === "mask" && maskPreview ? "#e5484d" : object.color;
    ctx.lineWidth = object.width;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.beginPath();
    ctx.moveTo(object.points[0].x, object.points[0].y);
    for (var index = 1; index < object.points.length; index += 1) ctx.lineTo(object.points[index].x, object.points[index].y);
    if (object.points.length === 1) ctx.lineTo(object.points[0].x + 0.1, object.points[0].y + 0.1);
    ctx.stroke();
    ctx.restore();
  }
  function loadImage(src, refreshCanvas) {
    if (!src) return Promise.resolve(null);
    var cached = imageCache.get(src);
    if (cached && cached.complete && cached.naturalWidth) return Promise.resolve(cached);
    if (refreshCanvas !== false) imageRefresh.add(src);
    if (imageLoads.has(src)) return imageLoads.get(src);
    var promise = new Promise(function (resolve) {
      var image = new Image();
      image.onload = function () {
        imageCache.set(src, image); imageLoads.delete(src); resolve(image);
        if (imageRefresh.has(src)) scheduleRender(true);
        imageRefresh.delete(src);
      };
      image.onerror = function () { imageLoads.delete(src); imageRefresh.delete(src); resolve(null); };
      image.src = src;
    });
    imageLoads.set(src, promise); return promise;
  }
  function drawContained(ctx, image, width, height) {
    var scale = Math.min(width / image.naturalWidth, height / image.naturalHeight);
    var w = image.naturalWidth * scale, h = image.naturalHeight * scale;
    ctx.drawImage(image, (width - w) / 2, (height - h) / 2, w, h);
  }
  function drawImageObject(ctx, object) {
    var source = object.src || object.url;
    var image = object._imageSource === source && object._image && object._image.complete ? object._image : imageCache.get(source);
    if (image && image.complete && image.naturalWidth) {
      object._image = image; object._imageSource = source;
      ctx.drawImage(image, object.x, object.y, object.width, object.height);
    } else loadImage(source, true).then(function (loaded) {
      if (loaded && (object.src || object.url) === source) { object._image = loaded; object._imageSource = source; }
    });
  }
  function scheduleRender(changed) {
    if (changed) contentDirty = true;
    if (frameTask) frameTask.request();
  }
  function rebuildContent() {
    contentContext.clearRect(0, 0, WIDTH, WIDTH);
    maskContentContext.clearRect(0, 0, WIDTH, WIDTH);
    state.objects.forEach(function (object) {
      if (object === drawingObject) return;
      if (isMaskStroke(object)) { drawStroke(maskContentContext, object, true); return; }
      if (object.type === "stroke") drawStroke(contentContext, object, true);
      else drawImageObject(contentContext, object);
      performance.objectsDrawn += 1;
    });
    contentDirty = false; performance.contentRebuilds += 1;
  }
  function paintFrame() {
    if (!context) return;
    performance.frames += 1;
    if (contentDirty) rebuildContent();
    context.clearRect(0, 0, WIDTH, WIDTH);
    selectionContext.clearRect(0, 0, WIDTH, WIDTH);
    context.drawImage(contentCanvas, 0, 0);
    if (maskContext) {
      maskContext.clearRect(0, 0, WIDTH, WIDTH);
      if (state.maskMode) {
        maskContext.drawImage(maskContentCanvas, 0, 0);
        if (isMaskStroke(drawingObject)) drawStroke(maskContext, drawingObject, true);
      }
    }
    if (drawingObject && !isMaskStroke(drawingObject)) drawStroke(context, drawingObject, true);
    var selected = selectedObjects();
    if (selected.length && !selectionMarquee) {
      var box = selectionBounds(selected);
      selectionContext.save();
      selectionContext.strokeStyle = "#ee4f85";
      selectionContext.lineWidth = 2;
      selectionContext.setLineDash([9, 7]);
      selectionContext.strokeRect(box.x, box.y, box.width, box.height);
      selectionContext.restore();
      selectionHandles(selected).forEach(function (handle) {
        selectionContext.save(); selectionContext.beginPath(); selectionContext.arc(handle.x, handle.y, HANDLE_DRAW_RADIUS, 0, Math.PI * 2);
        selectionContext.fillStyle = "#ffffff"; selectionContext.fill(); selectionContext.lineWidth = 4; selectionContext.strokeStyle = "#e75483"; selectionContext.stroke(); selectionContext.restore();
      });
    }
    if (selectionMarquee) {
      var marqueeBox = normalizedRect(selectionMarquee.start, selectionMarquee.current);
      selectionContext.save();
      selectionContext.fillStyle = "rgba(238,79,133,.12)"; selectionContext.fillRect(marqueeBox.x, marqueeBox.y, marqueeBox.width, marqueeBox.height);
      selectionContext.strokeStyle = "#e75483"; selectionContext.lineWidth = 2; selectionContext.setLineDash([10, 7]);
      selectionContext.strokeRect(marqueeBox.x, marqueeBox.y, marqueeBox.width, marqueeBox.height);
      selectionContext.restore();
    }
    var opacity = "1";
    if (state.maskMode) opacity = "0";
    else if (state.overlayGenerate) opacity = String(Math.max(0, Math.min(1, Number(state.layerOpacity == null ? 1 : state.layerOpacity))));
    var background = document.getElementById("stage-background");
    if (lastBackgroundStyle !== state.background) { background.style.background = state.background; lastBackgroundStyle = state.background; }
    if (lastOpacityStyle !== opacity) { canvas.style.opacity = opacity; lastOpacityStyle = opacity; }
    var meta = state.objects.length + "|" + state.background + "|" + opacity;
    if (meta !== lastRenderMeta) { lastRenderMeta = meta; app.events.emit("canvas:rendered", { objects: state.objects.length }); }
  }
  function render() {
    if (!context) return;
    contentDirty = true;
    if (frameTask) frameTask.cancel();
    paintFrame();
  }
  function refresh() {
    if (!context) return;
    if (frameTask) frameTask.cancel();
    paintFrame();
  }
  function selectedObject() {
    return state.objects.find(function (object) { return object.id === state.selectedId; }) || null;
  }
  function snapshot() {
    var objects = app.drawing.cloneObjects(state.objects);
    return { objects: objects, background: state.background, _weight: app.drawing.estimateWeight(objects) };
  }
  function cloneSnapshot(value) {
    return { objects: app.drawing.cloneObjects(value && value.objects || []), background: value && value.background || "#ffffff", _weight: value && value._weight || app.drawing.estimateWeight(value && value.objects || []) };
  }
  function trimHistory() {
    while (state.history.length > HISTORY_MAX_ENTRIES) state.history.shift();
    var weight = state.history.reduce(function (sum, item) { return sum + (item._weight || 0); }, 0);
    while (state.history.length > 2 && weight > HISTORY_MAX_WEIGHT) { weight -= state.history[0]._weight || 0; state.history.shift(); }
  }
  function restore(value) {
    var data = typeof value === "string" ? app.utils.parseJson(value, { objects: [], background: "#ffffff" }) : cloneSnapshot(value);
    state.objects = app.drawing.cloneObjects(data.objects || []);
    state.background = data.background || "#ffffff";
    setSelection([]);
    state.objects.forEach(function (object) { if (object.type === "image") loadImage(object.src || object.url, true); });
    render();
    app.events.emit("history", { undo: state.history.length > 1, redo: state.future.length > 0 });
    emitSelection();
    app.services.store.scheduleCanvasSave();
    app.services.imageEngine.schedule();
  }
  function resetHistory() { drawingObject = null; dragging = null; resizing = null; pinching = null; selectionGesture = null; selectionMarquee = null; activePointers = {}; boundsCache = new WeakMap(); state.history = [snapshot()]; state.future = []; app.events.emit("history", { undo: false, redo: false }); }
  function commit() {
    var next = snapshot();
    state.history.push(next); trimHistory();
    state.future = [];
    app.events.emit("history", { undo: state.history.length > 1, redo: false });
    emitSelection();
    app.services.store.scheduleCanvasSave();
    app.services.imageEngine.schedule();
  }
  function undo() {
    if (state.history.length <= 1) return;
    state.future.push(state.history.pop());
    restore(state.history[state.history.length - 1]);
  }
  function redo() {
    if (!state.future.length) return;
    var value = state.future.pop();
    state.history.push(value);
    restore(value);
  }
  function removeSelected() {
    var ids = selectionIds(); if (!ids.length) return;
    state.objects = state.objects.filter(function (object) { return ids.indexOf(object.id) < 0; });
    setSelection([]);
    render(); commit();
  }
  function clear() {
    if (!state.objects.length) return;
    state.objects = [];
    setSelection([]);
    render(); commit();
  }
  function moveLayer(direction) {
    if (selectionIds().length !== 1) return;
    var index = state.objects.findIndex(function (object) { return object.id === state.selectedId; });
    var target = index + direction;
    if (index < 0 || target < 0 || target >= state.objects.length) return;
    var object = state.objects.splice(index, 1)[0];
    state.objects.splice(target, 0, object);
    render(); commit();
  }
  function scaleSelected(factor) {
    var objects = selectedObjects(); if (!objects.length) return;
    var limits = transformLimits(objects); if (factor < limits.minimum || factor > limits.maximum) return;
    var box = selectionBounds(objects), center = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    scaleSnapshots(objects, snapshotObjects(objects), center, factor);
    render(); commit();
  }
  function groupSelected() {
    var objects = selectedObjects(); if (objects.length < 2) return;
    var groupId = app.utils.id("group");
    objects.forEach(function (object) { object.groupId = groupId; });
    setSelection(objects.map(function (object) { return object.id; })); render(); commit();
  }
  function ungroupSelected() {
    var objects = selectedObjects();
    var groupIds = objects.filter(function (object) { return Boolean(object.groupId); }).map(function (object) { return object.groupId; });
    if (!groupIds.length) return;
    state.objects.forEach(function (object) { if (groupIds.indexOf(object.groupId) >= 0) delete object.groupId; });
    setSelection(objects.map(function (object) { return object.id; })); render(); commit();
  }
  function duplicateSelected() {
    var objects = selectedObjects(); if (!objects.length) return;
    var copiedGroups = {};
    var copies = objects.map(function (object) {
      var copy = app.drawing.cloneObject(object); copy.id = app.utils.id(copy.type);
      if (copy.groupId) { copiedGroups[copy.groupId] = copiedGroups[copy.groupId] || app.utils.id("group"); copy.groupId = copiedGroups[copy.groupId]; }
      translate(copy, 22, 22); return copy;
    });
    copies.forEach(function (copy) { state.objects.push(copy); }); setSelection(copies.map(function (copy) { return copy.id; })); render(); commit();
  }
  async function addImage(file) {
    if (!file || !file.url) return;
    var image = await loadImage(file.url, false);
    if (!image) throw new Error("无法读取所选图片");
    var scale = Math.min(WIDTH * 0.72 / image.naturalWidth, WIDTH * 0.72 / image.naturalHeight, 1);
    var width = image.naturalWidth * scale, height = image.naturalHeight * scale;
    var object = {
      id: app.utils.id("image"), type: "image", url: file.url, src: file.url,
      logicalFileId: file.logicalFileId || "", name: file.name || "image",
      x: (WIDTH - width) / 2, y: (WIDTH - height) / 2, width: width, height: height
    };
    object._image = image; object._imageSource = file.url;
    state.objects.push(object);
    setSelection([object.id]);
    state.tool = "select";
    render(); commit();
    app.events.emit("tool", "select");
  }
  function isMaskStroke(object) { return Boolean(object && object.type === "stroke" && object.tool === "mask"); }
  function maskStrokes() { return state.objects.filter(isMaskStroke); }
  function hasMask() { return state.objects.some(isMaskStroke); }
  function contentCount() { return state.objects.length - maskStrokes().length; }
  function clearMask() {
    var removed = 0;
    for (var index = state.objects.length - 1; index >= 0; index -= 1) {
      if (!isMaskStroke(state.objects[index])) continue;
      state.objects.splice(index, 1); removed += 1;
    }
    if (!removed) return 0;
    setSelection([]); render(); commit();
    return removed;
  }
  async function drawObjectList(targetContext, includeMask, opacity, objects) {
    var layer = document.createElement("canvas"); layer.width = WIDTH; layer.height = WIDTH;
    var layerContext = layer.getContext("2d");
    objects = objects || state.objects;
    for (var index = 0; index < objects.length; index += 1) {
      var object = objects[index];
      if (object.type === "stroke") {
        if (object.tool === "mask" && !includeMask) continue;
        drawStroke(layerContext, object, false);
      } else {
        var image = await loadImage(object.src || object.url, false);
        if (image) layerContext.drawImage(image, object.x, object.y, object.width, object.height);
      }
    }
    targetContext.save(); targetContext.globalAlpha = opacity == null ? 1 : opacity; targetContext.drawImage(layer, 0, 0); targetContext.restore();
  }
  function captureComposition() {
    var currentResultOpacity = Number(state.resultOpacity);
    if (!Number.isFinite(currentResultOpacity)) currentResultOpacity = 1;
    var masking = Boolean(state.maskMode);
    return {
      background: state.background || "#ffffff",
      localMode: masking,
      overlayGenerate: masking ? false : Boolean(state.overlayGenerate),
      resultOpacity: masking ? 1 : Math.max(0, Math.min(1, currentResultOpacity)),
      layerOpacity: masking ? 0 : Math.max(0, Math.min(1, Number(state.layerOpacity == null ? 1 : state.layerOpacity))),
      resultVisible: masking ? true : state.resultVisible !== false,
      resultSrc: state.result && state.result.src || "",
      resultBrightness: state.resultBrightness,
      resultContrast: state.resultContrast,
      resultSaturation: state.resultSaturation,
      resultHue: state.resultHue,
      resultGlow: state.resultGlow,
      resultClarity: state.resultClarity,
      resultAdjustmentsEnabled: state.resultAdjustmentsEnabled !== false,
      objects: masking ? [] : app.drawing.cloneObjects(state.objects)
    };
  }
  async function drawCompositionResult(ctx, composition) {
    if (!composition.resultVisible || !composition.resultSrc) return;
    var result = await loadImage(composition.resultSrc, false);
    if (!result) return;
    ctx.save(); ctx.globalAlpha = composition.resultOpacity; drawResult(ctx, result, WIDTH, WIDTH, true, composition); ctx.restore();
  }
  async function renderComposition(composition, targetSize, visibleSnapshot) {
    var output = document.createElement("canvas");
    output.width = targetSize; output.height = targetSize;
    var ctx = output.getContext("2d");
    if (targetSize !== WIDTH) ctx.scale(targetSize / WIDTH, targetSize / WIDTH);
    ctx.fillStyle = composition.background;
    ctx.fillRect(0, 0, WIDTH, WIDTH);
    if (composition.overlayGenerate) {
      await drawCompositionResult(ctx, composition);
      await drawObjectList(ctx, false, composition.layerOpacity, composition.objects);
    } else {
      await drawObjectList(ctx, false, 1, composition.objects);
      if (visibleSnapshot || composition.localMode) await drawCompositionResult(ctx, composition);
    }
    return output;
  }
  async function snapshotVisible() {
    var composition = captureComposition();
    var output = await renderComposition(composition, WIDTH, true), src = output.toDataURL("image/png");
    await loadImage(src, false);
    var object = { id: app.utils.id("image"), type: "image", url: src, src: src, logicalFileId: "", name: "VibeDraw snapshot", x: 0, y: 0, width: WIDTH, height: WIDTH };
    state.objects.push(object); setSelection([object.id]); state.tool = "select";
    render(); commit(); app.events.emit("tool", "select");
    return object;
  }
  async function composeInput(options) {
    options = options || {};
    var targetSize = Number(options.size) || WIDTH;
    var output = await renderComposition(captureComposition(), targetSize);
    return encodeCanvas(output, options);
  }
  async function composeVisibleInput(options) {
    options = options || {};
    var targetSize = Number(options.size) || WIDTH;
    var output = await renderComposition(captureComposition(), targetSize, true);
    return encodeCanvas(output, options);
  }
  function encodeCanvas(output, options) {
    var mime = options.mime || "image/png", quality = Number(options.quality) || 0.82;
    var encoded = output.toDataURL(mime, quality), maxBytes = Number(options.maxBytes) || 0;
    while (maxBytes && mime === "image/jpeg" && app.utils.dataUrlByteLength(encoded) > maxBytes && quality > 0.45) {
      quality = Math.max(0.45, quality - 0.1); encoded = output.toDataURL(mime, quality);
    }
    return encoded;
  }
  function composeMask(openAiAlpha) {
    if (!hasMask()) return null;
    var output = document.createElement("canvas");
    output.width = WIDTH; output.height = WIDTH;
    var ctx = output.getContext("2d");
    if (openAiAlpha) {
      ctx.fillStyle = "white"; ctx.fillRect(0, 0, WIDTH, WIDTH);
      ctx.globalCompositeOperation = "destination-out";
    } else {
      ctx.fillStyle = "black"; ctx.fillRect(0, 0, WIDTH, WIDTH);
      ctx.strokeStyle = "white";
    }
    state.objects.filter(function (object) { return object.type === "stroke" && (object.tool === "mask" || object.tool === "eraser"); }).forEach(function (object) {
      var copy = { points: object.points, width: object.width, color: !openAiAlpha && object.tool === "eraser" ? "black" : "white", opacity: 1, tool: openAiAlpha && object.tool === "mask" ? "eraser" : "brush" };
      drawStroke(ctx, copy, false);
    });
    return output.toDataURL("image/png");
  }
  async function exportSource(src, logicalFileId, baseName) {
    var bridge = app.platform.hermit.current();
    if (bridge && logicalFileId) return bridge.files.export({ logicalFileId: logicalFileId });
    if (bridge) {
      var image = await loadImage(src, false), output = document.createElement("canvas");
      var dimension = Math.min(1536, image.naturalWidth);
      var encoded;
      do {
        output.width = dimension; output.height = Math.round(dimension * image.naturalHeight / image.naturalWidth);
        output.getContext("2d").drawImage(image, 0, 0, output.width, output.height);
        encoded = output.toDataURL("image/jpeg", 0.88); dimension = Math.round(dimension * 0.8);
      } while (encoded.length > 220000 && dimension > 160);
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="' + output.width + '" height="' + output.height + '" viewBox="0 0 ' + output.width + ' ' + output.height + '"><image width="100%" height="100%" xlink:href="' + encoded + '"/></svg>';
      var file = await bridge.files.writeText({ name: (baseName || "VibeDraw-canvas") + "-" + Date.now() + ".svg", text: svg });
      try { return await bridge.files.export({ logicalFileId: file.logicalFileId }); }
      finally { await bridge.files.delete({ logicalFileId: file.logicalFileId }).catch(function () {}); }
    }
    var anchor = document.createElement("a");
    anchor.download = (baseName || "vibedraw-canvas") + "-" + new Date().toISOString().replace(/[:.]/g, "-") + ".png";
    anchor.href = src;
    document.body.appendChild(anchor); anchor.click(); anchor.remove();
  }
  async function exportVisibleCanvas() {
    var src = await composeVisibleInput({ size: WIDTH, mime: "image/png" });
    return exportSource(src, "", "VibeDraw-canvas");
  }
  async function imageDimensions(src) {
    var image = await loadImage(src, false);
    return image ? { width: image.naturalWidth, height: image.naturalHeight } : { width: 0, height: 0 };
  }
  function load(saved) {
    if (!saved) return;
    ["prompt", "localPrompt", "negativePrompt", "background", "color", "size", "opacity", "strength", "colorStrength", "seed", "seedLocked", "autoDelayMs", "autoGenerate", "overlayGenerate", "resultOpacity", "layerOpacity", "resultVisible", "resultBrightness", "resultContrast", "resultSaturation", "resultHue", "resultGlow", "resultClarity", "resultAdjustmentsEnabled", "workId", "workTitle"].forEach(function (key) {
      if (saved[key] !== undefined) state[key] = saved[key];
    });
    state.objects = saved.objects || [];
    state.result = saved.result || null;
    setSelection([]);
    state.objects.forEach(function (object) {
      if (object.type === "image") { object.src = object.src || object.url; loadImage(object.src, true); }
    });
    render(); resetHistory();
  }
  async function thumbnail(saved, target) {
    var size = 768, ctx = target.getContext("2d"); target.width = 288; target.height = 288;
    ctx.scale(288 / size, 288 / size); ctx.fillStyle = saved.background || "#fff"; ctx.fillRect(0, 0, size, size);
    if (saved.result && saved.result.asset) {
      var src = await app.services.assets.resolve(saved.result.asset), result = await loadImage(src, false);
      if (result) drawContained(ctx, result, size, size);
      return;
    }
    var layer = document.createElement("canvas"); layer.width = size; layer.height = size; var layerCtx = layer.getContext("2d");
    for (var object of saved.objects || []) {
      if (object.type === "stroke") { if (object.tool !== "mask") drawStroke(layerCtx, object, false); }
      else { var image = await loadImage(object.asset ? await app.services.assets.resolve(object.asset) : object.url, false); if (image) layerCtx.drawImage(image, object.x, object.y, object.width, object.height); }
    }
    ctx.drawImage(layer, 0, 0);
  }

  app.components.canvas = {
    init: init,
    render: render,
    refresh: refresh,
    commit: commit,
    undo: undo,
    redo: redo,
    removeSelected: removeSelected,
    clear: clear,
    moveLayer: moveLayer,
    scaleSelected: scaleSelected,
    groupSelected: groupSelected,
    ungroupSelected: ungroupSelected,
    duplicateSelected: duplicateSelected,
    addImage: addImage,
    snapshotVisible: snapshotVisible,
    composeInput: composeInput,
    composeVisibleInput: composeVisibleInput,
    composeMask: composeMask,
    exportVisibleCanvas: exportVisibleCanvas,
    exportSource: exportSource,
    imageDimensions: imageDimensions,
    load: load,
    thumbnail: thumbnail,
    hasMask: hasMask,
    contentCount: contentCount,
    maskStrokes: maskStrokes,
    clearMask: clearMask,
    selectionHandles: function () { return selectionHandles(selectedObjects()); },
    resultFilter: resultFilter,
    resultGlowFilter: resultGlowFilter,
    drawResult: drawResult,
    syncSharpenFilter: syncSharpenFilter,
    performance: function () { return { frames: performance.frames, contentRebuilds: performance.contentRebuilds, objectsDrawn: performance.objectsDrawn, imageCache: imageCache.stats(), historyEntries: state.history.length, futureEntries: state.future.length }; }
  };
})(window.vibedraw);
