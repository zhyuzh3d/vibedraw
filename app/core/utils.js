(function (app) {
  "use strict";

  function clamp(value, min, max) { return Math.min(max, Math.max(min, Number(value) || 0)); }
  function copy(value) { return JSON.parse(JSON.stringify(value)); }
  function id(prefix) { return String(prefix || "id") + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8); }
  function parseJson(value, fallback) { try { return JSON.parse(value); } catch (_) { return fallback; } }
  function sleep(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function stripSlash(value) { return String(value || "").replace(/\/+$/, ""); }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (char) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char];
    });
  }
  function cleanError(error) {
    var message = error && error.message ? error.message : String(error || "未知错误");
    if (app.i18n) message = app.i18n.error(message);
    return message.replace(/Bearer\s+[^\s]+/gi, "Bearer ***").replace(/sk-[A-Za-z0-9_-]{8,}/g, "***").slice(0, 500);
  }
  function validateEndpoint(value) {
    var parsed;
    try { parsed = new URL(String(value || "")); } catch (_) { throw new Error("服务地址必须是完整的 HTTP(S) URL"); }
    if (["http:", "https:"].indexOf(parsed.protocol) < 0 || parsed.username || parsed.password || parsed.hash) {
      throw new Error("服务地址只能使用无账号信息的 HTTP(S) URL");
    }
    if (parsed.protocol === "http:" && !isPrivateHost(parsed.hostname)) {
      throw new Error("公网服务必须使用 HTTPS；HTTP 仅允许可信局域网地址");
    }
    return parsed.toString();
  }
  function isPrivateHost(host) {
    var value = String(host || "").toLowerCase();
    return value === "localhost" || value === "127.0.0.1" || value === "::1" || value === "10.0.2.2" ||
      /^10\./.test(value) || /^192\.168\./.test(value) || /^172\.(1[6-9]|2\d|3[01])\./.test(value) || /\.local$/.test(value);
  }
  function parseHeaders(text) {
    if (!String(text || "").trim()) return {};
    var value = parseJson(text, null);
    if (!value || Object.prototype.toString.call(value) !== "[object Object]") throw new Error("自定义 Header 必须是 JSON 对象");
    var result = {};
    Object.keys(value).forEach(function (key) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key)) throw new Error("Header 名称不合法：" + key);
      if (/^(host|content-length)$/i.test(key)) throw new Error("不能自定义 " + key + " Header");
      result[key] = String(value[key]);
    });
    return result;
  }
  function merge(target, source) {
    var output = copy(target || {});
    Object.keys(source || {}).forEach(function (key) {
      if (source[key] && Object.prototype.toString.call(source[key]) === "[object Object]" && output[key] && Object.prototype.toString.call(output[key]) === "[object Object]") {
        output[key] = merge(output[key], source[key]);
      } else {
        output[key] = source[key];
      }
    });
    return output;
  }
  function bytesToBase64(bytes) {
    var result = "", chunk = 0x8000;
    for (var index = 0; index < bytes.length; index += chunk) {
      result += String.fromCharCode.apply(null, bytes.subarray(index, Math.min(index + chunk, bytes.length)));
    }
    return btoa(result);
  }
  function base64ToBytes(value) {
    var binary = atob(String(value || "").replace(/\s/g, ""));
    var bytes = new Uint8Array(binary.length);
    for (var index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }
  function utf8Bytes(value) {
    if (typeof TextEncoder === "function") return new TextEncoder().encode(String(value));
    var encoded = unescape(encodeURIComponent(String(value))), bytes = new Uint8Array(encoded.length);
    for (var index = 0; index < encoded.length; index += 1) bytes[index] = encoded.charCodeAt(index);
    return bytes;
  }
  function concatBytes(parts) {
    var total = parts.reduce(function (sum, part) { return sum + part.length; }, 0);
    var output = new Uint8Array(total), offset = 0;
    parts.forEach(function (part) { output.set(part, offset); offset += part.length; });
    return output;
  }
  function dataUrlParts(dataUrl) {
    var match = /^data:([^;,]+)?(?:;charset=[^;,]+)?;base64,(.+)$/i.exec(String(dataUrl || ""));
    if (!match) throw new Error("画布图像格式异常");
    return { mime: match[1] || "image/png", base64: match[2], bytes: base64ToBytes(match[2]) };
  }
  function multipart(fields, files) {
    var boundary = "----VibeDraw" + Math.random().toString(16).slice(2) + Date.now().toString(16);
    var chunks = [];
    Object.keys(fields || {}).forEach(function (name) {
      var value = fields[name];
      if (value == null || value === "") return;
      chunks.push(utf8Bytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + name + "\"\r\n\r\n" + String(value) + "\r\n"));
    });
    (files || []).forEach(function (file) {
      chunks.push(utf8Bytes("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + file.name + "\"; filename=\"" + (file.filename || "image.png") + "\"\r\nContent-Type: " + (file.mime || "image/png") + "\r\n\r\n"));
      chunks.push(file.bytes);
      chunks.push(utf8Bytes("\r\n"));
    });
    chunks.push(utf8Bytes("--" + boundary + "--\r\n"));
    return { bytes: concatBytes(chunks), contentType: "multipart/form-data; boundary=" + boundary };
  }
  function imageMimeFromHeaders(headers, fallback) {
    var keys = Object.keys(headers || {}), type = "";
    keys.some(function (name) { if (name.toLowerCase() === "content-type") { type = headers[name]; return true; } return false; });
    type = String(type || fallback || "image/png").split(";")[0].trim();
    return /^image\//.test(type) ? type : "image/png";
  }

  app.utils = {
    clamp: clamp,
    copy: copy,
    id: id,
    parseJson: parseJson,
    sleep: sleep,
    stripSlash: stripSlash,
    escapeHtml: escapeHtml,
    cleanError: cleanError,
    validateEndpoint: validateEndpoint,
    isPrivateHost: isPrivateHost,
    parseHeaders: parseHeaders,
    merge: merge,
    bytesToBase64: bytesToBase64,
    base64ToBytes: base64ToBytes,
    utf8Bytes: utf8Bytes,
    concatBytes: concatBytes,
    dataUrlParts: dataUrlParts,
    multipart: multipart,
    imageMimeFromHeaders: imageMimeFromHeaders
  };
})(window.vibedraw);
