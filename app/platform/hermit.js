(function (app) {
  "use strict";

  var ready = false;
  var waiters = [];

  // The page-to-host transport drops any single message larger than 256 KiB
  // without a reply or an error, which leaves the caller waiting for its own
  // timeout. Every inline request body therefore stays well below that.
  var MESSAGE_CHARS = 200000;

  function current() { return window.hermit && window.hermit.isReady ? window.hermit : null; }
  function markReady() {
    if (!current()) return;
    ready = true;
    waiters.splice(0).forEach(function (resolve) { resolve(true); });
    app.events.emit("platform:ready", true);
  }
  window.addEventListener("hermitready", markReady);
  if (current()) markReady();

  function awaitReady(timeoutMs) {
    if (ready || current()) { markReady(); return Promise.resolve(true); }
    return new Promise(function (resolve) {
      var done = false;
      function finish(value) { if (done) return; done = true; resolve(value); }
      waiters.push(finish);
      setTimeout(function () {
        waiters = waiters.filter(function (item) { return item !== finish; });
        finish(Boolean(current()));
      }, typeof timeoutMs === "number" ? timeoutMs : 1200);
    });
  }

  function localized(zh, en) { return app.i18n && app.i18n.text ? app.i18n.text(zh, en) : zh; }

  function checkBudget(options) {
    var size = typeof options.bodyText === "string" ? options.bodyText.length
      : options.bodyBytes ? Math.ceil(options.bodyBytes.length / 3) * 4 : 0;
    if (size <= MESSAGE_CHARS) return;
    var kb = Math.round(size / 1024);
    throw new Error(localized("这次要发送的数据有 " + kb + " KB，超过了宿主单次请求的上限。请减少画布上的图片元素，或改用更小的画幅后重试",
      "This request carries " + kb + " KB, above what the host accepts in one message. Remove image elements from the canvas or use a smaller size and retry."));
  }

  async function request(options) {
    app.utils.validateEndpoint(options.url);
    checkBudget(options);
    var headers = options.headers || {};
    if (current() || await awaitReady(800)) {
      var params = {
        url: options.url,
        method: String(options.method || "GET").toUpperCase(),
        headers: headers,
        timeoutMs: options.timeoutMs || 60000
      };
      if (options.bodyBytes) {
        params.bodyBase64 = app.utils.bytesToBase64(options.bodyBytes);
        params.contentType = options.contentType || "application/octet-stream";
      } else if (typeof options.bodyText === "string") {
        params.bodyText = options.bodyText;
        params.contentType = options.contentType || "application/json";
      }
      return current().network.request(params);
    }
    var controller = typeof AbortController === "function" ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, options.timeoutMs || 60000) : null;
    try {
      var response = await fetch(options.url, {
        method: String(options.method || "GET").toUpperCase(),
        headers: headers,
        body: options.bodyBytes || options.bodyText,
        signal: controller ? controller.signal : undefined
      });
      var responseHeaders = {};
      response.headers.forEach(function (value, name) { responseHeaders[name] = value; });
      var type = response.headers.get("content-type") || "application/octet-stream";
      if (/json|text|xml/i.test(type)) return { status: response.status, headers: responseHeaders, url: response.url, bodyText: await response.text() };
      return { status: response.status, headers: responseHeaders, url: response.url, bodyBase64: app.utils.bytesToBase64(new Uint8Array(await response.arrayBuffer())) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function requestJson(options) {
    var response = await request(options), payload = app.utils.parseJson(response.bodyText || "", null);
    if (response.status < 200 || response.status >= 300) throw httpError(response, payload, options.headers);
    if (!payload) throw new Error("服务返回的不是有效 JSON");
    return { response: response, data: payload };
  }
  function httpError(response, payload, headers) {
    var detail = payload && (payload.error || payload.detail || payload.message) || response.bodyText || "服务未返回可读错误";
    if (detail && typeof detail === "object") detail = detail.message || detail.code || JSON.stringify(detail);
    Object.keys(headers || {}).forEach(function (name) {
      if (!/authorization|key|token|secret/i.test(name)) return;
      var secret = String(headers[name] || "").replace(/^Bearer\s+/i, "");
      if (secret.length > 3) detail = String(detail).split(secret).join("***");
    });
    var category = response.status === 401 ? "认证失败" : response.status === 403 ? "权限不足" : response.status === 429 ? "额度或频率限制" : response.status >= 500 ? "服务端错误" : "请求失败";
    var error = new Error(category + "（" + response.status + "）：" + String(detail).slice(0, 300));
    error.status = response.status;
    return error;
  }

  async function getData(collection, key) {
    if (current() || await awaitReady(800)) return current().data.get({ collection: collection, key: key });
    var stored = localStorage.getItem("vibedraw:" + collection + ":" + key);
    return stored ? { collection: collection, key: key, value: app.utils.parseJson(stored, null), revision: "browser" } : null;
  }
  async function putData(collection, key, value, expectedRevision) {
    if (current() || await awaitReady(800)) {
      var params = { collection: collection, key: key, value: value };
      if (expectedRevision) params.expectedRevision = expectedRevision;
      return current().data.put(params);
    }
    localStorage.setItem("vibedraw:" + collection + ":" + key, JSON.stringify(value));
    return { collection: collection, key: key, value: value, revision: "browser" };
  }
  async function pickImage() {
    if (current() || await awaitReady(500)) return current().files.pickImage({ maxDimension: 2048, maxBytes: 12 * 1024 * 1024 });
    return null;
  }
  async function deleteData(collection, key) {
    if (current() || await awaitReady(800)) return current().data.delete({ collection: collection, key: key });
    localStorage.removeItem("vibedraw:" + collection + ":" + key);
    return { deleted: true };
  }
  async function clipboardRead() {
    if (current() || await awaitReady(500)) {
      var result = await current().clipboard.read();
      return String(result && result.text || "");
    }
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.readText();
    throw new Error("当前环境不能读取剪贴板，请长按输入框粘贴");
  }
  async function reportTheme() {
    if (!(current() || await awaitReady(500))) return;
    var dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;
    await current().appearance.reportTheme({ theme: dark ? "dark" : "light" }).catch(function () {});
  }
  async function appReady() {
    if (current() || await awaitReady(1000)) await current().app.ready().catch(function () {});
  }

  app.platform.hermit = {
    messageChars: MESSAGE_CHARS,
    current: current,
    available: function () { return Boolean(current()); },
    awaitReady: awaitReady,
    request: request,
    requestJson: requestJson,
    httpError: httpError,
    getData: getData,
    putData: putData,
    deleteData: deleteData,
    pickImage: pickImage,
    clipboardRead: clipboardRead,
    reportTheme: reportTheme,
    appReady: appReady
  };
})(window.vibedraw);
