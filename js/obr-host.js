// Ponte compatível com o SDK do Owlbear Rodeo (@owlbear-rodeo/sdk 3.x).
// As extensões rodam em iframes e conversam com a Mesa pelo mesmo protocolo de postMessage
// que usam com o Owlbear, então o mesmo código funciona nos dois lugares sem alteração.
import { uid } from "./net.js";

export const LAYERS = ["MAP", "GRID", "DRAWING", "PROP", "MOUNT", "CHARACTER", "ATTACHMENT", "NOTE", "TEXT", "RULER", "FOG", "POINTER", "POST_PROCESS", "CONTROL", "POPOVER"];
export const EXT_LIST_ID = "extensions";
export const DEFAULT_EXTENSIONS = [
  "https://pebarrosdenashor.github.io/fichas-ordem-paranormal/manifest.json",
  "https://pebarrosdenashor.github.io/hexatombe/manifest.json",
  "https://pebarrosdenashor.github.io/mestre-hexatombe/manifest.json",
];
const ROOM_META = "obr-room";
const SCENE_META = "obr-scene";
const clone = (o) => (o === undefined ? undefined : structuredClone(o));
const getPath = (o, k) => (Array.isArray(k) ? k : [k]).reduce((v, p) => (v == null ? undefined : v[p]), o);
const same = (a, b) => a === b || (a && b && typeof a === "object" && JSON.stringify(a) === JSON.stringify(b));

export class ObrHost {
  constructor(app) {
    this.app = app;
    this.net = app.net;
    this.frames = new Map();   // ref -> frame
    this.local = new Map();    // itens locais (scene.local) deste navegador
    this.menus = new Map();    // contextMenu id -> {ref, icons}
    this.exts = new Map();     // manifestUrl -> {manifest, base, bg, action}
    this.playerMeta = {};
    this.conn = uid(8);
    this.selection = [];
    this._queued = new Set();
    window.addEventListener("message", (e) => this._onMessage(e));
    this.net.onLive((ev, p) => { if (ev === "obr-bc") this._deliver(p.channel, p.data, p.conn); });
    this.net.onChange((ent, id, kind) => {
      if (kind === "token" || kind === "item") this._changed("items");
      if (id === ROOM_META) this._changed("room");
      if (id === SCENE_META) this._changed("scenemeta");
      if (kind === "scene") this._changed("grid");
    });
  }

  // ---------------------------------------------------------------- jogador
  get role() { return this.app.isGM ? "GM" : "PLAYER"; }
  player() {
    const me = this.app.me;
    return { id: me.id, connectionId: this.conn, role: this.role, selection: [...this.selection], name: me.name, color: me.color, syncView: false, metadata: this.playerMeta };
  }
  party() {
    return [...this.app.presence.values()].filter(p => p.id !== this.app.me.id)
      .map(p => ({ id: p.id, connectionId: p.conn || p.id, role: p.gm ? "GM" : "PLAYER", selection: [], name: p.name, color: p.color, syncView: false, metadata: {} }));
  }
  setSelection(ids) {
    ids = (ids || []).filter(Boolean);
    if (same(ids, this.selection)) return;
    this.selection = ids;
    this._changed("player");
  }
  partyChanged() { this._changed("party"); }

  // ---------------------------------------------------------------- itens
  dpi() { return this.app.board.scene.grid; }

  tokenItem(t) {
    const d = t.data, g = this.dpi(), size = d.size || 1, p = this.app.board.tokenPos(t);
    return {
      id: t.id, type: "IMAGE", name: d.label || "", visible: !d.hidden, locked: !!d.locked, layer: d.layer || "CHARACTER",
      position: { x: p.x, y: p.y }, rotation: d.rotation || 0, scale: { x: 1, y: 1 }, zIndex: d.z || 0,
      createdUserId: d.owner || "", lastModified: d.mod || "", lastModifiedUserId: d.modBy || "",
      metadata: clone(d.metadata || {}),
      image: { width: size * g, height: size * g, mime: "image/webp", url: d.img || "" },
      grid: { dpi: g, offset: { x: size * g / 2, y: size * g / 2 } },
      text: { richText: [{ type: "paragraph", children: [{ text: "" }] }], plainText: d.label || "", style: { padding: 8, fontFamily: "Roboto", fontSize: 16, fontWeight: 400, textAlign: "CENTER", textAlignVertical: "BOTTOM", fillColor: "white", fillOpacity: 1, strokeColor: "white", strokeOpacity: 1, strokeWidth: 0, lineHeight: 1.5 }, type: "PLAIN", width: "AUTO", height: "AUTO" },
      textItemType: "LABEL",
      ...(d.owner ? { _mesaOwner: d.owner } : {}),
    };
  }

