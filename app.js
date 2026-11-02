'use strict';

// ============ Grundlagen ============
const $ = (s, el = document) => el.querySelector(s);
const KEY = 'fittrack-v1';
const DAY = 86400000;
const KCAL_PER_KG = 7700;   // Energie von 1 kg Gewichtsänderung
const MIN_LOGGED = 800;     // Tage darunter gelten als "nicht vollständig eingetragen"
const POSES = ['Vorne', 'Seite', 'Hinten'];
const ACT = {
  sedentary: [1.2, 'Sitzend', 'Bürojob, kaum Sport, < 5.000 Schritte'],
  light: [1.375, 'Leicht aktiv', '1–3× Training/Woche, ~7.000 Schritte'],
  moderate: [1.55, 'Mäßig aktiv', '3–5× Training/Woche, ~10.000 Schritte'],
  active: [1.725, 'Sehr aktiv', '6–7× Training/Woche oder körperliche Arbeit'],
  veryActive: [1.9, 'Extrem aktiv', '2× täglich Training oder Schwerstarbeit'],
};
const GOALS = { lose: 'Abnehmen', maintain: 'Halten', gain: 'Aufbauen' };

const defaultProfile = () => ({
  sex: 'male', birth: '2000-01-01', height: 180, bodyFat: null,
  activity: 'light', goal: 'lose', rate: 0.5, protein: 2.0, target: null,
});

