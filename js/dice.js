// Rolador de dados. Aceita: 1d20+5, 3d20kh1, 2d20kl1+2, 2d6+1d4-1, d100, 4dF não.
// kh = mantém maiores, kl = mantém menores.
const TERM = /^(\d*)d(\d+)(?:(kh|kl)(\d+))?$/i;

export function rollDie(sides) {
  const r = new Uint32Array(1);
  crypto.getRandomValues(r);
  return (r[0] % sides) + 1;
}

export function roll(expr) {
  const clean = String(expr).replace(/\s+/g, "").toLowerCase();
  if (!clean || !/^[0-9dklh+\-]+$/.test(clean)) throw new Error("Expressão inválida: " + expr);
  const parts = clean.match(/[+\-]?[^+\-]+/g);
  let total = 0;
  const pieces = [];
  let crit = null;
  for (let p of parts) {
    const sign = p.startsWith("-") ? -1 : 1;
    p = p.replace(/^[+\-]/, "");
    const m = p.match(TERM);
    if (m) {
      const n = Math.min(parseInt(m[1] || "1", 10), 100);
      const sides = parseInt(m[2], 10);
      if (!n || sides < 2 || sides > 1000) throw new Error("Dado inválido: " + p);
      const rolls = Array.from({ length: n }, () => rollDie(sides));
      let kept = rolls.map((v, i) => i);
      if (m[3]) {
        const k = Math.min(parseInt(m[4], 10), n);
        const order = rolls.map((v, i) => i).sort((a, b) => m[3] === "kh" ? rolls[b] - rolls[a] : rolls[a] - rolls[b]);
        kept = order.slice(0, k);
      }
      const sum = kept.reduce((s, i) => s + rolls[i], 0);
      total += sign * sum;
      if (sides === 20 && kept.length === 1) crit = rolls[kept[0]] === 20 ? "crit" : rolls[kept[0]] === 1 ? "fail" : crit;
      pieces.push({ sign, label: `${n}d${sides}${m[3] ? m[3] + m[4] : ""}`, rolls, kept, sides });
    } else if (/^\d+$/.test(p)) {
      total += sign * parseInt(p, 10);
      pieces.push({ sign, label: p, flat: parseInt(p, 10) });
    } else throw new Error("Não entendi: " + p);
  }
  return { expr: clean, total, pieces, crit };
}

// Teste no estilo Ordem Paranormal: nº de d20 = atributo, pega o maior;
// atributo 0 => rola 2d20 e pega o menor.
export function opTestExpr(attr, bonus = 0) {
  attr = Number(attr) || 0;
  const dice = attr <= 0 ? "2d20kl1" : `${attr}d20kh1`;
  return bonus ? `${dice}${bonus > 0 ? "+" : ""}${bonus}` : dice;
}

export function rollToHTML(r) {
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
  const parts = r.pieces.map((p, idx) => {
    const sign = idx === 0 ? (p.sign < 0 ? "−" : "") : (p.sign < 0 ? " − " : " + ");
    if (p.flat != null) return sign + Number(p.flat);
    const ds = p.rolls.map((v, i) => {
      v = Number(v);
      const k = p.kept.includes(i);
      const cls = !k ? "drop" : Number(p.sides) === 20 && v === 20 ? "max" : v === 1 ? "min" : "";
      return `<span class="d ${cls}">${v}</span>`;
    }).join("");
    return `${sign}<span class="lbl">${esc(p.label)}</span>[${ds}]`;
  }).join("");
  return parts;
}
