'use strict';

/* =========================================================
   Agenda del servizio
   - Con "Avvia agenda.bat" i dati vengono salvati in dati.json
     e il foglio delle prediche si aggiorna da solo.
   - Aperta direttamente (file://) funziona lo stesso, ma i dati
     restano solo nel browser.
   ========================================================= */

const STORAGE_KEY = 'agenda-servizio-v1';

// Modelli di preparazione. Per ogni passo:
//   offset = quanti giorni prima dell'impegno · when = blocco della giornata · heavy = lavoro impegnativo
// I passi che cadrebbero di domenica vengono anticipati al sabato (la domenica resta libera da responsabilità).
const DEFAULT_TEMPLATES = {
  predica: { label: 'Predica', icon: '🎤', color: '#D32F2F', steps: [
    { label: 'Il brano non è ancora nel foglio: chiedilo ai responsabili', offset: 9, when: 'sera', ifMissing: true },
    { label: 'Scegliere il brano (la predica è a tema libero)', offset: 9, when: 'mattina', ifFree: true },
    { label: 'Lettura del brano e prime osservazioni', offset: 8, when: 'mattina' },
    { label: 'Esegesi e commentari — giorno 1 di 4', offset: 8, when: 'sera', heavy: true },
    { label: 'Esegesi e commentari — giorno 2 di 4', offset: 6, when: 'mattina', heavy: true },
    { label: 'Esegesi e commentari — giorno 3 di 4', offset: 5, when: 'mattina', heavy: true },
    { label: 'Esegesi e commentari — giorno 4 di 4', offset: 4, when: 'mattina', heavy: true },
    { label: 'Idea centrale in una frase (senza questa non si va avanti)', offset: 4, when: 'sera', heavy: true },
    { label: 'Schema chiaro della predica', offset: 3, when: 'mattina', heavy: true },
    { label: 'Iniziare la stesura', offset: 3, when: 'sera', heavy: true },
    { label: 'Finire la stesura completa (entro stasera!)', offset: 2, when: 'mattina', heavy: true },
    { label: 'Preparare il PowerPoint', offset: 1, when: 'mattina' },
    { label: 'Ripetizione ad alta voce, almeno due volte', offset: 1, when: 'pomeriggio', heavy: true },
  ]},
  presidenza: { label: 'Presidenza', icon: '📋', color: '#2F78C4', steps: [
    { label: 'Scegliere i canti (10 minuti)', offset: 3, when: 'sera' },
    { label: 'Rivedere canti e ordine del culto (10 minuti)', offset: 2, when: 'sera' },
  ]},
  // time = orario abituale: occupa tutta la sera (l'incontro finisce tardi)
  giovanissimi: { label: 'Giovanissimi', icon: '🧒', color: '#A12FB5', time: '19:30', steps: [
    { label: 'Leggere il brano e le domande', offset: 5, when: 'sera' },
    { label: 'Studio del brano — giorno 1 di 2', offset: 4, when: 'mattina', heavy: true },
    { label: 'Studio del brano — giorno 2 di 2', offset: 3, when: 'mattina', heavy: true },
    { label: 'Preparare lo studio: schema e punti principali', offset: 2, when: 'mattina', heavy: true },
    { label: 'Ripasso dello studio (e rompighiaccio, se serve)', offset: 1, when: 'sera' },
  ]},
  chiesa: { label: 'Chiesa in casa', icon: '🏠', color: '#2E7D4F', time: '19:30', steps: [
    { label: 'Scegliere brano o tema', offset: 5, when: 'sera', ifMissing: true },
    { label: 'Studio del brano — giorno 1 di 2', offset: 4, when: 'mattina', heavy: true },
    { label: 'Studio del brano — giorno 2 di 2', offset: 3, when: 'mattina', heavy: true },
    { label: 'Preparare lo studio: schema e domande', offset: 2, when: 'mattina', heavy: true },
    { label: 'Ripasso dello studio', offset: 1, when: 'sera' },
  ]},
  altro: { label: 'Altro', icon: '📌', color: '#6b6b6b', steps: [] },
};

const DEFAULT_SETTINGS = {
  myName: 'Josiah',
  sheetUrl: '',
  lastSync: null,
};

const STUDY_COLOR = '#9E6C00';
const UNITS = {
  pagine: ['pagina', 'pagine'],
  capitoli: ['capitolo', 'capitoli'],
  lezioni: ['lezione', 'lezioni'],
  video: ['video', 'video'],
};
const DOW = ['Dom', 'Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab'];
const DOW_ORDER = [1, 2, 3, 4, 5, 6, 0];
const WHEN = { mattina: '☀️ mattina', pomeriggio: '🌤️ pomeriggio', sera: '🌙 sera' };
const WHEN_HOURS = { mattina: '7–9', pomeriggio: '', sera: '19–20' };
const WHEN_CYCLE = ['mattina', 'pomeriggio', 'sera'];
const SLOT_TITLE = { mattina: '☀️ Mattina, 7–9', pomeriggio: '🌤️ Pomeriggio', sera: '🌙 Sera, 19–20' };
const MONTHS = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

/* ---------- Stato e salvataggio ---------- */

let state;
let serverMode = false;
let saveTimer = null;

function normalize(s) {
  const templates = structuredClone(DEFAULT_TEMPLATES);
  for (const [k, t] of Object.entries(s.templates || {})) {
    if (templates[k]) templates[k].steps = t.steps || [];
  }
  return {
    events: s.events || [],
    studies: (s.studies || []).map(p => ({ kind: 'pages', ...p })),
    templates,
    settings: { ...DEFAULT_SETTINGS, ...(s.settings || {}) },
    plannedWeeks: s.plannedWeeks || {},
    seedVersion: s.seedVersion || 0,
    schema: s.schema || 0,
    habitStart: s.habitStart || null,
    sessions: s.sessions || [],
    lastBackup: s.lastBackup || null,
    updatedAt: s.updatedAt || null,
  };
}

// Aggiornamenti dei dati tra una versione e l'altra (girano anche sul sito, dove seed.js non c'è).
const SCHEMA = 5;
function migrate() {
  const t = today();
  if (state.schema < 3) {
    // v3: Wright al mattino, promemoria per il brano non assegnato, abitudini
    state.templates = structuredClone(DEFAULT_TEMPLATES);
    for (const ev of state.events) {
      if (ev.date >= t && !ev.notMine && !ev.steps.some(st => st.done)) ev.steps = planSteps(ev.type, ev.date, ev.passage).map(stepFrom);
    }
    state.habitStart = state.habitStart || addDays(t, 1);
  }
  if (state.schema < 4) {
    // v4: chiesa in casa e giovanissimi hanno un orario abituale, che occupa la sera
    for (const ev of state.events) if (!ev.time && ev.date >= t && tpl(ev.type).time) ev.time = tpl(ev.type).time;
  }
  if (state.schema < 5) {
    // v5: benvenuto e feste dei giovanissimi erano "Altro": diventano Giovanissimi (stesso colore), senza preparazione
    for (const ev of state.events) {
      if (ev.type === 'altro' && ev.seedKey && ev.seedKey.startsWith('seed:giov:')) {
        ev.type = 'giovanissimi';
        ev.noPrep = true;
        ev.title = ev.title.replace(/^Giovanissimi · /, '');
      }
    }
  }
  state.schema = SCHEMA;
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return normalize(JSON.parse(raw));
  } catch (e) {
    console.error('Impossibile leggere i dati salvati', e);
  }
  return normalize({});
}

function pushServer() {
  saveTimer = null;
  return fetch('/api/data', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(state) })
    .then(r => { if (!r.ok) throw new Error(r.status); })
    .catch(e => { console.error(e); toast('⚠️ Non riesco a salvare su file: l\'agenda è stata chiusa?'); });
}

// "Istantanea" dei dati senza la data di modifica: serve a capire se è cambiato davvero qualcosa.
const snapshotOf = st => JSON.stringify({ ...st, updatedAt: null });
let lastSnap = null;

function save() {
  const snap = snapshotOf(state);
  if (snap !== lastSnap) {
    state.updatedAt = new Date().toISOString();
    lastSnap = snap;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  if (serverMode) {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(pushServer, 400);
  }
  if (cloud.cfg && snap !== cloud.snap) {
    clearTimeout(cloud.timer);
    cloud.timer = setTimeout(cloudPush, 1500);
  }
}

/* ---------- Sincronizzazione tra dispositivi (repository privato su GitHub) ----------
   I dati stanno in dati.json di un repository privato. La chiave (token) resta solo in
   questo browser e non finisce mai nei backup. */

const CLOUD_KEY = 'agenda-cloud';
const DEFAULT_REPO = 'JosiahCatch/agenda-dati';
const cloud = {
  cfg: (() => { try { return JSON.parse(localStorage.getItem(CLOUD_KEY)); } catch (e) { return null; } })(),
  sha: null, snap: null, timer: null, busy: false, status: '', at: null,
};

const b64enc = str => {
  let bin = '';
  new TextEncoder().encode(str).forEach(b => { bin += String.fromCharCode(b); });
  return btoa(bin);
};
const b64dec = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), c => c.charCodeAt(0)));

function cloudRequest(method, body) {
  return fetch(`https://api.github.com/repos/${cloud.cfg.repo}/contents/dati.json${method === 'GET' ? `?t=${Date.now()}` : ''}`, {
    method,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${cloud.cfg.token}`, Accept: 'application/vnd.github+json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function cloudPull() {
  const r = await cloudRequest('GET');
  if (r.status === 404) { cloud.sha = null; return null; }
  if (r.status === 401 || r.status === 403) throw new Error('chiave non valida o senza permessi');
  if (!r.ok) throw new Error(`GitHub ha risposto ${r.status}`);
  const j = await r.json();
  cloud.sha = j.sha;
  return JSON.parse(b64dec(j.content));
}

function adoptRemote(remote) {
  state = normalize(remote);
  migrate();
  rebalanceAll();
  lastSnap = cloud.snap = snapshotOf(state);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function setCloudStatus(status) {
  cloud.status = status;
  if (status === 'ok') cloud.at = new Date();
  renderSyncStatus();
}

async function cloudPush() {
  cloud.timer = null;
  if (!cloud.cfg || cloud.busy) return;
  cloud.busy = true;
  setCloudStatus('saving');
  try {
    const snap = snapshotOf(state);
    let r = await cloudRequest('PUT', { message: 'Aggiornamento agenda', content: b64enc(JSON.stringify(state)), ...(cloud.sha ? { sha: cloud.sha } : {}) });
    if (r.status === 409 || r.status === 422) {
      // Qualcun altro (un altro dispositivo) ha salvato nel frattempo: vince la versione più recente.
      const remote = await cloudPull();
      if (remote && (remote.updatedAt || '') > (state.updatedAt || '')) {
        adoptRemote(remote);
        render();
        toast('Agenda aggiornata con le modifiche dell\'altro dispositivo');
        setCloudStatus('ok');
        return;
      }
      r = await cloudRequest('PUT', { message: 'Aggiornamento agenda', content: b64enc(JSON.stringify(state)), ...(cloud.sha ? { sha: cloud.sha } : {}) });
    }
    if (!r.ok) throw new Error(`GitHub ha risposto ${r.status}`);
    cloud.sha = (await r.json()).content.sha;
    cloud.snap = snap;
    setCloudStatus('ok');
  } catch (e) {
    console.error(e);
    setCloudStatus('error');
  } finally {
    cloud.busy = false;
    if (cloud.cfg && snapshotOf(state) !== cloud.snap && !cloud.timer) cloud.timer = setTimeout(cloudPush, 1500);
  }
}

// All'avvio e quando torni sulla finestra: se sul cloud c'è una versione più recente, la usa.
async function cloudRefresh({ initial = false } = {}) {
  if (!cloud.cfg || cloud.busy || cloud.timer) return;
  try {
    const remote = await cloudPull();
    if (!remote) { cloud.snap = null; return; }
    if ((remote.updatedAt || '') > (state.updatedAt || '') || initial && !state.updatedAt) {
      adoptRemote(remote);
      if (!initial) { render(); toast('Agenda aggiornata dall\'altro dispositivo'); }
    } else if (snapshotOf(remote) === snapshotOf(state)) {
      cloud.snap = snapshotOf(state);
    }
    setCloudStatus('ok');
  } catch (e) {
    console.error(e);
    setCloudStatus('error');
  }
}

async function cloudConnect(token, repo) {
  cloud.cfg = { token: token.trim(), repo: repo.trim() || DEFAULT_REPO };
  try {
    const remote = await cloudPull();
    const hasLocal = state.events.length || state.studies.length;
    if (remote && (!hasLocal || confirm(`Sul cloud ci sono già dei dati (aggiornati ${remote.updatedAt ? new Date(remote.updatedAt).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' }) : 'in passato'}).\n\nOK = usa quelli (consigliato)\nAnnulla = sostituiscili con i dati di questo dispositivo`))) {
      adoptRemote(remote);
    } else {
      cloud.snap = null;
    }
    localStorage.setItem(CLOUD_KEY, JSON.stringify(cloud.cfg));
    save();
    render();
    setCloudStatus('ok');
    toast('Sincronizzazione attiva ☁️');
  } catch (e) {
    cloud.cfg = null;
    alert(`Non riesco a collegarmi: ${e.message}.\nControlla la chiave e che abbia accesso al repository ${repo || DEFAULT_REPO} (Contents: lettura e scrittura).`);
  }
}

// Collegare un altro dispositivo senza un'altra chiave: il PC mostra un QR con un link che contiene
// la chiave dopo il "#" (quella parte resta nel browser e non viene mai inviata al sito).
const SITE_URL = 'https://josiahcatch.github.io/agenda/';
const LINK_KEY = 'collega=';

function loadScript(src) {
  return new Promise((ok, ko) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = ok;
    s.onerror = () => ko(new Error(`non riesco a caricare ${src}`));
    document.head.appendChild(s);
  });
}

async function openCloudShare() {
  if (!window.qrcode) await loadScript('qrcode.js');
  const base = location.hostname.endsWith('github.io') ? location.origin + location.pathname : SITE_URL;
  const link = `${base}#${LINK_KEY}${btoa(JSON.stringify({ t: cloud.cfg.token, r: cloud.cfg.repo }))}`;
  const qr = qrcode(0, 'L');
  qr.addData(link);
  qr.make();
  openModal(`
    <div class="share">
      <h2>📱 Collega il telefono</h2>
      <p>Inquadra il codice con la fotocamera del telefono e apri il link: l'agenda si collega da sola
        e resta collegata. Non dovrai farlo più.</p>
      <div class="qr">${qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true })}</div>
      <p class="muted">Il codice contiene la tua chiave: non fotografarlo e non mandarlo a nessuno.</p>
      <div class="btn-row"><button class="primary" data-close>Fatto</button></div>
    </div>`);
}

// All'avvio: se il link arriva dal QR, salva la chiave e la toglie subito dall'indirizzo.
function takeLinkFromUrl() {
  if (!location.hash.startsWith(`#${LINK_KEY}`)) return null;
  const raw = location.hash.slice(LINK_KEY.length + 1);
  history.replaceState(null, '', location.pathname + location.search);
  try {
    const { t, r } = JSON.parse(atob(decodeURIComponent(raw)));
    return t ? { token: t, repo: r || DEFAULT_REPO } : null;
  } catch (e) {
    return null;
  }
}

function cloudDisconnect() {
  if (!confirm('Scollegare questo dispositivo? I dati restano qui e sul cloud, ma non si sincronizzano più.')) return;
  localStorage.removeItem(CLOUD_KEY);
  cloud.cfg = null;
  cloud.status = '';
  render();
}

window.addEventListener('beforeunload', () => {
  if (serverMode && saveTimer) {
    clearTimeout(saveTimer);
    navigator.sendBeacon('/api/data', new Blob([JSON.stringify(state)], { type: 'application/json' }));
  }
});

const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

/* ---------- Date ---------- */

const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parse = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const today = () => iso(new Date());
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return iso(d); };
const diffDays = (a, b) => Math.round((parse(b) - parse(a)) / 86400000);
const mondayOf = s => addDays(s, -((parse(s).getDay() + 6) % 7));
const fmtLong = s => parse(s).toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long' });
const fmtShort = s => parse(s).toLocaleDateString('it-IT', { weekday: 'short', day: 'numeric', month: 'short' });
const fmtDM = s => parse(s).toLocaleDateString('it-IT', { day: 'numeric', month: 'long' });
const fmtWeekday = s => parse(s).toLocaleDateString('it-IT', { weekday: 'long' });