  // posição efetiva de um item anexado (segue o pai)
  _eff(it, lookup) {
    if (!it.attachedTo || !it._ap) return it.position;
    const parent = lookup(it.attachedTo);
    if (!parent) return it.position;
    const pp = parent.position;
    return { x: it.position.x + pp.x - it._ap.x, y: it.position.y + pp.y - it._ap.y };
  }
  _public(it, lookup) {
    const out = { ...it, position: this._eff(it, lookup) };
    delete out._ap; delete out._mesaOwner;
    return out;
  }

  sceneItems() {
    const raw = new Map();
    for (const t of this.net.all("token")) raw.set(t.id, this.tokenItem(t));
    for (const e of this.net.all("item")) raw.set(e.id, e.data);
    const lookup = (id) => { const p = raw.get(id); return p ? { position: this._eff(p, () => null) } : null; };
    return [...raw.values()].map(it => this._public(it, lookup));
  }
  localItems() {
    const scene = new Map(this.sceneItems().map(i => [i.id, i]));
    const lookup = (id) => scene.get(id) || (this.local.has(id) ? { position: this.local.get(id).position } : null);
    return [...this.local.values()].map(it => this._public(it, lookup));
  }
  findAny(id) {
    return this.sceneItems().find(i => i.id === id) || this.localItems().find(i => i.id === id) || null;
  }

  // lista para desenhar: tudo, na ordem de camada e zIndex
  renderList() {
    const gm = this.app.isGM;
    const out = [];
    const tokens = new Map(this.net.all("token").map(t => [t.id, t]));
    for (const it of this.sceneItems()) out.push({ it, token: tokens.get(it.id) || null, local: false });
    for (const it of this.localItems()) out.push({ it, token: null, local: true });
    const ids = new Set(out.map(o => o.it.id));
    return out
      .filter(o => !o.it.attachedTo || ids.has(o.it.attachedTo))
      .filter(o => gm || o.it.visible !== false)
      .filter(o => !o.it.attachedTo || gm || !(out.find(p => p.it.id === o.it.attachedTo)?.it.visible === false))
      .sort((a, b) => (LAYERS.indexOf(a.it.layer) - LAYERS.indexOf(b.it.layer)) || ((a.it.zIndex || 0) - (b.it.zIndex || 0)));
  }

  bounds(it) {
    const g = this.dpi();
    const sx = Math.abs(it.scale?.x ?? 1), sy = Math.abs(it.scale?.y ?? 1);
    const p = it.position;
    let x0, y0, w, h;
    if (it.type === "IMAGE") {
      const k = g / (it.grid?.dpi || g);
      w = (it.image?.width || g) * k * sx; h = (it.image?.height || g) * k * sy;
      x0 = p.x - (it.grid?.offset?.x ?? 0) * k * sx; y0 = p.y - (it.grid?.offset?.y ?? 0) * k * sy;
    } else if (it.type === "SHAPE") {
      w = (it.width || 0) * sx; h = (it.height || 0) * sy;
      const centered = it.shapeType === "CIRCLE" || it.shapeType === "HEXAGON";
      x0 = centered ? p.x - w / 2 : it.shapeType === "TRIANGLE" ? p.x - w / 2 : p.x;
      y0 = centered ? p.y - h / 2 : p.y;
    } else if (it.type === "TEXT" || it.type === "LABEL") {
      const m = this.app.board.measureText(it);
      w = m.w * sx; h = m.h * sy;
      if (it.type === "LABEL") { x0 = p.x - w / 2; y0 = p.y - h - (it.style?.pointerHeight || 0); }
      else { x0 = p.x; y0 = p.y; }
    } else if (Array.isArray(it.points) && it.points.length) {
      const xs = it.points.map(q => q.x * sx + p.x), ys = it.points.map(q => q.y * sy + p.y);
      x0 = Math.min(...xs); y0 = Math.min(...ys); w = Math.max(...xs) - x0; h = Math.max(...ys) - y0;
    } else { x0 = p.x; y0 = p.y; w = 0; h = 0; }
    return { x0, y0, w, h };
  }
  boundsOf(items) {
    if (!items.length) return null;
    let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
    for (const it of items) { const r = this.bounds(it); a = Math.min(a, r.x0); b = Math.min(b, r.y0); c = Math.max(c, r.x0 + r.w); d = Math.max(d, r.y0 + r.h); }
    return { min: { x: a, y: b }, max: { x: c, y: d }, width: c - a, height: d - b, center: { x: (a + c) / 2, y: (b + d) / 2 } };
  }

