(function (app) {
  "use strict";
  var t = app.i18n.text, u = app.utils, ui, session = 0, actions, previewObserver = null, moreObserver = null;
  var previewQueue = [], previewRunning = false, PREVIEW_ATTEMPTS = 3;
  var PAGE_SIZE = 12, MAX_LIVE_PREVIEWS = 24, drawnPreviews = [];
  function wait(ms) { return new Promise(function (resolve) { setTimeout(resolve, ms); }); }
  function stopPreviews() {
    session += 1; previewQueue = []; drawnPreviews = [];
    if (previewObserver) previewObserver.disconnect(); previewObserver = null;
    if (moreObserver) moreObserver.disconnect(); moreObserver = null;
  }
  async function open() {
    ui = app.components.ui; await app.services.store.flush();
    var root = ui.open({ title: t("历史作品", "Your artwork"), beforeClose: function () { stopPreviews(); return true; }, html: '<div class="gallery-tools"><input id="history-search" type="search" placeholder="' + t("搜索作品名称或描述", "Search artwork") + '" aria-label="' + t("搜索作品", "Search artwork") + '"><button class="button button-secondary" data-new><i class="fa-solid fa-plus"></i>' + t("新建", "New") + '</button></div><div class="gallery-grid" id="gallery-grid"></div><p class="field-help">' + t("作品自动保存。继续编辑会更新原作，复制可保留原作。", "Artwork saves automatically. Continue updates the original; duplicate keeps it unchanged.") + '</p>' });
    root.querySelector("[data-new]").onclick = ui.action(async function () { stopPreviews(); await actions.newWork(); });
    root.querySelector("#history-search").oninput = function (event) { render(root, event.target.value); };
    await render(root, "");
  }
  function cardMarkup(item) {
    var id = u.escapeHtml(item.id), title = u.escapeHtml(item.title || t("未命名作品", "Untitled"));
    return '<article class="art-card" data-work="' + id + '"><button class="art-preview" data-restore="' + id + '" aria-label="' + t("继续编辑 ", "Continue ") + title + '"><canvas></canvas>' +
      (item.id === app.state.workId ? '<span class="art-current">' + t("当前作品", "Current") + '</span>' : '') +
      '</button><div class="art-meta"><span class="art-title">' + title + '</span><div class="art-date">' + new Date(item.updatedAt).toLocaleString(app.i18n.language() === "zh" ? "zh-CN" : "en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + '</div><div class="art-actions"><button class="button button-secondary" data-restore="' + id + '">' + t("继续画", "Continue") + '</button><button class="icon-button" data-copy="' + id + '" aria-label="' + t("复制作品", "Duplicate artwork") + '"><i class="fa-regular fa-copy"></i></button><button class="icon-button" data-delete="' + id + '" aria-label="' + t("删除作品", "Delete artwork") + '"><i class="fa-regular fa-trash-can"></i></button></div></div></article>';
  }
  // A long library must not be built all at once. Cards arrive a page at a time as the end of
  // the grid comes into view, and a card only gets a cover when it reaches the screen; the
  // drawn ones are then given back, oldest first, once the list holds more of them than a
  // screenful or two can show. Without both halves a few hundred works means a few hundred
  // 288px canvases — a third of a megabyte each — and the list stops responding long before
  // the user reaches the end of it.
  async function render(root, query) {
    var token = ++session, grid = root.querySelector("#gallery-grid");
    previewQueue = []; drawnPreviews = [];
    if (previewObserver) { previewObserver.disconnect(); previewObserver = null; }
    if (moreObserver) { moreObserver.disconnect(); moreObserver = null; }
    var list = app.services.store.list().filter(function (item) { return String(item.title || "").toLowerCase().indexOf(query.toLowerCase()) >= 0; });
    if (!list.length) {
      grid.innerHTML = '<div class="empty-state gallery-empty-full"><i class="fa-regular fa-folder-open"></i><strong>' + (query ? t("没有匹配的作品", "No matching artwork") : t("你的灵感会留在这里", "Your ideas live here")) + '</strong><p>' + t("开始绘制或输入描述后，作品就会自动保存。", "Start drawing or add a prompt to save your first work.") + '</p></div>'; return;
    }
    grid.innerHTML = "";
    var observer = createPreviewObserver(grid, list, token), sentinel = document.createElement("div"), shown = 0;
    sentinel.className = "gallery-sentinel";
    grid.appendChild(sentinel);
    function appendPage() {
      var page = list.slice(shown, shown + PAGE_SIZE);
      if (!page.length) return false;
      shown += page.length;
      sentinel.insertAdjacentHTML("beforebegin", page.map(cardMarkup).join(""));
      grid.querySelectorAll("[data-work]:not([data-bound])").forEach(function (card) {
        card.dataset.bound = "1"; bindCard(card, root);
        var item = list.find(function (value) { return value.id === card.dataset.work; });
        if (!item) return;
        if (observer) observer.observe(card); else enqueuePreview(grid, item, token);
      });
      return true;
    }
    appendPage();
    if (observer) {
      moreObserver = new IntersectionObserver(function (entries) {
        if (!entries.some(function (entry) { return entry.isIntersecting; })) return;
        if (!appendPage()) { moreObserver.disconnect(); moreObserver = null; }
      }, { rootMargin: "400px 0px" });
      moreObserver.observe(sentinel);
    } else {
      while (appendPage()) { /* no IntersectionObserver: everything at once is the only option */ }
    }
  }
  function bindCard(card, root) {
    card.querySelectorAll("[data-restore]").forEach(function (button) {
      button.onclick = ui.action(async function () { await restore(button.dataset.restore, false); });
    });
    card.querySelectorAll("[data-copy]").forEach(function (button) { button.onclick = ui.action(async function () { await restore(button.dataset.copy, true); }); });
    card.querySelectorAll("[data-delete]").forEach(function (button) {
      button.onclick = ui.action(async function () {
        if (!await ui.confirm({ title: t("删除这件作品？", "Delete this artwork?"), message: t("此操作会删除已保存的草稿与记录，无法撤销。", "The saved sketch and record will be deleted. This cannot be undone."), ok: t("删除作品", "Delete"), danger: true })) return;
        var id = button.dataset.delete;
        if (id === app.state.workId) { app.services.imageEngine.cancel(); await app.services.store.flush(); actions.resetWork(); }
        await app.services.store.remove(id);
        await render(root, root.querySelector("#history-search").value);
        ui.toast(t("作品已删除", "Artwork deleted"));
      });
    });
  }
  // Covers load lazily and one at a time. The observer enqueues a card the moment it enters
  // the viewport, and a single worker draws the queue in turn. Loading the visible cards in
  // parallel made the host answer `Too many concurrent Hermit requests` as soon as a few
  // records had to be reassembled from their storage chunks at the same moment, and that
  // failure left those cards blank for good: a card the list draws once and never revisits
  // has nowhere to recover. The queue keeps the burst inside what the host accepts, and the
  // bounded retry turns a leftover collision into a card that arrives a moment later.
  function enqueuePreview(grid, item, token) {
    var card = grid.querySelector('[data-work="' + item.id + '"]');
    if (!card || card.dataset.previewState) return;
    card.dataset.previewState = "queued";
    previewQueue.push({ grid: grid, item: item, token: token });
    drainPreviews();
  }
  async function drainPreviews() {
    if (previewRunning) return;
    previewRunning = true;
    try {
      while (previewQueue.length) {
        var job = previewQueue.shift();
        await loadPreview(job.grid, job.item, job.token);
        if (job.token !== session) { previewQueue = []; return; }
      }
    } finally { previewRunning = false; }
  }
  async function loadPreview(grid, item, token) {
    if (token !== session || !grid.isConnected) return;
    var card = grid.querySelector('[data-work="' + item.id + '"]');
    if (!card || card.dataset.previewState === "ready") return;
    card.dataset.previewState = "loading";
    for (var attempt = 0; attempt < PREVIEW_ATTEMPTS; attempt += 1) {
      try {
        var saved = await app.services.store.get(item.id);
        var target = card.querySelector("canvas");
        if (saved && target && token === session && grid.isConnected) await app.components.canvas.thumbnail(saved, target);
        card.dataset.previewState = "ready";
        rememberPreview(card);
        return;
      } catch (_) {
        if (attempt + 1 < PREVIEW_ATTEMPTS) await wait(220 * (attempt + 1));
      }
      if (token !== session || !grid.isConnected) return;
    }
    card.dataset.previewState = "error";
    var button = card.querySelector(".art-preview");
    if (button) button.setAttribute("aria-label", t("缩略图暂不可用，仍可继续编辑", "Preview unavailable. Continue to edit."));
  }
  function createPreviewObserver(grid, list, token) {
    if (!("IntersectionObserver" in window)) return null;
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        observer.unobserve(entry.target);
        var item = list.find(function (value) { return value.id === entry.target.dataset.work; });
        if (item) enqueuePreview(grid, item, token);
      });
    }, { rootMargin: "180px 0px" });
    previewObserver = observer;
    return observer;
  }
  // Only a bitmap that has scrolled clear of the screen may be given back: releasing one the
  // user is looking at would only make it redraw and put the list in a loop.
  function offScreen(card) {
    var box = card.getBoundingClientRect();
    return box.bottom < -240 || box.top > (window.innerHeight || 0) + 240;
  }
  function rememberPreview(card) {
    drawnPreviews = drawnPreviews.filter(function (value) { return value !== card && value.isConnected; });
    drawnPreviews.push(card);
    while (drawnPreviews.length > MAX_LIVE_PREVIEWS) {
      var stale = drawnPreviews.filter(offScreen)[0];
      if (!stale) break;
      drawnPreviews = drawnPreviews.filter(function (value) { return value !== stale; });
      releasePreview(stale);
    }
  }
  function releasePreview(card) {
    var target = card.querySelector("canvas");
    if (target) { target.width = 0; target.height = 0; }
    delete card.dataset.previewState;
    if (previewObserver && card.isConnected) previewObserver.observe(card);
  }
  async function restore(id, duplicate) {
    stopPreviews();
    app.services.imageEngine.cancel();
    var saved = await app.services.store.restoreWork(id, duplicate);
    app.components.canvas.load(saved); actions.syncAll();
    await app.services.store.flush(); ui.close();
    ui.toast(duplicate ? t("已创建副本，可以继续画", "Copy created. Keep drawing.") : t("作品已恢复，继续创作吧", "Artwork restored. Keep creating."));
  }
  app.components.gallery = { init: function (handlers) { actions = handlers; }, open: open, restore: restore };
})(window.vibedraw);