function rel(s) {
  const n = diffDays(today(), s);
  if (n === 0) return 'oggi';
  if (n === 1) return 'domani';
  if (n === -1) return 'ieri';
  if (n > 1) return `tra ${n} giorni`;
  return `${-n} giorni fa`;
}

/* ---------- Utilità ---------- */

const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- Impegni ---------- */

const tpl = type => state.templates[type] || state.templates.altro;
const findEvent = id => state.events.find(e => e.id === id);
const byDate = (a, b) => a.date.localeCompare(b.date) || (a.time || '').localeCompare(b.time || '');

// Brano vuoto = non ancora assegnato (promemoria per chiederlo); "libero" = da scegliere io (un giorno in più).
const isFreePassage = p => /^\s*(tema\s+)?libero/i.test(p || '');

function planSteps(type, date, passage = '') {
  const t = today();
  const missing = ['predica', 'chiesa'].includes(type) && !(passage || '').trim();
  const free = type === 'predica' && isFreePassage(passage);
  return tpl(type).steps.filter(st => (!st.ifFree || free) && (!st.ifMissing || missing)).map(st => {
    let due = addDays(date, -st.offset);
    if (st.offset > 0 && parse(due).getDay() === 0) due = addDays(due, -1);
    const squeezed = date >= t && due < t;
    if (squeezed) due = t;
    return { label: st.label, due, squeezed, when: st.when || 'mattina', heavy: !!st.heavy, auto: st.ifMissing ? 'missing' : undefined };
  });
}

const stepFrom = s => ({ id: uid(), label: s.label, due: s.due, done: false, when: s.when, heavy: s.heavy, ...(s.auto ? { auto: s.auto } : {}) });

function setDone(item, done) {
  item.done = done;
  item.doneAt = done ? new Date().toISOString() : null;
}

function createEvent({ type, date, title, notes, time, passage }) {
  const ev = {
    id: uid(), type, date,
    time: time || tpl(type).time || '',
    title: title || tpl(type).label,
    passage: passage || '',
    notes: notes || '',
    steps: planSteps(type, date, passage).map(stepFrom),
  };
  state.events.push(ev);
  return ev;
}

// Giovanissimi: gli incontri ci sono tutti, ma la preparazione parte solo per quelli che guidi tu.
function setMine(ev, mine) {
  if (mine === !ev.notMine) return;
  ev.notMine = !mine;
  ev.steps = mine ? planSteps(ev.type, ev.date, ev.passage).map(stepFrom) : [];
}

function eventHealth(ev) {
  const t = today();
  if (ev.notMine || !ev.steps.length) return 'none';
  if (ev.steps.every(s => s.done)) return 'done';
  if (ev.steps.some(s => !s.done && s.due < t)) return 'late';
  if (ev.steps.some(s => !s.done && s.due === t)) return 'today';
  return 'ok';
}

const HEALTH = {
  late: ['In ritardo', 'late'],
  today: ['Un passo oggi', 'today'],
  ok: ['In regola', 'ok'],
  done: ['Pronto ✓', 'done'],
};
const healthBadge = h => HEALTH[h] ? `<span class="badge ${HEALTH[h][1]}">${HEALTH[h][0]}</span>` : '';
const sortedSteps = ev => [...ev.steps].sort((a, b) => a.due.localeCompare(b.due));

/* ---------- Studio: piani "a capitoli" ---------- */

const findStudy = id => state.studies.find(p => p.id === id);
const sectionPages = s => s.from ? (s.to > s.from ? `pp. ${s.from}–${s.to}` : `p. ${s.from}`) : '';

// Distribuisce le letture: un capitolo per settimana (lun–dom, due se è lungo). Dentro la settimana
// le sezioni vanno sui giorni di studio in base alle pagine: la domenica conta doppio, i giorni in cui
// stai preparando una predica o uno studio contano la metà. L'esame del capitolo è l'ultimo giorno.
const RESPONSIBILITY = ['predica', 'giovanissimi', 'chiesa'];
const isHeavyDay = d => state.events.some(ev => !ev.notMine && (
  (ev.date === d && RESPONSIBILITY.includes(ev.type)) || ev.steps.some(s => s.heavy && s.due === d)));
const dayWeight = d => {
  // Mattina presa da una preparazione (o da un impegno) e sera presa da un incontro: niente Wright.
  if ((busyMorning(d) || eventInBlock(d, 'mattina')) && eventInBlock(d, 'sera')) return 0;
  return (parse(d).getDay() === 0 ? 2 : 1) * (isHeavyDay(d) ? 0.5 : 1);
};
const busyMorning = d => state.events.some(ev => !ev.notMine && ev.steps.some(st => st.heavy && st.when === 'mattina' && st.due === d));

// Un impegno con orario occupa il blocco in cui cade: dalle 17 la sera (es. giovanissimi 19:30–22),
// prima delle 12 la mattina. Vale anche per gli incontri guidati da altri: ci sei comunque.
const eventInBlock = (d, slot) => state.events.find(ev => ev.date === d && ev.time
  && (slot === 'sera' ? ev.time >= '17:00' : slot === 'mattina' ? ev.time < '12:00' : false));

const studyWhen = d => parse(d).getDay() === 0 ? 'pomeriggio'
  : busyMorning(d) || eventInBlock(d, 'mattina') ? 'sera' : 'mattina';

function studyDaysIn(plan, start, span, notBefore) {
  const out = [];
  for (let i = 0; i < span; i++) {
    const d = addDays(start, i);
    if (d >= notBefore && plan.days.includes(parse(d).getDay())) out.push(d);
  }
  return out;
}

function distribute(ch, allDays) {
  const usable = allDays.filter(d => dayWeight(d) > 0);
  const days = usable.length ? usable : allDays;
  const todo = ch.sections.filter(s => !s.done && !s.exam);
  const exam = ch.sections.find(s => s.exam && !s.done);
  const assign = (s, d) => { s.due = d; if (!s.whenSet) s.when = studyWhen(d); };
  const size = s => Math.max(1, (s.to || 0) - (s.from || 0) + 1);
  const weights = days.map(dayWeight);
  const W = weights.reduce((a, b) => a + b, 0);
  const cum = [];
  weights.reduce((a, w, i) => (cum[i] = a + w), 0);
  const total = todo.reduce((a, s) => a + size(s), 0);
  let acc = 0;
  todo.forEach(s => {
    let idx = days.length - 1;
    if (todo.length > 1 || exam) {
      const f = ((acc + size(s) / 2) / total) * W;
      idx = cum.findIndex(c => c >= f);
      if (idx < 0) idx = days.length - 1;
    }
    assign(s, days[idx]);
    acc += size(s);
  });
  if (exam) assign(exam, days[days.length - 1]);
}

function schedulePlan(plan, fromDate) {
  let week = mondayOf(fromDate);
  for (const ch of plan.chapters) {
    if (ch.sections.every(s => s.done)) continue;
    const span = (ch.weeks || 1) * 7;
    let days = studyDaysIn(plan, week, span, fromDate);
    for (let guard = 0; !days.length && guard < 104; guard++) {
      week = addDays(week, 7);
      days = studyDaysIn(plan, week, span, fromDate);
    }
    distribute(ch, days);
    week = addDays(week, span);
  }
}

// Quando cambiano gli impegni, riequilibra le letture dei capitoli futuri senza spostarli di settimana.
function moveOutOfBusyEvenings() {
  const t = today();
  for (const ev of state.events) {
    for (const st of ev.steps) {
      if (st.done || st.whenSet || st.when !== 'sera' || st.due < t || !eventInBlock(st.due, 'sera')) continue;
      const prev = addDays(st.due, -1);
      if (parse(st.due).getDay() === 6) st.when = 'pomeriggio';
      else if (prev >= t && parse(prev).getDay() !== 0 && !eventInBlock(prev, 'sera')) st.due = prev;
      else st.when = 'mattina';
    }
  }
}

function rebalanceAll() {
  const t = today();
  moveOutOfBusyEvenings();
  for (const plan of state.studies) {
    if (plan.kind !== 'chapters') continue;
    for (const ch of plan.chapters) {
      for (const sec of ch.sections) if (!sec.done && !sec.whenSet && sec.due > t) sec.when = studyWhen(sec.due);
    }
    for (const ch of plan.chapters) {
      const open = ch.sections.filter(s => !s.done);
      if (!open.length || open.some(s => !s.due || s.due <= t)) continue;
      const start = mondayOf(ch.sections.map(s => s.due).sort()[0]);
      const days = studyDaysIn(plan, start, (ch.weeks || 1) * 7, addDays(t, 1));
      if (days.length) distribute(ch, days);
    }
  }
}

function chapterStatus(p) {
  const t = today();
  const all = p.chapters.flatMap(c => c.sections);
  const done = all.filter(s => s.done).length;
  return {
    total: all.length,
    done,
    overdue: all.filter(s => !s.done && s.due < t).length,
    current: p.chapters.find(c => c.sections.some(s => !s.done)),
    end: all.reduce((m, s) => (s.due > m ? s.due : m), ''),
    finished: done === all.length,
  };
}

const chapterRange = c => {
  const dues = c.sections.map(s => s.due).sort();
  return [dues[0], dues[dues.length - 1]];
};

/* ---------- Studio: piani "a pagine" ---------- */

const qty = (n, unit) => `${n} ${n === 1 ? UNITS[unit][0] : UNITS[unit][1]}`;
const pos = (p, n) => p.unit === 'pagine' ? `pag. ${n}` : `${UNITS[p.unit][0]} ${n}`;

function countStudyDays(days, from, to) {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (days.includes(parse(d).getDay())) n++;
  return n;
}

function nextStudyDay(p, from) {
  for (let d = from; d <= p.endDate; d = addDays(d, 1)) if (p.days.includes(parse(d).getDay())) return d;
  return null;
}

function endDateForPace(start, days, remaining, pace) {
  const need = Math.max(1, Math.ceil(remaining / pace));
  let n = 0;
  for (let d = start, i = 0; i < 3650; d = addDays(d, 1), i++) {
    if (days.includes(parse(d).getDay()) && ++n >= need) return d;
  }
  return null;
}

function progressBefore(p, date) {
  let best = null, v = p.initial || 0;
  for (const [d, val] of Object.entries(p.log || {})) {
    if (d < date && (best === null || d > best)) { best = d; v = val; }
  }
  return v;
}

function studyStatus(p) {
  const t = today();
  const init = p.initial || 0;
  const s = { finished: p.current >= p.total };
  if (s.finished) return s;

  s.notStarted = t < p.startDate;
  s.expired = t > p.endDate;
  s.isStudyDay = !s.notStarted && !s.expired && p.days.includes(parse(t).getDay());
  s.before = progressBefore(p, t);

  const from = s.notStarted ? p.startDate : t;
  s.daysLeft = s.expired ? 0 : countStudyDays(p.days, from, p.endDate);
  s.quota = s.daysLeft ? Math.ceil((p.total - s.before) / s.daysLeft) : p.total - s.before;
  s.target = Math.min(p.total, s.before + s.quota);
  s.doneToday = s.isStudyDay && p.current >= s.target;

  const totalDays = countStudyDays(p.days, p.startDate, p.endDate) || 1;
  const elapsed = s.notStarted ? 0 : countStudyDays(p.days, p.startDate, addDays(t, -1));
  s.basePace = Math.ceil((p.total - init) / totalDays);
  s.expected = Math.round(init + (p.total - init) * Math.min(1, elapsed / totalDays));
  s.delta = s.before - s.expected;
  return s;
}

function setStudyProgress(p, value) {
  p.current = Math.max(0, Math.min(p.total, value));
  p.log = p.log || {};
  p.log[today()] = p.current;
  save();
}

const isFinished = p => p.kind === 'chapters' ? chapterStatus(p).finished : p.current >= p.total;

/* ---------- Attività (passi degli impegni + letture) ---------- */

const WHEN_ORDER = { mattina: 0, pomeriggio: 1, sera: 2 };
const byTask = (a, b) => a.item.due.localeCompare(b.item.due)
  || (WHEN_ORDER[a.item.when] ?? 3) - (WHEN_ORDER[b.item.when] ?? 3);

function allTasks() {
  const out = [];
  for (const ev of state.events) for (const st of ev.steps) out.push({ kind: 'step', ev, item: st });
  for (const p of state.studies) {
    if (p.kind !== 'chapters') continue;
    for (const ch of p.chapters) for (const s of ch.sections) out.push({ kind: 'section', plan: p, ch, item: s });
  }
  return out;
}

const taskSlot = x => x.item.when || (x.kind === 'section' ? 'sera' : 'mattina');

function taskFromRef(el) {
  if (el.dataset.kind === 'step') {
    const ev = findEvent(el.dataset.ev);
    const item = ev && ev.steps.find(s => s.id === el.dataset.st);
    return item && { kind: 'step', ev, item };
  }
  const plan = findStudy(el.dataset.plan);
  for (const ch of plan ? plan.chapters : []) {
    const item = ch.sections.find(s => s.id === el.dataset.sec);
    if (item) return { kind: 'section', plan, ch, item };
  }
  return null;
}