  async addItems(items, isLocal) {
    const all = new Map((isLocal ? [...this.sceneItems(), ...this.localItems()] : this.sceneItems()).map(i => [i.id, i]));
    for (let it of items) {
      it = clone(it);
      if (it.attachedTo) { const p = all.get(it.attachedTo); if (p) it._ap = { ...p.position }; }
      if (isLocal) this.local.set(it.id, it);
      else await this.net.put({ id: it.id, kind: "item", data: it });
    }
    if (isLocal) this._changed("local");
  }

  async updateItems(updates, isLocal) {
    const scene = new Map(this.sceneItems().map(i => [i.id, i]));
    for (const u of updates) {
      if (isLocal) {
        const cur = this.local.get(u.id); if (!cur) continue;
        this.local.set(u.id, this._merge(cur, u, (id) => scene.get(id) || this.local.get(id)));
        continue;
      }
      const tok = this.net.get(u.id);
      if (tok?.kind === "token") { await this._updateToken(tok, u); continue; }
      const ent = this.net.get(u.id);
      if (ent?.kind === "item") await this.net.put({ ...ent, data: this._merge(ent.data, u, (id) => scene.get(id)) });
    }
    if (isLocal) this._changed("local");
  }
  _merge(cur, u, lookup) {
    const next = { ...cur };
    for (const [k, v] of Object.entries(u)) {
      if (k === "id" || k === "type") continue;
      next[k] = clone(v);
    }
    // posição vinda da extensão é absoluta: rebaseia o anexo
    if ("position" in u || "attachedTo" in u) {
      const p = next.attachedTo && lookup(next.attachedTo);
      if (p) next._ap = { ...p.position }; else delete next._ap;
    }
    next.lastModified = new Date().toISOString(); next.lastModifiedUserId = this.app.me.id;
    return next;
  }
  async _updateToken(tok, u) {
    const d = { ...tok.data };
    if (u.position) { d.x = u.position.x; d.y = u.position.y; }
    if ("name" in u) d.label = u.name;
    if ("visible" in u) d.hidden = !u.visible;
    if ("locked" in u) d.locked = u.locked;
    if ("metadata" in u) d.metadata = clone(u.metadata);
    if ("zIndex" in u) d.z = u.zIndex;
    if ("rotation" in u) d.rotation = u.rotation;
    if ("layer" in u) d.layer = u.layer;
    if (u.image?.url !== undefined) d.img = u.image.url;
    d.mod = new Date().toISOString(); d.modBy = this.app.me.id;
    await this.net.put({ ...tok, data: d });
  }

  async deleteItems(ids, isLocal) {
    const kill = new Set(ids);
    // apaga também o que estiver anexado
    const pool = isLocal ? this.localItems() : this.sceneItems();
    let grew = true;
    while (grew) { grew = false; for (const it of pool) if (it.attachedTo && kill.has(it.attachedTo) && !kill.has(it.id)) { kill.add(it.id); grew = true; } }
    for (const id of kill) {
      if (isLocal) this.local.delete(id);
      else if (this.net.get(id)) await this.net.del(id);
    }
    if (isLocal) this._changed("local");
  }

  // apagado pela própria Mesa (tecla Delete etc.)
  onTokenDeleted(id) {
    const kids = this.sceneItems().filter(i => i.attachedTo === id).map(i => i.id);
    if (kids.length) this.deleteItems(kids, false);
    const lk = [...this.local.values()].filter(i => i.attachedTo === id).map(i => i.id);
    if (lk.length) this.deleteItems(lk, true);
  }

