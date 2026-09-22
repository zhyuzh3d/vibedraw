(function (app) {
  "use strict";
  // The public Hermit API supports text-file writes, not arbitrary binary writes.
  // Keep encoded raster bytes in bounded filesystem chunks; records only contain file references.
  var cache = app.runtime.createLru({
    maxEntries: 10,
    maxWeight: 24 * 1024 * 1024,
    weight: function (value) { return typeof value === "string" ? value.length * 2 : 1; }
  });
  var inFlight = new Map();
  async function persist(src, existing) {
    if (existing) return existing;
    if (!src) return null;
    if (inFlight.has(src)) return inFlight.get(src);
    if (src.indexOf("data:") !== 0) return { url: src };
    var bridge = app.platform.hermit.current();
    if (!bridge) throw new Error(app.i18n.text("保存图片需要在 Hermit 中打开应用", "Open in Hermit to save images"));
    var matched = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i.exec(String(src));
    var parts = matched ? { mime: matched[1] || "image/png", base64: matched[2] } : null;
    if (!parts || !/^image\/(png|jpeg|webp)$/.test(parts.mime) || app.utils.dataUrlByteLength(src) > 12 * 1024 * 1024) throw new Error(app.i18n.text("图片最大支持 12 MB 的 PNG、JPEG 或 WebP", "Use PNG, JPEG or WebP images up to 12 MB"));
    var pending = (async function () {
      var refs = [], value = parts.base64, id = app.utils.id("asset");
      try {
        for (var offset = 0; offset < value.length; offset += 720000) {
          var tasks = [];
          for (var chunkOffset = offset, position = refs.length; chunkOffset < Math.min(value.length, offset + 720000); chunkOffset += 180000, position += 1) {
            (function (partOffset, partPosition) {
              tasks.push(bridge.files.writeText({ name: id + "-" + partPosition + ".vdraw", text: value.slice(partOffset, partOffset + 180000) }).then(function (file) {
                refs[partPosition] = file.logicalFileId; return null;
              }, function (error) { return error; }));
            })(chunkOffset, position);
          }
          var errors = (await Promise.all(tasks)).filter(function (error) { return Boolean(error); });
          if (errors.length) throw errors[0];
        }
        var asset = { mime: parts.mime, parts: refs };
        cache.set(refs.join(","), src);
        return asset;
      } catch (error) {
        await Promise.all(refs.map(function (logicalFileId) { return bridge.files.delete({ logicalFileId: logicalFileId }).catch(function () {}); }));
        throw error;
      }
    })();
    inFlight.set(src, pending);
    try { return await pending; } finally { inFlight.delete(src); }
  }
  async function resolve(asset) {
    if (!asset) return "";
    if (asset.url) return asset.url;
    var key = (asset.parts || []).join(",");
    var cached = cache.get(key);
    if (cached) return cached;
    var bridge = app.platform.hermit.current(), values = new Array((asset.parts || []).length);
    if (!bridge) throw new Error(app.i18n.text("恢复图片需要 Hermit", "Hermit is required to restore images"));
    for (var index = 0; index < asset.parts.length; index += 4) {
      var tasks = [];
      for (var position = index; position < Math.min(asset.parts.length, index + 4); position += 1) {
        (function (partPosition) { tasks.push(bridge.files.readText({ logicalFileId: asset.parts[partPosition], maxBytes: 200000 }).then(function (part) { values[partPosition] = part.text; })); })(position);
      }
      await Promise.all(tasks);
    }
    if (!/^image\/(png|jpeg|webp)$/.test(asset.mime) || !values.every(function (value) { return /^[A-Za-z0-9+/=]+$/.test(value); })) throw new Error(app.i18n.text("历史图片数据损坏", "Saved image data is damaged"));
    var src = "data:" + asset.mime + ";base64," + values.join("");
    cache.set(key, src);
    return src;
  }
  function references(snapshot) {
    var refs = [];
    // The last render is artwork data and lives in the record, so its files must
    // survive the cleanup that runs when the artwork's references change.
    var items = (snapshot && snapshot.objects || []).concat(
      snapshot && snapshot.result ? [snapshot.result] : [],
      snapshot && snapshot.render ? [snapshot.render] : []);
    items.forEach(function (item) {
      if (item.asset && item.asset.parts) refs = refs.concat(item.asset.parts);
      if (item.logicalFileId) refs.push(item.logicalFileId);
    });
    return refs;
  }
  async function cleanup(removed, remaining) {
    var used = {};
    remaining.forEach(function (snapshot) { references(snapshot).forEach(function (id) { used[id] = true; }); });
    var bridge = app.platform.hermit.current();
    if (!bridge) return;
    var unique = {};
    references(removed).forEach(function (id) { if (!used[id]) unique[id] = true; });
    var ids = Object.keys(unique);
    for (var offset = 0; offset < ids.length; offset += 4) {
      await Promise.all(ids.slice(offset, offset + 4).map(function (id) { return bridge.files.delete({ logicalFileId: id }); }));
    }
    cache.keys().forEach(function (key) { if (key.split(",").some(function (id) { return unique[id]; })) cache.delete(key); });
  }
  function clearCache() { cache.clear(); }
  function performance() { return { cache: cache.stats(), inFlight: inFlight.size }; }
  app.services.assets = { persist: persist, resolve: resolve, cleanup: cleanup, references: references, clearCache: clearCache, performance: performance };
})(window.vibedraw);
