// Fichas no modelo Ordem Paranormal. Cada jogador vê as próprias; o mestre vê e edita todas.
import { opTestExpr } from "./dice.js";

export const ATRIBUTOS = ["AGI", "FOR", "INT", "PRE", "VIG"];
export const TREINO = [["Destreinado", 0], ["Treinado", 5], ["Veterano", 10], ["Expert", 15]];
const PERICIAS = [
  ["Acrobacia", "AGI"], ["Adestramento", "PRE"], ["Artes", "PRE"], ["Atletismo", "FOR"], ["Atualidades", "INT"],
  ["Ciências", "INT"], ["Crime", "AGI"], ["Diplomacia", "PRE"], ["Enganação", "PRE"], ["Fortitude", "VIG"],
  ["Furtividade", "AGI"], ["Iniciativa", "AGI"], ["Intimidação", "PRE"], ["Intuição", "PRE"], ["Investigação", "INT"],
  ["Luta", "FOR"], ["Medicina", "INT"], ["Ocultismo", "INT"], ["Percepção", "PRE"], ["Pilotagem", "AGI"],
  ["Pontaria", "AGI"], ["Profissão", "INT"], ["Reflexos", "AGI"], ["Religião", "PRE"], ["Sobrevivência", "INT"],
  ["Tática", "INT"], ["Tecnologia", "INT"], ["Vontade", "PRE"],
];