const tasksBetween = (from, to) => allTasks().filter(x => x.item.due >= from && x.item.due <= to).sort(byTask);

function overdueTasks(before = today()) {
  const t = today();
  return allTasks()
    .filter(x => !x.item.done && x.item.due < before && (x.kind === 'section' || x.ev.date >= t))
    .sort(byTask);
}

function taskFromEl(el) {
  if (el.dataset.kind === 'step') {
    const ev = findEvent(el.dataset.ev);
    return ev && ev.steps.find(s => s.id === el.dataset.st);
  }
  const p = findStudy(el.dataset.plan);
  return p && p.chapters.flatMap(c => c.sections).find(s => s.id === el.dataset.sec);
}

const taskRef = x => x.kind === 'step'
  ? `data-kind="step" data-ev="${x.ev.id}" data-st="${x.item.id}"`
  : `data-kind="section" data-plan="${x.plan.id}" data-sec="${x.item.id}"`;

function whenChip(x) {
  if (x.item.done) return '';
  const w = x.item.when;
  return `<button class="when ${w ? 'set' : ''}" data-action="cycle-when" ${taskRef(x)} title="Quando lo fai? Clicca per cambiare">${w ? WHEN[w] : 'quando?'}</button>`;
}

function taskItem(x, { showDue = false, suggest = false, onDay = null } = {}) {
  const it = x.item;
  const late = !it.done && it.due < today();
  let label, chip;
  if (x.kind === 'step') {
    const t = tpl(x.ev.type);
    label = esc(it.label);
    chip = `<button class="chip" style="--c:${t.color}" data-action="open-event" data-ev="${x.ev.id}">${t.icon} ${esc(x.ev.title)} · ${rel(x.ev.date)}</button>`;
  } else {
    label = it.exam ? `<strong>${esc(it.title)}</strong>` : `${esc(it.title)} <span class="muted">${sectionPages(it)}</span>`;
    chip = `<button class="chip" style="--c:${STUDY_COLOR}" data-action="nav" data-view="studio">📖 Cap. ${x.ch.n} · ${esc(x.ch.title)}</button>`;
  }
  return `
    <li class="task ${it.done ? 'is-done' : ''} ${late ? 'is-late' : ''} ${suggest ? 'suggest' : ''}">
      <label class="task-main">
        <input type="checkbox" data-action="toggle-task" ${taskRef(x)} ${it.done ? 'checked' : ''}>
        <span class="task-label">${suggest ? '<span class="suggest-tag">↪ Portati avanti:</span> ' : ''}${label}</span>
      </label>
      <span class="task-meta">
        ${showDue ? `<span class="due ${late ? 'late' : ''}">${late ? 'era per ' : ''}${rel(it.due)}</span>` : ''}
        ${suggest ? `<span class="due">previsto ${fmtShort(it.due)}</span>` : whenChip(x)}
        ${chip}
        ${!it.done && (it.due <= today() || (suggest && onDay === today())) ? `<button class="play" data-action="focus-start" ${taskRef(x)} title="Inizia ora: 25 minuti di concentrazione">▶</button>` : ''}
      </span>
    </li>`;
}

/* ---------- Componenti ---------- */

function eventCard(ev) {
  const t = tpl(ev.type);
  const h = eventHealth(ev);
  const done = ev.steps.filter(s => s.done).length;
  const next = sortedSteps(ev).find(s => !s.done);
  return `
    <button class="event-card" style="--c:${t.color}" data-action="open-event" data-ev="${ev.id}">
      <span class="ev-icon">${t.icon}</span>
      <span class="ev-body">
        <span class="ev-type">${esc(t.label)}</span>
        <span class="ev-title">${esc(ev.title)}</span>
        <span class="ev-meta">${cap(fmtLong(ev.date))}${ev.time ? ` · ore ${ev.time}` : ''} · <strong>${rel(ev.date)}</strong></span>
        ${ev.sheetMissing ? '<span class="ev-warn">⚠️ Non risulta più nel foglio delle prediche: verifica</span>' : ''}
        ${next ? `<span class="ev-next">Prossimo passo: ${esc(next.label)} <em>(${rel(next.due)})</em></span>` : ''}
      </span>
      <span class="ev-side">
        ${healthBadge(h)}
        ${ev.steps.length ? `<span class="dots">${ev.steps.map(s => `<i class="${s.done ? 'on' : ''}"></i>`).join('')}</span>
        <small>${done}/${ev.steps.length} passi</small>` : ''}
      </span>
    </button>`;
}

function pageCard(p) {
  const s = studyStatus(p);
  const pct = Math.round((p.current / p.total) * 100);
  let todayLine = '', status = '', actions = '';

  if (s.finished) {
    todayLine = `<p class="study-today done">🎉 Completato!</p>`;
  } else if (s.expired) {
    todayLine = `<p class="study-today late">⚠️ La scadenza (${fmtShort(p.endDate)}) è passata e mancano ancora ${qty(p.total - p.current, p.unit)}.
      Scegli una nuova data realistica e riparti.</p>`;
    actions = `<button data-action="edit-study" data-id="${p.id}">Nuova scadenza</button>`;
  } else if (s.notStarted) {
    todayLine = `<p class="study-today">Si parte ${fmtLong(p.startDate)}: ${qty(s.quota, p.unit)} per sessione.</p>`;
  } else if (!s.isStudyDay) {
    const nd = nextStudyDay(p, addDays(today(), 1));
    todayLine = `<p class="study-today rest">Oggi riposo.${nd ? ` Prossima sessione ${fmtShort(nd)}.` : ''}</p>`;
  } else if (s.doneToday) {
    todayLine = `<p class="study-today done">✓ Parte di oggi fatta (obiettivo: ${pos(p, s.target)}).</p>`;
  } else {
    const range = s.quota > 1 ? `da ${pos(p, s.before + 1)} a ${pos(p, s.target)}` : pos(p, s.target);
    todayLine = `<p class="study-today">Oggi: <strong>${range}</strong> <span class="muted">(${qty(s.target - s.before, p.unit)})</span></p>`;
    actions = `<button class="primary" data-action="study-done-today" data-id="${p.id}">✓ Fatto la parte di oggi</button>`;
  }

  if (!s.finished && !s.notStarted) {
    status = s.delta < 0
      ? `<span class="badge late">Indietro di ${qty(-s.delta, p.unit)}</span>`
      : `<span class="badge ok">In pari</span>`;
  }

  const warning = !s.finished && !s.expired && !s.notStarted && s.delta < 0 && s.quota > s.basePace
    ? `<p class="hint warn">Per stare nei tempi ora servono ${qty(s.quota, p.unit)} per sessione (all'inizio erano ${s.basePace}).
       Ogni giorno saltato si fa sentire: meglio poco ma oggi.</p>` : '';

  return `
    <article class="study-card">
      <header>
        <div>
          <h3>📖 ${esc(p.title)}</h3>
          <p class="muted">Sei a ${pos(p, p.current)} di ${p.total} · scadenza ${fmtShort(p.endDate)}${s.finished ? '' : ` (${rel(p.endDate)})`}</p>
        </div>
        ${status}
      </header>
      <div class="bar"><span style="width:${pct}%"></span></div>
      ${todayLine}
      ${warning}
      ${s.finished ? '' : `
      <div class="study-actions">
        ${actions}
        <form class="inline-form" data-progress-form="${p.id}">
          <label>Sono arrivato a <input type="number" name="value" min="0" max="${p.total}" value="${p.current}"></label>
          <button>Aggiorna</button>
        </form>
      </div>`}
    </article>`;
}

function chapterCard(p, { full = false, compact = false } = {}) {
  const st = chapterStatus(p);
  const t = today();
  const pct = Math.round((st.done / st.total) * 100);
  const mon = t, sun = addDays(t, 6);
  const week = p.chapters.flatMap(ch => ch.sections.map(s => ({ kind: 'section', plan: p, ch, item: s })))
    .filter(x => x.item.due >= mon && x.item.due <= sun).sort(byTask);
  const weekChapters = [...new Set(week.map(x => x.ch))];
  const chDone = p.chapters.filter(c => c.sections.every(s => s.done)).length;

  const status = st.finished ? '<span class="badge done">Completato 🎉</span>'
    : st.overdue ? `<span class="badge late">Indietro di ${plural(st.overdue, 'lettura', 'letture')}</span>`
    : t < p.startDate ? `<span class="badge today">Si parte ${fmtShort(p.startDate)}</span>`
    : '<span class="badge ok">In pari</span>';

  return `
    <article class="study-card">
      <header>
        <div>
          <h3>📖 ${esc(p.title)}</h3>
          <p class="muted">${chDone}/${p.chapters.length} capitoli · ${st.done}/${st.total} letture${st.finished ? '' : ` · fine prevista ${fmtDM(st.end)}`}</p>
        </div>
        ${status}
      </header>
      <div class="bar"><span style="width:${pct}%"></span></div>
      ${st.overdue ? `
        <p class="hint warn">Hai ${plural(st.overdue, 'lettura arretrata', 'letture arretrate')}. Puoi recuperarle in questi giorni,
          oppure ripianificare: il resto del piano slitta in avanti e la data di fine si sposta.</p>
        <div class="study-actions"><button data-action="replan" data-id="${p.id}">Ripianifica da oggi</button></div>` : ''}
      ${compact ? (st.current && !st.finished ? `<p class="study-today">In corso: <strong>Cap. ${st.current.n} — ${esc(st.current.title)}</strong> <span class="muted">(le letture sono nel giorno per giorno qui sopra)</span></p>` : '')
      : week.length ? `
        <h4>Prossimi 7 giorni: ${weekChapters.map(c => `Cap. ${c.n} — ${esc(c.title)}`).join(' · ')}</h4>
        <ul class="tasks">${week.map(x => taskItem(x, { showDue: true })).join('')}</ul>`
        : (!st.finished && st.current ? `<p class="study-today rest">Niente in programma nei prossimi 7 giorni. Prossimo: Cap. ${st.current.n} — ${esc(st.current.title)}.</p>` : '')}
      ${full ? `
        <details class="plan-details">
          <summary>Tutto il piano (${p.chapters.length} capitoli)</summary>
          <ol class="plan-list">
            ${p.chapters.map(c => {
              const [a, b] = chapterRange(c);
              const d = c.sections.filter(s => s.done).length;
              const isDone = d === c.sections.length;
              return `<li class="${isDone ? 'is-done' : ''}">
                <span><strong>Cap. ${c.n}</strong> ${esc(c.title)} ${c.from ? `<span class="muted">(${c.to - c.from + 1} pp.)</span>` : ''}</span>
                <span class="muted">${fmtDM(a)} – ${fmtDM(b)} · ${isDone ? '✓' : `${d}/${c.sections.length}`}</span>
              </li>`;
            }).join('')}
          </ol>
        </details>` : ''}
    </article>`;
}

const studyCard = (p, opts) => p.kind === 'chapters' ? chapterCard(p, opts) : pageCard(p);

function emptyCard(text, actions = '') {
  return `<div class="empty">${text}${actions ? `<div class="empty-actions">${actions}</div>` : ''}</div>`;
}

/* ---------- Viste ---------- */

let view = 'settimana';
let weekOffset = 0;
let calCursor = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1); })();
const main = document.getElementById('main');

// Colori degli impegni: distribuiti su tutto il cerchio cromatico, il più forte (rosso) alla predica.
function renderLegend() {
  const el = document.getElementById('legend');
  if (!el) return;
  const items = Object.values(state.templates).filter(t => t !== state.templates.altro)
    .map(t => [t.color, `${t.icon} ${t.label}`]).concat([[STUDY_COLOR, '📖 Studio personale']]);
  el.innerHTML = items.map(([c, l]) => `<li style="--c:${c}">${esc(l)}</li>`).join('');
}

/* ---------- Tema chiaro / scuro (scelta di questo dispositivo, non sincronizzata) ---------- */

const THEME_KEY = 'agenda-theme';
const currentTheme = () => document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';

function renderThemeButton() {
  const b = document.getElementById('theme-toggle');
  if (b) b.textContent = currentTheme() === 'dark' ? '☀️ Tema chiaro' : '🌙 Tema scuro';
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  renderThemeButton();
}

// Senza una scelta esplicita, segue il sistema anche quando cambia (es. modalità notte automatica)
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
  if (!localStorage.getItem(THEME_KEY)) setTheme(e.matches ? 'dark' : 'light');
});

function render() {
  renderLegend();
  renderThemeButton();
  document.querySelectorAll('.nav').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  main.dataset.view = view;
  main.innerHTML = VIEWS[view]();
  renderSyncStatus();
}