  // ---------------------------------------------------------------- metadados
  meta(id) { return clone(this.net.get(id)?.data || {}); }
  async setMeta(id, update) {
    const cur = this.net.get(id);
    const data = { ...(cur?.data || {}), ...clone(update) };
    for (const [k, v] of Object.entries(update)) if (v === undefined) delete data[k];
    await this.net.put({ id, kind: "meta", data });
  }

  // ---------------------------------------------------------------- broadcast
  broadcast(channel, data, dest = "REMOTE") {
    if (dest === "LOCAL" || dest === "ALL") this._deliver(channel, data, this.conn);
    if (dest === "REMOTE" || dest === "ALL") this.net.live("obr-bc", { channel, data, conn: this.conn });
  }
  _deliver(channel, data, conn) {
    for (const f of this.frames.values()) if (f.bc.has(channel)) this._post(f, `OBR_BROADCAST_MESSAGE_${channel}`, { data: clone(data), connectionId: conn });
  }

  // ---------------------------------------------------------------- iframes
  refFor(ext) {
    const ref = uid(14);
    return { ref, obrref: btoa(`${location.origin} mesa-${this.app.room}`) };
  }
  // cria um iframe de extensão e o registra
  makeFrame(url, ext, kind, extra = {}) {
    const { ref, obrref } = this.refFor(ext);
    const u = new URL(url, ext?.base || location.href);
    u.searchParams.set("obrref", obrref);
    const el = document.createElement("iframe");
    el.src = u.href;
    el.allow = "autoplay; clipboard-read; clipboard-write; fullscreen";
    el.dataset.ref = ref;
    const f = { ref, el, ext, kind, subs: new Set(), bc: new Set(), ready: false, ...extra };
    this.frames.set(ref, f);
    el.addEventListener("load", () => { f.ready = true; this._post(f, "OBR_READY", { ref, userId: this.app.me.id }); });
    return f;
  }
  dropFrame(f) { if (!f) return; this.frames.delete(f.ref); for (const [id, m] of this.menus) if (m.ref === f.ref) this.menus.delete(id); f.el.remove(); }

  _post(f, id, data) {
    try { f.el.contentWindow?.postMessage({ id, data }, "*"); } catch { /* frame fechado */ }
  }

  _changed(what) {
    this._queued.add(what);
    if (this._timer) return;
    this._timer = setTimeout(() => {
      const q = this._queued; this._queued = new Set(); this._timer = null;
      let items, local;
      for (const f of this.frames.values()) {
        if (q.has("items") && f.subs.has("items")) this._post(f, "OBR_SCENE_ITEMS_EVENT_CHANGE", { items: items ??= this.sceneItems() });
        if ((q.has("local") || q.has("items")) && f.subs.has("local")) this._post(f, "OBR_SCENE_LOCAL_EVENT_CHANGE", { items: local ??= this.localItems() });
        if (q.has("room") && f.subs.has("room")) this._post(f, "OBR_ROOM_METADATA_EVENT_CHANGE", { metadata: this.meta(ROOM_META) });
        if (q.has("scenemeta") && f.subs.has("scenemeta")) this._post(f, "OBR_SCENE_METADATA_EVENT_CHANGE", { metadata: this.meta(SCENE_META) });
        if (q.has("player") && f.subs.has("player")) this._post(f, "OBR_PLAYER_EVENT_CHANGE", { player: this.player() });
        if (q.has("party") && f.subs.has("party")) this._post(f, "OBR_PARTY_EVENT_CHANGE", { players: this.party() });
        if (q.has("grid") && f.subs.has("grid")) this._post(f, "OBR_SCENE_GRID_EVENT_CHANGE", { grid: this.gridInfo() });
        if (q.has("action") && f.subs.has("action") && f.ext) this._post(f, "OBR_ACTION_IS_OPEN_EVENT_CHANGE", { isOpen: this.app.dock.isOpen(f.ext) });
      }
      this.app.board.invalidate();
    }, 30);
  }
  actionChanged() { this._changed("action"); }

