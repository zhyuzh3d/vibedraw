(function (app) {
  "use strict";

  function createFrameTask(callback) {
    var handle = 0, pending = false, value;
    var request = window.requestAnimationFrame || function (task) { return setTimeout(task, 16); };
    var cancel = window.cancelAnimationFrame || clearTimeout;
    function run() {
      handle = 0;
      if (!pending) return;
      pending = false;
      var next = value; value = undefined;
      callback(next);
    }
    return {
      request: function (next) {
        value = next; pending = true;
        if (!handle) handle = request(run);
      },
      flush: function () {
        if (!pending) return;
        if (handle) cancel(handle);
        handle = 0; run();
      },
      cancel: function () {
        if (handle) cancel(handle);
        handle = 0; pending = false; value = undefined;
      },
      pending: function () { return pending; }
    };
  }

  function createLru(options) {
    options = options || {};
    var maximumEntries = Math.max(1, Number(options.maxEntries) || 16);
    var maximumWeight = Math.max(0, Number(options.maxWeight) || 0);
    var weigh = typeof options.weight === "function" ? options.weight : function () { return 1; };
    var values = new Map(), weights = new Map(), totalWeight = 0;
    function remove(key) {
      if (!values.has(key)) return false;
      totalWeight -= weights.get(key) || 0; weights.delete(key); values.delete(key); return true;
    }
    function trim() {
      while (values.size > maximumEntries || maximumWeight && totalWeight > maximumWeight) {
        var oldest = values.keys().next();
        if (oldest.done) break;
        remove(oldest.value);
      }
    }
    return {
      get: function (key) {
        if (!values.has(key)) return undefined;
        var value = values.get(key), weight = weights.get(key);
        values.delete(key); weights.delete(key); values.set(key, value); weights.set(key, weight);
        return value;
      },
      peek: function (key) { return values.get(key); },
      has: function (key) { return values.has(key); },
      set: function (key, value) {
        remove(key);
        var weight = Math.max(0, Number(weigh(value, key)) || 0);
        values.set(key, value); weights.set(key, weight); totalWeight += weight; trim();
        return value;
      },
      delete: remove,
      clear: function () { values.clear(); weights.clear(); totalWeight = 0; },
      keys: function () { return Array.from(values.keys()); },
      stats: function () { return { entries: values.size, weight: totalWeight }; }
    };
  }

  app.runtime = { createFrameTask: createFrameTask, createLru: createLru };
})(window.vibedraw);
