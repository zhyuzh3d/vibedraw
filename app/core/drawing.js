(function (app) {
  "use strict";

  function cloneValue(value) {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(cloneValue);
    var output = {};
    Object.keys(value).forEach(function (key) { if (key.charAt(0) !== "_") output[key] = cloneValue(value[key]); });
    return output;
  }
  function cloneObject(object) {
    if (!object || typeof object !== "object") return object;
    var output = {};
    Object.keys(object).forEach(function (key) {
      if (key.charAt(0) === "_") return;
      var value = object[key];
      if (key === "points" && Array.isArray(value)) {
        var points = new Array(value.length);
        for (var index = 0; index < value.length; index += 1) points[index] = { x: value[index].x, y: value[index].y };
        output.points = points;
      } else output[key] = value && typeof value === "object" ? cloneValue(value) : value;
    });
    return output;
  }
  function cloneObjects(objects) { return (objects || []).map(cloneObject); }
  function storageObject(object) {
    var copy = cloneObject(object); delete copy.src;
    if (copy.url && /^(data:|blob:)/.test(copy.url)) delete copy.url;
    return copy;
  }
  function bounds(object) {
    if (object.type === "image") return { x: object.x, y: object.y, width: object.width, height: object.height };
    var points = object.points || [], pad = Number(object.width) / 2 + 5;
    if (!points.length) return { x: 0, y: 0, width: 1, height: 1 };
    var left = points[0].x, right = left, top = points[0].y, bottom = top;
    for (var index = 1; index < points.length; index += 1) {
      var point = points[index];
      if (point.x < left) left = point.x; if (point.x > right) right = point.x;
      if (point.y < top) top = point.y; if (point.y > bottom) bottom = point.y;
    }
    return { x: left - pad, y: top - pad, width: Math.max(1, right - left + pad * 2), height: Math.max(1, bottom - top + pad * 2) };
  }
  function selectionBounds(objects, resolveBounds) {
    if (!objects || !objects.length) return null;
    var first = (resolveBounds || bounds)(objects[0]), left = first.x, top = first.y, right = first.x + first.width, bottom = first.y + first.height;
    for (var index = 1; index < objects.length; index += 1) {
      var box = (resolveBounds || bounds)(objects[index]);
      if (box.x < left) left = box.x; if (box.y < top) top = box.y;
      if (box.x + box.width > right) right = box.x + box.width;
      if (box.y + box.height > bottom) bottom = box.y + box.height;
    }
    return { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) };
  }
  function estimateWeight(objects) {
    var weight = 64;
    (objects || []).forEach(function (object) { weight += 256 + (object.points ? object.points.length * 20 : 0); });
    return weight;
  }

  app.drawing = { cloneObject: cloneObject, cloneObjects: cloneObjects, storageObject: storageObject, bounds: bounds, selectionBounds: selectionBounds, estimateWeight: estimateWeight };
})(window.vibedraw);