function viewSettimana() {
  const t = today();
  // Settimana "mobile": sempre 7 giorni a partire da oggi, così non è mai mezza vuota.
  const mon = addDays(t, weekOffset * 7);
  const sun = addDays(mon, 6);
  const isCurrent = weekOffset === 0;
  const weekKey = mondayOf(t);
  const tasks = tasksBetween(mon, sun);
  const done = tasks.filter(x => x.item.done).length;
  const weekEvents = state.events.filter(e => e.date >= mon && e.date <= sun).sort(byDate);
  const events = weekEvents.filter(e => !e.notMine);
  const late = isCurrent ? overdueTasks(mon) : [];
  const giovToChoose = !state.settings.giovChosen && state.events.some(e => e.notMine && e.date >= t);
  const pagePlans = state.studies.filter(p => p.kind !== 'chapters' && !isFinished(p));
  const activeStudies = state.studies.filter(p => !isFinished(p));
  const later = state.events.filter(e => !e.notMine && e.date > sun && e.date <= addDays(sun, 21)).sort(byDate);
  const needsPlanning = isCurrent && !state.plannedWeeks[weekKey] && tasks.some(x => !x.item.done && x.item.due >= t);
  const nothingAtAll = !state.events.length && !state.studies.length;

  const title = { 0: 'I prossimi 7 giorni', 1: 'La settimana dopo', [-1]: 'I 7 giorni prima' }[weekOffset] || 'Settimana';
  const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

  const anticip = anticipations(t, sun);
  let board = '';
  for (let i = 0; i < 7; i++) {
    const d = addDays(mon, i);
    const dayEvents = weekEvents.filter(e => e.date === d);
    const dayTasks = tasks.filter(x => x.item.due === d);
    const sessions = pagePlans.filter(p => p.days.includes(parse(d).getDay()) && d >= p.startDate && d <= p.endDate && d >= t);
    const sessionHtml = sessions.map(p => {
      if (d !== t) return `<li class="task faint"><span class="task-label">📖 ${esc(p.title)}: sessione di studio</span></li>`;
      const s = studyStatus(p);
      return `<li class="task ${s.doneToday ? 'is-done' : ''}">
        <label class="task-main"><input type="checkbox" data-action="toggle-pageplan" data-id="${p.id}" ${s.doneToday ? 'checked' : ''}>
        <span class="task-label">📖 ${esc(p.title)}: arriva a <strong>${pos(p, s.target)}</strong></span></label></li>`;
    }).join('');
    const empty = !dayEvents.length && !dayTasks.length && !sessionHtml && !anticip[`${d}|mattina`] && !anticip[`${d}|sera`];
    let tasksHtml = '';
    for (const slot of SLOT_ORDER) {
      const inSlot = dayTasks.filter(x => taskSlot(x) === slot);
      const sug = anticip[`${d}|${slot}`];
      if (inSlot.length || sug) {
        tasksHtml += `<li class="slot-label">${SLOT_TITLE[slot]}</li>${inSlot.map(x => taskItem(x)).join('')}`;
        if (sug) tasksHtml += taskItem(sug, { suggest: true, onDay: d });
      }
    }
    board += `
      <div class="board-day ${d === t ? 'is-today' : ''} ${d < t ? 'is-past' : ''}">
        <div class="board-date">
          <strong>${cap(fmtWeekday(d))}</strong>
          <span>${fmtDM(d)}</span>
          ${d === t ? '<em>oggi</em>' : ''}
        </div>
        <div class="board-items">
          ${dayEvents.map(ev => {
            const tp = tpl(ev.type);
            return `<button class="event-pill ${ev.notMine ? 'faint' : ''}" style="--c:${tp.color}" data-action="open-event" data-ev="${ev.id}">
              ${tp.icon} <strong>${esc(tp.label)}</strong> · ${esc(ev.title)}${ev.time ? ` · ${ev.time}` : ''}${ev.notMine ? ' · <em>guida un altro</em>' : ''}</button>`;
          }).join('')}
          ${tasksHtml || sessionHtml ? `<ul class="tasks">${tasksHtml}${sessionHtml}</ul>` : ''}
          ${empty ? '<span class="muted small">Libero</span>' : ''}
        </div>
      </div>`;
  }

  // Due colonne sugli schermi larghi: a sinistra cosa fare (Adesso, arretrati, settimana),
  // a destra il contesto. Sugli schermi stretti le colonne si sciolgono e vale l'ordine "w-N".
  const banners = [
    giovToChoose ? `<div class="banner w-3">🧒 <span><strong>Giovanissimi:</strong> quali incontri guidi tu? La preparazione partirà solo per quelli.</span>
      <button class="primary" data-action="giov-choose">Scegli i tuoi incontri</button></div>` : '',
    !serverMode && !cloud.cfg ? `<div class="banner w-4">☁️
      <span>I dati sono solo in questo browser. Attiva la sincronizzazione per averli uguali su tutti i dispositivi.</span>
      <button class="primary" data-action="nav" data-view="impostazioni">Attiva</button></div>` : '',
    !state.settings.sheetUrl && location.protocol !== 'file:' ? `<div class="banner w-5">🎤
      <span>Collega il foglio delle prediche: le tue prediche e presidenze arriveranno da sole.</span>
      <button data-action="nav" data-view="impostazioni">Collega il foglio</button></div>` : '',
    needsPlanning ? `
      <div class="plan-banner w-7">
        <div>
          <strong>🗓️ Pianifica la settimana (5 minuti)</strong>
          <p>Ogni passo ha già un momento della giornata (☀️ mattina 7–9, 🌙 sera 19–20). Scorri i giorni:
          se un momento non va bene cliccaci sopra per cambiarlo. Decidere in anticipo <em>quando</em> fare una cosa
          aumenta molto la probabilità di farla davvero.</p>
        </div>
        <button class="primary" data-action="week-planned" data-week="${weekKey}">Fatto, settimana pianificata</button>
      </div>` : '',
  ].join('');

  const header = `
    <header class="page-head row">
      <div>
        <p class="eyebrow">Dal ${fmtDM(mon)} al ${fmtDM(sun)}</p>
        <h1>${title}</h1>
      </div>
      <div class="btn-group">
        <button data-action="week-prev" title="Settimana precedente">‹</button>
        <button data-action="week-today">Oggi</button>
        <button data-action="week-next" title="Settimana successiva">›</button>
      </div>
    </header>`;

  if (nothingAtAll) {
    return `${header}${banners}${emptyCard('Non hai ancora inserito nulla.',
      `<button class="primary" data-action="new-event">+ Nuovo impegno</button>
       <button data-action="quick-add">Inserimento rapido</button>
       <button data-action="new-study">+ Piano di studio</button>`)}`;
  }

  return `${header}
    <div class="week-layout">
      <div class="week-main">
        ${isCurrent ? `<div class="w-1">${nowCard()}</div>` : ''}

        ${late.length ? `
          <section class="section late-section w-8">
            <h2>⚠️ Rimasti indietro</h2>
            <ul class="tasks">${late.map(x => taskItem(x, { showDue: true })).join('')}</ul>
          </section>` : ''}

        <section class="section w-10">
          <h2>Giorno per giorno</h2>
          <div class="board">${board}</div>
        </section>
      </div>

      <aside class="week-rail">
        <section class="week-summary w-6">
          <div class="stat"><strong>${events.length}</strong><span>${events.length === 1 ? 'impegno' : 'impegni'}</span></div>
          <div class="stat"><strong>${tasks.length}</strong><span>${tasks.length === 1 ? 'passo' : 'passi'} in programma</span></div>
          <div class="stat grow">
            <div class="stat-row"><span>Passi completati</span><strong>${done}/${tasks.length}</strong></div>
            <div class="bar"><span style="width:${pct}%"></span></div>
          </div>
        </section>

        ${isCurrent ? `<div class="w-2">${habitCard()}</div>` : ''}

        ${banners}

        <section class="section w-9">
          <h2>Impegni</h2>
          ${events.length ? `<div class="event-list">${events.map(eventCard).join('')}</div>`
            : '<p class="muted">Nessun impegno in questi 7 giorni.</p>'}
        </section>

        ${isCurrent && activeStudies.length ? `
          <section class="section w-11">
            <h2>Studio personale</h2>
            <div class="study-list">${activeStudies.map(p => studyCard(p, { compact: true })).join('')}</div>
          </section>` : ''}

        ${later.length ? `
          <section class="section w-12">
            <h2>Più avanti</h2>
            <div class="event-list">${later.map(eventCard).join('')}</div>
          </section>` : ''}
      </aside>
    </div>
  `;
}

const SLOT_ORDER = ['mattina', 'pomeriggio', 'sera'];

// Blocchi "veri": un passo impegnativo o una lettura. Un blocco con solo cose leggere (o niente) è libero.
const blockIsLight = (tasks, d, slot) =>
  !tasks.some(x => x.item.due === d && taskSlot(x) === slot && (x.kind === 'section' || x.item.heavy));

// Blocchi usati: qualcosa completato in quella fascia oraria, o un timer portato a termine.
function usedBlocks() {
  const set = new Set();
  const stamps = [
    ...allTasks().filter(x => x.item.done && x.item.doneAt).map(x => x.item.doneAt),
    ...state.sessions.map(se => se.at),
  ];
  for (const st of stamps) {
    const dt = new Date(st);
    if (dt.getHours() < 12) set.add(`${iso(dt)}|mattina`);
    else if (dt.getHours() >= 17) set.add(`${iso(dt)}|sera`);
  }
  return set;
}

// Per ogni mattina e sera libera (lun–sab) propone il prossimo passo da anticipare: prima gli impegni
// delle prossime 3 settimane (hanno una scadenza), poi le letture. Mai nei giorni già impegnativi.
function anticipations(from, to) {
  const t = today();
  const tasks = allTasks();
  const used = usedBlocks();
  const horizon = addDays(t, 21);
  const pool = tasks.filter(x => !x.item.done && !x.item.exam && x.item.due > t
    && !(x.kind === 'step' && (x.ev.notMine || x.ev.date > horizon || x.item.due >= x.ev.steps.reduce((m, st) => (st.due > m ? st.due : m), '')
      || (x.ev.type === 'predica' && !x.ev.passage))))
    .sort((a, b) => (a.kind === 'section') - (b.kind === 'section') || byTask(a, b));
  const taken = new Set();
  const out = {};
  for (let d = from < t ? t : from; d <= to; d = addDays(d, 1)) {
    if (parse(d).getDay() === 0 || isHeavyDay(d)) continue;
    for (const slot of ['mattina', 'sera']) {
      if (!blockIsLight(tasks, d, slot) || eventInBlock(d, slot) || (d === t && (used.has(`${d}|${slot}`) || (slot === 'mattina' && new Date().getHours() >= 12)))) continue;
      const x = pool.find(c => c.item.due > d && !taken.has(c.item.id));
      if (x) { taken.add(x.item.id); out[`${d}|${slot}`] = x; }
    }
  }
  return out;
}

function habitCard() {
  const t = today();
  const used = usedBlocks();
  const start = state.habitStart || t;
  const hour = new Date().getHours();
  const days = [];
  for (let i = 13; i >= 0; i--) days.push(addDays(t, -i));
  const expected = d => d >= start && parse(d).getDay() !== 0;
  const status = (d, block) => {
    if (used.has(`${d}|${block}`)) return 'on';
    if (!expected(d) || eventInBlock(d, block)) return 'rest';
    if (d === t) return block === 'mattina' && hour >= 12 ? 'off' : 'today';
    return 'off';
  };
  const row = (block, name) => {
    let streak = 0;
    for (let i = days.length - 1; i >= 0; i--) {
      const st = status(days[i], block);
      if (st === 'on') streak++;
      else if (st === 'off') break;
    }
    const y1 = status(addDays(t, -1), block), y2 = status(addDays(t, -2), block);
    return {
      html: `<div class="habit">
        <span class="habit-name">${name}</span>
        <span class="chain">${days.map(d => `<i class="${status(d, block)}" title="${fmtShort(d)}"></i>`).join('')}</span>
        <span class="habit-streak">${streak ? `${streak} di fila` : ''}</span>
      </div>`,
      missedTwice: y1 === 'off' && y2 === 'off',
      missedOnce: y1 === 'off',
    };
  };
  const m = row('mattina', '☀️ Mattine'), e = row('sera', '🌙 Sere');
  const msg = m.missedTwice || e.missedTwice
    ? '⚠️ Due blocchi saltati di fila: oggi ricomincia, anche solo 25 minuti. Conta ripartire, non recuperare.'
    : m.missedOnce || e.missedOnce
      ? 'Ieri un blocco è saltato: succede. La regola è non saltarlo due volte di fila, quindi oggi non saltarlo.'
      : 'Un pallino pieno per ogni blocco usato. Regola: mai saltare due volte di fila.';
  return `<section class="habits">${m.html}${e.html}<p class="hint">${msg}</p></section>`;
}

// Il riquadro "Adesso": in base all'ora dice una sola cosa da fare, adesso.
function nowCard() {
  const t = today();
  const tomorrow = addDays(t, 1);
  const now = new Date();
  const h = now.getHours() + now.getMinutes() / 60;
  const open = allTasks().filter(x => !x.item.done && x.item.due <= t && (x.kind === 'section' || x.ev.date >= t));
  const todays = open.filter(x => x.item.due === t).sort(byTask);
  const late = open.filter(x => x.item.due < t).sort(byTask);
  const doneToday = allTasks().filter(x => x.item.done && x.item.due === t).length;
  const slot = name => todays.filter(x => taskSlot(x) === name);
  const sug = anticipations(t, tomorrow);
  const used = usedBlocks();
  const pick = (...c) => c.find(Boolean) || null;

  let head = '', focus = null, preview = null, note = '';
  if (h < 9) {
    focus = pick(slot('mattina')[0], late[0], sug[`${t}|mattina`], todays[0]);
    head = h < 7 ? '🌅 Alle 7 inizia il blocco del mattino. Si comincia da:' : '☀️ Blocco del mattino (7–9). Adesso tocca a:';
    if (h < 7) note = 'Apri l\'agenda prima del telefono: il primo quarto d\'ora decide la giornata.';
  } else if (h < 22 && eventInBlock(t, 'sera')) {
    // Stasera c'è un incontro: niente blocco serale
    const ev = eventInBlock(t, 'sera');
    const what = `${tpl(ev.type).icon} ${esc(ev.title)} alle ${ev.time}`;
    focus = h < 19 ? pick(slot('mattina')[0], slot('pomeriggio')[0], late[0]) : null;
    if (focus) {
      head = `Stasera c'è ${what}. Se ti è rimasto qualcosa, fallo prima:`;
    } else {
      head = `Stasera c'è ${what}: niente blocco serale.`;
      preview = pick(tasksBetween(tomorrow, tomorrow).find(x => !x.item.done && taskSlot(x) === 'mattina'), sug[`${tomorrow}|mattina`]);
      note = preview ? "Goditi l'incontro: domattina si riparte da qui." : "Goditi l'incontro. Domattina non hai niente in programma.";
    }
  } else if (h < 19) {
    if (h >= 14 && slot('pomeriggio').length) {
      head = '🌤️ Pomeriggio. Adesso tocca a:';
      focus = slot('pomeriggio')[0];
    } else {
      head = '⏳ Il prossimo blocco è stasera alle 19:';
      focus = pick(slot('mattina')[0], slot('pomeriggio')[0], slot('sera')[0], late[0], sug[`${t}|sera`]);
      if (slot('mattina').length) note = 'Stamattina è rimasto qualcosa: stasera inizia da lì.';
    }
  } else if (h < 22 && !used.has(`${t}|sera`)) {
    focus = pick(slot('mattina')[0], slot('pomeriggio')[0], slot('sera')[0], late[0], sug[`${t}|sera`]);
    head = '🌙 Blocco serale. Adesso tocca a:';
    note = 'Prima il blocco, poi la TV. Non serve finire tutto: inizia con 25 minuti, il resto viene da sé.';
  } else {
    head = used.has(`${t}|sera`) ? '✅ Blocco serale fatto: il resto della serata è tuo.' : '🌛 È tardi: niente recuperi stanotte.';
    preview = pick(tasksBetween(tomorrow, tomorrow).find(x => !x.item.done && taskSlot(x) === 'mattina'), sug[`${tomorrow}|mattina`]);
    if (!preview) note = 'Domattina non hai niente in programma.';
  }
  if (!focus && !preview && h < 22 && !eventInBlock(t, 'sera')) {
    head = doneToday ? '✅ Per oggi hai fatto tutto' : '🌿 Oggi non hai niente in programma';
    note = 'Il resto del tempo è tuo: goditelo senza sensi di colpa. Te lo sei guadagnato.';
  }
  const ahead = focus && focus.item.due > t;
  if (ahead) {
    head = h < 9 ? '☀️ Mattina libera: portati avanti con'
      : h < 19 ? '⏳ Stasera alle 19 il blocco è libero: portati avanti con'
      : '🌙 Sera libera: portati avanti con';
  }

  const label = x => x.kind === 'step' ? esc(x.item.label) : esc(x.item.title);
  const context = x => x.kind === 'step'
    ? `${tpl(x.ev.type).icon} ${esc(x.ev.title)} · ${rel(x.ev.date)}`
    : `📖 Cap. ${x.ch.n} · ${esc(x.ch.title)} ${sectionPages(x.item)}`;
  const counts = [
    todays.length ? `oggi ${plural(todays.length, 'passo', 'passi')} da fare` : '',
    doneToday ? `${doneToday} ${doneToday === 1 ? 'fatto' : 'fatti'}` : '',
    late.length ? `${plural(late.length, 'arretrato', 'arretrati')}` : '',
  ].filter(Boolean).join(' · ');

  return `
    <section class="now-card ${focus ? '' : 'is-free'}">
      <p class="now-head">${head}</p>
      ${focus ? `
        <div class="now-focus">
          <div>
            <h2>${label(focus)}</h2>
            <p class="muted">${context(focus)}${focus.item.due < t ? ` · <span class="late-text">era per ${rel(focus.item.due)}</span>` : ''}${ahead ? ` · previsto ${fmtShort(focus.item.due)}` : ''}</p>
          </div>
          <div class="now-actions">
            <button class="primary big" data-action="focus-start" data-min="25" ${taskRef(focus)}>▶ Inizia · 25 min</button>
            <button data-action="focus-start" data-min="50" ${taskRef(focus)}>50 min</button>
            <button data-action="quick-done" ${taskRef(focus)}>✓ Già fatto</button>
          </div>
        </div>` : ''}
      ${preview ? `<p class="now-preview">Domattina alle 7: <strong>${label(preview)}</strong> <span>· ${context(preview)}</span></p>` : ''}
      ${note ? `<p class="now-note">${note}</p>` : ''}
      ${counts ? `<p class="now-counts">${counts}</p>` : ''}
    </section>`;
}

