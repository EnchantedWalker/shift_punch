// Shift Punch: time clock, timesheet and groups, backed by Firebase Auth + Firestore.
import { firebaseConfig } from "./firebase-config.js";

const FB = "https://www.gstatic.com/firebasejs/10.12.2/";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

if (!firebaseConfig || !firebaseConfig.apiKey) {
  $("view-setup").hidden = false;
  throw new Error("Shift Punch: firebase-config.js is not filled in yet.");
}

const { initializeApp } = await import(FB + "firebase-app.js");
const A = await import(FB + "firebase-auth.js");
const F = await import(FB + "firebase-firestore.js");

const fbApp = initializeApp(firebaseConfig);
const auth = A.getAuth(fbApp);
let db;
try { db = F.initializeFirestore(fbApp, { localCache: F.persistentLocalCache({ tabManager: F.persistentMultipleTabManager() }) }); }
catch (e) { db = F.getFirestore(fbApp); }

// Local testing against the Firebase emulators: open the page with ?emu
if (["localhost", "127.0.0.1"].includes(location.hostname) && new URLSearchParams(location.search).has("emu")) {
  A.connectAuthEmulator(auth, "http://127.0.0.1:9099", { disableWarnings: true });
  F.connectFirestoreEmulator(db, "127.0.0.1", 8080);
}

// ---------------------------------------------------------------- helpers
const TYPES = {
  in:        { name: "Clock in",   color: "var(--work)" },
  mealStart: { name: "Meal start", color: "var(--meal)" },
  mealEnd:   { name: "Meal end",   color: "var(--meal)" },
  out:       { name: "Clock out",  color: "var(--stop)" },
};
const DEFAULT_RATE = 15;
const pad = (n) => String(n).padStart(2, "0");
const keyOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dateOfKey = (k) => { const [y, m, d] = k.split("-").map(Number); return new Date(y, m - 1, d); };
const fmtTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
const hm = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return `${Math.floor(m / 60)}:${pad(m % 60)}`; };
const hrs = (ms) => ms / 3600000;
const money = (n) => "$" + n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const weekStart = (d) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - x.getDay()); return x; };
const shortDate = (k) => { const d = dateOfKey(k); return `${d.toLocaleDateString([], { weekday: "short" })} ${d.getMonth() + 1}/${d.getDate()}`; };
const longDate = (k) => dateOfKey(k).toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
const cleanEmail = (s) => String(s || "").trim().toLowerCase();
const validEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s);
const numRate = (v) => { const n = Number(v); return isFinite(n) && n >= 0 ? n : DEFAULT_RATE; };

export function summarize(events, now) {
  const ev = [...(events || [])].sort((a, b) => a.at - b.at);
  let work = 0, meal = 0, ws = null, ms = null, first = null, last = null;
  for (const e of ev) {
    if (e.t === "in") { if (ws == null && ms == null) ws = e.at; if (first == null) first = e.at; }
    else if (e.t === "mealStart") { if (ws != null) { work += e.at - ws; ws = null; } if (ms == null) ms = e.at; }
    else if (e.t === "mealEnd") { if (ms != null) { meal += e.at - ms; ms = null; } if (ws == null) ws = e.at; }
    else if (e.t === "out") { if (ws != null) { work += e.at - ws; ws = null; } if (ms != null) { meal += e.at - ms; ms = null; } last = e.at; }
  }
  const status = ms != null ? "meal" : ws != null ? "in" : "out";
  if (now) { if (ws != null) work += now - ws; if (ms != null) meal += now - ms; }
  return { work, meal, first, last, status, sorted: ev };
}

// ---------------------------------------------------------------- state
let me = null;                       // Firebase user
let profile = { name: "", rate: DEFAULT_RATE, openDay: null, leaders: {} };
let days = {};                       // my days: { key: { events } }
let myMemberships = [];              // invites to me / groups I joined
let ledGroups = [];                  // groups I lead
let ledMemberships = [];             // everyone in groups I lead
const memberDays = {};               // uid -> days (members of my groups)
const memberSubs = {};               // uid -> unsubscribe
let subs = [];
let period = "week";
let view = "clock";
let groupNav = { gid: null, mid: null };

const rate = () => numRate(profile.rate);
const userRef = () => F.doc(db, "users", me.uid);
const dayRef = (k) => F.doc(db, "users", me.uid, "days", k);
const report = (msg) => (e) => { console.error(e); toast(msg, false); };

// ---------------------------------------------------------------- auth UI
let authMode = "signin";
function setAuthMode(m) {
  authMode = m;
  $("f-name").hidden = m !== "signup";
  $("f-pass").hidden = m === "reset";
  $("a-pass").autocomplete = m === "signup" ? "new-password" : "current-password";
  $("auth-title").textContent = { signin: "Sign in", signup: "Create your account", reset: "Reset your password" }[m];
  $("auth-submit").textContent = { signin: "Sign in", signup: "Create account", reset: "Email me a reset link" }[m];
  $("auth-switch").textContent = m === "signin" ? "New here? Create an account" : "Have an account? Sign in";
  $("auth-forgot").hidden = m !== "signin";
  $("auth-err").textContent = ""; $("auth-ok").textContent = "";
}
$("auth-switch").onclick = () => setAuthMode(authMode === "signin" ? "signup" : "signin");
$("auth-forgot").onclick = () => setAuthMode("reset");

