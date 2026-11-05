import { Net, uid, online, shrinkImage } from "./net.js";
import { Board, SCENE_ID, DEFAULT_SCENE } from "./board.js";
import { Sheets } from "./sheets.js";
import { Chat } from "./chat.js";
import { ObrHost, DEFAULT_EXTENSIONS } from "./obr-host.js";
import { Dock } from "./dock.js";

const $ = (s) => document.querySelector(s);
const COLORS = ["#e8c26a", "#d9534f", "#5bc0de", "#7bd389", "#c38bf0", "#f0a35b", "#f07fb3", "#9fb4ff"];

function loadMe() {
  let me = null;
  try { me = JSON.parse(localStorage.getItem("mesa-me")); } catch {}
  if (!me?.id) me = { id: uid(12), name: "", color: COLORS[Math.floor(Math.random() * COLORS.length)] };
  return me;
}
function saveMe(me) { localStorage.setItem("mesa-me", JSON.stringify(me)); }

function parseHash() {
  const h = new URLSearchParams(location.hash.slice(1));
  return { sala: (h.get("sala") || "").toLowerCase().replace(/[^a-z0-9-]/g, ""), mestre: h.get("mestre") || "" };
}

class App {
  constructor() {
    this.me = loadMe();
    this.presence = new Map();
    this._lobby();
  }

  // ---------------- lobby ----------------
  _lobby() {
    const { sala, mestre } = parseHash();
    $("#name").value = this.me.name;
    $("#mode-note").textContent = online ? "Servidor online configurado." : "Modo local (sem servidor): só funciona em abas deste navegador. Veja o README para colocar online.";
    if (sala) { $("#join-code").value = sala; $("#join-box").classList.add("focus"); }
    const needName = () => {
      const n = $("#name").value.trim();
      if (!n) { $("#name").focus(); $("#name").classList.add("err"); return false; }
      this.me.name = n.slice(0, 24); saveMe(this.me); return true;
    };
    $("#create").onclick = async () => {
      if (!needName()) return;
      const code = uid(6), key = uid(16);
      localStorage.setItem("mesa-gm-" + code, key);
      location.hash = `sala=${code}`;
      await this.start(code, key, true);
    };
    $("#join").onclick = async () => {
      if (!needName()) return;
      const code = $("#join-code").value.trim().toLowerCase().replace(/^.*sala=/, "").replace(/[^a-z0-9-].*$/, "");
      if (!code) return $("#join-code").focus();
      if (mestre && code === sala) localStorage.setItem("mesa-gm-" + code, mestre);
      location.hash = `sala=${code}`;
      await this.start(code, localStorage.getItem("mesa-gm-" + code) || "", false);
    };
    $("#join-code").addEventListener("keydown", e => { if (e.key === "Enter") $("#join").click(); });
  }

  async start(code, gmKey, creating) {
    $("#lobby-error").textContent = "";
    $("#join").disabled = $("#create").disabled = true;
    this.room = code;
    this.net = new Net(code);
    try { await this.net.connect(); }
    catch (err) { $("#lobby-error").textContent = err.message; $("#join").disabled = $("#create").disabled = false; return; }

    if (creating) await this.net.put({ id: SCENE_ID, kind: "scene", data: { ...DEFAULT_SCENE, gmKey, gmName: this.me.name, created: Date.now() } });
    const scene = this.net.get(SCENE_ID);
    if (!scene) {
      $("#lobby-error").textContent = "Mesa não encontrada. Confira o código.";
      $("#join").disabled = $("#create").disabled = false; return;
    }
    this.gmKey = gmKey;
    this.isGM = !!gmKey && scene.data.gmKey === gmKey;

    $("#lobby").hidden = true; $("#app").hidden = false;
    document.body.classList.toggle("gm", this.isGM);
    $("#room-code").textContent = code;
    $("#role").textContent = this.isGM ? "Mestre" : "Jogador";
    $("#conn").textContent = this.net.status;
    $("#conn").className = "conn " + this.net.status;

    this.board = new Board($("#board"), this);
    this.obr = new ObrHost(this);
    this.dock = new Dock(this);
    this.sheets = new Sheets(this);
    this.chat = new Chat(this);
    this._wire();
    this.net.onChange((ent, id, kind) => this._changed(ent, id, kind));
    this.net.onLive((ev, p) => {
      if (ev !== "hi") return;
      const novo = !this.presence.has(p.id);
      this.presence.set(p.id, { ...p, t: Date.now() }); this._renderPresence();
      if (novo) { this.obr.partyChanged(); if (!p.reply) hi(true); }
    });
    const hi = (reply = false) => this.net.live("hi", { id: this.me.id, name: this.me.name, color: this.me.color, gm: this.isGM, conn: this.obr.conn, reply });
    hi(); setInterval(() => { hi(); this._renderPresence(); }, 8000);

    this.sheets.renderList(); this.chat.render();
    requestAnimationFrame(() => this.board.fit());
    this._renderPresence();
    this.dock.sync();
  }

