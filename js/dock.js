// Extensões no estilo Owlbear: botões na doca, janela da ação, fundo sempre ativo, modais e popovers.
import { EXT_LIST_ID, DEFAULT_EXTENSIONS } from "./obr-host.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export class Dock {
  constructor(app) {
    this.app = app;
    this.obr = app.obr;
    this.net = app.net;
    this.stage = document.querySelector(".stage");
    this.dockEl = document.getElementById("ext-dock");
    this.bgHost = document.getElementById("ext-bg");
    this.exts = new Map();     // url -> ext
    this.modals = new Map();   // id -> {el, frame}
    this.pops = new Map();     // id -> {el, frame, w, h, opts}
    this.z = 30;
    document.addEventListener("pointerdown", (e) => this._clickAway(e), true);
    window.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      const last = [...this.modals.values()].pop();
      if (last && !last.opts.hidePaper) this.closeModal(last.id);
    });
    this.net.onChange((ent, id) => { if (id === EXT_LIST_ID) this.sync(); });
  }

  urls() {
    const e = this.net.get(EXT_LIST_ID);
    return e ? (e.data.urls || []) : DEFAULT_EXTENSIONS;
  }
  async saveUrls(urls) { await this.net.put({ id: EXT_LIST_ID, kind: "config", data: { urls } }); }

  async sync() {
    const want = this.urls();
    for (const [url, ext] of this.exts) if (!want.includes(url)) this._unload(ext);
    for (const url of want) if (!this.exts.has(url)) await this._load(url);
    // mantém a ordem da lista
    this.exts = new Map(want.filter(u => this.exts.has(u)).map(u => [u, this.exts.get(u)]));
    this.renderButtons();
    this.app.renderExtManager?.();
  }

  async _load(url) {
    const ext = { url, base: url, title: url, icon: "", error: "", manifest: null, win: null, bg: null };
    this.exts.set(url, ext);
    try {
      const r = await fetch(url, { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const m = await r.json();
      ext.manifest = m;
      ext.title = m.action?.title || m.name || url;
      ext.name = m.name || ext.title;
      ext.icon = m.action?.icon ? new URL(m.action.icon, url).href : "";
      ext.popover = m.action?.popover ? new URL(m.action.popover, url).href : "";
      ext.w = m.action?.width || 400; ext.h = m.action?.height || 600;
      if (m.background_url) {
        ext.bg = this.obr.makeFrame(new URL(m.background_url, url).href, ext, "background");
        this.bgHost.appendChild(ext.bg.el);
      }
    } catch (err) {
      ext.error = "Não consegui carregar: " + err.message;
    }
  }
  _unload(ext) {
    this.close(ext, true);
    this.obr.dropFrame(ext.bg);
    for (const [id, m] of this.modals) if (m.ext === ext) this.closeModal(id);
    for (const [id, p] of this.pops) if (p.ext === ext) this.closePopover(id);
    this.exts.delete(ext.url);
  }

  renderButtons() {
    this.dockEl.innerHTML = "";
    for (const ext of this.exts.values()) {
      const b = document.createElement("button");
      b.className = "dock-btn" + (this.isOpen(ext) ? " on" : "") + (ext.error ? " err" : "");
      b.title = ext.error || ext.title;
      b.innerHTML = ext.icon ? `<img src="${esc(ext.icon)}" alt="">` : `<span>${esc((ext.title || "?").slice(0, 2))}</span>`;
      if (ext.badge) b.insertAdjacentHTML("beforeend", `<i class="badge" style="${ext.badgeColor ? `background:${esc(ext.badgeColor)}` : ""}">${esc(ext.badge)}</i>`);
      b.onclick = () => (this.isOpen(ext) ? this.close(ext) : this.open(ext));
      this.dockEl.appendChild(b);
    }
  }

  // ---------- janela da ação ----------
  isOpen(ext) { return !!ext?.win && !ext.win.el.hidden; }
  size(ext) { return ext?.win ? { w: ext.win.w, h: ext.win.h } : { w: ext?.w, h: ext?.h }; }
  open(ext) {
    if (!ext || !ext.popover) return;
    if (!ext.win) {
      const el = document.createElement("div");
      el.className = "ext-win";
      el.innerHTML = `<header><img src="${esc(ext.icon)}" alt=""><span>${esc(ext.title)}</span><button class="mini ghost" data-close title="Fechar">✕</button></header>`;
      const f = this.obr.makeFrame(ext.popover, ext, "action");
      el.appendChild(f.el);
      el.querySelector("[data-close]").onclick = () => this.close(ext);
      this._draggable(el, el.querySelector("header"));
      this.stage.appendChild(el);
      const idx = [...this.exts.values()].indexOf(ext);
      ext.win = { el, frame: f, w: ext.w, h: ext.h, x: 64 + idx * 24, y: 10 + idx * 24 };
      this._place(ext.win);
    }
    ext.win.el.hidden = false;
    ext.win.el.style.zIndex = ++this.z;
    this.renderButtons(); this.obr.actionChanged();
  }
  close(ext, destroy = false) {
    if (!ext?.win) return;
    if (destroy) { this.obr.dropFrame(ext.win.frame); ext.win.el.remove(); ext.win = null; }
    else ext.win.el.hidden = true;
    this.renderButtons(); this.obr.actionChanged();
  }
  resize(ext, w, h) { if (!ext?.win) { if (w) ext.w = w; if (h) ext.h = h; return; } if (w) ext.win.w = w; if (h) ext.win.h = h; this._place(ext.win); }
  _place(win) {
    const r = this.stage.getBoundingClientRect();
    const w = Math.min(win.w, r.width - 16), h = Math.min(win.h + 34, r.height - 16);
    win.x = Math.max(8, Math.min(win.x, r.width - w - 8)); win.y = Math.max(8, Math.min(win.y, r.height - h - 8));
    Object.assign(win.el.style, { width: w + "px", height: h + "px", left: win.x + "px", top: win.y + "px" });
  }
  _draggable(el, handle) {
    handle.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;
      const win = [...this.exts.values()].find(x => x.win?.el === el)?.win;
      el.style.zIndex = ++this.z;
      const sx = e.clientX, sy = e.clientY, ox = el.offsetLeft, oy = el.offsetTop;
      el.classList.add("dragging");
      const mv = (ev) => { const x = ox + ev.clientX - sx, y = oy + ev.clientY - sy; el.style.left = x + "px"; el.style.top = y + "px"; if (win) { win.x = x; win.y = y; } };
      const up = () => { el.classList.remove("dragging"); window.removeEventListener("pointermove", mv); window.removeEventListener("pointerup", up); };
      window.addEventListener("pointermove", mv); window.addEventListener("pointerup", up);
    });
  }

  // ---------- modais ----------
  openModal(ext, opts) {
    this.closeModal(opts.id);
    const el = document.createElement("div");
    el.className = "ext-modal" + (opts.hideBackdrop ? " no-backdrop" : "") + (opts.disablePointerEvents ? " no-pointer" : "");
    const box = document.createElement("div");
    box.className = "ext-modal-box" + (opts.fullScreen ? " full" : "") + (opts.hidePaper ? " no-paper" : "");
    if (!opts.fullScreen) { box.style.width = `min(${opts.width || 600}px, 96vw)`; box.style.height = `min(${opts.height || 500}px, 92vh)`; }
    const f = this.obr.makeFrame(opts.url, ext, "modal");
    box.appendChild(f.el);
    if (!opts.hidePaper) {
      const x = document.createElement("button"); x.className = "close"; x.textContent = "✕"; x.title = "Fechar";
      x.onclick = () => this.closeModal(opts.id); box.appendChild(x);
    }
    el.appendChild(box);
    if (!opts.hideBackdrop && !opts.disablePointerEvents) el.addEventListener("pointerdown", (e) => { if (e.target === el) this.closeModal(opts.id); });
    document.body.appendChild(el);
    this.modals.set(opts.id, { id: opts.id, el, frame: f, ext, opts });
  }
  closeModal(id) {
    const m = this.modals.get(id); if (!m) return;
    this.obr.dropFrame(m.frame); m.el.remove(); this.modals.delete(id);
  }

  // ---------- popovers ----------
  openPopover(ext, o) {
    this.closePopover(o.id);
    const el = document.createElement("div");
    el.className = "ext-pop" + (o.hidePaper ? " no-paper" : "");
    const f = this.obr.makeFrame(o.url, ext, "popover");
    el.appendChild(f.el);
    this.stage.appendChild(el);
    const p = { id: o.id, el, frame: f, ext, w: o.width || 300, h: o.height || 300, opts: o, opened: performance.now() };
    this.pops.set(o.id, p);
    this._placePop(p);
  }
  _placePop(p) {
    const o = p.opts, r = this.stage.getBoundingClientRect();
    const w = Math.min(p.w, r.width - 8), h = Math.min(p.h, r.height - 8);
    let ax = r.width / 2, ay = r.height / 2;
    if (o.anchorReference === "POSITION" && o.anchorPosition) { ax = o.anchorPosition.left; ay = o.anchorPosition.top; }
    else if (o.anchorElementId) {
      const a = document.getElementById(o.anchorElementId)?.getBoundingClientRect();
      if (a) { ax = a.left - r.left + a.width / 2; ay = a.bottom - r.top; }
    }
    const to = o.transformOrigin || { horizontal: "CENTER", vertical: "TOP" };
    let x = to.horizontal === "LEFT" ? ax : to.horizontal === "RIGHT" ? ax - w : ax - w / 2;
    let y = to.vertical === "TOP" ? ay : to.vertical === "BOTTOM" ? ay - h : ay - h / 2;
    x = Math.max(4, Math.min(x, r.width - w - 4)); y = Math.max(4, Math.min(y, r.height - h - 4));
    Object.assign(p.el.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px", zIndex: ++this.z });
  }
  closePopover(id) {
    const p = this.pops.get(id); if (!p) return;
    this.obr.dropFrame(p.frame); p.el.remove(); this.pops.delete(id);
  }
  popoverSize(id) { const p = this.pops.get(id); return p ? { w: p.w, h: p.h } : null; }
  resizePopover(id, w, h) { const p = this.pops.get(id); if (!p) return; if (w) p.w = w; if (h) p.h = h; this._placePop(p); }
  _clickAway(e) {
    for (const p of [...this.pops.values()]) {
      if (p.opts.disableClickAway || p.el.contains(e.target)) continue;
      if (performance.now() - p.opened < 250) continue;
      this.closePopover(p.id);
    }
  }
}
