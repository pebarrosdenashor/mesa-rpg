// Mapa: canvas com pan/zoom, grid, tokens, itens das extensões, régua, ping e menu de clique direito.
export const SCENE_ID = "scene";
export const DEFAULT_SCENE = { mapUrl: "", mapW: 1400, mapH: 1000, grid: 70, gridOn: true, gridColor: "#ffffff", gridAlpha: 0.18, unit: 1.5, unitName: "m" };

const rgba = (c, a = 1) => {
  if (!c) return `rgba(0,0,0,${a})`;
  if (c === "white") c = "#ffffff"; else if (c === "black") c = "#000000";
  if (c[0] !== "#") return c;
  let h = c.slice(1); if (h.length === 3) h = [...h].map(x => x + x).join("");
  const n = parseInt(h.slice(0, 6), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
const textOf = (t) => {
  if (!t) return "";
  if (t.type === "PLAIN" || !Array.isArray(t.richText)) return t.plainText || "";
  const walk = (n) => n.text ?? (n.children || []).map(walk).join("");
  return t.richText.map(walk).join("\n") || t.plainText || "";
};

export class Board {
  constructor(canvas, app) {
    this.cv = canvas;
    this.g = canvas.getContext("2d");
    this.mctx = document.createElement("canvas").getContext("2d");
    this.app = app;
    this.net = app.net;
    this.cam = { x: 0, y: 0, z: 1 };
    this.tool = "move";
    this.imgs = new Map();
    this.drag = null;
    this.livePos = new Map();
    this.rulers = new Map();
    this.pings = [];
    this.selected = null;     // seleção principal
    this.selection = [];
    this.dirty = true;
    this._bind();
    this._resize();
    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    const loop = () => { if (this.dirty || this.pings.length) this._draw(); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
    this.net.onLive((ev, p) => this._onLive(ev, p));
  }

  get scene() { return { ...DEFAULT_SCENE, ...(this.net.get(SCENE_ID)?.data || {}), ...(this.app._scPending || {}) }; }
  invalidate() { this.dirty = true; }

  _resize() {
    const r = this.cv.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.cv.width = r.width * dpr; this.cv.height = r.height * dpr;
    this.cv.style.width = r.width + "px"; this.cv.style.height = r.height + "px";
    this.dpr = dpr; this.w = r.width; this.h = r.height;
    this.dirty = true;
  }

  fit() {
    const s = this.scene;
    this.fitBounds({ min: { x: 0, y: 0 }, max: { x: s.mapW, y: s.mapH } }, 40, 2);
  }
  fitBounds(b, pad = 40, maxZ = 3) {
    const w = Math.max(1, b.max.x - b.min.x), h = Math.max(1, b.max.y - b.min.y);
    const z = Math.max(0.1, Math.min((this.w - pad * 2) / w, (this.h - pad * 2) / h, maxZ));
    this.cam = { z, x: this.w / 2 - (b.min.x + w / 2) * z, y: this.h / 2 - (b.min.y + h / 2) * z };
    this.dirty = true;
  }

  toWorld(sx, sy) { return { x: (sx - this.cam.x) / this.cam.z, y: (sy - this.cam.y) / this.cam.z }; }
  _evPos(e) { const r = this.cv.getBoundingClientRect(); return { sx: e.clientX - r.left, sy: e.clientY - r.top }; }

  img(url) {
    if (!url) return null;
    let im = this.imgs.get(url);
    if (!im) {
      im = new Image(); im.crossOrigin = "anonymous";
      im.onload = () => { this.dirty = true; };
      im.onerror = () => { if (!im._retried) { im._retried = true; im.removeAttribute("crossorigin"); im.src = url; } };
      im.src = url; this.imgs.set(url, im);
    }
    return im.complete && im.naturalWidth ? im : null;
  }

  visibleTokens() {
    const gm = this.app.isGM;
    return this.net.all("token").filter(t => gm || !t.data.hidden).sort((a, b) => (a.data.z || 0) - (b.data.z || 0));
  }

  tokenPos(t) {
    if (this.drag && this.drag.id === t.id) return { x: this.drag.x, y: this.drag.y };
    const lp = this.livePos.get(t.id);
    if (lp && performance.now() - lp.t < 3000) return lp;
    return { x: t.data.x, y: t.data.y };
  }

  // item da lista de desenho sob o ponto (de cima para baixo)
  hit(wx, wy) {
    const list = this.app.obr.renderList();
    const g = this.scene.grid;
    for (let i = list.length - 1; i >= 0; i--) {
      const o = list[i], it = o.it;
      if (it.disableHit || it.layer === "MAP" || it.layer === "GRID" || it.layer === "POST_PROCESS") continue;
      if (o.token) {
        const p = this.tokenPos(o.token), r = (o.token.data.size || 1) * g / 2;
        if (Math.abs(wx - p.x) <= r && Math.abs(wy - p.y) <= r) return o;
        continue;
      }
      if (it.layer !== "ATTACHMENT" && it.locked && !this.app.isGM) continue;
      const b = this.app.obr.bounds(this._dragged(it));
      if (b.w > 20000 || b.h > 20000) continue; // telas cheias de efeito não pegam clique
      if (wx >= b.x0 && wx <= b.x0 + b.w && wy >= b.y0 && wy <= b.y0 + b.h) return o;
    }
    return null;
  }
  _dragged(it) { return this.drag && this.drag.id === it.id ? { ...it, position: { x: this.drag.x, y: this.drag.y } } : it; }

  canMove(o) {
    if (o.token) { const t = o.token; return this.app.isGM || (t.data.owner && t.data.owner === this.app.me.id) || t.data.free; }
    const it = o.it;
    if (it.locked || it.attachedTo) return false;
    return o.local || this.app.isGM || it.createdUserId === this.app.me.id;
  }

  snap(x, y, size) {
    const g = this.scene.grid;
    const off = (size % 2 === 1) ? g / 2 : 0;
    return { x: Math.round((x - off) / g) * g + off, y: Math.round((y - off) / g) * g + off };
  }

  select(id) { this.selectMany(id ? [id] : []); }
  selectMany(ids) {
    this.selection = [...(ids || [])];
    this.selected = this.selection[0] || null;
    this.dirty = true;
    this.app.onSelect(this.selected);
    this.app.obr?.setSelection(this.selection);
  }

  _bind() {
    const cv = this.cv;
    let pan = null, lastLive = 0, ruler = null, rdown = null;
    cv.addEventListener("contextmenu", e => e.preventDefault());
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      this.app.hideMenu();
      const { sx, sy } = this._evPos(e);
      const w = this.toWorld(sx, sy);
      if (e.button === 0 && e.shiftKey) { this._ping(w); return; }
      if (e.button === 0 && this.tool === "ruler") {
        const a = this._cellCenter(w); ruler = { a, b: a }; this._setRuler(this.app.me.id, ruler); return;
      }
      if (e.button === 2) rdown = { sx, sy, cx: e.clientX, cy: e.clientY, o: this.hit(w.x, w.y) };
      if (e.button === 0) {
        const o = this.hit(w.x, w.y);
        if (o) {
          this.select(o.it.id);
          if (this.canMove(o)) {
            const p = o.token ? this.tokenPos(o.token) : o.it.position;
            this.drag = { id: o.it.id, token: !!o.token, local: o.local, ox: w.x - p.x, oy: w.y - p.y, x: p.x, y: p.y, moved: false };
          }
          return;
        }
        this.select(null);
      }
      pan = { sx, sy, cx: this.cam.x, cy: this.cam.y };
    });
    cv.addEventListener("pointermove", (e) => {
      const { sx, sy } = this._evPos(e);
      const w = this.toWorld(sx, sy);
      if (rdown && Math.hypot(sx - rdown.sx, sy - rdown.sy) > 5) rdown = null;
      if (ruler) {
        ruler.b = this._cellCenter(w); this._setRuler(this.app.me.id, ruler);
        const now = performance.now(); if (now - lastLive > 50) { lastLive = now; this.net.live("ruler", { who: this.app.me.id, name: this.app.me.name, a: ruler.a, b: ruler.b }); }
        return;
      }
      if (this.drag) {
        this.drag.x = w.x - this.drag.ox; this.drag.y = w.y - this.drag.oy; this.drag.moved = true; this.dirty = true;
        const now = performance.now();
        if (this.drag.token && now - lastLive > 40) { lastLive = now; this.net.live("move", { id: this.drag.id, x: this.drag.x, y: this.drag.y }); }
        return;
      }
      if (pan) { this.cam.x = pan.cx + sx - pan.sx; this.cam.y = pan.cy + sy - pan.sy; this.dirty = true; }
    });
    const end = (e) => {
      if (ruler) { ruler = null; this.rulers.delete(this.app.me.id); this.net.live("ruler", { who: this.app.me.id, clear: true }); this.dirty = true; }
      if (this.drag) {
        const d = this.drag; this.drag = null;
        if (d.moved) {
          if (d.token) {
            const t = this.net.get(d.id);
            if (t) { const p = this.snap(d.x, d.y, t.data.size || 1); this.net.put({ ...t, data: { ...t.data, x: p.x, y: p.y } }); }
          } else {
            this.app.obr.updateItems([{ id: d.id, type: "", position: { x: d.x, y: d.y } }], d.local);
          }
        }
        this.dirty = true;
      }
      if (rdown && e?.type === "pointerup") {
        const o = rdown.o; rdown = null;
        if (o) { if (!this.selection.includes(o.it.id)) this.select(o.it.id); this.app.showMenu(e.clientX, e.clientY, o); }
      }
      pan = null;
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    cv.addEventListener("dblclick", (e) => {
      const { sx, sy } = this._evPos(e); const w = this.toWorld(sx, sy);
      const o = this.hit(w.x, w.y);
      if (o?.token?.data.sheetId) this.app.openSheet(o.token.data.sheetId);
    });
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const { sx, sy } = this._evPos(e);
      const f = Math.exp(-e.deltaY * 0.0015);
      const z = Math.min(6, Math.max(0.05, this.cam.z * f));
      const w = this.toWorld(sx, sy);
      this.cam.z = z; this.cam.x = sx - w.x * z; this.cam.y = sy - w.y * z; this.dirty = true;
    }, { passive: false });
    window.addEventListener("keydown", (e) => {
      if (e.target.closest("input,textarea,select,[contenteditable]")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && this.selected && this.app.isGM) this.app.deleteSelected();
      if (e.key === "r" || e.key === "R") this.app.setTool(this.tool === "ruler" ? "move" : "ruler");
      if (e.key === "Escape") { this.select(null); this.app.hideMenu(); }
    });
  }

  _cellCenter(w) { const g = this.scene.grid; return { x: Math.floor(w.x / g) * g + g / 2, y: Math.floor(w.y / g) * g + g / 2 }; }
  _setRuler(who, r) { this.rulers.set(who, { ...r, t: performance.now(), name: who === this.app.me.id ? "" : r.name }); this.dirty = true; }
  _ping(w) { this.pings.push({ ...w, t: performance.now(), color: this.app.me.color }); this.net.live("ping", { x: w.x, y: w.y, color: this.app.me.color }); }

  _onLive(ev, p) {
    if (ev === "move") { this.livePos.set(p.id, { x: p.x, y: p.y, t: performance.now() }); }
    else if (ev === "ruler") { if (p.clear) this.rulers.delete(p.who); else this._setRuler(p.who, p); }
    else if (ev === "ping") this.pings.push({ x: p.x, y: p.y, color: p.color, t: performance.now() });
    else return;
    this.dirty = true;
  }
  tokenSaved(id) { this.livePos.delete(id); this.dirty = true; }

  // ---------- texto ----------
  _font(st) { return `${st.fontWeight || 400} ${st.fontSize || 16}px ${st.fontFamily && st.fontFamily !== "Roboto" ? `"${st.fontFamily}", ` : ""}Inter, Roboto, sans-serif`; }
  _lines(it) {
    const st = it.text?.style || {}, pad = st.padding || 0;
    const raw = textOf(it.text).split("\n");
    this.mctx.font = this._font(st);
    const maxW = typeof it.text?.width === "number" ? it.text.width - pad * 2 : Infinity;
    const lines = [];
    for (const para of raw) {
      if (maxW === Infinity) { lines.push(para); continue; }
      let cur = "";
      for (const word of para.split(/(\s+)/)) {
        const t = cur + word;
        if (cur && this.mctx.measureText(t).width > maxW) { lines.push(cur.trimEnd()); cur = word.trimStart(); } else cur = t;
      }
      lines.push(cur);
    }
    return lines;
  }
  measureText(it) {
    const st = it.text?.style || {}, pad = st.padding || 0, fs = st.fontSize || 16, lh = fs * (st.lineHeight || 1.5);
    const lines = this._lines(it);
    this.mctx.font = this._font(st);
    const w = typeof it.text?.width === "number" ? it.text.width : Math.max(1, ...lines.map(l => this.mctx.measureText(l).width)) + pad * 2;
    const h = typeof it.text?.height === "number" ? it.text.height : lines.length * lh + pad * 2;
    return { w, h, lines, lh, pad, st };
  }
  _drawText(g, it, x0, y0, m) {
    const st = m.st, fs = st.fontSize || 16;
    g.font = this._font(st);
    g.textBaseline = "middle";
    const align = st.textAlign || "LEFT";
    g.textAlign = align === "CENTER" ? "center" : align === "RIGHT" ? "right" : "left";
    const tx = align === "CENTER" ? x0 + m.w / 2 : align === "RIGHT" ? x0 + m.w - m.pad : x0 + m.pad;
    const blockH = m.lines.length * m.lh;
    const va = st.textAlignVertical || "TOP";
    let ty = va === "MIDDLE" ? y0 + (m.h - blockH) / 2 : va === "BOTTOM" ? y0 + m.h - m.pad - blockH : y0 + m.pad;
    for (const line of m.lines) {
      const cy = ty + m.lh / 2;
      if (st.strokeWidth > 0) { g.lineWidth = st.strokeWidth; g.strokeStyle = rgba(st.strokeColor, st.strokeOpacity ?? 1); g.lineJoin = "round"; g.strokeText(line, tx, cy); }
      g.fillStyle = rgba(st.fillColor || "#ffffff", st.fillOpacity ?? 1);
      g.fillText(line, tx, cy);
      ty += m.lh;
    }
    void fs;
  }

  // ---------- desenho de itens de extensão ----------
  _drawItem(g, it, gm) {
    it = this._dragged(it);
    const p = it.position, sx = it.scale?.x ?? 1, sy = it.scale?.y ?? 1;
    g.save();
    if (it.visible === false) g.globalAlpha *= gm ? 0.4 : 0;
    g.translate(p.x, p.y);
    if (it.rotation) g.rotate(it.rotation * Math.PI / 180);
    g.scale(sx, sy);
    if (it.type === "SHAPE") {
      const s = it.style || {}, w = it.width || 0, h = it.height || 0;
      g.beginPath();
      if (it.shapeType === "CIRCLE") g.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2);
      else if (it.shapeType === "TRIANGLE") { g.moveTo(0, 0); g.lineTo(w / 2, h); g.lineTo(-w / 2, h); g.closePath(); }
      else if (it.shapeType === "HEXAGON") { for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i; g[i ? "lineTo" : "moveTo"](Math.cos(a) * w / 2, Math.sin(a) * h / 2); } g.closePath(); }
      else g.rect(0, 0, w, h);
      if ((s.fillOpacity ?? 1) > 0) { g.fillStyle = rgba(s.fillColor, s.fillOpacity ?? 1); g.fill(); }
      if ((s.strokeWidth ?? 0) > 0 && (s.strokeOpacity ?? 1) > 0) {
        g.lineWidth = s.strokeWidth / Math.max(Math.abs(sx), 0.0001); g.strokeStyle = rgba(s.strokeColor, s.strokeOpacity ?? 1);
        g.setLineDash(s.strokeDash || []); g.stroke(); g.setLineDash([]);
      }
    } else if (it.type === "IMAGE") {
      const im = this.img(it.image?.url);
      const k = this.scene.grid / (it.grid?.dpi || this.scene.grid);
      const w = (it.image?.width || 0) * k, h = (it.image?.height || 0) * k;
      const ox = (it.grid?.offset?.x || 0) * k, oy = (it.grid?.offset?.y || 0) * k;
      if (im) g.drawImage(im, -ox, -oy, w, h);
    } else if (it.type === "TEXT") {
      this._drawText(g, it, 0, 0, this.measureText(it));
    } else if (it.type === "LABEL") {
      const m = this.measureText(it), s = it.style || {}, ph = s.pointerHeight ?? 4, pw = s.pointerWidth ?? 4, r = s.cornerRadius ?? 8;
      const x0 = -m.w / 2, y0 = -m.h - ph;
      g.fillStyle = rgba(s.backgroundColor || "#3D4051", s.backgroundOpacity ?? 1);
      g.beginPath(); g.roundRect(x0, y0, m.w, m.h, r); g.fill();
      g.beginPath(); g.moveTo(-pw, -ph); g.lineTo(pw, -ph); g.lineTo(0, 0); g.closePath(); g.fill();
      this._drawText(g, it, x0, y0, m);
    } else if ((it.type === "LINE" || it.type === "CURVE" || it.type === "PATH") && Array.isArray(it.points || [it.startPosition])) {
      const s = it.style || {}, pts = it.points || [it.startPosition, it.endPosition].filter(Boolean);
      g.beginPath(); pts.forEach((q, i) => g[i ? "lineTo" : "moveTo"](q.x, q.y));
      if (it.style?.closed) g.closePath();
      if ((s.fillOpacity ?? 0) > 0) { g.fillStyle = rgba(s.fillColor, s.fillOpacity); g.fill(); }
      g.lineWidth = s.strokeWidth || 2; g.strokeStyle = rgba(s.strokeColor || "#fff", s.strokeOpacity ?? 1); g.stroke();
    }
    g.restore();
  }

  _drawToken(g, t, s, c) {
    const d = t.data, p = this.tokenPos(t), r = (d.size || 1) * s.grid / 2 - 2;
    g.save();
    g.globalAlpha = d.hidden ? 0.45 : 1;
    g.translate(p.x, p.y); if (d.rotation) g.rotate(d.rotation * Math.PI / 180); g.translate(-p.x, -p.y);
    g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2);
    g.fillStyle = d.color || "#8a1c1c"; g.fill();
    const ti = this.img(d.img);
    if (ti) {
      g.save(); g.beginPath(); g.arc(p.x, p.y, r - 3, 0, Math.PI * 2); g.clip();
      const k = Math.max((2 * r) / ti.naturalWidth, (2 * r) / ti.naturalHeight);
      g.drawImage(ti, p.x - ti.naturalWidth * k / 2, p.y - ti.naturalHeight * k / 2, ti.naturalWidth * k, ti.naturalHeight * k);
      g.restore();
    } else {
      g.fillStyle = "#f3ece2"; g.font = `600 ${Math.max(10, r * 0.8)}px Inter, sans-serif`;
      g.textAlign = "center"; g.textBaseline = "middle";
      g.fillText((d.label || "?").slice(0, 2).toUpperCase(), p.x, p.y + 1);
    }
    const sel = this.selection.includes(t.id);
    g.lineWidth = sel ? 4 / c.z + 2 : 2;
    g.strokeStyle = sel ? "#e8c26a" : "rgba(0,0,0,.6)";
    g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.stroke();
    const sh = d.sheetId && this.net.get(d.sheetId);
    if (sh && (this.app.isGM || !d.hideHp || sh.data.owner === this.app.me.id)) {
      const pv = sh.data.pv || {}; const max = Number(pv.max) || 0, cur = Number(pv.atual) || 0;
      if (max > 0) {
        const bw = r * 1.8, bx = p.x - bw / 2, by = p.y + r + 4;
        g.fillStyle = "rgba(0,0,0,.7)"; g.fillRect(bx, by, bw, 6);
        g.fillStyle = cur / max > 0.5 ? "#4fa36b" : cur / max > 0.25 ? "#d8a33a" : "#c2392b";
        g.fillRect(bx + 1, by + 1, Math.max(0, (bw - 2) * Math.min(1, cur / max)), 4);
      }
    }
    // se uma extensão desenha barras/anexos no token, o nome da Mesa sai do caminho
    if (d.label && (d.showName ?? true) && !this._hasAttach(t.id)) {
      g.font = `500 ${Math.max(11, 12 / c.z)}px Inter, sans-serif`; g.textAlign = "center"; g.textBaseline = "top";
      const ty = p.y + r + (sh ? 13 : 4);
      const tw = g.measureText(d.label).width;
      g.fillStyle = "rgba(0,0,0,.65)"; g.fillRect(p.x - tw / 2 - 4, ty - 1, tw + 8, Math.max(11, 12 / c.z) + 4);
      g.fillStyle = "#f3ece2"; g.fillText(d.label, p.x, ty + 1);
    }
    g.restore();
  }

  _hasAttach(id) { return this._attachSet?.has(id); }

  _draw() {
    this.dirty = false;
    const g = this.g, s = this.scene, c = this.cam, gm = this.app.isGM;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = "#0b0a0c"; g.fillRect(0, 0, this.w, this.h);
    g.setTransform(this.dpr * c.z, 0, 0, this.dpr * c.z, this.dpr * c.x, this.dpr * c.y);

    const im = this.img(s.mapUrl);
    if (im) g.drawImage(im, 0, 0, s.mapW, s.mapH);
    else { g.fillStyle = "#17151a"; g.fillRect(0, 0, s.mapW, s.mapH); }

    const list = this.app.obr ? this.app.obr.renderList() : [];
    this._attachSet = new Set(list.filter(o => o.it.attachedTo).map(o => o.it.attachedTo));
    const beforeGrid = list.filter(o => o.it.layer === "MAP");
    for (const o of beforeGrid) this._drawItem(g, o.it, gm);

    if (s.gridOn) {
      g.strokeStyle = s.gridColor; g.globalAlpha = s.gridAlpha; g.lineWidth = 1 / c.z;
      g.beginPath();
      for (let x = 0; x <= s.mapW + 0.1; x += s.grid) { g.moveTo(x, 0); g.lineTo(x, s.mapH); }
      for (let y = 0; y <= s.mapH + 0.1; y += s.grid) { g.moveTo(0, y); g.lineTo(s.mapW, y); }
      g.stroke(); g.globalAlpha = 1;
    }

    for (const o of list) {
      if (o.it.layer === "MAP") continue;
      if (o.token) this._drawToken(g, o.token, s, c);
      else this._drawItem(g, o.it, gm);
    }
    // contorno da seleção em itens que não são tokens
    for (const id of this.selection) {
      const o = list.find(x => x.it.id === id);
      if (!o || o.token) continue;
      const b = this.app.obr.bounds(this._dragged(o.it));
      if (b.w > 20000) continue;
      g.strokeStyle = "#e8c26a"; g.lineWidth = 2 / c.z; g.setLineDash([6 / c.z, 4 / c.z]);
      g.strokeRect(b.x0 - 3 / c.z, b.y0 - 3 / c.z, b.w + 6 / c.z, b.h + 6 / c.z); g.setLineDash([]);
    }

    const now = performance.now();
    for (const [who, r] of this.rulers) {
      if (now - r.t > 8000) { this.rulers.delete(who); continue; }
      const cells = Math.max(Math.abs(r.b.x - r.a.x), Math.abs(r.b.y - r.a.y)) / s.grid;
      g.strokeStyle = "#e8c26a"; g.lineWidth = 3 / c.z; g.setLineDash([10 / c.z, 6 / c.z]);
      g.beginPath(); g.moveTo(r.a.x, r.a.y); g.lineTo(r.b.x, r.b.y); g.stroke(); g.setLineDash([]);
      const label = `${+(cells * s.unit).toFixed(1)} ${s.unitName} (${Math.round(cells)} q)` + (r.name ? ` — ${r.name}` : "");
      const fs = 14 / c.z;
      g.font = `600 ${fs}px Inter, sans-serif`; g.textAlign = "left"; g.textBaseline = "middle";
      const tw = g.measureText(label).width;
      g.fillStyle = "rgba(10,8,10,.85)"; g.fillRect(r.b.x + 12 / c.z, r.b.y - fs, tw + 12 / c.z, fs * 2);
      g.fillStyle = "#e8c26a"; g.fillText(label, r.b.x + 18 / c.z, r.b.y);
    }

    this.pings = this.pings.filter(p => now - p.t < 1600);
    for (const p of this.pings) {
      const k = (now - p.t) / 1600;
      g.strokeStyle = p.color || "#e8c26a"; g.globalAlpha = 1 - k; g.lineWidth = 4 / c.z;
      g.beginPath(); g.arc(p.x, p.y, (10 + k * 60) / c.z * 1.5, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
    }
  }
}