  _changed(ent, id, kind) {
    if (kind === "token") { this.board.tokenSaved(id); if (id === this.board.selected) this.onSelect(ent ? id : null); if (!ent) this.obr.onTokenDeleted(id); }
    if (kind === "item") this.board.invalidate();
    if (kind === "scene") { this.board.invalidate(); this._renderScenePanel(); }
    if (kind === "sheet") { this.sheets.renderList(); this.sheets.changed(id); this.board.invalidate(); }
    if (kind === "msg") { cancelAnimationFrame(this._chatRaf); this._chatRaf = requestAnimationFrame(() => this.chat.render()); }
  }

  _renderPresence() {
    const now = Date.now();
    let gone = false;
    for (const [id, p] of this.presence) if (now - p.t > 25000) { this.presence.delete(id); gone = true; }
    if (gone) this.obr?.partyChanged();
    const all = [{ ...this.me, gm: this.isGM }, ...[...this.presence.values()].filter(p => p.id !== this.me.id)];
    $("#people").innerHTML = all.map(p => `<span class="person" title="${p.name}${p.gm ? " (mestre)" : ""}" style="--c:${p.color}">${(p.name || "?").slice(0, 1).toUpperCase()}${p.gm ? "<i>★</i>" : ""}</span>`).join("");
  }

  // ---------------- interface ----------------
  _wire() {
    document.querySelectorAll("[data-tool]").forEach(b => b.onclick = () => this.setTool(b.dataset.tool));
    $("#fit").onclick = () => this.board.fit();
    $("#invite").onclick = () => this._copy(`${location.origin}${location.pathname}#sala=${this.room}`, "Convite copiado! Mande para os jogadores.");
    $("#gm-link").onclick = () => this._copy(`${location.origin}${location.pathname}#sala=${this.room}&mestre=${this.gmKey}`, "Link de mestre copiado. Não compartilhe com jogadores!");
    $("#add-token").onclick = () => this.addToken({});
    $("#map-file").onchange = (e) => this._uploadMap(e.target.files[0]);
    $("#scene-btn").onclick = () => { $("#scene-panel").hidden = !$("#scene-panel").hidden; this._renderScenePanel(); this.renderExtManager(); };
    $("#scene-panel").addEventListener("input", (e) => this._sceneInput(e));
    document.querySelectorAll(".tabs button").forEach(b => b.onclick = () => {
      document.querySelectorAll(".tabs button").forEach(x => x.classList.toggle("on", x === b));
      document.querySelectorAll(".tab").forEach(t => t.hidden = t.id !== b.dataset.tab);
    });
    $("#tok-panel").addEventListener("input", (e) => this._tokInput(e));
    $("#tok-panel").addEventListener("click", (e) => this._tokClick(e));
    $("#tok-file").onchange = (e) => this._tokImage(e.target.files[0]);
    $("#leave").onclick = () => { location.hash = ""; location.reload(); };
    $("#me-name").textContent = this.me.name;
    $("#ext-add").onclick = () => this.addExtension();
    $("#ext-url").addEventListener("keydown", (e) => { if (e.key === "Enter") this.addExtension(); });
    $("#ext-reset").onclick = () => this.dock.saveUrls([...DEFAULT_EXTENSIONS]);
    document.addEventListener("pointerdown", (e) => { if (!e.target.closest("#ctx-menu")) this.hideMenu(); });
  }