const AUTH_ERRORS = {
  "auth/invalid-email": "That email address doesn't look right.",
  "auth/missing-password": "Enter your password.",
  "auth/invalid-credential": "Email or password is wrong.",
  "auth/wrong-password": "Email or password is wrong.",
  "auth/user-not-found": "No account uses that email. Create one instead.",
  "auth/email-already-in-use": "An account already uses that email. Sign in instead.",
  "auth/weak-password": "Use a password with at least 6 characters.",
  "auth/too-many-requests": "Too many tries. Wait a few minutes and try again.",
  "auth/network-request-failed": "Can't reach the internet. Check your connection.",
};
$("auth-form").onsubmit = async (e) => {
  e.preventDefault();
  const email = cleanEmail($("a-email").value), pass = $("a-pass").value, name = $("a-name").value.trim();
  $("auth-err").textContent = ""; $("auth-ok").textContent = "";
  if (authMode === "signup" && !name) { $("auth-err").textContent = "Enter your name so group leaders know who you are."; return; }
  $("auth-submit").disabled = true;
  try {
    if (authMode === "signin") await A.signInWithEmailAndPassword(auth, email, pass);
    else if (authMode === "signup") {
      const cred = await A.createUserWithEmailAndPassword(auth, email, pass);
      await A.updateProfile(cred.user, { displayName: name });
      await F.setDoc(F.doc(db, "users", cred.user.uid), { name, email, rate: DEFAULT_RATE, openDay: null, leaders: {} }, { merge: true });
      A.sendEmailVerification(cred.user).catch(() => {});
    } else {
      await A.sendPasswordResetEmail(auth, email);
      $("auth-ok").textContent = "Check your email for a link to reset your password.";
    }
  } catch (err) {
    $("auth-err").textContent = AUTH_ERRORS[err.code] || "Something went wrong. Try again.";
  } finally { $("auth-submit").disabled = false; }
};

// ---------------------------------------------------------------- data wiring
A.onAuthStateChanged(auth, (u) => {
  subs.forEach((f) => f()); subs = [];
  Object.keys(memberSubs).forEach((k) => { memberSubs[k](); delete memberSubs[k]; delete memberDays[k]; });
  me = u;
  $("view-auth").hidden = !!u;
  $("view-app").hidden = !u;
  $("tabs").hidden = !u;
  if (!u) { setAuthMode("signin"); return; }
  days = {}; myMemberships = []; ledGroups = []; ledMemberships = [];
  profile = { name: u.displayName || "", rate: DEFAULT_RATE, openDay: null, leaders: {} };
  $("who").textContent = u.displayName || u.email;
  const email = cleanEmail(u.email);

  subs.push(F.onSnapshot(userRef(), (s) => {
    const v = s.data() || {};
    profile = { name: v.name || u.displayName || "", rate: numRate(v.rate ?? DEFAULT_RATE), openDay: v.openDay || null, leaders: v.leaders || {} };
    if (document.activeElement !== $("rate")) $("rate").value = rate();
    render();
  }, report("Couldn't load your settings.")));

  subs.push(F.onSnapshot(F.collection(db, "users", u.uid, "days"), (s) => {
    days = {}; s.forEach((d) => { const v = d.data(); if (Array.isArray(v.events)) days[d.id] = { events: v.events }; });
    render();
  }, report("Couldn't load your punches.")));

  subs.push(F.onSnapshot(F.query(F.collection(db, "memberships"), F.where("email", "==", email)), (s) => {
    myMemberships = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderGroup();
  }, report("Couldn't load your group invites.")));

  subs.push(F.onSnapshot(F.query(F.collection(db, "groups"), F.where("leaderUid", "==", u.uid)), (s) => {
    ledGroups = s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    renderGroup();
  }, report("Couldn't load your groups.")));

  subs.push(F.onSnapshot(F.query(F.collection(db, "memberships"), F.where("leaderUid", "==", u.uid)), (s) => {
    ledMemberships = s.docs.map((d) => ({ id: d.id, ...d.data() }));
    syncMemberSubs();
    renderGroup();
  }, report("Couldn't load your group members.")));

  show(view);
});

// Keep one live listener per joined member of a group I lead.
function syncMemberSubs() {
  const want = new Set(ledMemberships.filter((m) => m.status === "joined" && m.uid).map((m) => m.uid));
  for (const uid of Object.keys(memberSubs)) if (!want.has(uid)) { memberSubs[uid](); delete memberSubs[uid]; delete memberDays[uid]; }
  for (const uid of want) {
    if (memberSubs[uid]) continue;
    memberDays[uid] = null; // loading
    memberSubs[uid] = F.onSnapshot(F.collection(db, "users", uid, "days"), (s) => {
      const d = {}; s.forEach((x) => { const v = x.data(); if (Array.isArray(v.events)) d[x.id] = { events: v.events }; });
      memberDays[uid] = d; renderGroup();
    }, () => { memberDays[uid] = "denied"; renderGroup(); });
  }
}

// ---------------------------------------------------------------- punching
function currentStatus() {
  const k = profile.openDay;
  if (!k || !days[k]) return { status: "out", day: null };
  const s = summarize(days[k].events);
  const lastEv = s.sorted[s.sorted.length - 1];
  return { status: s.status, day: k, since: lastEv ? lastEv.at : null };
}

function writeDay(k, events) {
  const p = events && events.length ? F.setDoc(dayRef(k), { events }) : F.deleteDoc(dayRef(k));
  p.catch(report("Couldn't save that punch. Try again."));
}
function writeOpenDay(k) { F.setDoc(userRef(), { openDay: k || null }, { merge: true }).catch(report("Couldn't save your shift status.")); }

