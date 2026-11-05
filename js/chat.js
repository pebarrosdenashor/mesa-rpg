// Chat e rolagens. Comandos: /r 1d20+5 texto  |  /gr 1d20 (rolagem secreta, só você e o mestre veem)
import { roll, rollToHTML } from "./dice.js";

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

export class Chat {
  constructor(app) {
    this.app = app;
    this.net = app.net;
    this.log = document.getElementById("chat-log");
    this.form = document.getElementById("chat-form");
    this.input = document.getElementById("chat-input");
    this.secretBox = document.getElementById("secret-roll");
    this.form.onsubmit = (e) => { e.preventDefault(); this.submit(this.input.value); this.input.value = ""; };
    document.querySelectorAll("[data-die]").forEach(b => b.onclick = () => this.roll(b.dataset.die));
    document.getElementById("clear-chat").onclick = () => this.clear();
  }

  canSee(m) { return !m.secret || this.app.isGM || m.authorId === this.app.me.id; }

  submit(text) {
    text = text.trim(); if (!text) return;
    const m = text.match(/^\/(g?r)(?:oll)?\s+(\S+)\s*(.*)$/i);
    if (m) return this.roll(m[2], m[3], m[1].toLowerCase() === "gr");
    this.post({ text });
  }

  roll(expr, label = "", secret = null) {
    try {
      const r = roll(expr);
      this.post({ label, roll: { expr: r.expr, total: r.total, pieces: r.pieces, crit: r.crit }, secret: secret ?? this.secretBox.checked });
    } catch (err) { this.system(err.message); }
  }

  post(data) {
    const me = this.app.me;
    this.net.put({ kind: "msg", data: { author: me.name, authorId: me.id, color: me.color, gm: this.app.isGM, ts: Date.now(), secret: false, ...data } });
  }

  system(text) {
    const div = document.createElement("div"); div.className = "msg sys"; div.textContent = text;
    this.log.appendChild(div); this.log.scrollTop = this.log.scrollHeight;
  }

  async clear() {
    if (!confirm("Apagar todo o histórico do chat da mesa?")) return;
    for (const m of this.net.all("msg")) await this.net.del(m.id);
  }

  render() {
    document.getElementById("clear-chat").hidden = !this.app.isGM;
    const atBottom = this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 60;
    const msgs = this.net.all("msg").map(m => ({ id: m.id, ...m.data })).filter(m => this.canSee(m)).sort((a, b) => a.ts - b.ts).slice(-250);
    this.log.innerHTML = msgs.map(m => {
      const t = new Date(m.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
      const head = `<div class="mh"><b style="color:${esc(m.color)}">${esc(m.author)}${m.gm ? " ★" : ""}</b><time>${t}</time>${m.secret ? `<span class="secret">secreta</span>` : ""}</div>`;
      if (m.roll) {
        const cls = m.roll.crit === "crit" ? "crit" : m.roll.crit === "fail" ? "fail" : "";
        return `<div class="msg roll ${m.secret ? "is-secret" : ""}">${head}
          ${m.label ? `<div class="rl">${esc(m.label)}</div>` : ""}
          <div class="rr"><span class="total ${cls}">${Number(m.roll.total)}</span><span class="detail">${rollToHTML(m.roll)}</span></div></div>`;
      }
      return `<div class="msg">${head}<div class="mt">${esc(m.text)}</div></div>`;
    }).join("") || `<p class="empty">Role dados ou mande uma mensagem.<br><code>/r 2d20kh1+5 Luta</code> · <code>/gr 1d20</code> (secreta)</p>`;
    if (atBottom) this.log.scrollTop = this.log.scrollHeight;
  }
}
