(function (app) {
  "use strict";
  // The public Hermit API supports text-file writes, not arbitrary binary writes.
  // Keep encoded raster bytes in bounded filesystem chunks; records only contain file references.
  var cache = {}, inFlight = {};
  async function persist(src, existing) {
    if (existing) return existing;
    if (!src) return null;
    if (inFlight[src]) return inFlight[src];
    if (src.indexOf("data:") !== 0) return { url: src };
    var bridge = app.platform.hermit.current();
    if (!bridge) throw new Error(app.i18n.text("保存图片需要在 Hermit 中打开应用", "Open in Hermit to save images"));
    var parts = app.utils.dataUrlParts(src);
    if (!/^image\/(png|jpeg|webp)$/.test(parts.mime) || parts.bytes.length > 12 * 1024 * 1024) throw new Error(app.i18n.text("图片最大支持 12 MB 的 PNG、JPEG 或 WebP", "Use PNG, JPEG or WebP images up to 12 MB"));
    inFlight[src] = (async function () {
      var refs = [], value = parts.base64, id = app.utils.id("asset");
      try {
        for (var offset = 0; offset < value.length; offset += 180000) {
          var file = await bridge.files.writeText({ name: id + "-" + refs.length + ".vdraw", text: value.slice(offset, offset + 180000) });
          refs.push(file.logicalFileId);
        }
        var asset = { mime: parts.mime, parts: refs };
        cache[refs.join(",")] = src;
        return asset;
      } catch (error) {
        await Promise.all(refs.map(function (logicalFileId) { return bridge.files.delete({ logicalFileId: logicalFileId }).catch(function () {}); }));
        throw error;
      }
    })();
    try { return await inFlight[src]; } finally { delete inFlight[src]; }
  }
  async function resolve(asset) {
    if (!asset) return "";
    if (asset.url) return asset.url;
    var key = (asset.parts || []).join(",");
    if (cache[key]) return cache[key];
    var bridge = app.platform.hermit.current(), values = [];
    if (!bridge) throw new Error(app.i18n.text("恢复图片需要 Hermit", "Hermit is required to restore images"));
    for (var index = 0; index < asset.parts.length; index += 1) {
      var part = await bridge.files.readText({ logicalFileId: asset.parts[index], maxBytes: 200000 });
      values.push(part.text);
    }
    if (!/^image\/(png|jpeg|webp)$/.test(asset.mime) || !values.every(function (value) { return /^[A-Za-z0-9+/=]+$/.test(value); })) throw new Error(app.i18n.text("历史图片数据损坏", "Saved image data is damaged"));
    cache[key] = "data:" + asset.mime + ";base64," + values.join("");
    return cache[key];
  }
  function references(snapshot) {
    var refs = [];
    (snapshot && snapshot.objects || []).concat(snapshot && snapshot.result ? [snapshot.result] : []).forEach(function (item) {
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
    for (var id of Object.keys(unique)) await bridge.files.delete({ logicalFileId: id });
    Object.keys(cache).forEach(function (key) { if (key.split(",").some(function (id) { return unique[id]; })) delete cache[key]; });
  }
  function clearCache() { cache = {}; }
  app.services.assets = { persist: persist, resolve: resolve, cleanup: cleanup, references: references, clearCache: clearCache };
})(window.vibedraw);