let undoSnap = null;
function punch(t) {
  const now = Date.now();
  let k = t === "in" ? keyOf(new Date(now)) : currentStatus().day;
  if (!k) return;
  const before = days[k] ? [...days[k].events] : [];
  undoSnap = { k, events: before, openDay: profile.openDay };
  const events = [...before, { t, at: now }];
  days[k] = { events };
  const open = t === "out" ? null : k;
  profile.openDay = open;
  writeDay(k, events); writeOpenDay(open);
  render();
  toast(`${TYPES[t].name} at ${fmtTime(now)}`, true);
}
function undo() {
  if (!undoSnap) return;
  const { k, events, openDay } = undoSnap; undoSnap = null;
  if (events.length) days[k] = { events }; else delete days[k];
  profile.openDay = openDay;
  writeDay(k, events); writeOpenDay(openDay);
  render(); toast("Punch undone", false);
}

// ---------------------------------------------------------------- toast
let toastTimer;
function toast(msg, withUndo) {
  clearTimeout(toastTimer);
  const root = $("toast-root"); root.innerHTML = "";
  const el = document.createElement("div"); el.className = "toast"; el.setAttribute("role", "status");
  const span = document.createElement("span"); span.textContent = msg; el.appendChild(span);
  if (withUndo) { const b = document.createElement("button"); b.textContent = "Undo"; b.onclick = undo; el.appendChild(b); }
  root.appendChild(el);
  toastTimer = setTimeout(() => { root.innerHTML = ""; }, 5000);
}

// ---------------------------------------------------------------- clock view
let lastStatus = null, lastLogSig = "";
function renderPunches(status) {
  const p = $("punches");
  const btn = (cls, t, label, sub) => `<button class="punch ${cls}" data-t="${t}">${label}<span>${sub}</span></button>`;
  if (status === "out") p.innerHTML = btn("p-in", "in", "Clock in", "Start your shift");
  else if (status === "in") p.innerHTML = btn("p-meal", "mealStart", "Start meal", "Go on break") + btn("p-out", "out", "Clock out", "End your shift");
  else p.innerHTML = btn("p-meal wide", "mealEnd", "End meal", "Back to work") + btn("p-out wide", "out", "Clock out", "Ends meal and shift");
  p.querySelectorAll("button").forEach((b) => (b.onclick = () => punch(b.dataset.t)));
}
function renderClock() {
  if (!me) return;
  const now = new Date();
  const t = now.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const m = t.match(/^(.*?)\s?([AaPp]\.?[Mm]\.?)$/);
  $("now").innerHTML = m ? `${esc(m[1])}<small>${esc(m[2].toUpperCase())}</small>` : esc(t);
  $("date").textContent = now.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  const cur = currentStatus();
  $("chip").className = "chip " + cur.status;
  $("chip").textContent = cur.status === "in" ? "On the clock" : cur.status === "meal" ? "On meal break" : "Off the clock";
  $("since").textContent = cur.status !== "out" && cur.since ? `since ${fmtTime(cur.since)} · ${hm(now - cur.since)}` : "";
  if (cur.status !== lastStatus) { renderPunches(cur.status); lastStatus = cur.status; }
  const k = cur.day || keyOf(now);
  $("today-label").textContent = cur.day && cur.day !== keyOf(now) ? `Shift started ${dateOfKey(cur.day).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" })}` : "Today";
  const s = summarize(days[k] && days[k].events, cur.day ? now.getTime() : null);
  $("s-work").textContent = hm(s.work);
  $("s-meal").textContent = hm(s.meal);
  $("s-pay").textContent = money(hrs(s.work) * rate());
  const sig = k + JSON.stringify(s.sorted);
  if (sig !== lastLogSig) {
    lastLogSig = sig;
    $("log").innerHTML = s.sorted.length
      ? s.sorted.slice().reverse().map((e) => `<div class="log-row"><span><i class="dot" style="background:${TYPES[e.t].color}"></i>${TYPES[e.t].name}</span><span class="t num">${fmtTime(e.at)}</span></div>`).join("")
      : `<div class="empty">No punches yet today. Tap <b>Clock in</b> when your shift starts.</div>`;
  }
}