  gridInfo() {
    const s = this.app.board.scene;
    return { dpi: s.grid, style: { lineType: "SOLID", lineOpacity: s.gridAlpha, lineColor: "LIGHT", lineWidth: 1 }, type: "SQUARE", measurement: "CHEBYSHEV", scale: `${s.unit}${s.unitName}` };
  }
  gridScale() {
    const s = this.app.board.scene;
    return { raw: `${s.unit}${s.unitName}`, parsed: { multiplier: Number(s.unit) || 1, unit: s.unitName, digits: 1 } };
  }

  // ---------------------------------------------------------------- menu de contexto
  menusFor(items) {
    const out = [];
    for (const [id, m] of this.menus) {
      m.icons.forEach((icon, idx) => {
        if (this._passes(icon.filter, items)) out.push({ id, icon, idx, ref: m.ref });
      });
    }
    // uma entrada por menu (o primeiro ícone que passou)
    const seen = new Set();
    return out.filter(o => !seen.has(o.id) && seen.add(o.id));
  }
  _passes(f, items) {
    if (!f) return items.length > 0;
    if (f.roles && !f.roles.includes(this.role)) return false;
    if (f.min != null && items.length < f.min) return false;
    if (f.max != null && items.length > f.max) return false;
    if (!items.length) return false;
    const test = (it, list) => {
      let res = null, coord = "&&";
      for (const k of list) {
        const v = getPath(it, k.key);
        const eq = same(v, k.value);
        const ok = (k.operator || "==") === "!=" ? !eq : eq;
        res = res === null ? ok : coord === "||" ? (res || ok) : (res && ok);
        coord = k.coordinator || "&&";
      }
      return res ?? true;
    };
    if (f.every && !items.every(it => test(it, f.every))) return false;
    if (f.some && !items.some(it => test(it, f.some))) return false;
    return true;
  }
  clickMenu(entry, items) {
    const f = this.frames.get(entry.ref); if (!f) return;
    const bounds = this.boundsOf(items);
    this._post(f, "OBR_CONTEXT_MENU_EVENT_CLICK", { id: entry.id, context: { items, selectionBounds: bounds }, elementId: "" });
  }

  // ---------------------------------------------------------------- mensagens
  async _onMessage(e) {
    const m = e.data;
    if (!m || typeof m.id !== "string" || !m.ref) return;
    const f = this.frames.get(m.ref);
    if (!f || e.source !== f.el.contentWindow) return;
    const reply = (data) => { if (m.nonce !== undefined) this._post(f, `${m.id}_RESPONSE${m.nonce}`, data ?? {}); };
    const fail = (err) => { if (m.nonce !== undefined) this._post(f, `${m.id}_ERROR${m.nonce}`, { name: "Error", message: String(err?.message || err) }); };
    try { reply(await this._handle(f, m.id, m.data || {})); }
    catch (err) { console.warn("[obr]", m.id, err); fail(err); }
  }

