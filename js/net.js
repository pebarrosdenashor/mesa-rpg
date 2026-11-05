// Camada de sincronização. Tudo na mesa é uma "entidade": {id, kind, data}.
// kinds: scene, token, sheet, msg.
// Modo online: Supabase (tabela `entities` + Realtime). Modo local: BroadcastChannel + localStorage.
import { SUPABASE_URL, SUPABASE_ANON_KEY, STORAGE_BUCKET } from "./config.js";

export const online = Boolean(SUPABASE_URL && SUPABASE_ANON_KEY);

export function uid(n = 10) {
  const a = "abcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  const r = crypto.getRandomValues(new Uint8Array(n));
  for (const b of r) s += a[b % a.length];
  return s;
}

export class Net {
  constructor(room) {
    this.room = room;
    this.entities = new Map();
    this.listeners = new Set();     // (entity|null, id, kind) => void
    this.liveListeners = new Set(); // (event, payload) => void
    this.status = "desconectado";
  }

  onChange(fn) { this.listeners.add(fn); }
  onLive(fn) { this.liveListeners.add(fn); }
  _emit(id, ent, kind) { for (const fn of this.listeners) fn(ent, id, kind); }
  _emitLive(ev, p) { for (const fn of this.liveListeners) fn(ev, p); }

  all(kind) { return [...this.entities.values()].filter(e => e.kind === kind); }
  get(id) { return this.entities.get(id); }

  _applyLocal(ent) {
    this.entities.set(ent.id, ent);
    this._emit(ent.id, ent, ent.kind);
  }
  _removeLocal(id) {
    const old = this.entities.get(id);
    if (!old) return;
    this.entities.delete(id);
    this._emit(id, null, old.kind);
  }

  async connect() {
    if (online) return this._connectSupabase();
    return this._connectLocal();
  }

  // ---------- modo local ----------
  _lsKey() { return "mesa-local-" + this.room; }
  _saveLocalStore() {
    try { localStorage.setItem(this._lsKey(), JSON.stringify([...this.entities.values()])); } catch {}
  }
  async _connectLocal() {
    try {
      const arr = JSON.parse(localStorage.getItem(this._lsKey()) || "[]");
      for (const e of arr) this.entities.set(e.id, e);
    } catch {}
    this.bc = new BroadcastChannel("mesa-" + this.room);
    this.bc.onmessage = ({ data }) => {
      if (data.t === "put") this._applyLocal(data.ent);
      else if (data.t === "del") this._removeLocal(data.id);
      else if (data.t === "live") this._emitLive(data.ev, data.p);
    };
    this.status = "local";
  }

  // ---------- modo Supabase ----------
  async _connectSupabase() {
    const { createClient } = await import("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm");
    this.sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const { data, error } = await this.sb.from("entities").select("id,kind,data").eq("room", this.room);
    if (error) throw new Error("Erro ao carregar a mesa: " + error.message);
    for (const r of data) this.entities.set(r.id, { id: r.id, kind: r.kind, data: r.data });

    this.ch = this.sb.channel("mesa:" + this.room, { config: { broadcast: { self: false } } });
    this.ch.on("postgres_changes",
      { event: "*", schema: "public", table: "entities", filter: `room=eq.${this.room}` },
      (p) => {
        if (p.eventType === "DELETE") return this._removeLocal(p.old.id);
        const r = p.new;
        this._applyLocal({ id: r.id, kind: r.kind, data: r.data });
      });
    // DELETE não respeita filtro no Supabase; escuta sem filtro e confere a sala.
    this.ch.on("postgres_changes", { event: "DELETE", schema: "public", table: "entities" },
      (p) => { if (p.old && p.old.room === this.room) this._removeLocal(p.old.id); });
    this.ch.on("broadcast", { event: "live" }, ({ payload }) => this._emitLive(payload.ev, payload.p));
    await new Promise((res) => this.ch.subscribe((s) => {
      this.status = s === "SUBSCRIBED" ? "online" : s.toLowerCase();
      if (s === "SUBSCRIBED") res();
    }));
  }

  // ---------- API ----------
  async put(ent) {
    ent = { id: ent.id || uid(), kind: ent.kind, data: ent.data };
    this._applyLocal(ent);
    if (online) {
      const { error } = await this.sb.from("entities").upsert({
        room: this.room, id: ent.id, kind: ent.kind, data: ent.data, updated_at: new Date().toISOString(),
      });
      if (error) console.error(error);
    } else {
      this.bc.postMessage({ t: "put", ent });
      this._saveLocalStore();
    }
    return ent;
  }

  async del(id) {
    this._removeLocal(id);
    if (online) {
      const { error } = await this.sb.from("entities").delete().eq("room", this.room).eq("id", id);
      if (error) console.error(error);
    } else {
      this.bc.postMessage({ t: "del", id });
      this._saveLocalStore();
    }
  }

  // Mensagens efêmeras (arrastar token ao vivo, ping no mapa). Não são salvas.
  live(ev, p) {
    if (online) this.ch?.send({ type: "broadcast", event: "live", payload: { ev, p } });
    else this.bc.postMessage({ t: "live", ev, p });
  }

  // Envia uma imagem (já reduzida) e devolve a URL.
  async uploadImage(blob) {
    if (!online) {
      return await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(blob); });
    }
    const path = `${this.room}/${uid(12)}.webp`;
    const { error } = await this.sb.storage.from(STORAGE_BUCKET).upload(path, blob, { contentType: blob.type, upsert: false });
    if (error) throw new Error("Falha ao enviar imagem: " + error.message);
    return this.sb.storage.from(STORAGE_BUCKET).getPublicUrl(path).data.publicUrl;
  }
}

// Reduz uma imagem para no máximo `max` px no maior lado.
export async function shrinkImage(file, max = 2400, quality = 0.85) {
  const bmp = await createImageBitmap(file);
  const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return await new Promise((res) => c.toBlob(res, "image/webp", quality));
}