let state = loadState();
let photos = [];
const ui = { tab: 'home', range: 90, day: todayKey(), pose: 'all', compare: false, cmpPose: 'Vorne', before: null, after: null, mode: 'slider' };
let pendingPhoto = null;

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(KEY));
    if (s) return { profile: null, weights: [], days: {}, ...s };
  } catch {}
  return { profile: null, weights: [], days: {} };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(state)); }
  catch (e) { toast('Speichern fehlgeschlagen: ' + e.message); }
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Fotos liegen in IndexedDB (zu groß für localStorage)
const db = (() => {
  let conn;
  const open = () => conn ??= new Promise((res, rej) => {
    const r = indexedDB.open('fittrack', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('photos', { keyPath: 'id' });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const run = async (mode, fn) => {
    const d = await open();
    return new Promise((res, rej) => {
      const t = d.transaction('photos', mode);
      const req = fn(t.objectStore('photos'));
      t.oncomplete = () => res(req?.result);
      t.onerror = () => rej(t.error);
    });
  };
  return {
    all: () => run('readonly', s => s.getAll()),
    put: v => run('readwrite', s => s.put(v)),
    del: id => run('readwrite', s => s.delete(id)),
    clear: () => run('readwrite', s => s.clear()),
  };
})();

// ============ Datum & Formatierung ============
function pad(n) { return String(n).padStart(2, '0'); }
function dayKey(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function todayKey() { return dayKey(new Date()); }
const parseDay = k => { const [y, m, d] = k.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const daysBetween = (a, b) => Math.round((parseDay(b) - parseDay(a)) / DAY);
const localDateTime = d => `${dayKey(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
function weekStart(d) { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return x; }
function isoWeek(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  x.setUTCDate(x.getUTCDate() + 4 - (x.getUTCDay() || 7));
  return Math.ceil(((x - Date.UTC(x.getUTCFullYear(), 0, 1)) / DAY + 1) / 7);
}
function ageOf(birth) {
  const b = parseDay(birth), n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a--;
  return a;
}

const nf = (v, d = 1) => v.toLocaleString('de-DE', { minimumFractionDigits: d, maximumFractionDigits: d });
const kg = v => v == null ? '–' : nf(v, 1) + ' kg';
const int = v => Math.round(v || 0).toLocaleString('de-DE');
const kcal = v => v == null ? '–' : int(v) + ' kcal';
const signed = (v, d = 2) => (v > 0 ? '+' : v < 0 ? '−' : '±') + nf(Math.abs(v), d) + ' kg';
const fmtDay = (k, o = { day: '2-digit', month: '2-digit' }) => parseDay(k).toLocaleDateString('de-DE', o);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = s => { const v = parseFloat(String(s ?? '').replace(',', '.')); return Number.isFinite(v) ? v : null; };

// ============ Berechnungen ============
function dailyWeights() {
  const g = {};
  for (const w of state.weights) (g[w.t.slice(0, 10)] ??= []).push(w.kg);
  return Object.keys(g).sort().map(k => ({ day: k, v: g[k].reduce((a, b) => a + b, 0) / g[k].length }));
}

/** Exponentiell geglätteter Trend: filtert Wasser-, Salz- und Verdauungsschwankungen heraus. */
function trendOf(daily, alpha = 0.1) {
  if (!daily.length) return [];
  const seed = daily.slice(0, 3);
  let t = seed.reduce((a, p) => a + p.v, 0) / seed.length;
  return daily.map((p, i) => {
    if (i > 0) {
      const gap = Math.max(1, daysBetween(daily[i - 1].day, p.day));
      t += (1 - Math.pow(1 - alpha, gap)) * (p.v - t);
    }
    return { day: p.day, v: t };
  });
}

function weeklyRate(trend, days = 28) {
  const last = trend.at(-1);
  const first = trend.find(p => p.day >= dayKey(addDays(new Date(), -days)));
  if (!last || !first) return null;
  const span = daysBetween(first.day, last.day);
  return span >= 7 ? (last.v - first.v) / span * 7 : null;
}

function dayTotals(k) {
  const d = state.days[k] || {};
  const t = { kcal: 0, p: 0, c: 0, f: 0, steps: d.steps || 0, meals: d.meals || [] };
  for (const m of t.meals) { t.kcal += m.kcal || 0; t.p += m.p || 0; t.c += m.c || 0; t.f += m.f || 0; }
  return t;
}

function weeklySummaries(daily) {
  const weeks = {};
  const get = d => weeks[dayKey(weekStart(d))] ??= { w: [], kcal: [], steps: [] };
  for (const p of daily) get(parseDay(p.day)).w.push(p.v);
  for (const k of Object.keys(state.days)) {
    const t = dayTotals(k);
    if (t.kcal >= MIN_LOGGED) get(parseDay(k)).kcal.push(t.kcal);
    if (t.steps > 0) get(parseDay(k)).steps.push(t.steps);
  }
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  let prev = null;
  return Object.keys(weeks).sort().map(k => {
    const w = weeks[k], a = avg(w.w);
    const r = { start: k, avg: a, n: w.w.length, change: a != null && prev != null ? a - prev : null, kcal: avg(w.kcal), steps: avg(w.steps) };
    if (a != null) prev = a;
    return r;
  }).reverse();
}

/** Genaueste Methode: echter Verbrauch = Ø gegessen − (Trendänderung × 7700 / Tage). */
function adaptiveTDEE(trend, windowDays = 21) {
  const end = todayKey(), start = dayKey(addDays(new Date(), -windowDays));
  const logged = Object.keys(state.days).filter(k => k >= start && k < end).map(dayTotals).filter(t => t.kcal >= MIN_LOGGED);
  const pts = trend.filter(p => p.day >= start && p.day < end);
  if (logged.length < 10 || pts.length < 4) return null;
  const span = daysBetween(pts[0].day, pts.at(-1).day);
  if (span < 10) return null;
  const avgIntake = logged.reduce((a, t) => a + t.kcal, 0) / logged.length;
  const perDay = (pts.at(-1).v - pts[0].v) / span;
  const tdee = avgIntake - perDay * KCAL_PER_KG;
  if (tdee < 1200 || tdee > 6000) return null;
  const conf = Math.min(1, logged.length / windowDays * 1.1) * Math.min(1, pts.length / (windowDays * 0.5));
  return { tdee, avgIntake, weekly: perDay * 7, logged: logged.length, weighIns: pts.length, windowDays,
    label: conf >= 0.8 ? 'hoch' : conf >= 0.55 ? 'mittel' : 'niedrig' };
}

function insights() {
  const p = { ...defaultProfile(), ...(state.profile || {}) };
  const daily = dailyWeights(), trend = trendOf(daily);
  const weight = trend.at(-1)?.v ?? 75;
  const age = ageOf(p.birth);
  let bmr, bmrName;
  if (p.bodyFat) { bmr = 370 + 21.6 * weight * (1 - p.bodyFat / 100); bmrName = 'Katch-McArdle'; }
  else { bmr = 10 * weight + 6.25 * p.height - 5 * age + (p.sex === 'male' ? 5 : -161); bmrName = 'Mifflin-St Jeor'; }
  const formula = bmr * ACT[p.activity][0];
  const ad = adaptiveTDEE(trend);
  const tdee = ad ? ad.tdee : formula;
  const adj = p.goal === 'lose' ? -p.rate * KCAL_PER_KG / 7 : p.goal === 'gain' ? p.rate * KCAL_PER_KG / 7 : 0;
  const target = tdee + adj;
  const protein = weight * p.protein;
  const fat = Math.max(weight * 0.8, target * 0.25 / 9);
  const carbs = Math.max(0, (target - protein * 4 - fat * 9) / 4);
  const weeks = weeklySummaries(daily);
  return {
    p, daily, trend, weight, age, bmr, bmrName, formula, ad, tdee, adj, target,
    source: ad ? 'adaptiv' : 'Formel',
    macros: { protein, fat, carbs },
    below: target < (p.sex === 'male' ? 1500 : 1200) || target < bmr,
    weeks, thisWeek: weeks.find(w => w.start === dayKey(weekStart(new Date()))),
    rate: weeklyRate(trend), today: dayTotals(todayKey()),
  };
}
const isGood = (I, c) => I.p.goal === 'lose' ? c <= 0 : I.p.goal === 'gain' ? c >= 0 : Math.abs(c) < 0.3;

// ============ Bausteine ============
const ico = {
  scale: '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 11a4 4 0 0 1 8 0"/><path d="m12 11 1.6-2.4"/></svg>',
  flame: '<svg viewBox="0 0 24 24"><path d="M12 3c.8 3.6 5 5.2 5 10.2a5 5 0 0 1-10 0c0-2.6 1.4-4 2-6.2 1.4 1 2.4 2.4 2.6 4.2"/></svg>',
  chart: '<svg viewBox="0 0 24 24"><path d="M4 19h16"/><path d="m5 15 4-4 3 3 7-7"/></svg>',
  target: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/></svg>',
  calc: '<svg viewBox="0 0 24 24"><rect x="5" y="3" width="14" height="18" rx="2.5"/><path d="M8.5 7.5h7M9 12h.01M12 12h.01M15 12h.01M9 16h.01M12 16h.01M15 16h.01"/></svg>',
  info: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/></svg>',
  list: '<svg viewBox="0 0 24 24"><path d="M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01"/></svg>',
  save: '<svg viewBox="0 0 24 24"><path d="M12 4v11"/><path d="m7.5 10.5 4.5 4.5 4.5-4.5"/><path d="M5 19h14"/></svg>',
  phone: '<svg viewBox="0 0 24 24"><rect x="7" y="3" width="10" height="18" rx="2.5"/><path d="M11 18h2"/></svg>',
};
const card = (title, color, icon, body) => `<section class="card"><h2 style="color:${color}">${icon || ''}${title}</h2>${body}</section>`;
const stat = (l, v, s = '', cls = '') => `<div class="stat"><div class="l">${l}</div><div class="v">${v}</div>${s ? `<div class="s ${cls}">${s}</div>` : ''}</div>`;
const bar = (frac, color) => `<div class="bar"><i style="width:${Math.max(0, Math.min(1, frac || 0)) * 100}%;background:${color}"></i></div>`;
const macroBar = (name, cur, target, color) =>
  `<div class="macro"><div class="head"><b>${name}</b><span>${int(cur)} / ${int(target)} g</span></div>${bar(cur / target, color)}</div>`;
const seg = (name, opts, cur) =>
  `<div class="seg">${opts.map(([v, l]) => `<button data-action="seg" data-name="${name}" data-val="${v}" class="${String(v) === String(cur) ? 'on' : ''}">${l}</button>`).join('')}</div>`;

function weightChart(daily, trend, target) {
  if (daily.length < 2) return `<div class="empty small">Ab 2 Messungen siehst du hier den Verlauf.</div>`;
  const W = 340, H = 200, L = 34, R = 8, T = 10, B = 22;
  const vals = [...daily.map(p => p.v), ...trend.map(p => p.v)];
  let lo = Math.min(...vals), hi = Math.max(...vals);
  const showTarget = target && target > lo - 3 && target < hi + 3;
  if (showTarget) { lo = Math.min(lo, target); hi = Math.max(hi, target); }
  lo -= 0.4; hi += 0.4;
  const d0 = parseDay(daily[0].day).getTime(), d1 = Math.max(parseDay(daily.at(-1).day).getTime(), d0 + DAY);
  const x = k => L + (parseDay(k).getTime() - d0) / (d1 - d0) * (W - L - R);
  const y = v => T + (hi - v) / (hi - lo) * (H - T - B);
  let s = '';
  for (let i = 0; i <= 3; i++) {
    const v = lo + (hi - lo) * i / 3;
    s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 5}" y="${y(v) + 3}" text-anchor="end">${nf(v, 1)}</text>`;
  }
  if (showTarget) s += `<line x1="${L}" x2="${W - R}" y1="${y(target)}" y2="${y(target)}" stroke="var(--green)" stroke-dasharray="4 4"/><text x="${W - R}" y="${y(target) - 4}" text-anchor="end" style="fill:var(--green)">Ziel</text>`;
  s += daily.map(p => `<circle cx="${x(p.day)}" cy="${y(p.v)}" r="2.6" fill="var(--blue)" opacity=".35"/>`).join('');
  s += `<path d="${trend.map((p, i) => `${i ? 'L' : 'M'}${x(p.day).toFixed(1)},${y(p.v).toFixed(1)}`).join('')}" fill="none" stroke="var(--blue)" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`;
  s += `<text x="${L}" y="${H - 6}">${fmtDay(daily[0].day)}</text><text x="${W - R}" y="${H - 6}" text-anchor="end">${fmtDay(daily.at(-1).day)}</text>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Gewichtsverlauf">${s}</svg>`;
}

function kcalChart(target) {
  const W = 340, H = 170, L = 34, R = 8, T = 10, B = 20, n = 14;
  const days = Array.from({ length: n }, (_, i) => dayKey(addDays(new Date(), i - n + 1)));
  const vals = days.map(k => dayTotals(k).kcal);
  const hi = Math.max(target, ...vals) * 1.1 || 2500;
  const bw = (W - L - R) / n;
  const y = v => T + (1 - v / hi) * (H - T - B);
  let s = '';
  for (let i = 0; i <= 2; i++) {
    const v = hi * i / 2;
    s += `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text x="${L - 5}" y="${y(v) + 3}" text-anchor="end">${int(v)}</text>`;
  }
  days.forEach((k, i) => {
    const v = vals[i];
    const color = v > target * 1.05 ? 'var(--red)' : 'var(--orange)';
    if (v > 0) s += `<rect x="${L + i * bw + 3}" y="${y(v)}" width="${bw - 6}" height="${y(0) - y(v)}" rx="3" fill="${color}"/>`;
    s += `<text x="${L + i * bw + bw / 2}" y="${H - 6}" text-anchor="middle">${parseDay(k).toLocaleDateString('de-DE', { weekday: 'narrow' })}</text>`;
  });
  s += `<line x1="${L}" x2="${W - R}" y1="${y(target)}" y2="${y(target)}" stroke="var(--green)" stroke-width="1.5" stroke-dasharray="4 4"/>`;
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Kalorien der letzten 14 Tage">${s}</svg>`;
}

// ============ Ansichten ============
function viewHome(I) {
  let h = '';
  if (!state.profile) {
    h += card('Willkommen bei FitTrack 👋', 'var(--accent)', '',
      `<p class="small muted" style="margin:0 0 12px">Richte kurz dein Profil ein, damit dein Kalorienbedarf berechnet werden kann.</p>
       <button class="btn" data-action="tab" data-tab="profile">Profil einrichten</button>`);
  }
  if (isIOS() && !navigator.standalone) {
    h += card('Als App installieren', 'var(--blue)', ico.phone,
      `<p class="small" style="margin:0">Tippe in Safari unten auf <b>Teilen</b> (□↑) → <b>Zum Home-Bildschirm</b>. Dann startet FitTrack wie eine normale App, im Vollbild und offline.</p>`);
  }

  const tw = I.thisWeek;
  h += card('Gewicht', 'var(--blue)', ico.scale,
    `<div class="stats">
      ${stat('Trendgewicht', kg(I.trend.at(-1)?.v), I.daily.length ? 'Letzte Waage: ' + kg(I.daily.at(-1).v) : 'Noch keine Messung')}
      ${stat('Wochenschnitt', kg(tw?.avg), tw?.change != null ? signed(tw.change) + ' zur Vorwoche' : '', tw?.change != null ? (isGood(I, tw.change) ? 'good' : 'bad') : '')}
    </div>
    ${I.rate != null ? `<p class="small">Tempo der letzten 4 Wochen: <b>${signed(I.rate)} pro Woche</b></p>` : ''}
    <button class="btn sec" data-action="addWeight" style="margin-top:14px">+ Gewicht eintragen</button>`);

  const left = I.target - I.today.kcal;
  h += card('Heute', 'var(--orange)', ico.flame,
    `<div class="stats">
      ${stat('Gegessen', kcal(I.today.kcal))}
      ${stat(left >= 0 ? 'Noch übrig' : 'Drüber', kcal(Math.abs(left)), 'Ziel ' + kcal(I.target), left < 0 ? 'danger' : '')}
      ${stat('Schritte', int(I.today.steps))}
      ${stat('Protein', int(I.today.p) + ' g', 'Ziel ' + int(I.macros.protein) + ' g')}
    </div>
    ${bar(I.today.kcal / I.target, left < 0 ? 'var(--red)' : 'var(--orange)')}
    <button class="btn sec" data-action="tab" data-tab="food" style="margin-top:14px">Essen & Schritte eintragen</button>`);

  if (I.daily.length > 1) {
    const c = dayKey(addDays(new Date(), -30));
    h += card('Letzte 30 Tage', 'var(--blue)', ico.chart,
      weightChart(I.daily.filter(p => p.day >= c), I.trend.filter(p => p.day >= c)) +
      `<p class="sub">Punkte = Waage · Linie = Trend (glättet Wasserschwankungen)</p>`);
  }

  const hasData = state.weights.length || photos.length;
  const last = state.lastBackup ? new Date(state.lastBackup) : null;
  if (hasData && (!last || Date.now() - last > 14 * DAY)) {
    h += card('Backup machen', 'var(--purple)', ico.save,
      `<p class="small" style="margin:0 0 12px">Deine Daten liegen nur auf diesem Handy. Sichere sie ab und zu, z. B. in iCloud Drive oder per Mail an dich.</p>
       <button class="btn sec" data-action="export">Backup jetzt speichern</button>`);
  }
  return { html: h };
}

function viewWeight(I) {
  const c = ui.range ? dayKey(addDays(new Date(), -ui.range)) : '';
  let body = seg('range', [[30, '30 T'], [90, '90 T'], [365, '1 J'], [0, 'Alle']], ui.range);
  if (!I.daily.length) {
    body += `<div class="empty">Noch keine Messungen.<br>Tippe oben rechts auf <b>+</b>.</div>`;
  } else {
    const cur = I.trend.at(-1).v, target = I.p.target;
    body += `<div style="margin-top:14px">${weightChart(I.daily.filter(p => p.day >= c), I.trend.filter(p => p.day >= c), target)}</div>
      <div class="stats three" style="margin-top:14px">
        ${stat('Trend', kg(cur))}
        ${stat('Pro Woche', I.rate != null ? signed(I.rate) : '–', 'Ø 4 Wochen')}
        ${target ? stat('Bis zum Ziel', kg(Math.abs(cur - target)), eta(cur - target, I.rate)) : ''}
      </div>`;
  }
  let h = `<section class="card">${body}</section>`;

  const weeks = I.weeks.filter(w => w.n || w.kcal != null || w.steps != null);
  if (weeks.length) {
    h += card('Wochenschnitte', 'var(--text)', ico.list, `<div class="list">${weeks.map(w => {
      const d = parseDay(w.start), e = addDays(d, 6);
      const info = [`${w.n}× gewogen`, w.kcal != null && `Ø ${kcal(w.kcal)}`, w.steps != null && `Ø ${int(w.steps)} Schritte`].filter(Boolean).join(' · ');
      return `<div class="li"><div class="grow"><b>KW ${isoWeek(d)}</b> <span class="sub">${fmtDay(w.start)} – ${fmtDay(dayKey(e))}</span><div class="sub">${info}</div></div>
        <div style="text-align:right"><b>${kg(w.avg)}</b>${w.change != null ? `<div class="sub ${isGood(I, w.change) ? 'good' : 'bad'}"><b>${signed(w.change)}</b></div>` : ''}</div></div>`;
    }).join('')}</div>`);
  }

  if (state.weights.length) {
    const list = [...state.weights].sort((a, b) => b.t.localeCompare(a.t));
    h += card('Alle Messungen', 'var(--text)', '', `<div class="list">${list.map(w => {
      const d = new Date(w.t);
      return `<div class="li"><div class="grow">${d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', year: '2-digit' })}
        <span class="sub">${d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}</span></div>
        <b>${kg(w.kg)}</b><button class="x" data-action="delWeight" data-id="${w.id}" aria-label="Löschen">×</button></div>`;
    }).join('')}</div>`);
  }
  return { html: h, action: `<button class="iconbtn" data-action="addWeight" aria-label="Gewicht eintragen">+</button>` };
}

function eta(remaining, rate) {
  if (!rate || remaining * rate >= 0) return '';
  const date = addDays(new Date(), Math.round(Math.abs(remaining / rate) * 7));
  return 'ca. ' + date.toLocaleDateString('de-DE', { month: 'short', year: 'numeric' });
}

function viewFood(I) {
  const k = ui.day, t = dayTotals(k), isToday = k === todayKey();
  const goalText = I.p.goal === 'maintain' ? '' :
    ` ${I.adj < 0 ? '−' : '+'} ${int(Math.abs(I.adj))} für ${nf(I.p.rate, 2)} kg/Woche`;

  let h = card('Dein Tagesziel', 'var(--green)', ico.target,
    `<div class="big">${kcal(I.target)}</div>
     <div class="small muted">Erhaltung ${kcal(I.tdee)} (${I.source})${goalText}</div>
     <div class="pills">
       <div class="pill" style="background:rgba(255,59,48,.13)"><b>${int(I.macros.protein)} g</b>Protein</div>
       <div class="pill" style="background:rgba(10,132,255,.13)"><b>${int(I.macros.carbs)} g</b>Kohlenhydrate</div>
       <div class="pill" style="background:rgba(255,204,0,.18)"><b>${int(I.macros.fat)} g</b>Fett</div>
     </div>
     ${I.below ? `<p class="small danger">⚠️ Das Ziel liegt unter deinem Grundumsatz bzw. dem empfohlenen Minimum. Wähle im Profil ein langsameres Tempo.</p>` : ''}`);

  h += `<section class="card">
    <div class="daynav">
      <button class="btn sec small" data-action="day" data-d="-1" aria-label="Vorheriger Tag">‹</button>
      <b>${isToday ? 'Heute' : fmtDay(k, { weekday: 'short', day: '2-digit', month: '2-digit' })}</b>
      <button class="btn sec small" data-action="day" data-d="1" aria-label="Nächster Tag" ${isToday ? 'disabled' : ''}>›</button>
    </div>
    <div class="stats" style="margin-top:14px">
      ${stat('Gegessen', kcal(t.kcal))}
      ${stat(t.kcal > I.target ? 'Drüber' : 'Übrig', kcal(Math.abs(I.target - t.kcal)), '', t.kcal > I.target ? 'danger' : '')}
    </div>
    ${bar(t.kcal / I.target, t.kcal > I.target ? 'var(--red)' : 'var(--orange)')}
    ${macroBar('Protein', t.p, I.macros.protein, 'var(--red)')}
    ${macroBar('Kohlenhydrate', t.c, I.macros.carbs, 'var(--blue)')}
    ${macroBar('Fett', t.f, I.macros.fat, 'var(--yellow)')}
    ${t.meals.length ? `<div class="list" style="margin-top:10px">${t.meals.map(m => `
      <div class="li"><div class="grow">${esc(m.name || 'Eintrag')}
        <div class="sub">${[m.p && `P ${int(m.p)} g`, m.c && `K ${int(m.c)} g`, m.f && `F ${int(m.f)} g`].filter(Boolean).join(' · ')}</div></div>
        <b>${int(m.kcal)}</b><button class="x" data-action="delMeal" data-id="${m.id}" aria-label="Löschen">×</button></div>`).join('')}</div>` : ''}
    <form data-form="meal" class="mealform" autocomplete="off">
      <input name="what" placeholder="Was? (optional, z. B. Yazio Tagessumme)" enterkeyhint="next">
      <div class="row4">
        <input name="kcal" inputmode="decimal" placeholder="kcal" required>
        <input name="p" inputmode="decimal" placeholder="Prot. g">
        <input name="c" inputmode="decimal" placeholder="KH g">
        <input name="f" inputmode="decimal" placeholder="Fett g">
      </div>
      <button class="btn">+ Hinzufügen</button>
    </form>
    <form data-form="steps" class="row" style="margin-top:12px" autocomplete="off">
      <input name="steps" inputmode="numeric" placeholder="Schritte an diesem Tag" value="${t.steps || ''}">
      <button class="btn sec small">Speichern</button>
    </form>
    <p class="sub">Tipp: Abends einfach die Tagessumme aus Yazio als einen Eintrag übernehmen und die Schritte aus StepsApp abtippen.</p>
  </section>`;

  const ad = I.ad;
  h += card('Gesamtumsatz berechnen', 'var(--purple)', ico.calc, `
    <div class="method"><div class="grow"><b>Adaptiv: deine echten Daten</b> ${ad ? '<span class="badge">AKTIV</span>' : ''}
      <div class="sub">${ad ? 'Aus deinen Kalorien und deinem Gewichtstrend der letzten 21 Tage' : 'Wird freigeschaltet, sobald du in 21 Tagen mind. 10 Tage Essen und 4 Wiegungen eingetragen hast.'}</div></div>
      <b>${ad ? kcal(ad.tdee) : '–'}</b></div>
    <div class="method"><div class="grow"><b>Formel (${I.bmrName})</b> ${ad ? '' : '<span class="badge">AKTIV</span>'}
      <div class="sub">Grundumsatz ${kcal(I.bmr)} × ${nf(ACT[I.p.activity][0], 3)} (${ACT[I.p.activity][1]})</div></div>
      <b>${kcal(I.formula)}</b></div>
    ${ad ? `<div class="stats" style="margin-top:12px">
        ${stat('Ø gegessen', kcal(ad.avgIntake))}${stat('Trend / Woche', signed(ad.weekly))}
        ${stat('Datenbasis', `${ad.logged}/${ad.windowDays} Tage`, `${ad.weighIns} Wiegungen`)}${stat('Genauigkeit', ad.label)}
      </div>
      <p class="sub">Rechnung: ${int(ad.avgIntake)} − (${nf(ad.weekly, 2)} kg × 7.700 ÷ 7) = <b>${kcal(ad.tdee)}</b></p>` : ''}`);

  h += card('Letzte 14 Tage', 'var(--orange)', ico.chart, kcalChart(I.target) + `<p class="sub">Grüne Linie = dein Tagesziel</p>`);

  h += card('Wie genau ist das?', 'var(--muted)', ico.info, `<div class="small">
    <p style="margin:0">Keine Formel kennt deinen Stoffwechsel exakt, Formeln liegen bei vielen Menschen um ±10 % daneben.</p>
    <p>Deshalb rechnet FitTrack, sobald genug Daten da sind, <b>adaptiv</b>: Es vergleicht, was du isst, mit dem, was deine Waage wirklich macht. Nach 3–4 Wochen liegt das meist nur wenige Prozent daneben, wenn du:</p>
    <p>• <b>alles</b> einträgst (auch Öl, Soßen, Getränke)<br>• dich möglichst täglich morgens unter gleichen Bedingungen wiegst</p></div>`);
  return { html: h };
}

function viewPhotos() {
  if (ui.compare) return viewCompare();
  const list = ui.pose === 'all' ? photos : photos.filter(p => p.pose === ui.pose);
  let h = `<div class="row">
      <label class="btn">📷 Kamera<input type="file" accept="image/*" capture="environment" data-file="photo" hidden></label>
      <label class="btn sec">🖼️ Mediathek<input type="file" accept="image/*" data-file="photo" hidden></label>
    </div>
    ${seg('pose', [['all', 'Alle'], ...POSES.map(p => [p, p])], ui.pose)}`;
  if (!list.length) {
    h += `<div class="empty">Noch keine Formbilder.<br><span class="small">Mach alle 1–2 Wochen Fotos von vorne, seitlich und hinten. Gleiches Licht, gleiche Uhrzeit, gleicher Ort.</span></div>`;
  } else {
    h += `<div class="grid3">${list.map(p => `<button class="thumb" data-action="photo" data-id="${p.id}"><img src="${thumbURL(p)}" alt="Formbild ${esc(p.pose)}" loading="lazy"><span>${fmtDay(p.date, { day: '2-digit', month: 'short' })}</span></button>`).join('')}</div>`;
  }
  return { html: h, action: photos.length >= 2 ? `<button class="btn sec small" data-action="openCompare">Vergleichen</button>` : '' };
}

function viewCompare() {
  const list = photos.filter(p => p.pose === ui.cmpPose).sort((a, b) => a.date.localeCompare(b.date));
  const before = list.find(p => p.id === ui.before) || list[0];
  const after = list.find(p => p.id === ui.after) || list.at(-1);
  let h = `<section class="card">${seg('cmpPose', POSES.map(p => [p, p]), ui.cmpPose)}<div style="height:8px"></div>
    ${seg('mode', [['slider', 'Schieberegler'], ['side', 'Nebeneinander']], ui.mode)}</section>`;
  if (before && after && before.id !== after.id) {
    const b = fullURL(before), a = fullURL(after);
    h += ui.mode === 'slider'
      ? `<div class="compare"><img src="${a}" alt="Nachher"><img class="before" src="${b}" alt="Vorher"><div class="line"></div>
         <span class="tag l">Vorher</span><span class="tag r">Nachher</span>
         <input type="range" min="0" max="100" value="50" step="0.5" data-range="cmp" aria-label="Vorher/Nachher verschieben"></div>`
      : `<div class="side"><img src="${b}" alt="Vorher"><img src="${a}" alt="Nachher"></div>`;
    const days = daysBetween(before.date, after.date);
    h += `<section class="card"><div class="stats">${stat('Zeitraum', `${days} Tage`, `${fmtDay(before.date)} → ${fmtDay(after.date)}`)}
      ${before.kg && after.kg ? stat('Gewicht', signed(after.kg - before.kg, 1), `${kg(before.kg)} → ${kg(after.kg)}`) : ''}</div></section>`;
  } else {
    h += `<div class="empty">Für „${ui.cmpPose}“ brauchst du mindestens 2 Fotos.</div>`;
  }
  const strip = (which, sel) => `<section class="card"><h2>${which === 'before' ? 'Vorher' : 'Nachher'}</h2><div class="strip">${list.map(p =>
    `<button class="thumb ${sel?.id === p.id ? 'sel' : ''}" data-action="pick" data-which="${which}" data-id="${p.id}"><img src="${thumbURL(p)}" alt=""><span>${fmtDay(p.date)}</span></button>`).join('')}</div></section>`;
  if (list.length) h += strip('before', before) + strip('after', after);
  return { html: h, action: `<button class="btn sec small" data-action="closeCompare">Fertig</button>` };
}

function viewProfile(I) {
  const p = I.p;
  const opt = (v, l, cur) => `<option value="${v}" ${String(v) === String(cur) ? 'selected' : ''}>${l}</option>`;
  let h = '';
  if (!state.profile) h += `<section class="card"><b>Willkommen!</b><p class="small muted">Ein paar Angaben für deinen Kalorienbedarf. Du kannst alles später ändern.</p></section>`;
  h += `<form class="card" data-form="profile" autocomplete="off">
    <h2>Körper</h2>
    <label class="f">Geschlecht<select name="sex">${opt('male', 'Männlich', p.sex)}${opt('female', 'Weiblich', p.sex)}</select></label>
    <label class="f">Geburtsdatum<input type="date" name="birth" value="${p.birth}" required></label>
    <label class="f">Größe (cm)<input name="height" inputmode="decimal" value="${nf(p.height, 0)}" required></label>
    <label class="f">Körperfett in % (optional)<input name="bodyFat" inputmode="decimal" value="${p.bodyFat ? nf(p.bodyFat, 0) : ''}" placeholder="leer lassen, wenn unbekannt"></label>
    <h2 style="margin-top:6px">Aktivität</h2>
    <label class="f">Alltag & Training<select name="activity">${Object.entries(ACT).map(([k, a]) => opt(k, `${a[1]}: ${a[2]}`, p.activity)).join('')}</select></label>
    <p class="hint">Gilt nur für die Formel. Sobald genug Daten da sind, rechnet FitTrack mit deinem tatsächlichen Verbrauch.</p>
    <h2 style="margin-top:6px">Ziel</h2>
    <label class="f">Ziel<select name="goal">${Object.entries(GOALS).map(([k, l]) => opt(k, l, p.goal)).join('')}</select></label>
    <label class="f">Tempo (kg pro Woche)<input name="rate" inputmode="decimal" value="${nf(p.rate, 2)}"></label>
    <p class="hint">Empfehlung: Abnehmen 0,5–1 % des Körpergewichts pro Woche, Aufbauen 0,1–0,3 kg.</p>
    <label class="f">Zielgewicht in kg (optional)<input name="goalKg" inputmode="decimal" value="${p.target ? nf(p.target, 1) : ''}"></label>
    <label class="f">Protein (g pro kg Körpergewicht)<input name="protein" inputmode="decimal" value="${nf(p.protein, 1)}"></label>
    <p class="hint">1,6–2,2 g/kg sind für Muskelaufbau und -erhalt gut belegt.</p>
    <button class="btn">Speichern</button>
  </form>`;

  const last = state.lastBackup ? new Date(state.lastBackup).toLocaleDateString('de-DE') : 'noch nie';
  h += card('Backup', 'var(--purple)', ico.save, `
    <p class="small" style="margin:0 0 12px">Alle Daten (inkl. Fotos) liegen nur auf diesem Gerät. Speichere ein Backup, z. B. in der Dateien-App/iCloud Drive. Letztes Backup: <b>${last}</b></p>
    <button class="btn" data-action="export">Backup speichern</button>
    <label class="btn sec" style="margin-top:8px">Backup wiederherstellen<input type="file" accept="application/json,.json" data-file="backup" hidden></label>`);

  h += card('So nutzt du FitTrack', 'var(--blue)', ico.info, `<div class="small">
    <p style="margin:0"><b>Installieren:</b> In Safari auf Teilen (□↑) → „Zum Home-Bildschirm“.</p>
    <p><b>Yazio:</b> Abends die Tagessumme (kcal, Protein, KH, Fett) im Tab Kalorien eintragen.</p>
    <p><b>Schritte:</b> Den Wert aus StepsApp oder der Health-App abtippen.</p>
    <p><b>Gewicht:</b> Am besten jeden Morgen nach dem Toilettengang, vor dem Essen.</p></div>`);

  h += `<button class="btn danger-btn" data-action="wipe">Alle Daten löschen</button>`;
  return { html: h };
}

// ============ Rendern ============
const VIEWS = { home: ['Übersicht', viewHome], weight: ['Gewicht', viewWeight], food: ['Kalorien', viewFood], photos: ['Fotos', viewPhotos], profile: ['Profil', viewProfile] };

function render() {
  const [title, fn] = VIEWS[ui.tab];
  const { html, action } = fn(insights());
  $('#title').textContent = ui.tab === 'photos' && ui.compare ? 'Vergleich' : title;
  $('#topaction').innerHTML = action || '';
  $('#view').innerHTML = html;
  document.querySelectorAll('.tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === ui.tab));
}

function toast(msg) {
  document.querySelector('.toast')?.remove();
  const t = Object.assign(document.createElement('div'), { className: 'toast', textContent: msg });
  document.body.append(t);
  setTimeout(() => t.remove(), 2600);
}

const dlg = $('#dlg');
function openDialog(html) { dlg.innerHTML = html; dlg.showModal(); }
function closeDialog() { if (dlg.open) dlg.close(); }
dlg.addEventListener('close', () => {
  if (pendingPhoto) { URL.revokeObjectURL(pendingPhoto.preview); pendingPhoto = null; }
  dlg.innerHTML = '';
});

const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

// Objekt-URLs für Fotos (werden beim Löschen freigegeben)
const urls = new Map();
function blobURL(key, blob) { if (!urls.has(key)) urls.set(key, URL.createObjectURL(blob)); return urls.get(key); }
const thumbURL = p => blobURL(p.id + ':t', p.thumb);
const fullURL = p => blobURL(p.id + ':f', p.full);
function dropURLs(id) { for (const s of [':t', ':f']) { const u = urls.get(id + s); if (u) { URL.revokeObjectURL(u); urls.delete(id + s); } } }

async function processImage(file) {
  const src = URL.createObjectURL(file);
  try {
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error('Bild konnte nicht gelesen werden'));
      i.src = src;
    });
    const make = (max, q) => new Promise((res, rej) => {
      const s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
      const c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s);
      c.height = Math.round(img.naturalHeight * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => b ? res(b) : rej(new Error('Bild konnte nicht gespeichert werden')), 'image/jpeg', q);
    });
    return { full: await make(1600, 0.85), thumb: await make(400, 0.72) };
  } finally {
    URL.revokeObjectURL(src);
  }
}

// ============ Aktionen ============
const actions = {
  tab(el) { ui.tab = el.dataset.tab; ui.compare = false; if (ui.tab === 'food') ui.day = todayKey(); render(); scrollTo(0, 0); },
  seg(el) {
    const v = el.dataset.val;
    ui[el.dataset.name] = v !== '' && !isNaN(+v) ? +v : v;
    if (el.dataset.name === 'cmpPose') ui.before = ui.after = null;
    render();
  },
  day(el) {
    const next = dayKey(addDays(parseDay(ui.day), +el.dataset.d));
    if (next <= todayKey()) { ui.day = next; render(); }
  },
  addWeight() {
    const last = state.weights.length ? [...state.weights].sort((a, b) => a.t.localeCompare(b.t)).at(-1).kg : null;
    openDialog(`<form data-form="weight" autocomplete="off">
      <h3>Gewicht eintragen</h3>
      <label class="f">Gewicht (kg)<input class="kginput" name="kg" inputmode="decimal" placeholder="${last ? nf(last, 1) : '75,0'}" required autofocus></label>
      <label class="f">Zeitpunkt<input type="datetime-local" name="t" value="${localDateTime(new Date())}" max="${localDateTime(new Date())}" required></label>
      <p class="hint">Tipp: jeden Morgen unter gleichen Bedingungen wiegen. Ausreißer gleicht der Trend aus.</p>
      <button class="btn">Speichern</button>
      <button type="button" class="btn sec" data-action="close">Abbrechen</button>
    </form>`);
  },
  delWeight(el) {
    if (!confirm('Diese Messung löschen?')) return;
    state.weights = state.weights.filter(w => w.id !== el.dataset.id);
    save(); render();
  },
  delMeal(el) {
    const d = state.days[ui.day];
    if (!d) return;
    d.meals = d.meals.filter(m => m.id !== el.dataset.id);
    save(); render();
  },
  photo(el) {
    const p = photos.find(x => x.id === el.dataset.id);
    if (!p) return;
    openDialog(`<img class="preview" src="${fullURL(p)}" alt="Formbild">
      <div class="stats">${stat('Datum', fmtDay(p.date, { day: '2-digit', month: '2-digit', year: 'numeric' }))}${stat('Pose', esc(p.pose))}${p.kg ? stat('Gewicht', kg(p.kg)) : ''}</div>
      ${p.note ? `<p class="small">${esc(p.note)}</p>` : ''}
      <div style="height:14px"></div>
      <button class="btn sec" data-action="close">Schließen</button>
      <button class="btn danger-btn" data-action="delPhoto" data-id="${p.id}">Foto löschen</button>`);
  },
  async delPhoto(el) {
    if (!confirm('Foto endgültig löschen?')) return;
    const id = el.dataset.id;
    await db.del(id);
    photos = photos.filter(p => p.id !== id);
    closeDialog(); dropURLs(id); render();
  },
  openCompare() { ui.compare = true; ui.before = ui.after = null; const first = photos.at(-1); if (first) ui.cmpPose = first.pose; render(); scrollTo(0, 0); },
  closeCompare() { ui.compare = false; render(); },
  pick(el) { ui[el.dataset.which] = el.dataset.id; render(); },
  close() { closeDialog(); },
  export: () => exportBackup().catch(e => toast('Backup fehlgeschlagen: ' + e.message)),
  async wipe() {
    if (!confirm('Wirklich ALLE Daten (Gewicht, Essen, Fotos, Profil) löschen? Das kann nicht rückgängig gemacht werden.')) return;
    state = { profile: null, weights: [], days: {} };
    save();
    await db.clear();
    photos.forEach(p => dropURLs(p.id));
    photos = [];
    ui.tab = 'home'; render(); toast('Alle Daten gelöscht');
  },
};

const forms = {
  weight(f) {
    const v = num(f.kg.value);
    if (v == null || v < 20 || v > 400) return toast('Bitte ein gültiges Gewicht eingeben');
    state.weights.push({ id: uid(), t: f.t.value || localDateTime(new Date()), kg: v });
    save(); closeDialog(); render(); toast('Gespeichert ✓');
  },
  meal(f) {
    const k = num(f.kcal.value);
    if (k == null || k < 0) return toast('Bitte Kalorien eingeben');
    const d = state.days[ui.day] ??= { meals: [], steps: 0 };
    (d.meals ??= []).push({ id: uid(), name: f.what.value.trim(), kcal: k, p: num(f.p.value) || 0, c: num(f.c.value) || 0, f: num(f.f.value) || 0 });
    save(); render(); toast('Hinzugefügt ✓');
  },
  steps(f) {
    const s = num(f.steps.value);
    const d = state.days[ui.day] ??= { meals: [], steps: 0 };
    d.steps = s && s > 0 ? Math.round(s) : 0;
    save(); render(); toast('Schritte gespeichert ✓');
  },
  profile(f) {
    const height = num(f.height.value), rate = num(f.rate.value), protein = num(f.protein.value);
    const bodyFat = num(f.bodyFat.value), target = num(f.goalKg.value);
    if (!height || height < 100 || height > 250) return toast('Bitte eine gültige Größe eingeben');
    if (!f.birth.value) return toast('Bitte Geburtsdatum eingeben');
    const first = !state.profile;
    state.profile = {
      sex: f.sex.value, birth: f.birth.value, height,
      bodyFat: bodyFat && bodyFat >= 3 && bodyFat <= 60 ? bodyFat : null,
      activity: f.activity.value, goal: f.goal.value,
      rate: Math.min(1.5, Math.max(0.05, rate || 0.5)),
      protein: Math.min(3.5, Math.max(0.8, protein || 2)),
      target: target && target > 20 ? target : null,
    };
    save(); toast('Profil gespeichert ✓');
    if (first) ui.tab = 'home';
    render(); scrollTo(0, 0);
  },
  async photoMeta(f) {
    if (!pendingPhoto) return;
    const p = { id: uid(), date: f.date.value || todayKey(), pose: f.pose.value, note: f.note.value.trim(),
      kg: num(f.kg.value), full: pendingPhoto.full, thumb: pendingPhoto.thumb };
    try {
      await db.put(p);
    } catch (e) {
      return toast('Foto konnte nicht gespeichert werden: ' + e.message);
    }
    photos.push(p);
    photos.sort((a, b) => b.date.localeCompare(a.date));
    closeDialog(); render(); toast('Formbild gespeichert ✓');
  },
};

async function onPhotoFile(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  toast('Bild wird verarbeitet …');
  let res;
  try { res = await processImage(file); } catch (e) { return toast(e.message); }
  const lastKg = state.weights.length ? [...state.weights].sort((a, b) => a.t.localeCompare(b.t)).at(-1).kg : null;
  pendingPhoto = { ...res, preview: URL.createObjectURL(res.full) };
  openDialog(`<form data-form="photoMeta" autocomplete="off">
    <h3>Formbild speichern</h3>
    <img class="preview" src="${pendingPhoto.preview}" alt="Vorschau">
    <label class="f">Pose<select name="pose">${POSES.map(p => `<option ${p === (ui.pose !== 'all' ? ui.pose : 'Vorne') ? 'selected' : ''}>${p}</option>`).join('')}</select></label>
    <label class="f">Datum<input type="date" name="date" value="${todayKey()}" max="${todayKey()}"></label>
    <label class="f">Gewicht (kg, optional)<input name="kg" inputmode="decimal" value="${lastKg ? nf(lastKg, 1) : ''}"></label>
    <label class="f">Notiz (optional)<textarea name="note" placeholder="Licht, nüchtern, nach Training …"></textarea></label>
    <button class="btn">Speichern</button>
    <button type="button" class="btn sec" data-action="close">Abbrechen</button>
  </form>`);
}

// ============ Backup ============
const blobToDataURL = b => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(b); });
const dataURLToBlob = async u => (await fetch(u)).blob();

