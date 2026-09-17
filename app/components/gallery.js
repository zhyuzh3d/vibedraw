(function (app) {
  "use strict";
  var t = app.i18n.text, u = app.utils, ui, session = 0, actions;
  async function open() {
    ui = app.components.ui; await app.services.store.flush();
    var root = ui.open({ title: t("历史作品", "Your artwork"), html: '<div class="gallery-tools"><input id="history-search" type="search" placeholder="' + t("搜索作品名称或描述", "Search artwork") + '" aria-label="' + t("搜索作品", "Search artwork") + '"><button class="button button-secondary" data-new><i class="fa-solid fa-plus"></i>' + t("新建", "New") + '</button></div><div class="gallery-grid" id="gallery-grid"></div><p class="field-help">' + t("作品自动保存。继续编辑会更新原作，复制可保留原作。", "Artwork saves automatically. Continue updates the original; duplicate keeps it unchanged.") + '</p>' });
    root.querySelector("[data-new]").onclick = ui.action(async function () { await actions.newWork(); });
    root.querySelector("#history-search").oninput = function (event) { render(root, event.target.value); };
    await render(root, "");
  }
  async function render(root, query) {
    var token = ++session, grid = root.querySelector("#gallery-grid");
    var list = app.services.store.list().filter(function (item) { return String(item.title || "").toLowerCase().indexOf(query.toLowerCase()) >= 0; });
    if (!list.length) {
      grid.innerHTML = '<div class="empty-state gallery-empty-full"><i class="fa-regular fa-folder-open"></i><strong>' + (query ? t("没有匹配的作品", "No matching artwork") : t("你的灵感会留在这里", "Your ideas live here")) + '</strong><p>' + t("开始绘制或输入描述后，作品就会自动保存。", "Start drawing or add a prompt to save your first work.") + '</p></div>'; return;
    }
    grid.innerHTML = list.map(function (item) {
      var id = u.escapeHtml(item.id), title = u.escapeHtml(item.title || t("未命名作品", "Untitled"));
      return '<article class="art-card" data-work="' + id + '"><button class="art-preview" data-restore="' + id + '" aria-label="' + t("继续编辑 ", "Continue ") + title + '"><canvas></canvas>' +
        (item.id === app.state.workId ? '<span class="art-current">' + t("当前作品", "Current") + '</span>' : '') +
        '</button><div class="art-meta"><span class="art-title">' + title + '</span><div class="art-date">' + new Date(item.updatedAt).toLocaleString(app.i18n.language() === "zh" ? "zh-CN" : "en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) + '</div><div class="art-actions"><button class="button button-secondary" data-restore="' + id + '">' + t("继续画", "Continue") + '</button><button class="icon-button" data-copy="' + id + '" aria-label="' + t("复制作品", "Duplicate artwork") + '"><i class="fa-regular fa-copy"></i></button><button class="icon-button" data-delete="' + id + '" aria-label="' + t("删除作品", "Delete artwork") + '"><i class="fa-regular fa-trash-can"></i></button></div></div></article>';
    }).join("");
    grid.querySelectorAll("[data-restore]").forEach(function (button) {
      button.onclick = ui.action(async function () { await restore(button.dataset.restore, false); });
    });
    grid.querySelectorAll("[data-copy]").forEach(function (button) { button.onclick = ui.action(async function () { await restore(button.dataset.copy, true); }); });
    grid.querySelectorAll("[data-delete]").forEach(function (button) {
      button.onclick = ui.action(async function () {
        if (!await ui.confirm({ title: t("删除这件作品？", "Delete this artwork?"), message: t("此操作会删除已保存的草稿与记录，无法撤销。", "The saved sketch and record will be deleted. This cannot be undone."), ok: t("删除作品", "Delete"), danger: true })) return;
        var id = button.dataset.delete;
        if (id === app.state.workId) { app.services.imageEngine.cancel(); await app.services.store.flush(); actions.resetWork(); }
        await app.services.store.remove(id);
        await render(root, root.querySelector("#history-search").value);
        ui.toast(t("作品已删除", "Artwork deleted"));
      });
    });
    for (var item of list) {
      if (token !== session || !grid.isConnected) return;
      var saved = await app.services.store.get(item.id);
      var target = grid.querySelector('[data-work="' + item.id + '"] canvas');
      if (saved && target) await app.components.canvas.thumbnail(saved, target).catch(function () {
        target.parentNode.setAttribute("aria-label", t("缩略图暂不可用，仍可继续编辑", "Preview unavailable. Continue to edit."));
      });
    }
  }
  async function restore(id, duplicate) {
    app.services.imageEngine.cancel();
    var saved = await app.services.store.restoreWork(id, duplicate);
    app.components.canvas.load(saved); actions.syncAll();
    await app.services.store.flush(); ui.close();
    ui.toast(duplicate ? t("已创建副本，可以继续画", "Copy created. Keep drawing.") : t("作品已恢复，继续创作吧", "Artwork restored. Keep creating."));
  }
  app.components.gallery = { init: function (handlers) { actions = handlers; }, open: open, restore: restore };
})(window.vibedraw);