// ---------------------------------------------------------------- timesheets (shared)
function periodRange() {
  const today = new Date();
  if (period === "week") { const s = weekStart(today); const e = new Date(s); e.setDate(e.getDate() + 7); return [s, e]; }
  if (period === "lastweek") { const e = weekStart(today); const s = new Date(e); s.setDate(s.getDate() - 7); return [s, e]; }
  if (period === "month") return [new Date(today.getFullYear(), today.getMonth(), 1), new Date(today.getFullYear(), today.getMonth() + 1, 1)];
  return [new Date(1970, 0, 1), new Date(9999, 0, 1)];
}
function rowsFor(dayMap, openDay) {
  const [s, e] = periodRange(); const now = Date.now();
  return Object.keys(dayMap || {})
    .filter((k) => { const d = dateOfKey(k); return d >= s && d < e && dayMap[k].events.length; })
    .sort().reverse()
    .map((k) => {
      const sm = summarize(dayMap[k].events);
      const open = sm.status !== "out" && (openDay === k || openDay === undefined);
      return { k, ...summarize(dayMap[k].events, open ? now : null), open };
    });
}
function totalsOf(rows, r) {
  let w = 0, m = 0; rows.forEach((x) => { w += x.work; m += x.meal; });
  return { work: w, meal: m, days: rows.length, pay: hrs(w) * r };
}
function totalsHTML(t) {
  return `<div class="total"><span class="label">Hours worked</span><b class="num">${hrs(t.work).toFixed(2)}</b></div>
    <div class="total money"><span class="label">Gross pay</span><b class="num">${money(t.pay)}</b></div>
    <div class="total"><span class="label">Meal breaks</span><b class="num">${hm(t.meal)}</b></div>
    <div class="total"><span class="label">Days worked</span><b class="num">${t.days}</b></div>`;
}
function segHTML() {
  const opts = [["week", "This week"], ["lastweek", "Last week"], ["month", "This month"], ["all", "All time"]];
  return opts.map(([p, l]) => `<button data-p="${p}" aria-pressed="${p === period}">${l}</button>`).join("");
}
function wireSeg(root) {
  root.querySelectorAll("[data-seg]").forEach((seg) => {
    seg.innerHTML = segHTML();
    seg.querySelectorAll("button").forEach((b) => (b.onclick = () => { period = b.dataset.p; render(); }));
  });
}
function sheetHTML(rows, r, emptyMsg) {
  if (!rows.length) return `<div class="sheet-empty"><b>No shifts in this period</b><span>${emptyMsg}</span></div>`;
  const groups = [];
  rows.forEach((x) => {
    const wk = keyOf(weekStart(dateOfKey(x.k)));
    let g = groups[groups.length - 1];
    if (!g || g.wk !== wk) { g = { wk, rows: [], w: 0, m: 0 }; groups.push(g); }
    g.rows.push(x); g.w += x.work; g.m += x.meal;
  });
  const multi = groups.length > 1 || period === "month" || period === "all";
  let h = `<table><thead><tr><th>Date</th><th>In</th><th>Out</th><th>Meal</th><th>Worked</th><th>Hours</th><th>Pay</th></tr></thead><tbody>`;
  for (const g of groups) {
    for (const x of g.rows) {
      h += `<tr class="day${x.open ? " open" : ""}" data-k="${x.k}" tabindex="0">
        <td>${shortDate(x.k)}${x.open ? "<small>In progress</small>" : ""}</td>
        <td>${x.first ? fmtTime(x.first) : "—"}</td>
        <td>${x.open ? "…" : x.last ? fmtTime(x.last) : "—"}</td>
        <td>${hm(x.meal)}</td><td>${hm(x.work)}</td><td>${hrs(x.work).toFixed(2)}</td>
        <td class="pay">${money(hrs(x.work) * r)}</td></tr>`;
    }
    if (multi) {
      const ws = dateOfKey(g.wk);
      h += `<tr class="week"><td>Week of ${ws.getMonth() + 1}/${ws.getDate()}</td><td></td><td></td><td>${hm(g.m)}</td><td>${hm(g.w)}</td><td>${hrs(g.w).toFixed(2)}</td><td class="pay">${money(hrs(g.w) * r)}</td></tr>`;
    }
  }
  return h + `</tbody></table>`;
}

function renderSheet() {
  if (!me) return;
  wireSeg($("view-sheet"));
  const rows = rowsFor(days, profile.openDay);
  $("my-totals").innerHTML = totalsHTML(totalsOf(rows, rate()));
  $("sheet").innerHTML = sheetHTML(rows, rate(), "Clock in on the Clock tab and each day shows up here with hours, breaks and pay.");
  $("sheet").querySelectorAll("tr.day").forEach((tr) => {
    tr.onclick = () => openEditor(tr.dataset.k);
    tr.onkeydown = (e) => { if (e.key === "Enter") openEditor(tr.dataset.k); };
  });
}