function viewAgenda() {
  const t = today();
  const late = overdueTasks();
  let days = '';
  for (let d = t; d <= addDays(t, 27); d = addDays(d, 1)) {
    const evs = state.events.filter(e => e.date === d).sort(byDate);
    const st = tasksBetween(d, d);
    if (!evs.length && !st.length) continue;
    days += `
      <section class="day">
        <h3>${cap(fmtLong(d))} <span class="muted">· ${rel(d)}</span></h3>
        ${evs.map(ev => {
          const tp = tpl(ev.type);
          return `<button class="event-row ${ev.notMine ? 'faint' : ''}" style="--c:${tp.color}" data-action="open-event" data-ev="${ev.id}">
            <span>${tp.icon}</span><strong>${esc(ev.title)}</strong><span class="muted">${esc(tp.label)}${ev.time ? ` · ${ev.time}` : ''}${ev.notMine ? ' · guida un altro' : ''}</span>
            ${healthBadge(eventHealth(ev))}</button>`;
        }).join('')}
        ${st.length ? `<ul class="tasks">${st.map(x => taskItem(x)).join('')}</ul>` : ''}
      </section>`;
  }
  return `
    <header class="page-head">
      <p class="eyebrow">Le prossime 4 settimane</p>
      <h1>Agenda</h1>
    </header>
    ${late.length ? `
      <section class="section late-section">
        <h2>⚠️ Rimasti indietro</h2>
        <ul class="tasks">${late.map(x => taskItem(x, { showDue: true })).join('')}</ul>
      </section>` : ''}
    ${days || emptyCard('Nessun impegno nelle prossime settimane.',
      `<button class="primary" data-action="new-event">+ Nuovo impegno</button>`)}
  `;
}

function viewCalendario() {
  const t = today();
  const y = calCursor.getFullYear(), m = calCursor.getMonth();
  const offset = (new Date(y, m, 1).getDay() + 6) % 7;
  const gridStart = iso(new Date(y, m, 1 - offset));
  const tasks = allTasks().filter(x => !x.item.done);
  let cells = '';
  for (let i = 0; i < 42; i++) {
    const d = addDays(gridStart, i);
    const inMonth = parse(d).getMonth() === m;
    const evs = state.events.filter(e => e.date === d).sort(byDate);
    const due = tasks.filter(x => x.item.due === d).length;
    const studyEnds = state.studies.filter(p => p.kind !== 'chapters' && p.endDate === d && !isFinished(p));
    cells += `
      <div class="cal-cell ${inMonth ? '' : 'out'} ${d === t ? 'is-today' : ''}" data-action="new-on-date" data-date="${d}" title="Clicca per aggiungere un impegno">
        <span class="cal-num">${parse(d).getDate()}</span>
        ${evs.map(ev => { const tp = tpl(ev.type); return `<button class="cal-chip ${ev.notMine ? 'faint' : ''}" style="--c:${tp.color}" data-action="open-event" data-ev="${ev.id}">${tp.icon} ${esc(ev.title)}</button>`; }).join('')}
        ${studyEnds.map(p => `<button class="cal-chip" style="--c:${STUDY_COLOR}" data-action="nav" data-view="studio">📖 Fine: ${esc(p.title)}</button>`).join('')}
        ${due ? `<span class="cal-steps">${plural(due, 'passo', 'passi')}</span>` : ''}
      </div>`;
  }
  return `
    <header class="page-head row">
      <div>
        <p class="eyebrow">Calendario</p>
        <h1>${cap(calCursor.toLocaleDateString('it-IT', { month: 'long', year: 'numeric' }))}</h1>
      </div>
      <div class="btn-group">
        <button data-action="cal-prev">‹</button>
        <button data-action="cal-today">Oggi</button>
        <button data-action="cal-next">›</button>
      </div>
    </header>
    <div class="cal">
      ${['Lun', 'Mar', 'Mer', 'Gio', 'Ven', 'Sab', 'Dom'].map(d => `<div class="cal-head">${d}</div>`).join('')}
      ${cells}
    </div>
    <p class="hint">Clicca su un giorno per aggiungere un impegno in quella data.</p>
  `;
}

function viewStudio() {
  const active = state.studies.filter(p => !isFinished(p));
  const done = state.studies.filter(isFinished);
  return `
    <header class="page-head row">
      <div>
        <p class="eyebrow">Programma di studio</p>
        <h1>Studio personale</h1>
      </div>
      <button class="primary" data-action="new-study">+ Nuovo piano</button>
    </header>

    <div class="explain">
      <strong>Come funziona.</strong> Senza un esame serve una scadenza che lo sostituisca: il piano divide il libro in letture
      piccole e assegna a ogni lettura un giorno preciso. Ogni settimana hai la tua checklist; se resti indietro lo vedi subito
      e puoi recuperare o ripianificare in modo onesto (la data di fine si sposta, non si nasconde).
    </div>

    ${active.length ? `<div class="study-list">${active.map(p => `
      <div class="study-wrap">
        ${studyCard(p, { full: true })}
        <div class="study-tools">
          <button data-action="edit-study" data-id="${p.id}">Modifica</button>
          <button class="danger-link" data-action="delete-study" data-id="${p.id}">Elimina</button>
        </div>
      </div>`).join('')}</div>`
      : emptyCard('Nessun piano di studio attivo.',
        `<button class="primary" data-action="new-study">+ Crea il primo piano</button>`)}

    ${done.length ? `
      <section class="section">
        <h2>Completati 🎉</h2>
        <ul class="plain">${done.map(p => `<li>📖 ${esc(p.title)}
          <button class="danger-link" data-action="delete-study" data-id="${p.id}">Elimina</button></li>`).join('')}</ul>
      </section>` : ''}
  `;
}

function viewImpostazioni() {
  const s = state.settings;
  const cards = Object.entries(state.templates).filter(([k]) => k !== 'altro').map(([k, t]) => `
    <article class="tpl-card" data-type="${k}" style="--c:${t.color}">
      <h3>${t.icon} ${esc(t.label)}</h3>
      <div class="tpl-rows">
        ${[...t.steps].sort((a, b) => b.offset - a.offset).map(tplRow).join('')}
      </div>
      <button class="link" data-action="tpl-add-step">+ Aggiungi passo</button>
    </article>`).join('');

  return `
    <header class="page-head">
      <p class="eyebrow">Impostazioni</p>
      <h1>Impostazioni</h1>
    </header>

    <section class="section">
      <h2>☁️ Sincronizzazione tra dispositivi</h2>
      ${cloud.cfg ? `
        <div class="settings-form">
          <p>✅ Collegato a <strong>${esc(cloud.cfg.repo)}</strong> (repository privato). Ogni modifica viene salvata lì
            e ritrovata su tutti i dispositivi collegati.</p>
          <div class="btn-row">
            <button class="primary" data-action="cloud-share">📱 Collega il telefono</button>
            <button data-action="cloud-disconnect">Scollega questo dispositivo</button>
          </div>
        </div>` : `
        <form class="form settings-form" id="cloud-form">
          <p class="muted">Collega questo dispositivo e i tuoi dati saranno uguali su PC, telefono e ovunque apri l'agenda.
            Va fatto <strong>una volta sola per dispositivo</strong>.</p>
          <p>📱 <strong>Hai già collegato il PC?</strong> Non serve un'altra chiave: sul PC apri Impostazioni →
            <em>Collega il telefono</em> e inquadra il codice con la fotocamera.</p>
          <ol class="howto">
            <li>Apri <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">questa pagina di GitHub</a> (crea una chiave).</li>
            <li><em>Token name</em>: <code>agenda</code> · <em>Expiration</em>: la più lunga che ti propone.</li>
            <li><em>Repository access</em>: <strong>Only select repositories</strong> → scegli <code>agenda-dati</code>.</li>
            <li><em>Permissions</em> → <em>Repository permissions</em> → <strong>Contents: Read and write</strong>.</li>
            <li>Clicca <strong>Generate token</strong>, copia la chiave (inizia con <code>github_pat_</code>) e incollala qui sotto.</li>
          </ol>
          <div class="field-row">
            <label class="field grow2"><span>Chiave</span><input name="token" type="password" placeholder="github_pat_…" autocomplete="off" required></label>
            <label class="field"><span>Repository</span><input name="repo" value="${DEFAULT_REPO}"></label>
          </div>
          <div class="btn-row"><button class="primary">Collega</button></div>
        </form>`}
    </section>

    <section class="section">
      <h2>Foglio delle prediche</h2>
      <p class="muted">L'agenda legge il foglio a ogni avvio: le righe in cui compare il tuo nome nella colonna
        <em>Predica</em> o <em>Presiede</em> diventano impegni, con la loro tabella di marcia.</p>
      <form class="form settings-form" id="sheet-form">
        <div class="field-row">
          <label class="field"><span>Il tuo nome nel foglio</span><input name="myName" value="${esc(s.myName)}"></label>
          <label class="field grow2"><span>Link del foglio</span><input name="sheetUrl" value="${esc(s.sheetUrl)}"></label>
        </div>
        <div class="btn-row">
          <button class="primary">Salva e aggiorna ora</button>
          <span class="muted">${s.lastSync ? `Ultimo aggiornamento: ${new Date(s.lastSync).toLocaleString('it-IT', { dateStyle: 'medium', timeStyle: 'short' })}` : 'Mai aggiornato'}</span>
        </div>
      </form>
    </section>

    <section class="section">
      <h2>Modelli di preparazione</h2>
      <p class="muted">Questi passi vengono creati in automatico per ogni nuovo impegno: giorni prima dell'impegno, momento della giornata
        e 💪 se è un lavoro impegnativo (in quei giorni Wright si alleggerisce). Le modifiche valgono per gli impegni che inserirai da ora in poi.</p>
      <div class="tpl-grid">${cards}</div>
      <div class="form-actions">
        <button data-action="tpl-reset">Ripristina predefiniti</button>
        <button class="primary" data-action="tpl-save">Salva modelli</button>
      </div>
    </section>

    <section class="section">
      <h2>Backup dei dati</h2>
      <p class="muted">${serverMode
        ? 'I dati sono salvati nel file <code>dati.json</code> nella cartella dell\'agenda, con una copia automatica al giorno nella cartella <code>backup</code>.'
        : 'I dati sono salvati in questo browser (su un altro computer o telefono l\'agenda è vuota): per spostarli usa backup e ripristino.'}
        Puoi comunque scaricare una copia da conservare altrove.</p>
      <div class="btn-row">
        <button data-action="export">Scarica backup</button>
        <button data-action="import">Ripristina da backup…</button>
        <input type="file" id="import-file" accept="application/json,.json" hidden>
      </div>
    </section>
  `;
}

function tplRow(st = { label: '', offset: 1, when: 'mattina' }) {
  return `
    <div class="tpl-row" data-iffree="${st.ifFree ? 1 : ''}" data-ifmissing="${st.ifMissing ? 1 : ''}">
      <input class="tpl-label" value="${esc(st.label)}" placeholder="Descrizione del passo">
      <input class="tpl-offset" type="number" min="0" max="60" value="${st.offset}">
      <span class="muted">gg prima</span>
      <select class="tpl-when">${SLOT_ORDER.map(w => `<option value="${w}" ${w === (st.when || 'mattina') ? 'selected' : ''}>${WHEN[w]}</option>`).join('')}</select>
      <label class="tpl-heavy" title="Lavoro impegnativo: in quel giorno Wright si alleggerisce"><input type="checkbox" class="tpl-heavy-cb" ${st.heavy ? 'checked' : ''}>💪</label>
      <button class="icon-btn" data-action="tpl-remove-step" title="Rimuovi">✕</button>
    </div>`;
}