  async _handle(f, id, d) {
    const app = this.app, board = app.board;
    switch (id) {
      // jogador
      case "OBR_PLAYER_GET_ID": return { id: app.me.id };
      case "OBR_PLAYER_GET_NAME": return { name: app.me.name };
      case "OBR_PLAYER_GET_ROLE": return { role: this.role };
      case "OBR_PLAYER_GET_COLOR": return { color: app.me.color };
      case "OBR_PLAYER_GET_CONNECTION_ID": return { connectionId: this.conn };
      case "OBR_PLAYER_GET_SELECTION": return { selection: this.selection.length ? [...this.selection] : undefined };
      case "OBR_PLAYER_SELECT": board.selectMany(d.replace === false ? [...new Set([...this.selection, ...d.items])] : d.items); return;
      case "OBR_PLAYER_DESELECT": board.selectMany(d.items ? this.selection.filter(x => !d.items.includes(x)) : []); return;
      case "OBR_PLAYER_GET_METADATA": return { metadata: clone(this.playerMeta) };
      case "OBR_PLAYER_SET_METADATA": Object.assign(this.playerMeta, clone(d.update)); this._changed("player"); return;
      case "OBR_PLAYER_SET_NAME": case "OBR_PLAYER_SET_COLOR": case "OBR_PLAYER_SET_SYNC_VIEW": return;
      case "OBR_PLAYER_GET_SYNC_VIEW": return { syncView: false };
      case "OBR_PLAYER_SUBSCRIBE": f.subs.add("player"); return;
      case "OBR_PLAYER_UNSUBSCRIBE": f.subs.delete("player"); return;
      case "OBR_PARTY_GET_PLAYERS": return { players: this.party() };
      case "OBR_PARTY_SUBSCRIBE": f.subs.add("party"); return;
      case "OBR_PARTY_UNSUBSCRIBE": f.subs.delete("party"); return;

      // sala
      case "OBR_ROOM_GET_METADATA": return { metadata: this.meta(ROOM_META) };
      case "OBR_ROOM_SET_METADATA": await this.setMeta(ROOM_META, d.update); return;
      case "OBR_ROOM_METADATA_SUBSCRIBE": f.subs.add("room"); return;
      case "OBR_METADATA_ROOM_UNSUBSCRIBE": f.subs.delete("room"); return;
      case "OBR_ROOM_GET_PERMISSIONS": return { permissions: [] };
      case "OBR_ROOM_PERMISSIONS_SUBSCRIBE": case "OBR_PERMISSIONS_ROOM_UNSUBSCRIBE": return;

      // cena
      case "OBR_SCENE_IS_READY": return { ready: true };
      case "OBR_SCENE_READY_SUBSCRIBE": case "OBR_SCENE_READY_UNSUBSCRIBE": return;
      case "OBR_SCENE_GET_METADATA": return { metadata: this.meta(SCENE_META) };
      case "OBR_SCENE_SET_METADATA": await this.setMeta(SCENE_META, d.update); return;
      case "OBR_SCENE_METADATA_SUBSCRIBE": f.subs.add("scenemeta"); return;
      case "OBR_SCENE_METADATA_UNSUBSCRIBE": f.subs.delete("scenemeta"); return;

      case "OBR_SCENE_ITEMS_GET_ALL_ITEMS": return { items: this.sceneItems() };
      case "OBR_SCENE_ITEMS_GET_ITEMS": { const s = new Set(d.ids); return { items: this.sceneItems().filter(i => s.has(i.id)) }; }
      case "OBR_SCENE_ITEMS_ADD_ITEMS": await this.addItems(d.items, false); return;
      case "OBR_SCENE_ITEMS_UPDATE_ITEMS": await this.updateItems(d.updates, false); return;
      case "OBR_SCENE_ITEMS_DELETE_ITEMS": await this.deleteItems(d.ids, false); return;
      case "OBR_SCENE_ITEMS_GET_ITEM_ATTACHMENTS": return { items: this._attachments(this.sceneItems(), d.ids) };
      case "OBR_SCENE_ITEMS_GET_ITEM_BOUNDS": {
        const s = new Set(d.ids); const its = this.sceneItems().filter(i => s.has(i.id));
        if (!its.length) throw new Error("Item não encontrado");
        return { bounds: this.boundsOf(its) };
      }
      case "OBR_SCENE_ITEMS_SUBSCRIBE": f.subs.add("items"); return;
      case "OBR_SCENE_ITEMS_UNSUBSCRIBE": f.subs.delete("items"); return;

      case "OBR_SCENE_LOCAL_GET_ALL_ITEMS": return { items: this.localItems() };
      case "OBR_SCENE_LOCAL_GET_ITEMS": { const s = new Set(d.ids); return { items: this.localItems().filter(i => s.has(i.id)) }; }
      case "OBR_SCENE_LOCAL_ADD_ITEMS": await this.addItems(d.items, true); return;
      case "OBR_SCENE_LOCAL_UPDATE_ITEMS": await this.updateItems(d.updates, true); return;
      case "OBR_SCENE_LOCAL_DELETE_ITEMS": await this.deleteItems(d.ids, true); return;
      case "OBR_SCENE_LOCAL_GET_ITEM_ATTACHMENTS": return { items: this._attachments(this.localItems(), d.ids) };
      case "OBR_SCENE_LOCAL_GET_ITEM_BOUNDS": {
        const s = new Set(d.ids); const its = this.localItems().filter(i => s.has(i.id));
        if (!its.length) throw new Error("Item não encontrado");
        return { bounds: this.boundsOf(its) };
      }
      case "OBR_SCENE_LOCAL_SUBSCRIBE": f.subs.add("local"); return;
      case "OBR_SCENE_LOCAL_UNSUBSCRIBE": f.subs.delete("local"); return;

      // grid
      case "OBR_SCENE_GRID_GET_DPI": return { dpi: this.dpi() };
      case "OBR_SCENE_GRID_GET_SCALE": return this.gridScale();
      case "OBR_SCENE_GRID_GET_COLOR": return { color: "LIGHT" };
      case "OBR_SCENE_GRID_GET_OPACITY": return { opacity: board.scene.gridAlpha };
      case "OBR_SCENE_GRID_GET_TYPE": return { type: "SQUARE" };
      case "OBR_SCENE_GRID_GET_LINE_TYPE": return { lineType: "SOLID" };
      case "OBR_SCENE_GRID_GET_MEASUREMENT": return { measurement: "CHEBYSHEV" };
      case "OBR_SCENE_GRID_GET_LINE_WIDTH": return { lineWidth: 1 };
      case "OBR_SCENE_GRID_SNAP_POSITION": { const p = board.snap(d.position.x, d.position.y, 1); return { position: d.useCorners ? { x: Math.round(d.position.x / this.dpi()) * this.dpi(), y: Math.round(d.position.y / this.dpi()) * this.dpi() } : p }; }
      case "OBR_SCENE_GRID_GET_DISTANCE": { const g = this.dpi(); return { distance: Math.max(Math.abs(d.to.x - d.from.x), Math.abs(d.to.y - d.from.y)) / g }; }
      case "OBR_SCENE_GRID_SUBSCRIBE": f.subs.add("grid"); return;
      case "OBR_SCENE_GRID_UNSUBSCRIBE": f.subs.delete("grid"); return;

      // broadcast
      case "OBR_BROADCAST_SEND_MESSAGE": {
        const size = JSON.stringify(d.data ?? null).length;
        if (size > 64000) throw new Error("Mensagem grande demais");
        this.broadcast(d.channel, d.data, d.options?.destination || "REMOTE"); return;
      }
      case "OBR_BROADCAST_SUBSCRIBE": f.bc.add(d.channel); return;
      case "OBR_BROADCAST_UNSUBSCRIBE": f.bc.delete(d.channel); return;

      // interface
      case "OBR_NOTIFICATION_SHOW": { const nid = uid(8); app.notify(d.message, d.variant, nid); return { id: nid }; }
      case "OBR_NOTIFICATION_CLOSE": app.closeNotify(d.id); return;
      case "OBR_MODAL_OPEN": app.dock.openModal(f.ext, d); return;
      case "OBR_MODAL_CLOSE": app.dock.closeModal(d.id); return;
      case "OBR_POPOVER_OPEN": app.dock.openPopover(f.ext, d); return;
      case "OBR_POPOVER_CLOSE": app.dock.closePopover(d.id); return;
      case "OBR_POPOVER_GET_WIDTH": return { width: app.dock.popoverSize(d.id)?.w };
      case "OBR_POPOVER_GET_HEIGHT": return { height: app.dock.popoverSize(d.id)?.h };
      case "OBR_POPOVER_SET_WIDTH": app.dock.resizePopover(d.id, d.width, null); return;
      case "OBR_POPOVER_SET_HEIGHT": app.dock.resizePopover(d.id, null, d.height); return;

      case "OBR_ACTION_GET_IS_OPEN": return { isOpen: app.dock.isOpen(f.ext) };
      case "OBR_ACTION_OPEN": app.dock.open(f.ext); return;
      case "OBR_ACTION_CLOSE": app.dock.close(f.ext); return;
      case "OBR_ACTION_IS_OPEN_SUBSCRIBE": f.subs.add("action"); return;
      case "OBR_IS_OPEN_ACTION_UNSUBSCRIBE": f.subs.delete("action"); return;
      case "OBR_ACTION_GET_WIDTH": return { width: app.dock.size(f.ext)?.w };
      case "OBR_ACTION_GET_HEIGHT": return { height: app.dock.size(f.ext)?.h };
      case "OBR_ACTION_SET_WIDTH": app.dock.resize(f.ext, d.width, null); return;
      case "OBR_ACTION_SET_HEIGHT": app.dock.resize(f.ext, null, d.height); return;
      case "OBR_ACTION_GET_BADGE_TEXT": return { badgeText: f.ext?.badge };
      case "OBR_ACTION_SET_BADGE_TEXT": if (f.ext) { f.ext.badge = d.badgeText; app.dock.renderButtons(); } return;
      case "OBR_ACTION_GET_BADGE_BACKGROUND_COLOR": return { badgeBackgroundColor: f.ext?.badgeColor };
      case "OBR_ACTION_SET_BADGE_BACKGROUND_COLOR": if (f.ext) { f.ext.badgeColor = d.badgeBackgroundColor; app.dock.renderButtons(); } return;
      case "OBR_ACTION_GET_TITLE": return { title: f.ext?.title };
      case "OBR_ACTION_SET_TITLE": if (f.ext) { f.ext.title = d.title; app.dock.renderButtons(); } return;
      case "OBR_ACTION_GET_ICON": return { icon: f.ext?.icon };
      case "OBR_ACTION_SET_ICON": if (f.ext) { f.ext.icon = d.icon; app.dock.renderButtons(); } return;

      case "OBR_CONTEXT_MENU_CREATE": this.menus.set(d.id, { ref: f.ref, icons: d.icons || [], embed: d.embed }); return;
      case "OBR_CONTEXT_MENU_REMOVE": this.menus.delete(d.id); return;

      // viewport
      case "OBR_VIEWPORT_GET_WIDTH": return { width: board.w };
      case "OBR_VIEWPORT_GET_HEIGHT": return { height: board.h };
      case "OBR_VIEWPORT_GET_POSITION": return { position: { x: board.cam.x, y: board.cam.y } };
      case "OBR_VIEWPORT_SET_POSITION": board.cam.x = d.position.x; board.cam.y = d.position.y; board.invalidate(); return;
      case "OBR_VIEWPORT_GET_SCALE": return { scale: board.cam.z };
      case "OBR_VIEWPORT_SET_SCALE": board.cam.z = d.scale; board.invalidate(); return;
      case "OBR_VIEWPORT_TRANSFORM_POINT": return { point: { x: d.point.x * board.cam.z + board.cam.x, y: d.point.y * board.cam.z + board.cam.y } };
      case "OBR_VIEWPORT_INVERSE_TRANSFORM_POINT": return { point: board.toWorld(d.point.x, d.point.y) };
      case "OBR_VIEWPORT_ANIMATE_TO_BOUNDS": board.fitBounds(d.bounds); return;
      case "OBR_VIEWPORT_ANIMATE_TO": board.cam = { x: d.transform.position.x, y: d.transform.position.y, z: d.transform.scale }; board.invalidate(); return;
      case "OBR_VIEWPORT_RESET": board.fit(); return { transform: { position: { x: board.cam.x, y: board.cam.y }, scale: board.cam.z } };

      case "OBR_THEME_GET_THEME": return { theme: THEME };
      case "OBR_THEME_SUBSCRIBE": case "OBR_THEME_UNSUBSCRIBE": return;
      default:
        if (!this._warned?.has(id)) { (this._warned ??= new Set()).add(id); console.info("[obr] mensagem sem suporte:", id); }
        return {};
    }
  }
  _attachments(pool, ids) {
    const out = new Set(ids), res = [];
    let grew = true;
    while (grew) { grew = false; for (const it of pool) if (it.attachedTo && out.has(it.attachedTo) && !out.has(it.id)) { out.add(it.id); grew = true; } }
    for (const it of pool) if (out.has(it.id)) res.push(it);
    return res;
  }
}

const THEME = {
  mode: "DARK",
  primary: { main: "#e8c26a", light: "#f3dca0", dark: "#b8913f", contrastText: "#16141a" },
  secondary: { main: "#b3262d", light: "#d4545a", dark: "#7d1a1f", contrastText: "#ffffff" },
  background: { default: "#0d0c0f", paper: "#16141a" },
  text: { primary: "#ece6dc", secondary: "#9a92a3", disabled: "#5d5763" },
};