// ---------------------------------------------------------------- day editor
function openEditor(k) {
  const isNew = !k;
  let dayKey = k || keyOf(new Date());
  const existing = !isNew && days[k] ? summarize(days[k].events).sorted : [];
  let rows = existing.length
    ? existing.map((e) => ({ t: e.t, time: `${pad(new Date(e.at).getHours())}:${pad(new Date(e.at).getMinutes())}` }))
    : [{ t: "in", time: "09:00" }, { t: "out", time: "17:00" }];
  const root = $("overlay-root");
  const close = () => { root.innerHTML = ""; document.removeEventListener("keydown", onKey); };
  const onKey = (e) => { if (e.key === "Escape") close(); };
  document.addEventListener("keydown", onKey);
  const draw = () => {
    root.innerHTML = `<div class="overlay" id="ov"><div class="panel" role="dialog" aria-modal="true" aria-labelledby="ed-title">
      <h2 id="ed-title">${isNew ? "Add a day" : longDate(dayKey)}</h2>
      ${isNew ? `<div class="field"><label for="ed-date">Date</label><input id="ed-date" type="date" value="${dayKey}" max="${keyOf(new Date())}"></div>` : ""}
      <div class="hint">Change a time or punch type, or remove a punch. A time earlier than the clock-in counts as the next morning.</div>
      <div style="display:grid;gap:8px">${rows.map((r, i) => `<div class="ed-row">
        <select id="ed-t-${i}" aria-label="Punch type">${Object.entries(TYPES).map(([v, o]) => `<option value="${v}"${v === r.t ? " selected" : ""}>${o.name}</option>`).join("")}</select>
        <input id="ed-h-${i}" type="time" value="${r.time}" aria-label="Time">
        <button class="x" data-i="${i}" aria-label="Remove punch">×</button></div>`).join("")}</div>
      <button class="btn" id="ed-add">+ Add punch</button>
      <div class="err" id="ed-err"></div>
      <div class="actions">${isNew ? "" : `<button class="btn danger" id="ed-del">Delete day</button>`}<span style="flex:1"></span><button class="btn" id="ed-cancel">Cancel</button><button class="btn primary" id="ed-save">Save</button></div>
    </div></div>`;
    const pull = () => { rows.forEach((r, i) => { r.t = $("ed-t-" + i).value; r.time = $("ed-h-" + i).value; }); if (isNew) dayKey = $("ed-date").value || dayKey; };
    root.querySelectorAll(".x").forEach((b) => (b.onclick = () => { pull(); rows.splice(+b.dataset.i, 1); draw(); }));
    $("ed-add").onclick = () => {
      pull();
      const lastT = rows.length ? rows[rows.length - 1].t : null;
      const next = { in: "mealStart", mealStart: "mealEnd", mealEnd: "out", out: "in" }[lastT] || "in";
      rows.push({ t: next, time: rows.length ? rows[rows.length - 1].time : "09:00" }); draw();
    };
    $("ed-cancel").onclick = close;
    $("ov").onclick = (e) => { if (e.target.id === "ov") close(); };
    if (!isNew) $("ed-del").onclick = () => {
      const b = $("ed-del");
      if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = "Tap again to delete"; return; }
      delete days[dayKey];
      writeDay(dayKey, []);
      if (profile.openDay === dayKey) { profile.openDay = null; writeOpenDay(null); }
      close(); render(); toast("Day deleted", false);
    };
    $("ed-save").onclick = () => {
      pull();
      if (isNew && days[dayKey] && days[dayKey].events.length) { $("ed-err").textContent = `${longDate(dayKey)} already has punches. Tap that day in the timesheet to change it.`; return; }
      const d = dateOfKey(dayKey);
      const valid = rows.filter((r) => r.time);
      const firstIn = valid.find((r) => r.t === "in");
      const toMs = (time) => { const [h, m] = time.split(":").map(Number); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime(); };
      const startMs = firstIn ? toMs(firstIn.time) : null;
      const events = valid.map((r) => { let at = toMs(r.time); if (startMs != null && at < startMs) at += 86400000; return { t: r.t, at }; }).sort((a, b) => a.at - b.at);
      if (events.length) days[dayKey] = { events }; else delete days[dayKey];
      writeDay(dayKey, events);
      const st = summarize(events).status;
      const isToday = dayKey === keyOf(new Date());
      if (st !== "out" && (isToday || profile.openDay === dayKey)) { profile.openDay = dayKey; writeOpenDay(dayKey); }
      else if (profile.openDay === dayKey) { profile.openDay = null; writeOpenDay(null); }
      close(); render(); toast(isNew ? "Day added" : "Day updated", false);
    };
  };
  draw();
}

// ---------------------------------------------------------------- group view
const pending = () => myMemberships.filter((m) => m.status === "invited");
const joined = () => myMemberships.filter((m) => m.status === "joined" && m.uid === me.uid);
const membersOf = (gid) => ledMemberships.filter((m) => m.gid === gid).sort((a, b) => (a.status === b.status ? (a.name || a.email).localeCompare(b.name || b.email) : a.status === "joined" ? -1 : 1));
const display = (m) => m.name || m.email;

function memberStats(m) {
  if (m.status !== "joined") return null;
  const d = memberDays[m.uid];
  if (d === null || d === undefined) return "loading";
  if (d === "denied") return "denied";
  return totalsOf(rowsFor(d), numRate(m.rate));
}

function renderGroup() {
  const root = $("view-group");
  if (!me || root.hidden) return;
  // Keep typed text and focus when live data re-renders the view.
  const keep = {}; root.querySelectorAll("input[id]").forEach((i) => (keep[i.id] = i.value));
  const focusId = document.activeElement && root.contains(document.activeElement) ? document.activeElement.id : null;
  if (groupNav.mid) root.innerHTML = memberDetailHTML();
  else if (groupNav.gid) root.innerHTML = groupDetailHTML();
  else root.innerHTML = groupHomeHTML();
  Object.entries(keep).forEach(([id, v]) => { const el = $(id); if (el && (id !== "m-rate" || id === focusId)) el.value = v; });
  if (focusId && $(focusId)) $(focusId).focus();
  wireSeg(root);
  wireGroup(root);
}

function verifyBannerHTML() {
  if (me.emailVerified) return "";
  return `<div class="banner"><div><b>Confirm your email to join a group.</b> We sent a link to ${esc(me.email)}. Open it, then come back and tap “I confirmed it”.</div>
    <div class="inline-form"><button class="btn small" data-act="verified">I confirmed it</button><button class="btn small" data-act="resend">Send the link again</button></div></div>`;
}

function groupHomeHTML() {
  const inv = pending(), mine = joined();
  let h = "";
  if (inv.length) {
    h += `<div class="card"><h2>Invitations</h2>${verifyBannerHTML()}<div class="list">${inv.map((m) => `
      <div class="list-row"><div><b>${esc(m.groupName)}</b><div class="sub">From ${esc(m.leaderEmail)} · they'll see your punches, hours and pay</div></div>
      <div class="inline-form"><button class="btn small" data-act="decline" data-id="${esc(m.id)}">Decline</button><button class="btn small primary" data-act="accept" data-id="${esc(m.id)}" ${me.emailVerified ? "" : "disabled"}>Join</button></div></div>`).join("")}</div></div>`;
  }
  h += `<div class="card"><div class="card-row"><h2>Groups you lead</h2></div>`;
  if (ledGroups.length) {
    h += `<div class="list">${ledGroups.map((g) => {
      const ms = membersOf(g.id); const j = ms.filter((m) => m.status === "joined").length;
      return `<button class="list-row" data-act="open-group" data-id="${esc(g.id)}"><div><b>${esc(g.name)}</b><div class="sub">${j} member${j === 1 ? "" : "s"}${ms.length > j ? ` · ${ms.length - j} invited` : ""}</div></div><span aria-hidden="true">›</span></button>`;
    }).join("")}</div>`;
  } else h += `<div class="sub">Start a group to see your team's hours, meal breaks and gross pay in one place.</div>`;
  h += `<form class="inline-form" data-form="new-group"><input id="new-group-name" placeholder="Group name, e.g. Front desk" maxlength="80" aria-label="Group name"><button class="btn primary" type="submit">Start a group</button></form></div>`;
  h += `<div class="card"><h2>Groups you're in</h2>`;
  h += mine.length
    ? `<div class="list">${mine.map((m) => `<div class="list-row"><div><b>${esc(m.groupName)}</b><div class="sub">Led by ${esc(m.leaderEmail)}. They can see your punches and pay.</div></div><button class="btn small danger" data-act="leave" data-id="${esc(m.id)}">Leave</button></div>`).join("")}</div>`
    : `<div class="sub">When a group leader adds your email (${esc(me.email)}), the invite shows up here.</div>`;
  h += `</div>`;
  return h;
}