function viewMetodo() {
  return `
    <header class="page-head">
      <p class="eyebrow">Come usare bene il tempo</p>
      <h1>Il metodo</h1>
      <p class="lead">Non serve più forza di volontà: serve una struttura che decida al posto tuo. Sono poche regole, sempre le stesse.</p>
    </header>

    <section class="method-week">
      <h2>La tua giornata tipo</h2>
      <div class="method-grid">
        <div class="method-col"><h3>Lunedì – Venerdì</h3>
          <p><strong>☀️ 7–9</strong> Wright, a mente fresca. Se c'è esegesi, studio o stesura, prima quella (e Wright passa alla sera)</p>
          <p><strong>🌙 19–20</strong> La preparazione degli impegni. Sera libera? Ti porti avanti col prossimo passo</p>
          <p><strong>Dopo le 20</strong> Libero, davvero.</p></div>
        <div class="method-col"><h3>Sabato</h3>
          <p><strong>☀️ 7–9</strong> Il passo del giorno, o ti porti avanti</p>
          <p><strong>Prima di una predica</strong> PowerPoint e ripetizione ad alta voce</p></div>
        <div class="method-col"><h3>Domenica</h3>
          <p>Nessuna responsabilità da preparare</p>
          <p><strong>🌤️ Pomeriggio</strong> Wright (doppia razione) ed esame del capitolo</p>
          <p><strong>Sera</strong> 5 minuti: guarda la settimana che arriva</p></div>
      </div>
    </section>

    <ol class="method-rules">
      <li><strong>Due appuntamenti fissi con te stesso.</strong> Il blocco del mattino e quello della sera valgono come un appuntamento
        di lavoro: non si discute se farli, si sceglie solo cosa fare (e lo dice già l'agenda).</li>
      <li><strong>Prima il blocco, poi il tempo libero.</strong> La TV non è il nemico: è il premio. Se la guardi <em>dopo</em> il blocco
        serale te la godi senza sensi di colpa; se la guardi <em>al posto</em> del blocco ti rovina la serata e la settimana.</li>
      <li><strong>Un blocco libero è un blocco per portarsi avanti.</strong> Se mattina o sera non hanno niente in programma,
        l'agenda ti propone il prossimo passo. Un'ora anticipata stasera è un'ora di respiro sabato.</li>
      <li><strong>Iniziare è la parte difficile: 25 minuti.</strong> Premi ▶ e impegnati solo per 25 minuti, telefono lontano.
        Dopo puoi smettere: quasi sempre continuerai.</li>
      <li><strong>Una cosa alla volta.</strong> Il riquadro "Adesso" ti mostra una sola cosa: quella. Il resto della settimana lo guardi
        solo la domenica sera.</li>
      <li><strong>I passi sono piccoli apposta.</strong> "Preparare la predica" paralizza, "esegesi giorno 2" no. Se un passo ti sembra
        enorme, spezzalo in due dall'impegno (+ Aggiungi passo).</li>
      <li><strong>Se salti un giorno, non recuperare tutto insieme.</strong> Fai il passo di oggi più un arretrato. Se il piano è diventato
        irrealistico, ripianifica: non è un fallimento, è onestà.</li>
      <li><strong>Il sabato prima della predica è sacro.</strong> La stesura finisce venerdì: il sabato serve per PowerPoint e
        ripetizione ad alta voce. È la regola che protegge tutte le altre.</li>
    </ol>
  `;
}

const VIEWS = {
  settimana: viewSettimana,
  metodo: viewMetodo,
  agenda: viewAgenda,
  calendario: viewCalendario,
  studio: viewStudio,
  impostazioni: viewImpostazioni,
};

function renderSyncStatus() {
  const el = document.getElementById('sync-status');
  if (!el) return;
  const hm = d => new Date(d).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
  let html = '';
  if (location.protocol !== 'file:' && state.settings.sheetUrl) {
    const last = state.settings.lastSync;
    html += `<button class="link" data-action="sync" title="Rileggi il foglio delle prediche">↻ Foglio prediche</button>
      <small>${syncing ? 'aggiornamento…' : last ? `aggiornato ${hm(last)}` : 'mai aggiornato'}</small>`;
  }
  if (cloud.cfg) {
    const st = { saving: 'salvataggio…', error: '⚠️ non sincronizzato', ok: cloud.at ? `sincronizzato ${hm(cloud.at)}` : 'sincronizzato' }[cloud.status] || 'collegamento…';
    html += `<button class="link" data-action="nav" data-view="impostazioni" title="Sincronizzazione tra dispositivi">☁️ Cloud</button><small>${st}</small>`;
  }
  el.innerHTML = html;
}

/* ---------- Foglio Google delle prediche ---------- */

let syncing = false;

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false; }
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function sheetIds(url) {
  const id = (url.match(/\/d\/([\w-]+)/) || [])[1];
  const gid = (url.match(/[#?&]gid=(\d+)/) || [])[1] || '0';
  return id ? { id, gid } : null;
}

const meaningfulPassage = p => p && !/^\s*(tema\s+)?libero\b/i.test(p);

// Righe: "Settembre" (mese) poi "7,Nome,Brano,Presiede,…". L'anno non c'è:
// lo ricavo scegliendo quello in cui le date cadono tutte di domenica.
function parseSheet(rows, name) {
  const norm = v => (v || '').trim().toLowerCase();
  const hi = rows.findIndex(r => r.some(c => norm(c) === 'predica'));
  if (hi < 0) throw new Error('Nel foglio non trovo la colonna "Predica"');
  const header = rows[hi].map(norm);
  const iP = header.indexOf('predica'), iB = header.indexOf('brano'), iPr = header.indexOf('presiede');
  if (iPr < 0) throw new Error('Nel foglio non trovo la colonna "Presiede"');

  // Nell'export classico i mesi sono righe a sé. Letto direttamente dal sito (gviz) le righe dei mesi
  // spariscono, resta solo il primo fuso con l'intestazione: il cambio mese si deduce dal giorno che riparte.
  const raw = [];
  let month = MONTHS.indexOf(norm(rows[hi][0]));
  if (month < 0) month = null;
  let prevDay = null;
  for (const row of rows.slice(hi + 1)) {
    const first = norm(row[0]);
    const mi = MONTHS.indexOf(first);
    if (mi >= 0) { month = mi; prevDay = null; continue; }
    if (!/^\d{1,2}$/.test(first) || month === null) continue;
    const d = +first;
    if (prevDay !== null && d <= prevDay) month = (month + 1) % 12;
    prevDay = d;
    raw.push({ m: month, d, row });
  }
  const datesFor = y0 => {
    let y = y0, prev = -1;
    return raw.map(x => { if (x.m < prev) y++; prev = x.m; return new Date(y, x.m, x.d); });
  };
  const cy = new Date().getFullYear();
  let best = null;
  for (let y = cy - 3; y <= cy + 1; y++) {
    const score = datesFor(y).filter(d => d.getDay() === 0).length;
    if (!best || score > best.score) best = { y, score };
  }
  const dates = datesFor(best.y).map(iso);

  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^\\p{L}])${escRe(name.trim())}(?![\\p{L}])`, 'iu');
  const found = [];
  raw.forEach((x, i) => {
    const cell = j => (x.row[j] || '').trim().replace(/\s+/g, ' ');
    const passage = iB >= 0 ? cell(iB) : '';
    if (re.test(cell(iP))) found.push({ type: 'predica', date: dates[i], passage });
    if (re.test(cell(iPr))) found.push({ type: 'presidenza', date: dates[i], info: `Predica: ${cell(iP) || '?'}${passage ? ` — ${passage}` : ''}` });
  });
  return found;
}

function sheetTitle(f) {
  if (f.type === 'presidenza') return 'Presidenza del culto';
  if (meaningfulPassage(f.passage)) return f.passage;
  return f.passage ? 'Predica a tema libero' : 'Predica (brano non ancora assegnato)';
}

async function syncSheet({ silent = false } = {}) {
  if (syncing || location.protocol === 'file:') return;
  const ids = sheetIds(state.settings.sheetUrl || '');
  if (!ids || !state.settings.myName.trim()) { if (!silent) toast('Imposta nome e link del foglio nelle Impostazioni'); return; }
  syncing = true; renderSyncStatus();
  try {
    const r = await fetch(serverMode
      ? `/api/sheet?id=${ids.id}&gid=${ids.gid}`
      : `https://docs.google.com/spreadsheets/d/${ids.id}/gviz/tq?tqx=out:csv&gid=${ids.gid}`);
    if (!r.ok) throw new Error(await r.text());
    const found = parseSheet(parseCSV(await r.text()), state.settings.myName);
    const t = today();
    const upcoming = found.filter(f => f.date >= t);
    const keys = new Set(upcoming.map(f => `sheet:${f.type}:${f.date}`));
    let added = 0, changed = 0;

    for (const f of upcoming) {
      const key = `sheet:${f.type}:${f.date}`;
      let ev = state.events.find(e => e.sheetKey === key);
      if (!ev) {
        ev = createEvent({ type: f.type, date: f.date, title: sheetTitle(f), passage: f.passage });
        ev.sheetKey = key;
        ev.titleAuto = true;
        ev.info = f.info || '';
        added++;
      } else {
        const before = JSON.stringify([ev.passage, ev.info, ev.title]);
        if (f.passage !== undefined) ev.passage = f.passage;
        if (f.info !== undefined) ev.info = f.info;
        if (ev.titleAuto) ev.title = sheetTitle(f);
        if (f.passage) ev.steps.forEach(st => { if (st.auto === 'missing' && !st.done) setDone(st, true); });
        if (JSON.stringify([ev.passage, ev.info, ev.title]) !== before) changed++;
      }
    }
    for (const ev of state.events) {
      if (ev.sheetKey && ev.date >= t) ev.sheetMissing = !keys.has(ev.sheetKey);
    }
    state.settings.lastSync = new Date().toISOString();
    if (added) rebalanceAll();
    save();
    if (added || changed) toast(`Foglio prediche: ${added ? plural(added, 'nuovo impegno', 'nuovi impegni') : ''}${added && changed ? ', ' : ''}${changed ? plural(changed, 'aggiornamento', 'aggiornamenti') : ''}`);
    else if (!silent) toast('Foglio prediche: nessuna novità');
  } catch (e) {
    console.error(e);
    toast(`⚠️ Non riesco a leggere il foglio: ${e.message}`);
  } finally {
    syncing = false;
    render();
    if (modalRefresh) modalRefresh();
  }
}

/* ---------- Dati iniziali (seed.js) ---------- */

function applySeed() {
  const seed = window.SEED;
  if (!seed || state.seedVersion >= seed.version) return;
  const t = today();
  const untouched = ev => !ev.steps.some(s => s.done);

  if (state.seedVersion < 2) {
    // v2: modelli costruiti sulle risposte di Josiah. Rigenero solo ciò che non è ancora stato toccato.
    state.templates = structuredClone(DEFAULT_TEMPLATES);
    state.plannedWeeks = {};
    state.events = state.events.filter(ev => !(ev.seedKey && ev.date >= t && untouched(ev)));
    state.studies = state.studies.filter(p => !(p.seedKey === 'seed:wright' && !p.chapters.some(c => c.sections.some(s => s.done))));
    for (const ev of state.events) {
      if (ev.date >= t && untouched(ev) && !ev.notMine) ev.steps = planSteps(ev.type, ev.date, ev.passage).map(stepFrom);
    }
  }

  for (const m of seed.giovanissimi) {
    const key = `seed:giov:${m.n}`;
    if (m.date < t || state.events.some(e => e.seedKey === key)) continue;
    const isStudy = m.questions.length > 0 && m.date > t;
    const notes = [
      ...(m.questions.length ? ['Domande per il gruppo (facoltative):', ...m.questions] : []),
      ...(m.links.length ? ['', 'Link:', ...m.links] : []),
    ].join('\n');
    const ev = createEvent({ type: 'giovanissimi', date: m.date, time: m.time, passage: m.passage, notes, title: m.title });
    ev.seedKey = key;
    if (isStudy) setMine(ev, false);
    else { ev.noPrep = true; ev.steps = []; } // benvenuto e feste: nessuna preparazione
  }

  if (!state.studies.some(p => p.seedKey === 'seed:wright')) {
    const start = parse(t).getDay() === 1 ? t : addDays(mondayOf(t), 7);
    const plan = {
      id: uid(), seedKey: 'seed:wright', kind: 'chapters',
      title: seed.wright.title, startDate: start, days: [1, 2, 3, 4, 5, 0],
      chapters: seed.wright.chapters.map(c => ({
        id: uid(), n: c.n, title: c.title, from: c.from, to: c.to, weeks: c.weeks,
        sections: [
          ...c.sections.map(s => ({ id: uid(), title: s.title, from: s.from, to: s.to, due: '', done: false })),
          { id: uid(), title: `📝 Esame del capitolo ${c.n}`, exam: true, due: '', done: false },
        ],
      })),
    };
    schedulePlan(plan, start);
    state.studies.push(plan);
  }
  state.seedVersion = seed.version;
}

/* ---------- Finestre (modali) ---------- */

const modal = document.getElementById('modal');
const modalBody = document.getElementById('modal-body');
let modalRefresh = null;

function openModal(html, onMount, refresh = null) {
  modalBody.innerHTML = html;
  modalRefresh = refresh;
  if (!modal.open) modal.showModal();
  if (onMount) onMount(modalBody.firstElementChild);
}

function closeModal() {
  modalRefresh = null;
  if (modal.open) modal.close();
}

modal.addEventListener('click', e => {
  if (e.target === modal || e.target.closest('[data-close]')) closeModal();
});
modal.addEventListener('close', () => { modalRefresh = null; stopFocus(); });

function typePicker(selected) {
  return `<div class="type-picker">${Object.entries(state.templates).map(([k, t]) => `
    <label class="type-opt" style="--c:${t.color}">
      <input type="radio" name="type" value="${k}" ${k === selected ? 'checked' : ''}>
      <span>${t.icon} ${esc(t.label)}</span>
    </label>`).join('')}</div>`;
}

function openEventForm(ev, presetDate) {
  const isNew = !ev;
  const date = ev ? ev.date : (presetDate || addDays(today(), 7));
  openModal(`
    <form class="form">
      <h2>${isNew ? 'Nuovo impegno' : 'Modifica impegno'}</h2>
      ${typePicker(ev ? ev.type : '')}
      <div class="field-row">
        <label class="field"><span>Data</span><input type="date" name="date" value="${date}" required></label>
        <label class="field"><span>Ora <small>(facoltativa)</small></span><input type="time" name="time" value="${ev ? esc(ev.time || '') : ''}"></label>
      </div>
      <label class="field"><span>Titolo <small>(facoltativo)</small></span>
        <input name="title" value="${ev ? esc(ev.title) : ''}" placeholder="es. Culto di domenica"></label>
      <label class="field"><span>Brano <small>(facoltativo)</small></span>
        <input name="passage" value="${ev ? esc(ev.passage || '') : ''}" placeholder="es. Romani 8:1-11"></label>
      ${isNew ? `<label class="field"><span>Note</span><textarea name="notes" rows="2"></textarea></label>
      <div class="preview" id="ev-preview"></div>` : ''}
      <div class="form-actions">
        <button type="button" data-close>Annulla</button>
        <button class="primary" type="submit">${isNew ? 'Crea impegno' : 'Salva'}</button>
      </div>
    </form>`, form => {
    const preview = form.querySelector('#ev-preview');
    const update = () => {
      if (!preview) return;
      const type = form.elements.type.value, d = form.elements.date.value;
      if (!d || !type) { preview.innerHTML = type ? '' : '<p class="muted">Scegli il tipo di impegno per vedere la tabella di marcia.</p>'; return; }
      const steps = planSteps(type, d, form.elements.passage.value);
      const squeezed = steps.filter(s => s.squeezed).length;
      preview.innerHTML = steps.length ? `
        <p class="preview-title">Tabella di marcia che verrà creata:</p>
        <ul>${steps.map(s => `<li><span class="muted">${fmtShort(s.due)} · ${WHEN[s.when]}</span> ${esc(s.label)}</li>`).join('')}</ul>
        ${squeezed ? `<p class="hint warn">⚠️ Hai meno tempo del solito: ${squeezed} ${squeezed === 1 ? 'passo è stato spostato' : 'passi sono stati spostati'} a oggi.</p>` : ''}`
        : '<p class="muted">Nessun passo di preparazione per questo tipo.</p>';
    };
    // Orario abituale del tipo scelto, finché non lo cambi a mano
    const timeInput = form.elements.time;
    timeInput.addEventListener('input', () => { timeInput.dataset.touched = '1'; });
    form.addEventListener('change', e => {
      if (e.target.name === 'type' && !timeInput.dataset.touched) timeInput.value = tpl(e.target.value).time || '';
    });
    form.addEventListener('input', update);
    update();
    form.addEventListener('submit', e => {
      e.preventDefault();
      const f = form.elements;
      const type = f.type.value, d = f.date.value, title = f.title.value.trim();
      if (!type) return toast('Scegli il tipo di impegno');
      if (isNew) {
        const created = createEvent({ type, date: d, title, notes: f.notes.value, time: f.time.value, passage: f.passage.value.trim() });
        rebalanceAll(); save(); render();
        toast('Impegno creato');
        openEventDetail(created.id);
      } else {
        const shift = diffDays(ev.date, d);
        if (shift) ev.steps.forEach(s => { s.due = addDays(s.due, shift); });
        if (title !== ev.title) ev.titleAuto = false;
        Object.assign(ev, { type, date: d, time: f.time.value, passage: f.passage.value.trim(), title: title || tpl(type).label });
        save(); render();
        openEventDetail(ev.id);
      }
    });
  });
}