export function newSheet(owner, ownerName, npc = false) {
  return {
    owner, ownerName, npc,
    nome: npc ? "Novo NPC" : "Novo agente", origem: "", classe: "", trilha: "", nex: 5, deslocamento: 9,
    atributos: { AGI: 1, FOR: 1, INT: 1, PRE: 1, VIG: 1 },
    pv: { atual: 20, max: 20 }, pe: { atual: 2, max: 2 }, san: { atual: 12, max: 12 },
    defesa: 10, condicoes: "",
    pericias: PERICIAS.map(([nome, atributo]) => ({ nome, atributo, treino: 0, outros: 0 })),
    ataques: [{ nome: "Ataque desarmado", pericia: "Luta", dano: "1d3", critico: "20/x2" }],
    habilidades: "", inventario: "", notas: "",
  };
}

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export class Sheets {
  constructor(app) {
    this.app = app;
    this.net = app.net;
    this.listEl = document.getElementById("sheet-list");
    this.modal = document.getElementById("sheet-modal");
    this.body = document.getElementById("sheet-body");
    this.openId = null;
    this.saveTimer = null;
    this.pending = null;
    document.getElementById("sheet-close").onclick = () => this.close();
    this.modal.addEventListener("click", (e) => { if (e.target === this.modal) this.close(); });
    document.getElementById("new-sheet").onclick = () => this.create(false);
    document.getElementById("new-npc").onclick = () => this.create(true);
    this.body.addEventListener("input", (e) => this._onInput(e));
    this.body.addEventListener("click", (e) => this._onClick(e));
  }

  visible() {
    return this.net.all("sheet")
      .filter(s => this.app.isGM || (s.data.owner === this.app.me.id) || s.data.shared)
      .sort((a, b) => (a.data.npc - b.data.npc) || a.data.nome.localeCompare(b.data.nome));
  }
  canEdit(s) { return this.app.isGM || s.data.owner === this.app.me.id; }

  async create(npc) {
    const ent = await this.net.put({ kind: "sheet", data: newSheet(npc ? "" : this.app.me.id, npc ? "" : this.app.me.name, npc) });
    this.open(ent.id);
  }

  renderList() {
    document.getElementById("new-npc").hidden = !this.app.isGM;
    const items = this.visible();
    if (!items.length) { this.listEl.innerHTML = `<p class="empty">Nenhuma ficha ainda. Crie a sua acima.</p>`; return; }
    this.listEl.innerHTML = items.map(s => {
      const d = s.data, pv = d.pv || {}, pe = d.pe || {}, san = d.san || {};
      const pct = (o) => Math.max(0, Math.min(100, (Number(o.atual) / (Number(o.max) || 1)) * 100));
      return `<button class="sheet-card" data-open="${s.id}">
        <div class="sc-top"><strong>${esc(d.nome)}</strong><span class="tag">${d.npc ? "NPC" : esc(d.ownerName || "")}</span></div>
        <div class="sc-sub">${esc([d.classe, d.nex ? `NEX ${d.nex}%` : ""].filter(Boolean).join(" · "))}</div>
        <div class="bars">
          <div class="bar pv"><i style="width:${pct(pv)}%"></i><span>PV ${esc(pv.atual)}/${esc(pv.max)}</span></div>
          <div class="bar pe"><i style="width:${pct(pe)}%"></i><span>PE ${esc(pe.atual)}/${esc(pe.max)}</span></div>
          <div class="bar san"><i style="width:${pct(san)}%"></i><span>SAN ${esc(san.atual)}/${esc(san.max)}</span></div>
        </div></button>`;
    }).join("");
    this.listEl.querySelectorAll("[data-open]").forEach(b => b.onclick = () => this.open(b.dataset.open));
  }

  open(id) {
    const s = this.net.get(id);
    if (!s) return;
    if (!this.app.isGM && s.data.owner !== this.app.me.id && !s.data.shared) return;
    this.openId = id;
    this.modal.hidden = false;
    this.render();
  }
  close() { this._flush(); this.openId = null; this.modal.hidden = true; }

  // chamado quando a ficha muda vinda da rede
  changed(id) {
    if (id !== this.openId) return;
    const active = document.activeElement;
    if (active && this.body.contains(active) && active.matches("input,textarea,select")) return; // não atrapalha quem digita
    this.render();
  }

  render() {
    const s = this.net.get(this.openId);
    if (!s) return this.close();
    const d = this.pending || s.data, ro = this.canEdit(s) ? "" : "disabled";
    const num = (path, v, cls = "") => `<input type="number" class="${cls}" data-path="${path}" value="${esc(v)}" ${ro}>`;
    const txt = (path, v, ph = "") => `<input type="text" data-path="${path}" value="${esc(v)}" placeholder="${ph}" ${ro}>`;
    const res = (key, label) => `<div class="res ${key}"><label>${label}</label>
      <div class="res-row"><button class="mini" data-adj="${key}" data-n="-1" ${ro}>−</button>${num(`${key}.atual`, d[key]?.atual)}<span>/</span>${num(`${key}.max`, d[key]?.max)}<button class="mini" data-adj="${key}" data-n="1" ${ro}>+</button></div></div>`;
    const atributos = ATRIBUTOS.map(a => `<div class="attr"><button class="attr-roll" data-roll-attr="${a}" title="Rolar ${a}">${a}</button>${num(`atributos.${a}`, d.atributos[a])}</div>`).join("");
    const pericias = d.pericias.map((p, i) => {
      const bonus = (Number(p.treino) || 0) + (Number(p.outros) || 0);
      return `<tr class="${p.treino ? "trained" : ""}">
        <td><button class="link" data-roll-per="${i}">${esc(p.nome)}</button></td>
        <td><select data-path="pericias.${i}.atributo" ${ro}>${ATRIBUTOS.map(a => `<option ${a === p.atributo ? "selected" : ""}>${a}</option>`).join("")}</select></td>
        <td><select data-path="pericias.${i}.treino" data-num ${ro}>${TREINO.map(([n, v]) => `<option value="${v}" ${v == p.treino ? "selected" : ""}>${n}</option>`).join("")}</select></td>
        <td>${num(`pericias.${i}.outros`, p.outros, "sm")}</td>
        <td class="tot">${bonus >= 0 ? "+" : ""}${bonus}</td></tr>`;
    }).join("");
    const ataques = d.ataques.map((a, i) => `<tr>
        <td>${txt(`ataques.${i}.nome`, a.nome)}</td>
        <td><select data-path="ataques.${i}.pericia" ${ro}>${d.pericias.map(p => `<option ${p.nome === a.pericia ? "selected" : ""}>${esc(p.nome)}</option>`).join("")}</select></td>
        <td>${txt(`ataques.${i}.dano`, a.dano, "1d8+2")}</td>
        <td>${txt(`ataques.${i}.critico`, a.critico, "19/x2")}</td>
        <td class="actions"><button class="mini" data-atk="${i}">Atacar</button><button class="mini" data-dmg="${i}">Dano</button>${ro ? "" : `<button class="mini ghost" data-del-atk="${i}" title="Remover">✕</button>`}</td></tr>`).join("");

    this.body.innerHTML = `
      <div class="sh-head">
        <input class="sh-name" data-path="nome" value="${esc(d.nome)}" ${ro}>
        <div class="sh-meta">
          <label>Origem ${txt("origem", d.origem)}</label>
          <label>Classe ${txt("classe", d.classe)}</label>
          <label>Trilha ${txt("trilha", d.trilha)}</label>
          <label>NEX % ${num("nex", d.nex)}</label>
          <label>Desloc. ${num("deslocamento", d.deslocamento)}</label>
          <label>Defesa ${num("defesa", d.defesa)}</label>
        </div>
        ${this.app.isGM ? `<div class="sh-gm">
          <label>Dono <select data-path="owner">${this._ownerOptions(d.owner)}</select></label>
          <label class="chk"><input type="checkbox" data-path="shared" data-bool ${d.shared ? "checked" : ""}> Visível a todos</label>
          <button class="mini" data-token>Criar token no mapa</button>
          <button class="mini danger" data-del-sheet>Apagar ficha</button></div>` :
          `<div class="sh-gm"><button class="mini" data-token>Criar token no mapa</button></div>`}
      </div>
      <div class="sh-grid">
        <section class="sh-col">
          <h4>Atributos</h4><div class="attrs">${atributos}</div>
          <p class="hint">Clique no atributo para rolar. Atributo 0 rola 2d20 e fica com o menor.</p>
          <h4>Recursos</h4>${res("pv", "Pontos de Vida")}${res("pe", "Pontos de Esforço")}${res("san", "Sanidade")}
          <label class="block">Condições ${txt("condicoes", d.condicoes, "abalado, caído…")}</label>
        </section>
        <section class="sh-col">
          <h4>Perícias</h4>
          <table class="per"><thead><tr><th>Perícia</th><th>Atr.</th><th>Treino</th><th>Outros</th><th></th></tr></thead><tbody>${pericias}</tbody></table>
        </section>
        <section class="sh-col">
          <h4>Ataques ${ro ? "" : `<button class="mini" data-add-atk>+ ataque</button>`}</h4>
          <table class="atk"><thead><tr><th>Nome</th><th>Teste</th><th>Dano</th><th>Crít.</th><th></th></tr></thead><tbody>${ataques}</tbody></table>
          <h4>Habilidades e rituais</h4><textarea data-path="habilidades" rows="5" ${ro}>${esc(d.habilidades)}</textarea>
          <h4>Inventário</h4><textarea data-path="inventario" rows="4" ${ro}>${esc(d.inventario)}</textarea>
          <h4>Anotações</h4><textarea data-path="notas" rows="3" ${ro}>${esc(d.notas)}</textarea>
        </section>
      </div>`;
  }

  _ownerOptions(cur) {
    const players = new Map();
    for (const s of this.net.all("sheet")) if (s.data.owner) players.set(s.data.owner, s.data.ownerName);
    for (const p of this.app.presence.values()) players.set(p.id, p.name);
    players.set(this.app.me.id, this.app.me.name);
    return `<option value="" ${!cur ? "selected" : ""}>— Mestre (NPC) —</option>` +
      [...players].map(([id, n]) => `<option value="${esc(id)}" ${id === cur ? "selected" : ""}>${esc(n)}</option>`).join("");
  }

  _data() { return this.pending || structuredClone(this.net.get(this.openId).data); }
  _set(obj, path, val) {
    const ks = path.split("."); let o = obj;
    for (let i = 0; i < ks.length - 1; i++) o = o[ks[i]] ??= {};
    o[ks.at(-1)] = val;
  }
  _queue(d, immediate = false) {
    this.pending = d;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this._flush(), immediate ? 0 : 350);
  }
  _flush() {
    clearTimeout(this.saveTimer);
    if (!this.pending || !this.openId) return;
    const s = this.net.get(this.openId), d = this.pending;
    this.pending = null;
    if (s) this.net.put({ ...s, data: d });
  }

  _onInput(e) {
    const el = e.target; const path = el.dataset.path;
    if (!path) return;
    let v = el.type === "checkbox" ? el.checked : el.value;
    if (el.type === "number" || el.dataset.num != null) v = v === "" ? "" : Number(v);
    const d = this._data();
    this._set(d, path, v);
    if (path === "owner") {
      const opt = el.selectedOptions[0]; d.ownerName = v ? opt.textContent : ""; d.npc = !v;
    }
    this._queue(d, el.tagName === "SELECT" || el.type === "checkbox");
    if (path.startsWith("pericias.")) {
      const i = +path.split(".")[1], p = d.pericias[i];
      const tot = (Number(p.treino) || 0) + (Number(p.outros) || 0);
      const row = el.closest("tr"); row.querySelector(".tot").textContent = (tot >= 0 ? "+" : "") + tot;
      row.classList.toggle("trained", !!p.treino);
    }
  }

  _onClick(e) {
    const b = e.target.closest("button"); if (!b) return;
    const s = this.net.get(this.openId); if (!s) return;
    const d = this._data();
    const who = d.nome;
    if (b.dataset.rollAttr) {
      const a = b.dataset.rollAttr;
      this.app.chat.roll(opTestExpr(d.atributos[a]), `${who}: teste de ${a}`);
    } else if (b.dataset.rollPer != null) {
      const p = d.pericias[+b.dataset.rollPer];
      const bonus = (Number(p.treino) || 0) + (Number(p.outros) || 0);
      this.app.chat.roll(opTestExpr(d.atributos[p.atributo], bonus), `${who}: ${p.nome}`);
    } else if (b.dataset.atk != null) {
      const a = d.ataques[+b.dataset.atk];
      const p = d.pericias.find(x => x.nome === a.pericia) || { atributo: "FOR", treino: 0, outros: 0 };
      const bonus = (Number(p.treino) || 0) + (Number(p.outros) || 0);
      this.app.chat.roll(opTestExpr(d.atributos[p.atributo], bonus), `${who}: ataque com ${a.nome} (crít. ${a.critico || "20/x2"})`);
    } else if (b.dataset.dmg != null) {
      const a = d.ataques[+b.dataset.dmg];
      this.app.chat.roll(a.dano || "1d4", `${who}: dano de ${a.nome}`);
    } else if (b.dataset.adj) {
      const k = b.dataset.adj; d[k].atual = (Number(d[k].atual) || 0) + Number(b.dataset.n);
      this._queue(d, true); this.render();
    } else if (b.hasAttribute("data-add-atk")) {
      d.ataques.push({ nome: "Novo ataque", pericia: "Luta", dano: "1d6", critico: "20/x2" });
      this._queue(d, true); this.render();
    } else if (b.dataset.delAtk != null) {
      d.ataques.splice(+b.dataset.delAtk, 1); this._queue(d, true); this.render();
    } else if (b.hasAttribute("data-token")) {
      this._flush(); this.app.addToken({ label: d.nome, sheetId: s.id, owner: d.owner, color: d.npc ? "#5b2333" : "#1f4b5c" }); this.close();
    } else if (b.hasAttribute("data-del-sheet")) {
      if (confirm(`Apagar a ficha "${d.nome}"?`)) { this.pending = null; this.net.del(s.id); this.close(); }
    }
  }
}