async function exportBackup() {
  toast('Backup wird erstellt …');
  const ph = [];
  for (const p of photos) ph.push({ ...p, full: await blobToDataURL(p.full), thumb: await blobToDataURL(p.thumb) });
  const json = JSON.stringify({ app: 'FitTrack', version: 1, exported: new Date().toISOString(), state, photos: ph });
  const file = new File([json], `FitTrack-Backup-${todayKey()}.json`, { type: 'application/json' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: 'FitTrack Backup' }); }
    catch (e) { if (e.name === 'AbortError') return; throw e; }
  } else {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(file), download: file.name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
  state.lastBackup = new Date().toISOString();
  save(); render(); toast('Backup gespeichert ✓');
}

async function importBackup(input) {
  const file = input.files[0];
  input.value = '';
  if (!file) return;
  let data;
  try { data = JSON.parse(await file.text()); } catch { return toast('Das ist keine gültige Backup-Datei'); }
  if (data?.app !== 'FitTrack' || !data.state) return toast('Das ist kein FitTrack-Backup');
  if (!confirm(`Backup vom ${new Date(data.exported).toLocaleDateString('de-DE')} wiederherstellen? Die aktuellen Daten auf diesem Gerät werden ersetzt.`)) return;
  try {
    toast('Wird wiederhergestellt …');
    const restored = [];
    for (const p of data.photos || []) restored.push({ ...p, full: await dataURLToBlob(p.full), thumb: await dataURLToBlob(p.thumb) });
    await db.clear();
    for (const p of restored) await db.put(p);
    photos.forEach(p => dropURLs(p.id));
    photos = restored.sort((a, b) => b.date.localeCompare(a.date));
    state = { profile: null, weights: [], days: {}, ...data.state };
    save(); ui.tab = 'home'; render(); toast('Backup wiederhergestellt ✓');
  } catch (e) {
    toast('Wiederherstellen fehlgeschlagen: ' + e.message);
  }
}

// ============ Events ============
document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el || el.disabled) return;
  const fn = actions[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el, e); }
});
document.addEventListener('submit', e => {
  const fn = forms[e.target.dataset.form];
  if (fn) { e.preventDefault(); fn(e.target); }
});
document.addEventListener('change', e => {
  if (e.target.dataset.file === 'photo') onPhotoFile(e.target);
  if (e.target.dataset.file === 'backup') importBackup(e.target);
});
document.addEventListener('input', e => {
  if (e.target.dataset.range === 'cmp') e.target.parentElement.style.setProperty('--pos', e.target.value + '%');
});
// Neuer Tag, während die App im Hintergrund war
let lastDay = todayKey();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || todayKey() === lastDay) return;
  if (ui.day === lastDay) ui.day = todayKey();
  lastDay = todayKey();
  if (!dlg.open) render();
});

async function init() {
  if (!state.profile) ui.tab = 'home';
  render();
  try {
    photos = (await db.all()).sort((a, b) => b.date.localeCompare(a.date));
    if (photos.length) render();
  } catch {
    toast('Fotos konnten nicht geladen werden');
  }
  navigator.storage?.persist?.().catch(() => {});
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}
init();