function openEventDetail(id) {
  const ev = findEvent(id);
  if (!ev) return closeModal();
  const t = tpl(ev.type);
  const td = today();
  const defaultDue = ev.date < td ? ev.date : td;
  openModal(`
    <div class="detail" style="--c:${t.color}">
      <div class="detail-head">
        <span class="detail-icon">${t.icon}</span>
        <div class="grow">
          <p class="eyebrow">${esc(t.label)} · ${fmtLong(ev.date)}${ev.time ? ` · ore ${ev.time}` : ''} (${rel(ev.date)})</p>
          <h2>${esc(ev.title)}</h2>
          ${ev.passage && ev.passage !== ev.title ? `<p class="detail-passage">📖 ${esc(ev.passage)}</p>` : ''}
          ${ev.info ? `<p class="muted">${esc(ev.info)}</p>` : ''}
          ${ev.sheetMissing ? '<p class="ev-warn">⚠️ Questo impegno non risulta più nel foglio delle prediche: forse è stato spostato o riassegnato.</p>' : ''}
          ${ev.type === 'giovanissimi' && !ev.noPrep ? `<label class="mine-toggle"><input type="checkbox" data-mine ${ev.notMine ? '' : 'checked'}> Lo guido io (crea la tabella di marcia)</label>` : ''}
        </div>
        ${healthBadge(eventHealth(ev))}
      </div>

      <h3>Tabella di marcia</h3>
      ${ev.notMine ? '<p class="muted">Questo incontro lo guida un altro: nessuna preparazione da fare.</p>' : ev.steps.length ? `<ul class="tasks">${sortedSteps(ev).map(st => {
        const x = { kind: 'step', ev, item: st };
        return `
        <li class="task ${st.done ? 'is-done' : ''} ${!st.done && st.due < td ? 'is-late' : ''}">
          <label class="task-main">
            <input type="checkbox" data-action="toggle-task" ${taskRef(x)} ${st.done ? 'checked' : ''}>
            <span class="task-label">${esc(st.label)}</span>
          </label>
          <span class="task-meta">
            ${whenChip(x)}
            <input type="date" class="due-input" data-st="${st.id}" value="${st.due}" title="Giorno in cui farlo">
            <button class="icon-btn" data-del-step="${st.id}" title="Elimina passo">✕</button>
          </span>
        </li>`;
      }).join('')}</ul>` : '<p class="muted">Nessun passo.</p>'}
      <form class="inline-form add-step">
        <input name="label" placeholder="Aggiungi un passo…" required>
        <input type="date" name="due" value="${defaultDue}" required>
        <button>Aggiungi</button>
      </form>

      <h3>Appunti</h3>
      <textarea class="notes" rows="9" placeholder="Brano, schema, idee, riferimenti…">${esc(ev.notes)}</textarea>
      <p class="hint">Gli appunti si salvano da soli.</p>

      <div class="form-actions">
        <button class="danger-link" data-del-event>Elimina impegno</button>
        <span class="grow"></span>
        <button data-edit-event>Modifica</button>
        <button class="primary" data-close>Chiudi</button>
      </div>
    </div>`, root => {
    root.querySelector('.notes').addEventListener('input', e => { ev.notes = e.target.value; save(); });
    const mine = root.querySelector('[data-mine]');
    if (mine) mine.addEventListener('change', () => {
      if (!mine.checked && ev.steps.some(s => s.done) && !confirm('Togliere la tabella di marcia? I passi già fatti andranno persi.')) { mine.checked = true; return; }
      setMine(ev, mine.checked);
      rebalanceAll(); save(); render(); openEventDetail(ev.id);
    });
    root.querySelectorAll('.due-input').forEach(inp => inp.addEventListener('change', () => {
      const st = ev.steps.find(s => s.id === inp.dataset.st);
      if (st && inp.value) { st.due = inp.value; save(); render(); openEventDetail(ev.id); }
    }));
    root.querySelectorAll('[data-del-step]').forEach(b => b.addEventListener('click', () => {
      ev.steps = ev.steps.filter(s => s.id !== b.dataset.delStep);
      save(); render(); openEventDetail(ev.id);
    }));
    root.querySelector('.add-step').addEventListener('submit', e => {
      e.preventDefault();
      const f = e.target.elements;
      ev.steps.push({ id: uid(), label: f.label.value.trim(), due: f.due.value, done: false, when: '' });
      save(); render(); openEventDetail(ev.id);
    });
    root.querySelector('[data-del-event]').addEventListener('click', () => {
      const fromSheet = ev.sheetKey && !ev.sheetMissing
        ? '\n\nAttenzione: è nel foglio delle prediche, al prossimo aggiornamento verrà ricreato.' : '';
      if (!confirm(`Eliminare "${ev.title}" con tutti i suoi passi e appunti?${fromSheet}`)) return;
      state.events = state.events.filter(e => e.id !== ev.id);
      save(); render(); closeModal(); toast('Impegno eliminato');
    });
    root.querySelector('[data-edit-event]').addEventListener('click', () => openEventForm(ev));
  }, () => openEventDetail(id));
}

function openGiovChooser() {
  const t = today();
  const list = state.events.filter(e => e.type === 'giovanissimi' && e.seedKey && !e.noPrep && e.date >= t).sort(byDate);
  openModal(`
    <form class="form">
      <h2>Quali incontri guidi tu?</h2>
      <p class="muted">Spunta gli incontri che toccano a te: solo per quelli verrà creata la preparazione.
        Gli altri restano in calendario come promemoria. Puoi cambiare idea quando vuoi dal dettaglio di ogni incontro.</p>
      <ul class="pick-list">${list.map((ev, i) => `
        <li><label><input type="checkbox" name="pick" value="${ev.id}" data-i="${i}" ${ev.notMine ? '' : 'checked'}>
          <span class="muted">${fmtShort(ev.date)}</span> ${esc(ev.title)} <span class="muted">· ${esc(ev.passage)}</span></label></li>`).join('')}
      </ul>
      <button type="button" class="link" id="alternate">↔ Uno sì e uno no, a partire dal primo spuntato</button>
      <div class="form-actions">
        <button type="button" data-close>Annulla</button>
        <button class="primary" type="submit">Salva</button>
      </div>
    </form>`, form => {
    const boxes = [...form.querySelectorAll('[name=pick]')];
    form.querySelector('#alternate').addEventListener('click', () => {
      const first = boxes.findIndex(b => b.checked);
      if (first < 0) return toast('Spunta prima il tuo primo incontro');
      boxes.forEach((b, i) => { b.checked = i >= first && (i - first) % 2 === 0; });
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      let n = 0;
      boxes.forEach(b => {
        const ev = findEvent(b.value);
        if (!b.checked && ev.steps.some(s => s.done)) return;
        setMine(ev, b.checked);
        if (b.checked) n++;
      });
      state.settings.giovChosen = true;
      rebalanceAll(); save(); render(); closeModal();
      toast(`Fatto: guidi ${plural(n, 'incontro', 'incontri')}`);
    });
  });
}

let focusTimer = null;

function beep() {
  try {
    const ctx = new AudioContext();
    [0, 0.35, 0.7].forEach(delay => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.connect(g); g.connect(ctx.destination);
      o.frequency.value = 880; g.gain.value = 0.12;
      o.start(ctx.currentTime + delay); o.stop(ctx.currentTime + delay + 0.2);
    });
  } catch (e) { /* audio non disponibile */ }
}

function stopFocus() {
  clearInterval(focusTimer);
  focusTimer = null;
  document.title = 'Agenda del servizio';
}

function openFocus(x, minutes) {
  const end = Date.now() + minutes * 60000;
  const label = x.kind === 'step' ? x.item.label : x.item.title;
  const context = x.kind === 'step'
    ? `${tpl(x.ev.type).icon} ${x.ev.title}`
    : `📖 Cap. ${x.ch.n} · ${x.ch.title} ${sectionPages(x.item)}`;
  openModal(`
    <div class="focus">
      <p class="eyebrow">Concentrazione · ${minutes} minuti</p>
      <h2>${esc(label)}</h2>
      <p class="muted">${esc(context)}</p>
      <div class="focus-time" id="focus-time">${minutes}:00</div>
      <p class="hint">Telefono lontano, TV spenta. Quando suona puoi fermarti, oppure continuare se sei in ritmo.</p>
      <div class="form-actions">
        <button data-close>Interrompi</button>
        <button class="primary" id="focus-done">✓ Fatto</button>
      </div>
    </div>`, root => {
    const el = root.querySelector('#focus-time');
    stopFocus();
    const tick = () => {
      const left = Math.max(0, end - Date.now());
      const m = Math.floor(left / 60000), sec = Math.floor(left / 1000) % 60;
      el.textContent = `${m}:${pad(sec)}`;
      document.title = `${m}:${pad(sec)} · ${label}`;
      if (!left) {
        stopFocus();
        el.textContent = 'Tempo! 🎉';
        el.classList.add('over');
        beep();
        state.sessions = [...state.sessions, { at: new Date().toISOString(), minutes }].slice(-300);
        save();
      }
    };
    tick();
    focusTimer = setInterval(tick, 1000);
    root.querySelector('#focus-done').addEventListener('click', () => {
      setDone(x.item, true);
      save(); closeModal(); render();
      toast('Fatto! Un passo in meno 💪');
    });
  });
}

/* Inserimento rapido: una riga per impegno, es. "20/10 predica" */

function detectType(s) {
  const l = s.toLowerCase();
  if (/predic|sermon/.test(l)) return 'predica';
  if (/presiede|presiden|conduzion/.test(l)) return 'presidenza';
  if (/giovan|ragazz|adolesc/.test(l)) return 'giovanissimi';
  if (/chiesa|casa|cellul/.test(l)) return 'chiesa';
  return 'altro';
}

function parseQuick(text) {
  const t = today();
  return text.split('\n').map(l => l.trim()).filter(Boolean).map(line => {
    const m = line.match(/^(\d{1,2})[\/.\-](\d{1,2})(?:[\/.\-](\d{2,4}))?\s*(.*)$/);
    if (!m) return { line, error: 'Data non riconosciuta (usa giorno/mese)' };
    const dd = +m[1], mm = +m[2];
    const y = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : new Date().getFullYear();
    let date = iso(new Date(y, mm - 1, dd));
    if (parse(date).getDate() !== dd || mm < 1 || mm > 12) return { line, error: 'Data non valida' };
    if (!m[3] && date < addDays(t, -30)) date = iso(new Date(y + 1, mm - 1, dd));
    const rest = m[4].trim();
    const type = detectType(rest);
    const title = rest ? cap(rest) : tpl(type).label;
    const dup = state.events.some(e => e.date === date && e.type === type);
    return { line, date, type, title, dup };
  });
}

function openQuickAdd() {
  openModal(`
    <form class="form">
      <h2>Inserimento rapido</h2>
      <p class="muted">Un impegno per riga: <strong>giorno/mese</strong> seguito dal tipo.
        Il tipo viene riconosciuto dalle parole (predica, presidenza, giovanissimi, chiesa in casa).</p>
      <textarea name="text" rows="8" placeholder="23/10 chiesa in casa da Marco e Anna&#10;6/11 chiesa in casa"></textarea>
      <div class="preview" id="qa-preview"></div>
      <div class="form-actions">
        <button type="button" data-close>Annulla</button>
        <button class="primary" type="submit" id="qa-submit" disabled>Aggiungi</button>
      </div>
    </form>`, form => {
    const preview = form.querySelector('#qa-preview');
    const btn = form.querySelector('#qa-submit');
    let rows = [];
    form.elements.text.addEventListener('input', () => {
      rows = parseQuick(form.elements.text.value);
      const ok = rows.filter(r => !r.error && !r.dup);
      preview.innerHTML = rows.length ? `<ul class="qa-list">${rows.map(r => r.error
        ? `<li class="err">✕ ${esc(r.line)} — ${r.error}</li>`
        : `<li class="${r.dup ? 'dup' : ''}">${tpl(r.type).icon} <strong>${fmtShort(r.date)}</strong> · ${esc(r.title)}
            <span class="muted">(${esc(tpl(r.type).label)})</span>${r.dup ? ' — <em>già presente, verrà saltato</em>' : ''}</li>`).join('')}</ul>` : '';
      btn.disabled = !ok.length;
      btn.textContent = ok.length ? `Aggiungi ${plural(ok.length, 'impegno', 'impegni')}` : 'Aggiungi';
    });
    form.addEventListener('submit', e => {
      e.preventDefault();
      const ok = rows.filter(r => !r.error && !r.dup);
      ok.forEach(r => createEvent(r));
      save(); render(); closeModal();
      toast(`${plural(ok.length, 'impegno aggiunto', 'impegni aggiunti')}`);
    });
  });
}

