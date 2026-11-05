// Mapa: canvas com pan/zoom, grid, tokens arrastáveis, régua e ping.
export const SCENE_ID = "scene";
export const DEFAULT_SCENE = { mapUrl: "", mapW: 1400, mapH: 1000, grid: 70, gridOn: true, gridColor: "#ffffff", gridAlpha: 0.18, unit: 1.5, unitName: "m" };

export class Board {
  constructor(canvas, app) {
    this.cv = canvas;
    this.g = canvas.getContext("2d");
    this.app = app;
    this.net = app.net;
    this.cam = { x: 0, y: 0, z: 1 };
    this.tool = "move";
    this.imgs = new Map();
    this.drag = null;         // {id, ox, oy, x, y}
    this.livePos = new Map(); // id -> {x,y,t} de outros jogadores arrastando
    this.rulers = new Map();  // quem -> {a,b,t}
    this.pings = [];
    this.selected = null;
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
    const z = Math.min(this.w / (s.mapW + 80), this.h / (s.mapH + 80), 2);
    this.cam = { z, x: this.w / 2 - (s.mapW / 2) * z, y: this.h / 2 - (s.mapH / 2) * z };
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
      im.src = url; this.imgs.set(url, im);
    }
    return im.complete && im.naturalWidth ? im : null;
  }

  visibleTokens() {
    const gm = this.app.isGM;
    return this.net.all("token")
      .filter(t => gm || !t.data.hidden)
      .sort((a, b) => (a.data.z || 0) - (b.data.z || 0));
  }

  tokenPos(t) {
    if (this.drag && this.drag.id === t.id) return { x: this.drag.x, y: this.drag.y };
    const lp = this.livePos.get(t.id);
    if (lp && performance.now() - lp.t < 3000) return lp;
    return { x: t.data.x, y: t.data.y };
  }

  hit(wx, wy) {
    const g = this.scene.grid;
    const toks = this.visibleTokens();
    for (let i = toks.length - 1; i >= 0; i--) {
      const t = toks[i], p = this.tokenPos(t), r = (t.data.size || 1) * g / 2;
      if (Math.abs(wx - p.x) <= r && Math.abs(wy - p.y) <= r) return t;
    }
    return null;
  }

  canMove(t) { return this.app.isGM || (t.data.owner && t.data.owner === this.app.me.id) || t.data.free; }

  snap(x, y, size) {
    const g = this.scene.grid;
    const off = (size % 2 === 1) ? g / 2 : 0;
    return { x: Math.round((x - off) / g) * g + off, y: Math.round((y - off) / g) * g + off };
  }

  _bind() {
    const cv = this.cv;
    let pan = null, lastLive = 0, ruler = null;
    cv.addEventListener("contextmenu", e => e.preventDefault());
    cv.addEventListener("pointerdown", (e) => {
      cv.setPointerCapture(e.pointerId);
      const { sx, sy } = this._evPos(e);
      const w = this.toWorld(sx, sy);
      if (e.button === 0 && e.shiftKey) { this._ping(w); return; }
      if (e.button === 0 && this.tool === "ruler") {
        const a = this._cellCenter(w); ruler = { a, b: a }; this._setRuler(this.app.me.id, ruler); return;
      }
      if (e.button === 0) {
        const t = this.hit(w.x, w.y);
        if (t) {
          this.select(t.id);
          if (this.canMove(t)) { const p = this.tokenPos(t); this.drag = { id: t.id, ox: w.x - p.x, oy: w.y - p.y, x: p.x, y: p.y, moved: false }; }
          return;
        }
        this.select(null);
      }
      pan = { sx, sy, cx: this.cam.x, cy: this.cam.y };
    });
    cv.addEventListener("pointermove", (e) => {
      const { sx, sy } = this._evPos(e);
      const w = this.toWorld(sx, sy);
      if (ruler) {
        ruler.b = this._cellCenter(w); this._setRuler(this.app.me.id, ruler);
        const now = performance.now(); if (now - lastLive > 50) { lastLive = now; this.net.live("ruler", { who: this.app.me.id, name: this.app.me.name, a: ruler.a, b: ruler.b }); }
        return;
      }
      if (this.drag) {
        this.drag.x = w.x - this.drag.ox; this.drag.y = w.y - this.drag.oy; this.drag.moved = true; this.dirty = true;
        const now = performance.now();
        if (now - lastLive > 40) { lastLive = now; this.net.live("move", { id: this.drag.id, x: this.drag.x, y: this.drag.y }); }
        return;
      }
      if (pan) { this.cam.x = pan.cx + sx - pan.sx; this.cam.y = pan.cy + sy - pan.sy; this.dirty = true; }
    });
    const end = () => {
      if (ruler) { ruler = null; this.rulers.delete(this.app.me.id); this.net.live("ruler", { who: this.app.me.id, clear: true }); this.dirty = true; }
      if (this.drag) {
        const d = this.drag; this.drag = null;
        const t = this.net.get(d.id);
        if (t && d.moved) {
          const p = this.snap(d.x, d.y, t.data.size || 1);
          this.net.put({ ...t, data: { ...t.data, x: p.x, y: p.y } });
        }
        this.dirty = true;
      }
      pan = null;
    };
    cv.addEventListener("pointerup", end);
    cv.addEventListener("pointercancel", end);
    cv.addEventListener("dblclick", (e) => {
      const { sx, sy } = this._evPos(e); const w = this.toWorld(sx, sy);
      const t = this.hit(w.x, w.y);
      if (t?.data.sheetId) this.app.openSheet(t.data.sheetId);
    });
    cv.addEventListener("wheel", (e) => {
      e.preventDefault();
      const { sx, sy } = this._evPos(e);
      const f = Math.exp(-e.deltaY * 0.0015);
      const z = Math.min(6, Math.max(0.1, this.cam.z * f));
      const w = this.toWorld(sx, sy);
      this.cam.z = z; this.cam.x = sx - w.x * z; this.cam.y = sy - w.y * z; this.dirty = true;
    }, { passive: false });
    window.addEventListener("keydown", (e) => {
      if (e.target.closest("input,textarea,select,[contenteditable]")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && this.selected && this.app.isGM) { this.net.del(this.selected); this.select(null); }
      if (e.key === "r" || e.key === "R") this.app.setTool(this.tool === "ruler" ? "move" : "ruler");
      if (e.key === "Escape") this.select(null);
    });
  }

  select(id) { this.selected = id; this.dirty = true; this.app.onSelect(id); }

  _cellCenter(w) { const g = this.scene.grid; return { x: Math.floor(w.x / g) * g + g / 2, y: Math.floor(w.y / g) * g + g / 2 }; }
  _setRuler(who, r) { this.rulers.set(who, { ...r, t: performance.now(), name: who === this.app.me.id ? "" : r.name }); this.dirty = true; }
  _ping(w) { this.pings.push({ ...w, t: performance.now(), color: this.app.me.color }); this.net.live("ping", { x: w.x, y: w.y, color: this.app.me.color }); }

  _onLive(ev, p) {
    if (ev === "move") { this.livePos.set(p.id, { x: p.x, y: p.y, t: performance.now() }); }
    else if (ev === "ruler") { if (p.clear) this.rulers.delete(p.who); else this._setRuler(p.who, p); }
    else if (ev === "ping") this.pings.push({ x: p.x, y: p.y, color: p.color, t: performance.now() });
    this.dirty = true;
  }

  // Quando o token salvo chega, descarta a posição "ao vivo".
  tokenSaved(id) { this.livePos.delete(id); this.dirty = true; }

  _draw() {
    this.dirty = false;
    const g = this.g, s = this.scene, c = this.cam;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = "#0b0a0c"; g.fillRect(0, 0, this.w, this.h);
    g.setTransform(this.dpr * c.z, 0, 0, this.dpr * c.z, this.dpr * c.x, this.dpr * c.y);

    // mapa
    const im = this.img(s.mapUrl);
    if (im) g.drawImage(im, 0, 0, s.mapW, s.mapH);
    else { g.fillStyle = "#17151a"; g.fillRect(0, 0, s.mapW, s.mapH); }

    // grid
    if (s.gridOn) {
      g.strokeStyle = s.gridColor; g.globalAlpha = s.gridAlpha; g.lineWidth = 1 / c.z;
      g.beginPath();
      for (let x = 0; x <= s.mapW + 0.1; x += s.grid) { g.moveTo(x, 0); g.lineTo(x, s.mapH); }
      for (let y = 0; y <= s.mapH + 0.1; y += s.grid) { g.moveTo(0, y); g.lineTo(s.mapW, y); }
      g.stroke(); g.globalAlpha = 1;
    }

    // tokens
    const sheets = this.net;
    for (const t of this.visibleTokens()) {
      const d = t.data, p = this.tokenPos(t), r = (d.size || 1) * s.grid / 2 - 2;
      g.save();
      g.globalAlpha = d.hidden ? 0.45 : 1;
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
      g.lineWidth = this.selected === t.id ? 4 / c.z + 2 : 2;
      g.strokeStyle = this.selected === t.id ? "#e8c26a" : "rgba(0,0,0,.6)";
      g.beginPath(); g.arc(p.x, p.y, r, 0, Math.PI * 2); g.stroke();
      // barra de vida
      const sh = d.sheetId && sheets.get(d.sheetId);
      if (sh && (this.app.isGM || !d.hideHp || sh.data.owner === this.app.me.id)) {
        const pv = sh.data.pv || {}; const max = Number(pv.max) || 0, cur = Number(pv.atual) || 0;
        if (max > 0) {
          const bw = r * 1.8, bx = p.x - bw / 2, by = p.y + r + 4;
          g.fillStyle = "rgba(0,0,0,.7)"; g.fillRect(bx, by, bw, 6);
          g.fillStyle = cur / max > 0.5 ? "#4fa36b" : cur / max > 0.25 ? "#d8a33a" : "#c2392b";
          g.fillRect(bx + 1, by + 1, Math.max(0, (bw - 2) * Math.min(1, cur / max)), 4);
        }
      }
      if (d.label && (d.showName ?? true)) {
        g.font = `500 ${Math.max(11, 12 / c.z)}px Inter, sans-serif`; g.textAlign = "center"; g.textBaseline = "top";
        const ty = p.y + r + (sh ? 13 : 4);
        const tw = g.measureText(d.label).width;
        g.fillStyle = "rgba(0,0,0,.65)"; g.fillRect(p.x - tw / 2 - 4, ty - 1, tw + 8, Math.max(11, 12 / c.z) + 4);
        g.fillStyle = "#f3ece2"; g.fillText(d.label, p.x, ty + 1);
      }
      g.restore();
    }

    // réguas
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

    // pings
    this.pings = this.pings.filter(p => now - p.t < 1600);
    for (const p of this.pings) {
      const k = (now - p.t) / 1600;
      g.strokeStyle = p.color || "#e8c26a"; g.globalAlpha = 1 - k; g.lineWidth = 4 / c.z;
      g.beginPath(); g.arc(p.x, p.y, (10 + k * 60) / c.z * 1.5, 0, Math.PI * 2); g.stroke(); g.globalAlpha = 1;
    }
  }
}