  setTool(t) {
    this.board.tool = t;
    document.querySelectorAll("[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === t));
    $("#board").style.cursor = t === "ruler" ? "crosshair" : "";
  }

  toast(msg) {
    const el = $("#toast"); el.textContent = msg; el.classList.add("show");
    clearTimeout(this._toast); this._toast = setTimeout(() => el.classList.remove("show"), 2600);
  }
  async _copy(text, msg) {
    try { await navigator.clipboard.writeText(text); this.toast(msg); } catch { prompt("Copie o link:", text); }
  }

  openSheet(id) { this.sheets.open(id); }

  // ------------- avisos (inclusive das extensões) -------------
  notify(msg, variant = "DEFAULT", id = "") {
    const box = $("#notes");
    const el = document.createElement("div");
    el.className = "note-item " + String(variant || "DEFAULT").toLowerCase();
    el.dataset.id = id; el.textContent = String(msg ?? "");
    el.onclick = () => el.remove();
    box.appendChild(el);
    while (box.children.length > 5) box.firstChild.remove();
    setTimeout(() => el.remove(), variant === "ERROR" ? 9000 : 5500);
  }
  closeNotify(id) { $(`#notes [data-id="${CSS.escape(id)}"]`)?.remove(); }

  // ------------- menu de clique direito -------------
  showMenu(x, y, o) {
    const menu = $("#ctx-menu");
    const items = this.board.selection.map(id => this.obr.findAny(id)).filter(Boolean);
    const entries = o.local ? [] : this.obr.menusFor(items);
    const own = [];
    if (o.token?.data.sheetId) own.push({ label: "Abrir ficha da Mesa", run: () => this.openSheet(o.token.data.sheetId) });
    if (this.isGM && !o.local) own.push({ label: o.it.visible === false ? "Mostrar aos jogadores" : "Esconder dos jogadores", run: () => this.obr.updateItems([{ id: o.it.id, type: o.it.type, visible: o.it.visible === false }], false) });
    if (this.isGM && !o.local) own.push({ label: "Apagar", danger: true, run: () => this.deleteSelected() });
    if (!entries.length && !own.length) return;
    menu.innerHTML = "";
    for (const en of entries) {
      const b = document.createElement("button");
      b.innerHTML = `${en.icon.icon ? `<img src="${en.icon.icon.replace(/"/g, "")}" alt="">` : ""}<span></span>`;
      b.querySelector("span").textContent = en.icon.label;
      b.onclick = () => { this.hideMenu(); this.obr.clickMenu(en, items); };
      menu.appendChild(b);
    }
    if (entries.length && own.length) menu.appendChild(document.createElement("hr"));
    for (const en of own) {
      const b = document.createElement("button"); b.textContent = en.label; if (en.danger) b.className = "danger";
      b.onclick = () => { this.hideMenu(); en.run(); };
      menu.appendChild(b);
    }
    menu.hidden = false;
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.min(x, innerWidth - r.width - 6) + "px";
    menu.style.top = Math.min(y, innerHeight - r.height - 6) + "px";
  }
  hideMenu() { const m = $("#ctx-menu"); if (m) m.hidden = true; }

  deleteSelected() {
    const ids = [...this.board.selection];
    for (const id of ids) {
      const e = this.net.get(id);
      if (e?.kind === "token") { this.net.del(id); this.obr.onTokenDeleted(id); }
      else if (e?.kind === "item") this.obr.deleteItems([id], false);
      else if (this.obr.local.has(id)) this.obr.deleteItems([id], true);
    }
    this.board.select(null);
  }

  // ------------- gerenciador de extensões (mestre) -------------
  renderExtManager() {
    const box = $("#ext-list"); if (!box) return;
    const urls = this.dock.urls();
    box.innerHTML = urls.map((u, i) => {
      const ext = this.dock.exts.get(u);
      const name = ext?.name || u.replace(/^https?:\/\//, "");
      return `<div class="ext-row${ext?.error ? " err" : ""}" title="${u.replace(/"/g, "&quot;")}">
        ${ext?.icon ? `<img src="${ext.icon.replace(/"/g, "")}" alt="">` : "<span class='dot'></span>"}
        <span class="nm"></span>
        <button class="mini ghost" data-up="${i}" title="Subir">↑</button>
        <button class="mini ghost danger" data-rm="${i}" title="Remover">✕</button></div>`;
    }).join("") || `<p class="hint">Nenhuma extensão.</p>`;
    box.querySelectorAll(".ext-row .nm").forEach((el, i) => { const ext = this.dock.exts.get(urls[i]); el.textContent = ext?.error ? `${ext?.name || urls[i]} — erro` : (ext?.name || urls[i]); });
    box.querySelectorAll("[data-rm]").forEach(b => b.onclick = () => { const u = [...urls]; u.splice(+b.dataset.rm, 1); this.dock.saveUrls(u); });
    box.querySelectorAll("[data-up]").forEach(b => b.onclick = () => { const i = +b.dataset.up; if (!i) return; const u = [...urls]; [u[i - 1], u[i]] = [u[i], u[i - 1]]; this.dock.saveUrls(u); });
  }
  addExtension() {
    let url = $("#ext-url").value.trim(); if (!url) return;
    if (!/^https?:\/\//.test(url)) url = "https://" + url;
    if (!/manifest\.json(\?.*)?$/.test(url)) url = url.replace(/\/?$/, "/manifest.json");
    const urls = this.dock.urls();
    if (!urls.includes(url)) this.dock.saveUrls([...urls, url]);
    $("#ext-url").value = "";
  }

  async addToken(opts) {
    const s = this.board.scene;
    const c = this.board.toWorld(this.board.w / 2, this.board.h / 2);
    let p = this.board.snap(Math.min(Math.max(c.x, 0), s.mapW), Math.min(Math.max(c.y, 0), s.mapH), 1);
    // procura uma casa livre em espiral perto do centro da tela
    const taken = (q) => this.net.all("token").some(t => Math.abs(t.data.x - q.x) < 1 && Math.abs(t.data.y - q.y) < 1);
    for (let ring = 1, base = p; taken(p) && ring < 12; ring++) {
      const cand = [];
      for (let dx = -ring; dx <= ring; dx++) for (let dy = -ring; dy <= ring; dy++)
        if (Math.max(Math.abs(dx), Math.abs(dy)) === ring) cand.push({ x: base.x + dx * s.grid, y: base.y + dy * s.grid });
      const free = cand.find(q => !taken(q) && q.x > 0 && q.y > 0 && q.x < s.mapW && q.y < s.mapH);
      if (free) p = free;
    }
    const n = this.net.all("token").length + 1;
    const ent = await this.net.put({ kind: "token", data: { x: p.x, y: p.y, size: 1, color: "#8a1c1c", label: `Token ${n}`, owner: this.isGM ? "" : this.me.id, hidden: false, z: Date.now(), ...opts } });
    this.board.select(ent.id);
  }

  async _uploadMap(file) {
    if (!file) return;
    try {
      this.toast("Enviando mapa…");
      const blob = await shrinkImage(file, 4096, 0.88);
      const bmp = await createImageBitmap(blob);
      const url = await this.net.uploadImage(blob);
      const sc = this.net.get(SCENE_ID);
      await this.net.put({ ...sc, data: { ...sc.data, mapUrl: url, mapW: bmp.width, mapH: bmp.height } });
      this.board.fit(); this.toast("Mapa atualizado.");
    } catch (err) { this.toast(err.message); }
    $("#map-file").value = "";
  }

  _renderScenePanel() {
    if ($("#scene-panel").hidden) return;
    const s = this.board.scene;
    for (const el of $("#scene-panel").querySelectorAll("[data-k]")) {
      if (document.activeElement === el) continue;
      const v = s[el.dataset.k];
      if (el.type === "checkbox") el.checked = !!v; else el.value = v;
    }
  }
  _sceneInput(e) {
    const el = e.target, k = el.dataset.k; if (!k) return;
    let v = el.type === "checkbox" ? el.checked : el.type === "number" || el.type === "range" ? Number(el.value) : el.value;
    if (k === "grid" && (!v || v < 10)) return;
    const sc = this.net.get(SCENE_ID);
    clearTimeout(this._scT);
    this._scPending = { ...(this._scPending || sc.data), [k]: v };
    this.board.invalidate();
    this._scT = setTimeout(() => { const d = this._scPending; this._scPending = null; this.net.put({ ...this.net.get(SCENE_ID), data: d }); }, 250);
  }

  // ------------- painel do token selecionado -------------
  canEditToken(t) { return this.isGM || t.data.owner === this.me.id; }
  onSelect(id) {
    const panel = $("#tok-panel");
    const t = id && this.net.get(id);
    if (!t || t.kind !== "token" || !this.canEditToken(t)) { panel.hidden = true; return; }
    panel.hidden = false;
    const d = t.data;
    const sheets = this.sheets.visible();
    panel.querySelector("[data-k=label]").value = d.label || "";
    panel.querySelector("[data-k=color]").value = d.color || "#8a1c1c";
    panel.querySelector("[data-k=size]").value = d.size || 1;
    panel.querySelector("[data-k=hidden]").checked = !!d.hidden;
    panel.querySelector("[data-k=hideHp]").checked = !!d.hideHp;
    const sel = panel.querySelector("[data-k=sheetId]");
    sel.innerHTML = `<option value="">— nenhuma —</option>` + sheets.map(s => `<option value="${s.id}" ${s.id === d.sheetId ? "selected" : ""}>${s.data.nome.replace(/</g, "&lt;")}</option>`).join("");
    panel.querySelector("[data-open-sheet]").disabled = !d.sheetId;
  }
  _tokPut(patch) {
    const t = this.net.get(this.board.selected); if (!t) return;
    this.net.put({ ...t, data: { ...t.data, ...patch } });
  }
  _tokInput(e) {
    const el = e.target, k = el.dataset.k; if (!k) return;
    let v = el.type === "checkbox" ? el.checked : k === "size" ? Number(el.value) : el.value;
    if (k === "sheetId" && v) {
      const sh = this.net.get(v);
      this._tokPut({ sheetId: v, owner: sh?.data.owner || "", label: sh?.data.nome || "" });
      return this.onSelect(this.board.selected);
    }
    clearTimeout(this._tkT);
    this._tkT = setTimeout(() => this._tokPut({ [k]: v }), el.type === "text" ? 300 : 0);
  }
  _tokClick(e) {
    const b = e.target.closest("button"); if (!b) return;
    const t = this.net.get(this.board.selected); if (!t) return;
    if (b.hasAttribute("data-front")) this._tokPut({ z: Date.now() });
    if (b.hasAttribute("data-back")) this._tokPut({ z: -Date.now() });
    if (b.hasAttribute("data-del")) { this.net.del(t.id); this.obr.onTokenDeleted(t.id); this.board.select(null); }
    if (b.hasAttribute("data-open-sheet") && t.data.sheetId) this.openSheet(t.data.sheetId);
    if (b.hasAttribute("data-clear-img")) this._tokPut({ img: "" });
  }
  async _tokImage(file) {
    if (!file) return;
    try { const blob = await shrinkImage(file, 400, 0.9); this._tokPut({ img: await this.net.uploadImage(blob) }); }
    catch (err) { this.toast(err.message); }
    $("#tok-file").value = "";
  }
}

window.app = new App();