function openStudyForm(p) {
  const isNew = !p;
  const t = today();
  const kind = p ? p.kind : 'chapters';
  const nextMon = parse(t).getDay() === 1 ? t : addDays(mondayOf(t), 7);
  const d = p || { title: '', unit: 'pagine', total: '', initial: 0, startDate: nextMon, endDate: addDays(t, 60), days: [1, 2, 3, 4, 5] };
  openModal(`
    <form class="form" data-kind="${kind}">
      <h2>${isNew ? 'Nuovo piano di studio' : 'Modifica piano di studio'}</h2>
      ${isNew ? `<div class="type-picker">
        <label class="type-opt" style="--c:${STUDY_COLOR}"><input type="radio" name="kind" value="chapters" checked><span>📚 Un capitolo a settimana</span></label>
        <label class="type-opt" style="--c:${STUDY_COLOR}"><input type="radio" name="kind" value="pages"><span>📄 Pagine entro una data</span></label>
      </div>` : ''}
      <label class="field"><span>Cosa vuoi studiare</span>
        <input name="title" value="${esc(d.title)}" placeholder="es. Teologia sistematica — W. Grudem" required></label>

      <div class="only-chapters">
        ${isNew ? `<label class="field"><span>Capitoli <small>(uno per riga)</small></span>
          <textarea name="chapters" rows="6" placeholder="Introduzione&#10;La rivelazione&#10;La Scrittura"></textarea></label>
          <label class="field"><span>Inizio</span><input type="date" name="chStart" value="${nextMon}"></label>`
        : `<p class="muted">Salvando, le letture non ancora fatte vengono ridistribuite da oggi in poi.</p>`}
      </div>

      <div class="only-pages">
        <div class="field-row">
          <label class="field"><span>Misura</span>
            <select name="unit">${Object.keys(UNITS).map(u => `<option value="${u}" ${u === d.unit ? 'selected' : ''}>${cap(u)}</option>`).join('')}</select></label>
          <label class="field"><span>Totale</span><input type="number" name="total" min="1" value="${d.total ?? ''}" placeholder="es. 320"></label>
          <label class="field"><span>${isNew ? 'Già fatto' : 'Punto di partenza'}</span><input type="number" name="initial" min="0" value="${d.initial || 0}"></label>
        </div>
        <div class="field-row">
          <label class="field"><span>Inizio</span><input type="date" name="startDate" value="${d.startDate}"></label>
          <label class="field"><span>Da finire entro</span><input type="date" name="endDate" value="${d.endDate || ''}"></label>
          <label class="field"><span>…oppure ritmo per sessione</span><input type="number" name="pace" min="1" placeholder="es. 10"></label>
        </div>
      </div>

      <div class="field"><span>Giorni di studio</span>
        <div class="days">${DOW_ORDER.map(n => `
          <label class="day-opt"><input type="checkbox" name="days" value="${n}" ${d.days.includes(n) ? 'checked' : ''}><span>${DOW[n]}</span></label>`).join('')}</div>
      </div>
      <div class="preview" id="st-preview"></div>
      <div class="form-actions">
        <button type="button" data-close>Annulla</button>
        <button class="primary" type="submit">${isNew ? 'Crea piano' : 'Salva'}</button>
      </div>
    </form>`, form => {
    const f = form.elements;
    const preview = form.querySelector('#st-preview');
    const currentKind = () => isNew ? f.kind.value : kind;
    const days = () => [...form.querySelectorAll('[name=days]:checked')].map(i => +i.value);
    const chapterLines = () => (f.chapters ? f.chapters.value : '').split('\n').map(s => s.trim()).filter(Boolean);
    const readPages = () => ({
      total: +f.total.value, initial: +f.initial.value || 0, unit: f.unit.value,
      startDate: f.startDate.value, endDate: f.endDate.value, days: days(),
    });
    const remainingFrom = v => isNew ? v.total - v.initial : v.total - Math.max(p.current, v.initial);

    const update = e => {
      form.dataset.kind = currentKind();
      if (!days().length) { preview.innerHTML = '<p class="hint warn">Scegli almeno un giorno di studio.</p>'; return; }
      if (currentKind() === 'chapters') {
        const n = isNew ? chapterLines().length : p.chapters.length;
        if (!n) { preview.innerHTML = ''; return; }
        const weeks = isNew ? n : p.chapters.filter(c => c.sections.some(s => !s.done)).reduce((a, c) => a + (c.weeks || 1), 0);
        const start = isNew ? (f.chStart.value || nextMon) : t;
        const end = addDays(mondayOf(start), weeks * 7 - 1);
        preview.innerHTML = `<p>${plural(n, 'capitolo', 'capitoli')} → circa <strong>${plural(weeks, 'settimana', 'settimane')}</strong>, fine prevista intorno al ${fmtDM(end)}.</p>`;
        return;
      }
      const v = readPages();
      const from = v.startDate > t ? v.startDate : t;
      if (e && e.target.name === 'pace' && +f.pace.value > 0 && v.total) {
        const end = endDateForPace(from, v.days, remainingFrom(v), +f.pace.value);
        if (end) f.endDate.value = end;
        v.endDate = f.endDate.value;
      } else if (e && e.target.name !== 'pace') {
        f.pace.value = '';
      }
      if (!v.total || !v.startDate || !v.endDate) { preview.innerHTML = ''; return; }
      const rem = remainingFrom(v);
      const n = countStudyDays(v.days, from, v.endDate);
      if (rem <= 0) { preview.innerHTML = '<p class="muted">Niente da studiare: il totale è già raggiunto.</p>'; return; }
      if (!n) { preview.innerHTML = '<p class="hint warn">Non ci sono giorni di studio prima della scadenza.</p>'; return; }
      const per = Math.ceil(rem / n);
      preview.innerHTML = `<p>≈ <strong>${qty(per, v.unit)}</strong> per sessione, su ${plural(n, 'sessione', 'sessioni')} di studio
        (fino a ${fmtLong(v.endDate)}).</p>
        ${per > 30 && v.unit === 'pagine' ? '<p class="hint warn">È un ritmo impegnativo: valuta una scadenza più lontana, così non molli dopo una settimana.</p>' : ''}`;
    };
    form.addEventListener('input', update);
    update();

    form.addEventListener('submit', e => {
      e.preventDefault();
      const title = f.title.value.trim();
      const dd = days();
      if (!dd.length) return toast('Scegli almeno un giorno di studio');

      if (currentKind() === 'chapters') {
        if (isNew) {
          const lines = chapterLines();
          if (!lines.length) return toast('Scrivi almeno un capitolo');
          const start = f.chStart.value || nextMon;
          const plan = {
            id: uid(), kind: 'chapters', title, startDate: start, days: dd,
            chapters: lines.map((l, i) => ({ id: uid(), n: i + 1, title: l, weeks: 1,
              sections: [{ id: uid(), title: 'Leggere il capitolo', due: '', done: false, when: '' }] })),
          };
          schedulePlan(plan, start > t ? start : t);
          state.studies.push(plan);
        } else {
          p.title = title;
          p.days = dd;
          schedulePlan(p, p.startDate > t ? p.startDate : t);
        }
      } else {
        const v = readPages();
        if (!v.total) return toast('Indica il totale');
        if (!v.startDate || !v.endDate) return toast('Indica inizio e scadenza');
        if (v.endDate < v.startDate) return toast('La scadenza è prima dell\'inizio');
        if (v.initial >= v.total) return toast('Il punto di partenza deve essere minore del totale');
        if (isNew) {
          state.studies.push({ id: uid(), kind: 'pages', title, ...v, current: v.initial, log: {} });
        } else {
          Object.assign(p, { title, ...v });
          if (p.current < p.initial) p.current = p.initial;
        }
      }
      save(); render(); closeModal();
      toast(isNew ? 'Piano di studio creato' : 'Piano aggiornato');
    });
  });
}

/* ---------- Backup ---------- */

function exportData() {
  state.lastBackup = today();
  save();
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `agenda-backup-${today()}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  render();
  toast('Backup scaricato');
}

function importData(file) {
  if (!file) return;
  file.text().then(text => {
    const data = JSON.parse(text);
    if (!Array.isArray(data.events)) throw new Error('formato');
    if (!confirm('Sostituire tutti i dati attuali con quelli del backup?')) return;
    state = normalize(data);
    migrate(); rebalanceAll();
    save(); render(); toast('Dati ripristinati');
  }).catch(() => alert('Il file non sembra un backup valido.'));
}

/* ---------- Modelli ---------- */

function saveTemplates() {
  document.querySelectorAll('.tpl-card').forEach(card => {
    const steps = [...card.querySelectorAll('.tpl-row')]
      .map(r => ({
        label: r.querySelector('.tpl-label').value.trim(),
        offset: Math.max(0, +r.querySelector('.tpl-offset').value || 0),
        when: r.querySelector('.tpl-when').value,
        heavy: r.querySelector('.tpl-heavy-cb').checked,
        ...(r.dataset.iffree ? { ifFree: true } : {}),
        ...(r.dataset.ifmissing ? { ifMissing: true } : {}),
      }))
      .filter(s => s.label)
      .sort((a, b) => b.offset - a.offset);
    state.templates[card.dataset.type].steps = steps;
  });
  save(); render(); toast('Modelli salvati');
}

/* ---------- Eventi globali ---------- */

document.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const id = el.dataset.id;
  switch (el.dataset.action) {
    case 'nav': view = el.dataset.view; closeModal(); render(); window.scrollTo(0, 0); break;
    case 'new-event': openEventForm(null); break;
    case 'new-on-date': openEventForm(null, el.dataset.date); break;
    case 'quick-add': openQuickAdd(); break;
    case 'open-event': openEventDetail(el.dataset.ev); break;
    case 'week-prev': weekOffset--; render(); break;
    case 'week-next': weekOffset++; render(); break;
    case 'week-today': weekOffset = 0; render(); break;
    case 'week-planned':
      state.plannedWeeks[el.dataset.week] = true;
      save(); render(); toast('Settimana pianificata. Ora un passo alla volta 💪');
      break;
    case 'giov-choose': openGiovChooser(); break;
    case 'cloud-disconnect': cloudDisconnect(); break;
    case 'cloud-share':
      openCloudShare().catch(err => alert(`Non riesco a creare il codice: ${err.message}.`));
      break;
    case 'toggle-theme': {
      const theme = currentTheme() === 'dark' ? 'light' : 'dark';
      localStorage.setItem(THEME_KEY, theme);
      setTheme(theme);
      break;
    }
    case 'focus-start': {
      const x = taskFromRef(el);
      if (x) openFocus(x, +(el.dataset.min || 25));
      break;
    }
    case 'quick-done': {
      const x = taskFromRef(el);
      if (x) { setDone(x.item, true); save(); render(); toast('Fatto! Avanti col prossimo 💪'); }
      break;
    }
    case 'cycle-when': {
      const it = taskFromEl(el);
      if (it) {
        it.whenSet = true;
        it.when = WHEN_CYCLE[(WHEN_CYCLE.indexOf(it.when || '') + 1) % WHEN_CYCLE.length];
        save(); render();
        if (modalRefresh) modalRefresh();
      }
      break;
    }
    case 'sync': syncSheet(); break;
    case 'cal-prev': calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() - 1, 1); render(); break;
    case 'cal-next': calCursor = new Date(calCursor.getFullYear(), calCursor.getMonth() + 1, 1); render(); break;
    case 'cal-today': { const d = new Date(); calCursor = new Date(d.getFullYear(), d.getMonth(), 1); render(); break; }
    case 'new-study': openStudyForm(null); break;
    case 'edit-study': openStudyForm(findStudy(id)); break;
    case 'delete-study': {
      const p = findStudy(id);
      if (p && confirm(`Eliminare il piano "${p.title}"?`)) {
        state.studies = state.studies.filter(s => s.id !== id);
        save(); render();
      }
      break;
    }
    case 'replan': {
      const p = findStudy(id);
      if (p) {
        schedulePlan(p, today());
        save(); render();
        toast(`Piano ripianificato: nuova fine ${fmtDM(chapterStatus(p).end)}`);
      }
      break;
    }
    case 'study-done-today': {
      const p = findStudy(id);
      if (p) { setStudyProgress(p, studyStatus(p).target); render(); toast('Parte di oggi completata 💪'); }
      break;
    }
    case 'export': exportData(); break;
    case 'import': document.getElementById('import-file').click(); break;
    case 'tpl-add-step': el.previousElementSibling.insertAdjacentHTML('beforeend', tplRow()); break;
    case 'tpl-remove-step': el.closest('.tpl-row').remove(); break;
    case 'tpl-save': saveTemplates(); break;
    case 'tpl-reset':
      if (confirm('Ripristinare i modelli predefiniti?')) {
        state.templates = structuredClone(DEFAULT_TEMPLATES);
        save(); render(); toast('Modelli ripristinati');
      }
      break;
  }
});

document.addEventListener('change', e => {
  const el = e.target;
  if (el.matches('[data-action="toggle-task"]')) {
    const it = taskFromEl(el);
    if (!it) return;
    setDone(it, el.checked);
    save(); render();
    if (modalRefresh) modalRefresh();
    if (it.done && el.dataset.kind === 'step') {
      const ev = findEvent(el.dataset.ev);
      if (ev.steps.every(s => s.done)) toast(`${ev.title}: tutto pronto! 🎉`);
    }
  } else if (el.matches('[data-action="toggle-pageplan"]')) {
    const p = findStudy(el.dataset.id);
    if (!p) return;
    setStudyProgress(p, el.checked ? studyStatus(p).target : progressBefore(p, today()));
    render();
  } else if (el.id === 'import-file') {
    importData(el.files[0]);
    el.value = '';
  }
});

document.addEventListener('submit', e => {
  const f = e.target;
  if (f.matches('[data-progress-form]')) {
    e.preventDefault();
    const p = findStudy(f.dataset.progressForm);
    if (!p) return;
    setStudyProgress(p, +f.elements.value.value);
    render();
    toast(p.current >= p.total ? `Hai finito "${p.title}"! 🎉` : 'Progresso aggiornato');
  } else if (f.id === 'cloud-form') {
    e.preventDefault();
    cloudConnect(f.elements.token.value, f.elements.repo.value);
  } else if (f.id === 'sheet-form') {
    e.preventDefault();
    state.settings.myName = f.elements.myName.value.trim();
    state.settings.sheetUrl = f.elements.sheetUrl.value.trim();
    save();
    syncSheet();
  }
});

// Se l'app resta aperta da un giorno all'altro, si aggiorna quando torni sulla finestra.
window.addEventListener('focus', () => {
  if (!modal.open) render();
  cloudRefresh();
});

/* ---------- Avvio ---------- */

async function boot() {
  const linked = takeLinkFromUrl();
  state = loadLocal();
  if (location.protocol.startsWith('http')) {
    try {
      const r = await fetch('/api/data');
      serverMode = r.ok;
      if (r.status === 200) state = normalize(await r.json());
    } catch (e) {
      console.warn('Server non raggiungibile, uso solo il browser', e);
    }
  }
  lastSnap = snapshotOf(state);
  await cloudRefresh({ initial: true });
  applySeed();
  migrate();
  rebalanceAll();
  save();
  render();
  if (linked && !cloud.cfg) await cloudConnect(linked.token, linked.repo);
  syncSheet({ silent: true });
}

boot();