function groupDetailHTML() {
  const g = ledGroups.find((x) => x.id === groupNav.gid);
  if (!g) { groupNav = { gid: null, mid: null }; return groupHomeHTML(); }
  const ms = membersOf(g.id);
  const tot = { work: 0, meal: 0, days: 0, pay: 0 };
  let loading = false;
  const rowsH = ms.map((m) => {
    const st = memberStats(m);
    if (st === "loading") loading = true;
    if (st && typeof st === "object") { tot.work += st.work; tot.meal += st.meal; tot.days += st.days; tot.pay += st.pay; }
    const cells = st && typeof st === "object"
      ? `<td>${st.days}</td><td>${hrs(st.work).toFixed(2)}</td><td>${hm(st.meal)}</td><td class="pay">${money(st.pay)}</td>`
      : `<td colspan="4" class="ro">${st === "loading" ? "Loading…" : st === "denied" ? "Can't see this person's hours" : "Hasn't joined yet"}</td>`;
    return `<tr class="day" data-mid="${esc(m.id)}" tabindex="0"><td>${esc(display(m))}<small>${m.status === "joined" ? esc(m.email) : "Invited"}</small></td>${cells}</tr>`;
  }).join("");
  let h = `<button class="back" data-act="home">‹ All groups</button>
    <div class="card-row"><h2 style="font-size:30px">${esc(g.name)}</h2><span class="pill lead">You lead</span></div>
    <div class="seg" role="group" aria-label="Period" data-seg></div>
    <div class="totals">${totalsHTML(tot)}</div>`;
  h += `<div class="sheet-wrap">${ms.length
    ? `<table class="compact"><thead><tr><th>Member</th><th>Days</th><th>Hours</th><th>Meal</th><th>Pay</th></tr></thead><tbody>${rowsH}</tbody></table>`
    : `<div class="sheet-empty"><b>No one here yet</b><span>Add your team by email below. Once they join, their hours and pay show up here.</span></div>`}</div>`;
  h += `<div class="hint">${loading ? "Loading members' hours… " : ""}Totals count members who have joined. Tap a member to see each day. You can view punches but not change them.</div>`;
  h += `<div class="card"><h2>Add someone</h2>
    <form class="inline-form" data-form="add-member"><input id="add-email" type="email" inputmode="email" autocomplete="off" placeholder="name@email.com" aria-label="Their email">
      <input id="add-rate" class="rate-in" type="number" inputmode="decimal" min="0" step="0.25" value="${DEFAULT_RATE}" aria-label="Their hourly rate in dollars">
      <button class="btn primary" type="submit">Add</button></form>
    <div class="err" id="add-err"></div>
    <div class="sub">They'll see the invite after they sign in to Shift Punch with that email. The number is their hourly rate, used for the pay you see here.</div>
    <button class="btn small" data-act="copy-invite" data-id="${esc(g.id)}" style="justify-self:start">Copy an invite message to send them</button></div>`;
  h += `<button class="btn danger" data-act="delete-group" data-id="${esc(g.id)}" style="justify-self:start">Delete this group</button>`;
  return h;
}

function memberDetailHTML() {
  const m = ledMemberships.find((x) => x.id === groupNav.mid);
  if (!m) { groupNav.mid = null; return groupDetailHTML(); }
  const g = ledGroups.find((x) => x.id === m.gid);
  const r = numRate(m.rate);
  let h = `<button class="back" data-act="back-group">‹ ${esc(g ? g.name : "Group")}</button>
    <div><h2 style="font-size:30px">${esc(display(m))}</h2><div class="sub">${esc(m.email)} · <span class="pill ${m.status}">${m.status === "joined" ? "Joined" : "Invited"}</span></div></div>`;
  if (m.status !== "joined") {
    h += `<div class="card"><div class="sub">${esc(m.email)} hasn't joined yet. Once they sign in to Shift Punch with this email and tap <b>Join</b>, their hours show up here.</div></div>`;
  } else {
    const d = memberDays[m.uid];
    const rows = d && typeof d === "object" ? rowsFor(d) : [];
    h += `<div class="seg" role="group" aria-label="Period" data-seg></div>
      <div class="totals">${totalsHTML(totalsOf(rows, r))}</div>
      <div class="sheet-wrap">${d === null || d === undefined ? `<div class="sheet-empty">Loading…</div>` : d === "denied" ? `<div class="sheet-empty">You can't see this person's hours right now.</div>` : sheetHTML(rows, r, "No shifts from this person in this period.")}</div>
      <div class="hint">View only. ${esc(display(m))} fixes their own punches.</div>`;
  }
  h += `<div class="rate-row"><label for="m-rate" class="label" style="color:var(--ink)">Their hourly rate $</label>
    <input id="m-rate" type="number" inputmode="decimal" min="0" step="0.25" value="${r}"><span class="sub">Used for the pay you see</span></div>`;
  h += `<button class="btn danger" data-act="remove-member" data-id="${esc(m.id)}" style="justify-self:start">Remove from group</button>`;
  return h;
}

function armed(btn, label) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = "1"; btn.textContent = label;
  setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; renderGroup(); } }, 4000);
  return false;
}

function wireGroup(root) {
  root.querySelectorAll("tr[data-mid]").forEach((tr) => {
    const go = () => { groupNav.mid = tr.dataset.mid; renderGroup(); window.scrollTo(0, 0); };
    tr.onclick = go; tr.onkeydown = (e) => { if (e.key === "Enter") go(); };
  });
  const ng = root.querySelector('[data-form="new-group"]');
  if (ng) ng.onsubmit = async (e) => {
    e.preventDefault();
    const name = $("new-group-name").value.trim();
    if (!name) { toast("Give your group a name first.", false); return; }
    const ref = F.doc(F.collection(db, "groups"));
    $("new-group-name").value = "";
    try {
      await F.setDoc(ref, { name, leaderUid: me.uid, leaderEmail: cleanEmail(me.email), createdAt: Date.now() });
      groupNav = { gid: ref.id, mid: null }; renderGroup();
    } catch (err) { report("Couldn't start the group. Try again.")(err); }
  };
  const am = root.querySelector('[data-form="add-member"]');
  if (am) am.onsubmit = async (e) => {
    e.preventDefault();
    const g = ledGroups.find((x) => x.id === groupNav.gid);
    const email = cleanEmail($("add-email").value);
    const r = numRate($("add-rate").value);
    if (!validEmail(email)) { $("add-err").textContent = "Enter a full email address, like name@email.com."; return; }
    const mid = `${g.id}_${email}`;
    if (ledMemberships.some((m) => m.id === mid)) { $("add-err").textContent = `${email} is already in this group.`; return; }
    $("add-email").value = "";
    try {
      await F.setDoc(F.doc(db, "memberships", mid), { gid: g.id, groupName: g.name, email, leaderUid: me.uid, leaderEmail: cleanEmail(me.email), status: "invited", uid: null, rate: r, addedAt: Date.now() });
      toast(`Invited ${email}`, false);
    } catch (err) { report("Couldn't add that person. Try again.")(err); }
  };
  const mr = $("m-rate");
  if (mr) mr.onchange = () => {
    F.updateDoc(F.doc(db, "memberships", groupNav.mid), { rate: numRate(mr.value) }).then(() => toast("Rate saved", false), report("Couldn't save the rate."));
  };

  root.querySelectorAll("[data-act]").forEach((b) => (b.onclick = async () => {
    const id = b.dataset.id;
    switch (b.dataset.act) {
      case "open-group": groupNav = { gid: id, mid: null }; renderGroup(); window.scrollTo(0, 0); break;
      case "home": groupNav = { gid: null, mid: null }; renderGroup(); break;
      case "back-group": groupNav.mid = null; renderGroup(); break;
      case "accept": {
        const m = myMemberships.find((x) => x.id === id); if (!m) return;
        b.disabled = true;
        try {
          await me.getIdToken(true);
          const batch = F.writeBatch(db);
          batch.update(F.doc(db, "memberships", id), { status: "joined", uid: me.uid, name: profile.name || me.displayName || "", joinedAt: Date.now() });
          batch.set(userRef(), { leaders: { [m.leaderUid]: id } }, { merge: true });
          await batch.commit();
          toast(`You joined ${m.groupName}`, false);
        } catch (err) { b.disabled = false; report("Couldn't join. Confirm your email first, then try again.")(err); }
        break;
      }
      case "decline": {
        if (!armed(b, "Tap again")) return;
        F.deleteDoc(F.doc(db, "memberships", id)).then(() => toast("Invite declined", false), report("Couldn't decline. Try again."));
        break;
      }
      case "leave": {
        if (!armed(b, "Tap again to leave")) return;
        const m = myMemberships.find((x) => x.id === id); if (!m) return;
        const batch = F.writeBatch(db);
        batch.delete(F.doc(db, "memberships", id));
        if (profile.leaders[m.leaderUid] === id) batch.set(userRef(), { leaders: { [m.leaderUid]: F.deleteField() } }, { merge: true });
        batch.commit().then(() => toast(`You left ${m.groupName}`, false), report("Couldn't leave the group. Try again."));
        break;
      }
      case "verified": {
        await me.reload().catch(() => {});
        await me.getIdToken(true).catch(() => {});
        toast(me.emailVerified ? "Email confirmed. You can join groups now." : "Not confirmed yet. Open the link in the email we sent.", false);
        renderGroup(); break;
      }
      case "resend": A.sendEmailVerification(me).then(() => toast(`Sent a new link to ${me.email}`, false), report("Couldn't send the email. Try again in a few minutes.")); break;
      case "copy-invite": {
        const g = ledGroups.find((x) => x.id === id);
        const url = location.origin + location.pathname;
        const text = `I added you to "${g.name}" on Shift Punch, the app we use to clock in and out. Open ${url}, create an account with this email address, then go to the Group tab and tap Join.`;
        try { await navigator.clipboard.writeText(text); toast("Invite message copied. Paste it in a text or email.", false); }
        catch (e) { toast("Copy isn't allowed here.", false); }
        break;
      }
      case "remove-member": {
        if (!armed(b, "Tap again to remove")) return;
        F.deleteDoc(F.doc(db, "memberships", id)).then(() => { groupNav.mid = null; renderGroup(); toast("Removed from group", false); }, report("Couldn't remove them. Try again."));
        break;
      }
      case "delete-group": {
        if (!armed(b, "Tap again to delete the group")) return;
        const batch = F.writeBatch(db);
        membersOf(id).forEach((m) => batch.delete(F.doc(db, "memberships", m.id)));
        batch.delete(F.doc(db, "groups", id));
        batch.commit().then(() => { groupNav = { gid: null, mid: null }; renderGroup(); toast("Group deleted", false); }, report("Couldn't delete the group. Try again."));
        break;
      }
    }
  }));
}

// ---------------------------------------------------------------- account panel
$("who").onclick = () => {
  const root = $("overlay-root");
  root.innerHTML = `<div class="overlay" id="ov"><div class="panel" role="dialog" aria-modal="true" aria-labelledby="acct-title">
    <h2 id="acct-title">${esc(profile.name || "Your account")}</h2>
    <div class="sub">${esc(me.email)}${me.emailVerified ? "" : " · not confirmed yet"}</div>
    <div class="actions"><button class="btn" id="acct-close">Close</button><button class="btn danger" id="acct-out">Sign out</button></div>
  </div></div>`;
  const close = () => (root.innerHTML = "");
  $("acct-close").onclick = close;
  $("ov").onclick = (e) => { if (e.target.id === "ov") close(); };
  $("acct-out").onclick = () => { close(); A.signOut(auth); };
};

// ---------------------------------------------------------------- CSV + rate
$("copy").onclick = async () => {
  const rows = rowsFor(days, profile.openDay).slice().reverse();
  const lines = ["Date,Clock in,Clock out,Meal (h:mm),Worked (h:mm),Hours,Pay"];
  rows.forEach((r) => lines.push([r.k, r.first ? fmtTime(r.first) : "", r.open ? "" : r.last ? fmtTime(r.last) : "", hm(r.meal), hm(r.work), hrs(r.work).toFixed(2), (hrs(r.work) * rate()).toFixed(2)].map((v) => `"${v}"`).join(",")));
  try { await navigator.clipboard.writeText(lines.join("\n")); toast("Timesheet copied. Paste it into a spreadsheet.", false); }
  catch (e) { toast("Copy isn't allowed here.", false); }
};
$("add-day").onclick = () => openEditor(null);
$("rate").onchange = () => {
  profile.rate = numRate(parseFloat($("rate").value)); $("rate").value = rate();
  F.setDoc(userRef(), { rate: rate() }, { merge: true }).catch(report("Couldn't save your rate."));
  render();
};

// ---------------------------------------------------------------- navigation
function render() {
  renderClock();
  if (!$("view-sheet").hidden) renderSheet();
  if (!$("view-group").hidden) renderGroup();
}
function show(v) {
  view = v;
  for (const name of ["clock", "sheet", "group"]) {
    const el = $("view-" + name);
    el.hidden = name !== v;
    el.style.display = name === v ? "grid" : "";
  }
  document.querySelectorAll(".tab").forEach((t) => t.setAttribute("aria-selected", t.dataset.v === v));
  try { localStorage.setItem("shiftpunch.tab", v); } catch (e) {}
  render();
}
document.querySelectorAll(".tab").forEach((b) => (b.onclick = () => { if (b.dataset.v === "group" && view === "group") groupNav = { gid: null, mid: null }; show(b.dataset.v); }));
try { view = localStorage.getItem("shiftpunch.tab") || "clock"; } catch (e) {}
if (!["clock", "sheet", "group"].includes(view)) view = "clock";

let ticks = 0;
setInterval(() => {
  if (!me) return;
  renderClock();
  ticks++;
  // Running shifts tick up; refresh the tables every 30 seconds rather than every second.
  if (ticks % 30 === 0) { if (!$("view-sheet").hidden && profile.openDay) renderSheet(); if (!$("view-group").hidden && !document.activeElement?.matches("input")) renderGroup(); }
}, 1000);

// ---------------------------------------------------------------- install as an app
(() => {
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  if (standalone) return;
  const box = $("install");
  let dismissedUntil = 0;
  try { dismissedUntil = Number(localStorage.getItem("shiftpunch.installLater")) || 0; } catch (e) {}
  if (Date.now() < dismissedUntil) return;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let deferred = null;

  $("install-later").onclick = () => {
    box.hidden = true;
    try { localStorage.setItem("shiftpunch.installLater", String(Date.now() + 14 * 86400000)); } catch (e) {}
  };
  if (isIOS) {
    $("install-how").innerHTML = `Tap <b>Share</b> <svg class="share-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-label="Share icon"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5"/><path d="M5 11v9h14v-9"/></svg> at the bottom (or top) of the browser, then <b>Add to Home Screen</b>.`;
    $("install-go").hidden = true;
    $("install-later").textContent = "Got it";
    box.hidden = false;
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault(); deferred = e;
    $("install-go").hidden = false; box.hidden = false;
  });
  $("install-go").onclick = async () => {
    if (!deferred) return;
    deferred.prompt();
    const { outcome } = await deferred.userChoice.catch(() => ({}));
    deferred = null;
    if (outcome === "accepted") box.hidden = true;
  };
  window.addEventListener("appinstalled", () => { box.hidden = true; toast("Shift Punch is on your home screen", false); });
})();
