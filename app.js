/* 狩猟免許 学科トレーニング（網・わな）
 * 画面: GitHub Pages（このファイル）／保存: ブラウザ＋GAS（任意）
 * データの考え方:
 *   - 勉強計画 plan: {id,name,startDate,endDate,laps,iv[],introEnd,createdAt,updatedAt,deleted}
 *   - 解答ログ event: {eid,pid,qid,ok,mode,ts,d}  ← これだけを積み上げ、進捗はすべてここから計算する
 *     （スマホとPCで同じ計画を使っても、ログを足し合わせるだけなので食い違わない）
 */
(function () {
  "use strict";

  // ---------------- 定数 ----------------
  var QB = window.QB;
  var QUESTIONS = QB.questions;
  var QMAP = {};
  QUESTIONS.forEach(function (q) { QMAP[q.id] = q; });
  var CATS = QB.cats; // [{id,name,short}]
  var CATNAME = {};
  CATS.forEach(function (c) { CATNAME[c.id] = c.name; });
  var BASE_IV = [1, 3, 7, 14, 30, 60]; // 復習の間隔（日）。エビングハウスの忘却曲線にならう
  var LAP_MODES = { daily: 1, ahead: 1 };
  var KANA = ["ア", "イ", "ウ"];
  var EXAM = { law: 13, bird: 9, mgmt: 2, net: 6, trap: 6, minutes: 90, pass: 0.7 };
  var LS = "kari.";

  // ---------------- 保存（ブラウザ） ----------------
  function load(key, def) {
    try { var v = localStorage.getItem(LS + key); return v == null ? def : JSON.parse(v); }
    catch (e) { return def; }
  }
  function save(key, val) {
    try { localStorage.setItem(LS + key, JSON.stringify(val)); } catch (e) { /* 容量不足などは無視（画面は動く） */ }
  }

  var settings = load("settings", { apiUrl: "", apiKey: "", tz: "Asia/Tokyo", sort: "updated" });
  var plans = load("plans", {});          // id -> plan
  var events = load("events", {});        // pid -> [event]
  var queue = load("queue", { plans: [], events: [], days: [] });
  var device = load("device", null);
  if (!device) { device = rid(6); save("device", device); }

  // サーバーから "2026-11-05T15:00:00.000Z" のような形で日付が届いても、設定のタイムゾーンの "2026-11-06" に直す
  function normDay(v) {
    if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    var t = new Date(v); if (isNaN(t)) return v;
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: settings.tz || "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(t); }
    catch (e) { return t.toISOString().slice(0, 10); }
  }
  function normPlan(p) {
    if (!p) return p;
    p.startDate = normDay(p.startDate); p.endDate = normDay(p.endDate); p.introEnd = normDay(p.introEnd);
    p.laps = Number(p.laps) || 1; p.createdAt = Number(p.createdAt); p.updatedAt = Number(p.updatedAt);
    p.deleted = p.deleted === true || p.deleted === "true";
    if (typeof p.iv === "string") p.iv = p.iv.split(",").map(Number);
    if (!Array.isArray(p.iv) || !p.iv.length || p.iv.some(isNaN)) p.iv = schedule(p.startDate, p.endDate, p.laps).iv;
    return p;
  }
  function normEvent(e) { e.d = normDay(e.d); e.ok = Number(e.ok) ? 1 : 0; e.ts = Number(e.ts); return e; }

  function persist() { save("plans", plans); save("events", events); save("queue", queue); save("settings", settings); }

  // ---------------- 小物 ----------------
  function rid(n) { var s = ""; var c = "abcdefghijkmnpqrstuvwxyz23456789"; for (var i = 0; i < n; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }
  function shuffle(a) { a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function seeded(seedStr) { // 計画ごとに決まった並び（スマホとPCで同じ順番になる）
    var h = 2166136261; for (var i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
    return function () { h ^= h << 13; h ^= h >>> 17; h ^= h << 5; return ((h >>> 0) % 100000) / 100000; };
  }
  function seededShuffle(a, seedStr) { var r = seeded(seedStr); a = a.slice(); for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(r() * (i + 1)); var t = a[i]; a[i] = a[j]; a[j] = t; } return a; }
  function pct(a, b) { return b ? Math.round((a / b) * 100) : 0; }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }

  // ---------------- 日付（タイムゾーンは設定で変更可） ----------------
  function today() {
    try { return new Intl.DateTimeFormat("en-CA", { timeZone: settings.tz || "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()); }
    catch (e) { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  }
  function toUTC(s) { var p = s.split("-"); return Date.UTC(+p[0], +p[1] - 1, +p[2]); }
  function addDays(s, n) { var t = new Date(toUTC(s) + n * 864e5); return t.toISOString().slice(0, 10); }
  function diffDays(a, b) { return Math.round((toUTC(a) - toUTC(b)) / 864e5); } // a - b
  var WD = ["日", "月", "火", "水", "木", "金", "土"];
  function jp(s) { var t = new Date(toUTC(s)); return (t.getUTCMonth() + 1) + "月" + t.getUTCDate() + "日"; }
  function jpw(s) { var t = new Date(toUTC(s)); return jp(s) + "(" + WD[t.getUTCDay()] + ")"; }
  function jpTime(ms) { var d = new Date(ms); return (d.getMonth() + 1) + "/" + d.getDate() + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0"); }

  // ---------------- 勉強計画の計算 ----------------
  // 期間 D 日で N 周するとき、1周目（新しい問題）を「目標日 − 復習にかかる日数」までに終え、
  // 2周目以降は忘却曲線の間隔（1日後→3日後→7日後…）で再出題する。期間が短いときは間隔を縮める。
  function schedule(startDate, endDate, laps) {
    var D = diffDays(endDate, startDate) + 1;
    var iv = BASE_IV.slice();
    var need = 0; for (var k = 0; k < laps - 1; k++) need += iv[Math.min(k, iv.length - 1)];
    var introDays = D - need;
    if (laps > 1 && introDays < Math.max(1, Math.ceil(D * 0.4))) {
      var scale = (D * 0.6) / need;
      iv = BASE_IV.map(function (x) { return Math.max(1, Math.round(x * scale)); });
      need = 0; for (k = 0; k < laps - 1; k++) need += iv[Math.min(k, iv.length - 1)];
      introDays = Math.max(1, D - need);
    }
    return { days: D, iv: iv, introDays: introDays, introEnd: addDays(startDate, introDays - 1), perDay: Math.ceil((QUESTIONS.length * laps) / D), newPerDay: Math.ceil(QUESTIONS.length / introDays) };
  }

  function makePlan(f) {
    var sc = schedule(f.startDate, f.endDate, f.laps);
    var now = Date.now();
    return { id: f.id || ("p" + now.toString(36) + rid(3)), name: f.name, startDate: f.startDate, endDate: f.endDate, laps: f.laps, iv: sc.iv, introEnd: sc.introEnd, createdAt: f.createdAt || now, updatedAt: now, deleted: false };
  }

  // 解答ログを畳み込んで、問題ごとの状態を出す
  function fold(plan, evs, beforeDate) {
    var st = {};
    QUESTIONS.forEach(function (q) { st[q.id] = { laps: 0, stage: 0, due: null, last: null, n: 0, ok: 0, ng: 0, dailyD: null }; });
    var iv = plan.iv || BASE_IV;
    for (var i = 0; i < evs.length; i++) {
      var e = evs[i];
      if (beforeDate && e.d >= beforeDate) continue;
      var s = st[e.qid]; if (!s) continue;
      s.n++; if (e.ok) s.ok++; else s.ng++;
      s.last = !!e.ok;
      if (LAP_MODES[e.mode] && s.dailyD !== e.d) {
        s.dailyD = e.d;
        if (s.laps === 0) s.laps = 1;
        else if (s.due && e.d >= s.due) s.laps++;
        if (e.ok) { s.stage++; s.due = addDays(e.d, iv[Math.min(s.stage - 1, iv.length - 1)]); }
        else { s.stage = 0; s.due = addDays(e.d, 1); }
      }
    }
    return st;
  }

  function planEvents(pid) { var a = events[pid] || []; a.sort(function (x, y) { return x.ts - y.ts; }); return a; }

  // その日の演習問題（その日より前のログだけで決まるので、どの端末でも同じになる）
  var setMemo = {};
  function daySet(plan, D, evs) {
    evs = evs || planEvents(plan.id);
    var nb = 0, lastTs = 0;
    for (var i = 0; i < evs.length; i++) if (evs[i].d < D) { nb++; if (evs[i].ts > lastTs) lastTs = evs[i].ts; }
    var mkey = [plan.id, D, nb, lastTs, plan.startDate, plan.endDate, plan.laps, plan.introEnd].join("|");
    if (setMemo[mkey]) return setMemo[mkey];
    var st = fold(plan, evs, D);
    var due = [], fresh = [];
    var order = seededShuffle(QUESTIONS.map(function (q) { return q.id; }), plan.id);
    order.forEach(function (id) {
      var s = st[id];
      if (s.laps === 0) fresh.push(id);
      else if (s.due && s.due <= D) due.push(id);
    });
    var quota = 0, plan2 = null;
    if (D >= plan.startDate) {
      plan2 = planAhead(plan, D, st, fresh.length, accRate(evs, D));
      quota = plan2.news[0];
      // 前日の「今日やる分」で解き残した新しい問題は、必ず今日に引き継ぐ
      // （前日のセット自体も同じ手順で決まるので、さかのぼって求める。復習は期限切れのまま残るので自動で引き継がれる）
      var prev = addDays(D, -1);
      if (prev >= plan.startDate) {
        var left = daySet(plan, prev, evs).newIds.filter(function (id) { return st[id].laps === 0; });
        if (left.length) quota = Math.max(quota, fresh.indexOf(left[left.length - 1]) + 1);
      }
      quota = Math.min(quota, fresh.length);
    }
    var newIds = fresh.slice(0, quota);
    var res = { ids: due.concat(newIds), newIds: newIds, review: due.length, fresh: newIds.length, freshAll: fresh, st: st, load: plan2 && plan2.load };
    setMemo[mkey] = res;
    return res;
  }

  // 今日以降の計画を立て直す。
  //  1) すでに解いた問題が、忘却曲線どおりなら今後どの日に復習として出てくるかを数える（これまでの正答率で、間違えて翌日に戻る分も見込む）
  //  2) 新しい問題を日 k に x 問入れると、k + 1日, +3日, +7日… に復習が x 問ずつ増える
  //  3) まず新しい問題を1周目の締切（introEnd）までの日数で均等に割り振り、
  //     「ある日の新しい問題を別の日へ移すと、毎日の量（新規＋復習）のばらつきが減るか」を試して、減る限り移し続ける
  //     ばらつきは「各日の問題数の4乗の合計」で測る（いちばん多い日を特に強く減らそうとする）
  var planMemo = {};
  // 計画に使う正答率の見込み：その日より前の解答から。記録が少ないうちは85%と仮定して混ぜる
  function accRate(evs, D) {
    var n = 0, ok = 0;
    for (var i = 0; i < evs.length; i++) { var e = evs[i]; if (e.d < D) { n++; if (e.ok) ok++; } }
    var prior = 30, r = (ok + 0.85 * prior) / (n + prior);
    return Math.round(Math.min(1, Math.max(0.5, r)) * 20) / 20; // 5%きざみ（計算の使い回しのため）
  }

  // 1問の今後の出題回数の見込み（期待値）。正解率 p なら次の復習日へ、間違えたら翌日にもう一度
  var expMemo = {};
  function expect(first, stage0, p, n, iv) {
    var key = first + "|" + stage0 + "|" + p + "|" + n + "|" + iv.join(".");
    if (expMemo[key]) return expMemo[key];
    var L = iv.length, E = [], m = [];
    for (var t = 0; t < n; t++) { E.push(0); m.push([]); }
    if (first < n) m[first][Math.min(stage0, L)] = 1;
    for (t = 0; t < n; t++) {
      for (var s = 0; s <= L; s++) {
        var w = m[t][s]; if (!w || w < 1e-4) continue;
        E[t] += w;
        var tc = t + iv[Math.min(s, L - 1)], ns = Math.min(s + 1, L);
        if (tc < n) m[tc][ns] = (m[tc][ns] || 0) + w * p;
        if (t + 1 < n && p < 1) m[t + 1][0] = (m[t + 1][0] || 0) + w * (1 - p);
      }
    }
    return (expMemo[key] = E);
  }

  function planAhead(plan, D, st, freshCount, p) {
    p = p == null ? 1 : p;
    var iv = plan.iv || BASE_IV, end = plan.endDate < D ? D : plan.endDate;
    var n = diffDays(end, D) + 1;
    var kIntro = Math.max(0, Math.min(n - 1, diffDays(plan.introEnd, D)));
    var base = []; for (var k = 0; k < n; k++) base.push(0);
    Object.keys(st).forEach(function (id) {
      var s = st[id]; if (!s.laps || !s.due) return;
      var E = expect(Math.max(0, diffDays(s.due, D)), s.stage, p, n, iv);
      for (var t = 0; t < n; t++) base[t] += E[t];
    });
    var key = [D, end, plan.introEnd, iv.join("."), freshCount, p, base.map(function (v) { return v.toFixed(2); }).join(".")].join("|");
    if (planMemo[key]) return planMemo[key];
    // 新しい問題1問を入れた日を0日目としたときの、その後の出題回数の見込み
    var patE = expect(0, 0, p, n, iv), pat = [], patW = [];
    for (k = 0; k < n; k++) if (patE[k] > 1e-3) { pat.push(k); patW.push(patE[k]); }
    var news = [], load = base.slice(), days = kIntro + 1;
    for (k = 0; k < n; k++) news.push(k <= kIntro ? Math.floor(freshCount / days) + (k < freshCount % days ? 1 : 0) : 0);
    function add(day, x) { for (var j = 0; j < pat.length; j++) if (day + pat[j] < n) load[day + pat[j]] += x * patW[j]; }
    for (k = 0; k <= kIntro; k++) if (news[k]) add(k, news[k]);
    function gain(i, j, m) { // i 日目の m 問を j 日目へ移したときの「2乗の合計」の減り方
      var before = 0, after = 0, touched = {}, idx = [], p, d;
      for (p = 0; p < pat.length; p++) { d = i + pat[p]; if (d < n && !touched[d]) { touched[d] = 1; idx.push(d); } d = j + pat[p]; if (d < n && !touched[d]) { touched[d] = 1; idx.push(d); } }
      idx.forEach(function (d) { var v = load[d] * load[d]; before += v * v; });
      add(i, -m); add(j, m);
      idx.forEach(function (d) { var v = load[d] * load[d]; after += v * v; });
      add(j, -m); add(i, m);
      return before - after;
    }
    var steps = [16, 8, 4, 2, 1];
    for (var si = 0; si < steps.length; si++) {
      var m = steps[si], moved = true, guard = 0;
      while (moved && guard++ < 400) {
        moved = false;
        for (var i = 0; i <= kIntro; i++) {
          if (news[i] < m) continue;
          var bestJ = -1, bestG = 0;
          for (var j = 0; j <= kIntro; j++) { if (j === i) continue; var g = gain(i, j, m); if (g > bestG) { bestG = g; bestJ = j; } }
          if (bestJ >= 0) { add(i, -m); add(bestJ, m); news[i] -= m; news[bestJ] += m; moved = true; }
        }
      }
    }
    load = load.map(function (v) { return Math.round(v); });
    var res = { news: news, load: load, mx: Math.max.apply(null, load) };
    planMemo[key] = res;
    return res;
  }

  function summary(plan) {
    var evs = planEvents(plan.id);
    var D = today();
    var set = daySet(plan, D, evs);
    var doneToday = {};
    evs.forEach(function (e) { if (e.d === D && e.mode === "daily") doneToday[e.qid] = true; });
    var done = set.ids.filter(function (id) { return doneToday[id]; }).length;
    var st = fold(plan, evs, null);
    var N = plan.laps, Q = QUESTIONS.length, lapUnits = 0, wrong = 0;
    var lapCount = []; for (var k = 0; k < Math.max(N, 1); k++) lapCount.push(0);
    QUESTIONS.forEach(function (q) {
      var s = st[q.id];
      lapUnits += Math.min(s.laps, N);
      for (var k = 0; k < N; k++) if (s.laps >= k + 1) lapCount[k]++;
      if (s.last === false) wrong++;
    });
    var n = evs.length, ok = evs.filter(function (e) { return e.ok; }).length;
    var tn = 0, tok = 0; evs.forEach(function (e) { if (e.d === D) { tn++; if (e.ok) tok++; } });
    return {
      D: D, set: set, done: done, todayPct: set.ids.length ? pct(done, set.ids.length) : 100,
      overallPct: pct(lapUnits, N * Q), lapUnits: lapUnits, total: N * Q, lapCount: lapCount,
      n: n, ok: ok, avg: n ? pct(ok, n) : null, tn: tn, tok: tok, wrong: wrong, st: st,
      daysLeft: diffDays(plan.endDate, D), started: D >= plan.startDate
    };
  }

  // ---------------- GAS との同期 ----------------
  var syncState = { status: "local", msg: "この端末だけに保存", busy: false };
  function apiReady() { return !!(settings.apiUrl && settings.apiKey); }
  function api(action, data) {
    var body = Object.assign({ action: action, key: settings.apiKey }, data || {});
    return fetch(settings.apiUrl, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify(body), redirect: "follow" })
      .then(function (r) { return r.json(); })
      .then(function (j) { if (!j || !j.ok) throw new Error((j && j.error) || "応答が正しくありません"); return j; });
  }
  function setSync(status, msg) { syncState.status = status; syncState.msg = msg; var el = document.querySelector("[data-sync]"); if (el) el.outerHTML = syncPill(); }
  function pending() { return queue.events.length + queue.plans.length + queue.days.length; }

  var flushTimer = null;
  function scheduleFlush(ms) { clearTimeout(flushTimer); flushTimer = setTimeout(flush, ms == null ? 1500 : ms); }
  function flush() {
    if (!apiReady()) { setSync("local", "この端末だけに保存"); return Promise.resolve(); }
    if (syncState.busy) { scheduleFlush(2000); return Promise.resolve(); }
    if (!pending()) { setSync("ok", "同期済み"); return Promise.resolve(); }
    syncState.busy = true; setSync("wait", "送信中…");
    var planIds = queue.plans.slice();
    var evs = queue.events.slice(0, 300);
    var days = queue.days.slice();
    var p = Promise.resolve();
    if (planIds.length) p = p.then(function () { return api("upsertPlans", { plans: planIds.map(function (id) { return plans[id]; }).filter(Boolean) }); })
      .then(function () { queue.plans = queue.plans.filter(function (id) { return planIds.indexOf(id) < 0; }); });
    if (evs.length) p = p.then(function () { return api("pushEvents", { events: evs }); })
      .then(function () { var sent = {}; evs.forEach(function (e) { sent[e.eid] = 1; }); queue.events = queue.events.filter(function (e) { return !sent[e.eid]; }); });
    if (days.length) p = p.then(function () { return api("pushDays", { days: days }); })
      .then(function () { queue.days = queue.days.slice(days.length); });
    return p.then(function () {
      syncState.busy = false; persist();
      if (pending()) { scheduleFlush(300); } else setSync("ok", "同期済み");
    }).catch(function (err) {
      syncState.busy = false; persist();
      setSync("err", "未送信 " + pending() + " 件（あとで再送します）");
      scheduleFlush(30000);
      console.warn(err);
    });
  }
  function pullPlans() {
    if (!apiReady()) return Promise.resolve();
    setSync("wait", "受信中…");
    return api("listPlans").then(function (j) {
      (j.plans || []).forEach(function (rp) {
        normPlan(rp);
        var lp = plans[rp.id];
        if (!lp || (rp.updatedAt || 0) > (lp.updatedAt || 0)) plans[rp.id] = rp;
      });
      Object.keys(plans).forEach(function (id) {
        var known = (j.plans || []).some(function (rp) { return rp.id === id; });
        if (!known && queue.plans.indexOf(id) < 0) queue.plans.push(id);
      });
      persist(); return flush();
    }).catch(function (e) { setSync("err", "サーバーに接続できません"); console.warn(e); });
  }
  function pullEvents(pid) {
    if (!apiReady()) return Promise.resolve(false);
    return api("pullEvents", { pid: pid }).then(function (j) {
      var have = {}; (events[pid] || []).forEach(function (e) { have[e.eid] = 1; });
      var added = 0;
      (j.events || []).forEach(function (e) { normEvent(e); if (!have[e.eid]) { (events[pid] = events[pid] || []).push(e); added++; } });
      persist(); return added > 0;
    }).catch(function (e) { setSync("err", "受信できませんでした"); console.warn(e); return false; });
  }
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "hidden") flush(); });

  // ---------------- 記録 ----------------
  function record(pid, qid, ok, mode) {
    var ts = Date.now();
    var e = { eid: device + ts.toString(36) + rid(3), pid: pid, qid: qid, ok: ok ? 1 : 0, mode: mode, ts: ts, d: today() };
    (events[pid] = events[pid] || []).push(e);
    queue.events.push(e);
    var p = plans[pid]; if (p) { p.updatedAt = ts; if (queue.plans.indexOf(pid) < 0) queue.plans.push(pid); }
    persist(); scheduleFlush();
  }
  function touchPlan(p) { p.updatedAt = Date.now(); plans[p.id] = p; if (queue.plans.indexOf(p.id) < 0) queue.plans.push(p.id); persist(); scheduleFlush(300); }

  // ---------------- 画面の土台 ----------------
  var app = document.getElementById("app");
  var view = { name: "slots", pid: null, tab: "home" };
  var session = null;
  var ICON = {
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/></svg>',
    drill: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
    log: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="5" width="16" height="15" rx="2"/><path d="M8 3v4M16 3v4M4 10h16"/></svg>',
    gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.6 1.6 0 00.3 1.8l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.6 1.6 0 00-1.8-.3 1.6 1.6 0 00-1 1.5V21a2 2 0 11-4 0v-.1a1.6 1.6 0 00-1-1.5 1.6 1.6 0 00-1.8.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.6 1.6 0 00.3-1.8 1.6 1.6 0 00-1.5-1H3a2 2 0 110-4h.1a1.6 1.6 0 001.5-1 1.6 1.6 0 00-.3-1.8l-.1-.1a2 2 0 112.8-2.8l.1.1a1.6 1.6 0 001.8.3H9a1.6 1.6 0 001-1.5V3a2 2 0 114 0v.1a1.6 1.6 0 001 1.5 1.6 1.6 0 001.8-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.6 1.6 0 00-.3 1.8V9a1.6 1.6 0 001.5 1H21a2 2 0 110 4h-.1a1.6 1.6 0 00-1.5 1z"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    swap: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M7 4L3 8l4 4"/><path d="M3 8h14"/><path d="M17 20l4-4-4-4"/><path d="M21 16H7"/></svg>'
  };

  function syncPill() {
    var cls = { ok: "ok", wait: "wait", err: "err", local: "" }[syncState.status] || "";
    return '<span class="sync-pill ' + cls + '" data-sync><i></i>' + esc(syncState.msg) + "</span>";
  }
  function toast(msg) {
    var t = document.createElement("div"); t.className = "toast"; t.setAttribute("role", "status"); t.textContent = msg;
    document.body.appendChild(t); setTimeout(function () { t.remove(); }, 2200);
  }
  function sheet(html, bind) {
    var bg = document.createElement("div"); bg.className = "sheet-bg";
    bg.innerHTML = '<div class="sheet" role="dialog" aria-modal="true">' + html + "</div>";
    bg.addEventListener("click", function (e) { if (e.target === bg) bg.remove(); });
    document.body.appendChild(bg);
    bind(bg.firstChild, function () { bg.remove(); });
    var f = bg.querySelector("button, input"); if (f) f.focus();
  }

  function render() {
    window.scrollTo(0, 0);
    if (view.name === "slots") return renderSlots();
    if (view.name === "newplan") return renderPlanForm(null);
    if (view.name === "editplan") return renderPlanForm(plans[view.pid]);
    if (view.name === "setup") return renderSetup();
    if (view.name === "session") return renderSession();
    if (view.name === "result") return renderResult();
    if (view.name === "plan") return renderPlan();
    if (view.name === "zsession") return renderZ();
    if (view.name === "zresult") return renderZResult();
    if (view.name === "zlist") return renderZList();
  }

  // ---------------- タイトル（セーブデータ選択） ----------------
  function visiblePlans() {
    var list = Object.keys(plans).map(function (k) { return plans[k]; }).filter(function (p) { return !p.deleted; });
    list.sort(function (a, b) { return settings.sort === "created" ? b.createdAt - a.createdAt : b.updatedAt - a.updatedAt; });
    return list;
  }
  function renderSlots() {
    var list = visiblePlans();
    var html = '<div class="wrap title-screen">' +
      '<header class="title-hero"><span class="eyebrow">新潟県 狩猟免許試験　網猟・わな猟</span><h1>狩猟免許 学科トレーニング</h1>' +
      '<p>全' + QUESTIONS.length + '問・三択。セーブデータ（勉強計画）を選んで始めます。</p></header>' +
      '<div class="slot-head"><h2>勉強計画をえらぶ</h2><div class="seg" role="group" aria-label="並び順">' +
      '<button data-sort="updated" aria-pressed="' + (settings.sort !== "created") + '">最終更新順</button>' +
      '<button data-sort="created" aria-pressed="' + (settings.sort === "created") + '">作成日順</button></div></div>' +
      '<div class="slots">';
    list.forEach(function (p, i) {
      var s = summary(p);
      html += '<button class="slot" data-open="' + p.id + '"><span class="no">SLOT ' + String(i + 1).padStart(2, "0") + '</span>' +
        '<span style="min-width:0"><span class="name">' + esc(p.name) + '</span>' +
        '<span class="meta"><span>' + jp(p.startDate) + '〜' + jp(p.endDate) + '・' + p.laps + '周</span>' +
        '<span>' + (s.daysLeft >= 0 ? 'あと' + s.daysLeft + '日' : '期間終了') + '</span>' +
        '<span>最終更新 ' + jpTime(p.updatedAt) + '</span><span>作成 ' + jpTime(p.createdAt) + '</span></span>' +
        '<span class="bar"><i style="width:' + s.overallPct + '%"></i></span></span>' +
        '<span class="pct">' + s.overallPct + '<small>%</small></span></button>';
    });
    html += '<button class="slot new" data-new><span class="plus">＋</span><span><span class="name">新しい勉強計画をつくる</span><span class="meta">名前・開始日・目標日・周回数を決めます</span></span></button>';
    html += '</div><div class="title-foot">' + syncPill() + '<button class="btn ghost" data-setup>' + ICON.gear + '同期の設定</button></div></div>';
    app.innerHTML = html;
    app.querySelectorAll("[data-sort]").forEach(function (b) { b.onclick = function () { settings.sort = b.dataset.sort; persist(); renderSlots(); }; });
    app.querySelectorAll("[data-open]").forEach(function (b) { b.onclick = function () { openPlan(b.dataset.open); }; });
    app.querySelector("[data-new]").onclick = function () { view = { name: "newplan" }; render(); };
    app.querySelector("[data-setup]").onclick = function () { view = { name: "setup" }; render(); };
  }

  function openPlan(pid) {
    view = { name: "plan", pid: pid, tab: "home" };
    render();
    pullEvents(pid).then(function (changed) { flush(); if (changed && view.name === "plan" && view.pid === pid) render(); });
  }

  // ---------------- 計画の作成・編集 ----------------
  function renderPlanForm(p) {
    var t = today();
    var f = p ? { name: p.name, startDate: p.startDate, endDate: p.endDate, laps: p.laps } : { name: "", startDate: t, endDate: addDays(t, 16), laps: 3 };
    app.innerHTML = '<header class="topbar"><div class="wrap"><button class="iconbtn" data-back aria-label="戻る">' + ICON.back + '</button>' +
      '<div class="ttl">' + (p ? "勉強計画を編集" : "新しい勉強計画") + '</div></div></header>' +
      '<div class="wrap" style="padding-block:18px 48px;max-width:640px"><form class="form panel" id="pf" novalidate>' +
      '<div class="field"><label for="pf-name">計画の名前</label><input type="text" id="pf-name" maxlength="30" placeholder="例：11/20 上越会場 本番" value="' + esc(f.name) + '"></div>' +
      '<div class="row2"><div class="field"><label for="pf-start">勉強開始日</label><input type="date" id="pf-start" value="' + f.startDate + '"></div>' +
      '<div class="field"><label for="pf-end">目標日（この日までに終える）</label><input type="date" id="pf-end" value="' + f.endDate + '"><span class="hint">ふつうは試験日の前日</span></div></div>' +
      '<div class="field"><label id="pf-laps-l">テキスト（全' + QUESTIONS.length + '問）を何周する？</label><div class="stepper" aria-labelledby="pf-laps-l"><button type="button" data-step="-1" aria-label="減らす">−</button><output id="pf-laps">' + f.laps + '</output><span>周</span><button type="button" data-step="1" aria-label="増やす">＋</button></div>' +
      '<span class="hint">1周目は全問を通しで解き、2周目以降は忘却曲線（1日後→3日後→7日後…）に合わせて再出題します。</span></div>' +
      '<div class="preview" id="pf-prev"></div><div class="err" id="pf-err" hidden></div>' +
      '<button class="btn primary block" type="submit">' + (p ? "保存する" : "この計画で始める") + '</button>' +
      (p ? '<button class="btn danger block" type="button" data-del>この計画を削除</button>' : "") +
      "</form></div>";
    var laps = f.laps;
    var $ = function (s) { return app.querySelector(s); };
    function upd() {
      var s = $("#pf-start").value, e = $("#pf-end").value, err = "";
      if (!s || !e) err = "日付を入力してください";
      else if (e < s) err = "目標日は開始日より後にしてください";
      $("#pf-err").hidden = !err; $("#pf-err").textContent = err;
      if (err) { $("#pf-prev").innerHTML = ""; return null; }
      var sc = schedule(s, e, laps);
      $("#pf-prev").innerHTML = '<div>期間 <b>' + sc.days + '</b> 日・' + laps + '周ぶん <b>' + (QUESTIONS.length * laps) + '</b> 問</div>' +
        (function () {
          var pa = planAhead({ iv: sc.iv, endDate: e, introEnd: sc.introEnd }, s, {}, QUESTIONS.length, 0.85);
          var tot = pa.load.reduce(function (a, b) { return a + b; }, 0);
          return '<div>1日あたり 約 <b>' + Math.round(tot / sc.days) + '</b> 問（多い日で ' + pa.mx + ' 問）</div><div class="small">間違えた問題のやり直しと、周回を終えた問題の復習も含みます。正答率85%と見込んだ量で、実際の正答率に合わせて毎日計算し直します。</div>';
        })() +
        '<div class="small">1周目（新しい問題）は ' + jp(sc.introEnd) + ' までに全問を一通り</div>' +
        (laps > 1 ? '<div class="small">復習の間隔：' + sc.iv.slice(0, laps - 1).join("日 → ") + '日後</div>' : "");
      return sc;
    }
    $("#pf-start").oninput = upd; $("#pf-end").oninput = upd;
    app.querySelectorAll("[data-step]").forEach(function (b) { b.onclick = function () { laps = Math.min(6, Math.max(1, laps + +b.dataset.step)); $("#pf-laps").textContent = laps; upd(); }; });
    upd();
    $("[data-back]").onclick = function () { view = p ? { name: "plan", pid: p.id, tab: "settings" } : { name: "slots" }; render(); };
    $("#pf").onsubmit = function (ev) {
      ev.preventDefault();
      var name = $("#pf-name").value.trim();
      if (!name) { $("#pf-err").hidden = false; $("#pf-err").textContent = "計画の名前を入力してください"; $("#pf-name").focus(); return; }
      if (!upd()) return;
      var np = makePlan({ id: p && p.id, createdAt: p && p.createdAt, name: name, startDate: $("#pf-start").value, endDate: $("#pf-end").value, laps: laps });
      touchPlan(np);
      toast(p ? "保存しました" : "計画を作りました");
      view = { name: "plan", pid: np.id, tab: p ? "settings" : "home" }; render();
    };
    if (p) $("[data-del]").onclick = function () {
      sheet('<h3>「' + esc(p.name) + '」を削除しますか？</h3><p class="muted small" style="margin:0">解答の記録も見えなくなります。元に戻せません。</p><div class="acts"><button class="btn" data-x>やめる</button><button class="btn blaze" data-y>削除する</button></div>', function (el, close) {
        el.querySelector("[data-x]").onclick = close;
        el.querySelector("[data-y]").onclick = function () { p.deleted = true; touchPlan(p); close(); toast("削除しました"); view = { name: "slots" }; render(); };
      });
    };
  }

  // ---------------- 同期の設定 ----------------
  function renderSetup() {
    app.innerHTML = '<header class="topbar"><div class="wrap"><button class="iconbtn" data-back aria-label="戻る">' + ICON.back + '</button><div class="ttl">同期の設定</div></div></header>' +
      '<div class="wrap stack" style="padding-block:18px 48px;max-width:640px">' +
      (window.KARI_DEMO ? '<div class="note" style="background:var(--blaze-soft)">この体験版ページでは同期は使えません（外部への通信が制限されるため）。GitHub Pages に置いた版で設定してください。</div>' : '') +
      '<div class="note">GAS（Apps Script）のWebアプリURLとアクセスキーを入れると、スマホとPCで同じ勉強計画・記録を使えます。空欄のままでも、この端末だけで使えます。</div>' +
      '<form class="form panel" id="sf" novalidate>' +
      '<div class="field"><label for="sf-url">WebアプリのURL</label><input type="url" id="sf-url" placeholder="https://script.google.com/macros/s/…/exec" value="' + esc(settings.apiUrl) + '"></div>' +
      '<div class="field"><label for="sf-key">アクセスキー</label><input type="password" id="sf-key" autocomplete="off" value="' + esc(settings.apiKey) + '"><span class="hint">GASの setup() を実行したときにログに出たキー</span></div>' +
      '<div class="field"><label for="sf-tz">「今日」の基準にするタイムゾーン</label><select id="sf-tz">' +
      ["Asia/Tokyo", "Asia/Baku", "UTC"].map(function (z) { return '<option value="' + z + '"' + (settings.tz === z ? " selected" : "") + ">" + { "Asia/Tokyo": "日本（Asia/Tokyo）", "Asia/Baku": "アゼルバイジャン（Asia/Baku）", "UTC": "協定世界時（UTC）" }[z] + "</option>"; }).join("") +
      '</select></div>' +
      '<div class="err" id="sf-msg" hidden></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn primary" type="submit">保存して接続テスト</button><button class="btn" type="button" data-clear>同期をやめる</button></div></form>' +
      '<div class="panel stack"><h3 style="font-size:15px">バックアップ</h3><p class="small muted" style="margin:0">計画と解答記録をテキストでコピーできます。別の端末で「読み込む」に貼り付けると復元できます。</p>' +
      '<textarea id="bk" aria-label="バックアップのテキスト" spellcheck="false"></textarea><div style="display:flex;gap:10px;flex-wrap:wrap"><button class="btn" data-copy>今のデータを表示・コピー</button><button class="btn" data-import>読み込む</button></div></div></div>';
    var $ = function (s) { return app.querySelector(s); };
    $("[data-back]").onclick = function () { view = { name: "slots" }; render(); };
    function msg(t, ok) { var m = $("#sf-msg"); m.hidden = false; m.textContent = t; m.style.color = ok ? "var(--ok)" : "var(--ng)"; }
    $("#sf").onsubmit = function (ev) {
      ev.preventDefault();
      settings.apiUrl = $("#sf-url").value.trim(); settings.apiKey = $("#sf-key").value.trim(); settings.tz = $("#sf-tz").value; persist();
      if (!apiReady()) { msg("タイムゾーンを保存しました（同期なし）", true); return; }
      msg("接続しています…", true);
      api("ping").then(function () { msg("接続できました。データを同期します。", true); return pullPlans(); })
        .catch(function (e) { msg("接続できませんでした：" + e.message + "。URLとキーを確認してください。"); });
    };
    $("[data-clear]").onclick = function () { settings.apiUrl = ""; settings.apiKey = ""; persist(); $("#sf-url").value = ""; $("#sf-key").value = ""; setSync("local", "この端末だけに保存"); msg("同期を止めました。この端末だけに保存します。", true); };
    $("[data-copy]").onclick = function () {
      var txt = JSON.stringify({ v: 1, plans: plans, events: events });
      $("#bk").value = txt; $("#bk").select();
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(function () { toast("コピーしました"); }, function () { toast("テキストを選択しました"); });
    };
    $("[data-import]").onclick = function () {
      try {
        var d = JSON.parse($("#bk").value);
        Object.keys(d.plans || {}).forEach(function (id) { var rp = d.plans[id]; if (!plans[id] || rp.updatedAt > plans[id].updatedAt) { plans[id] = rp; queue.plans.push(id); } });
        Object.keys(d.events || {}).forEach(function (pid) {
          var have = {}; (events[pid] || []).forEach(function (e) { have[e.eid] = 1; });
          d.events[pid].forEach(function (e) { if (!have[e.eid]) { (events[pid] = events[pid] || []).push(e); queue.events.push(e); } });
        });
        persist(); scheduleFlush(200); toast("読み込みました");
      } catch (e) { toast("読み込めませんでした（形式を確認してください）"); }
    };
  }

  // ---------------- 計画の中（タブ） ----------------
  var TABS = [["home", "ホーム", ICON.home], ["drill", "演習", ICON.drill], ["log", "記録", ICON.log], ["settings", "設定", ICON.gear]];
  function renderPlan() {
    var p = plans[view.pid]; if (!p || p.deleted) { view = { name: "slots" }; return render(); }
    var s = summary(p);
    var nav = TABS.map(function (t) { return '<button data-tab="' + t[0] + '"' + (view.tab === t[0] ? ' aria-current="page"' : "") + ">" + t[2] + "<span>" + t[1] + "</span></button>"; }).join("");
    var body = { home: tabHome, drill: tabDrill, log: tabLog, settings: tabSettings }[view.tab](p, s);
    app.innerHTML = '<header class="topbar"><div class="wrap"><button class="iconbtn" data-slots aria-label="勉強計画の選択に戻る" title="計画をえらび直す">' + ICON.swap + '</button>' +
      '<div class="ttl">' + esc(p.name) + '</div>' + syncPill() + '</div></header>' +
      '<div class="wrap shell"><nav class="rail" aria-label="メニュー"><div class="railplan"><div class="eyebrow">勉強計画</div><div style="font-weight:700">' + esc(p.name) + '</div><div class="small muted">' + jp(p.startDate) + '〜' + jp(p.endDate) + '・' + p.laps + '周</div></div>' + nav + '</nav>' +
      '<main class="content">' + body + '</main></div>' +
      '<nav class="tabbar" aria-label="メニュー">' + nav + '</nav>';
    app.querySelector("[data-slots]").onclick = function () { view = { name: "slots" }; render(); };
    app.querySelectorAll("[data-tab]").forEach(function (b) { b.onclick = function () { view.tab = b.dataset.tab; render(); }; });
    bindTab(p, s);
  }

  function ring(pctv, label, sub, alt) {
    var r = 52, c = 2 * Math.PI * r, off = c * (1 - Math.min(100, pctv) / 100);
    return '<div class="ring"><svg viewBox="0 0 140 140" role="img" aria-label="' + label + ' ' + pctv + 'パーセント">' +
      '<circle class="ring-bg" cx="70" cy="70" r="' + r + '" fill="none" stroke-width="14"/>' +
      '<circle class="ring-fg' + (alt ? " alt" : "") + '" cx="70" cy="70" r="' + r + '" fill="none" stroke-width="14" stroke-linecap="round" stroke-dasharray="' + c.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" transform="rotate(-90 70 70)"/>' +
      '<text class="ring-txt" x="70" y="76" text-anchor="middle" font-size="30">' + pctv + '<tspan class="ring-unit" font-size="15">%</tspan></text></svg>' +
      '<span class="lbl">' + label + '</span><span class="sub">' + sub + '</span></div>';
  }

  function tabHome(p, s) {
    var set = s.set, left = set.ids.length - s.done;
    var cta;
    if (!s.started) cta = '<p class="big">開始日（' + jpw(p.startDate) + '）まであと' + diffDays(p.startDate, s.D) + '日です。先に解いておくこともできます。</p><button class="btn" data-go="ahead">先取りで10問</button>';
    else if (!set.ids.length) cta = '<p class="big">今日の予定はありません。間違えた問題や分野別で復習しましょう。</p>';
    else if (left > 0) cta = '<p class="big">' + jpw(s.D) + 'の演習：残り <b class="num">' + left + '</b> 問（新しい問題 ' + set.fresh + '・復習 ' + set.review + '）</p><button class="btn blaze block" data-go="daily">今日の演習をはじめる</button>';
    else cta = '<p class="big">今日の分は終わりました。おつかれさまでした。</p><button class="btn" data-go="ahead">明日の分を先取り（10問）</button>';
    var lapRows = s.lapCount.map(function (n, k) { return '<div class="lap"><span>' + (k + 1) + '周目</span><span class="track"><i style="width:' + pct(n, QUESTIONS.length) + '%"></i></span><span class="v">' + pct(n, QUESTIONS.length) + '%</span></div>'; }).join("");
    var catRows = CATS.map(function (c) {
      var n = 0, ok = 0; QUESTIONS.forEach(function (q) { if (q.cat === c.id) { n += s.st[q.id].n; ok += s.st[q.id].ok; } });
      var r = n ? pct(ok, n) : null;
      return '<div class="catbar"><span>' + c.name + '</span><span class="num">' + (r == null ? "—" : r + "%") + '</span><span class="track"><i class="' + (r == null ? "" : r < 60 ? "low" : r < 80 ? "mid" : "") + '" style="width:' + (r || 0) + '%"></i></span></div>';
    }).join("");
    return '<div class="home-grid"><section class="card"><h2>進み具合<span class="small muted">' + (s.daysLeft >= 0 ? "目標日まであと" + s.daysLeft + "日" : "目標日を過ぎました") + '</span></h2>' +
      '<div class="rings">' + ring(s.todayPct, "今日の予定", s.done + " / " + set.ids.length + " 問") + ring(s.overallPct, "全体", s.lapUnits + " / " + s.total + " 問", true) + '</div>' +
      '<div class="today-cta" style="margin-top:14px">' + cta + '</div></section>' +
      '<section class="card"><h2>正答率</h2><div class="kpis">' +
      '<div class="kpi"><span class="v">' + (s.avg == null ? "—" : s.avg + "%") + '</span><span class="k">平均正答率</span></div>' +
      '<div class="kpi"><span class="v">' + (s.tn ? pct(s.tok, s.tn) + "%" : "—") + '</span><span class="k">今日の正答率</span></div>' +
      '<div class="kpi"><span class="v">' + s.wrong + '</span><span class="k">間違えたまま</span></div></div>' +
      '<p class="small muted" style="margin:10px 0 0">合格ラインは正答率70%（網・わな同時受験は36問中26問）。</p>' +
      '<div class="section-label">周回</div><div class="laps">' + lapRows + '</div></section>' +
      '<section class="card" style="grid-column:1/-1"><h2>分野別の正答率</h2><div class="catbars">' + catRows + '</div></section></div>';
  }

  function tabDrill(p, s) {
    var set = s.set, left = set.ids.length - s.done;
    var catCount = {}; QUESTIONS.forEach(function (q) { catCount[q.cat] = (catCount[q.cat] || 0) + 1; });
    var stars = QUESTIONS.filter(function (q) { return q.imp >= 2; }).length;
    var h = '<div class="section-label" style="margin-top:0">今日やること</div><div class="modes">' +
      '<button class="mode today wide" data-go="daily"><span class="ic">今</span><span><span class="t">' + jpw(s.D) + 'の演習問題</span><span class="d">新しい問題 ' + set.fresh + '・忘却曲線の復習 ' + set.review + '</span></span><span class="n">残り' + Math.max(0, left) + '</span></button>' +
      '<button class="mode" data-go="wrong"><span class="ic">×</span><span><span class="t">過去に間違った問題</span><span class="d">最後に間違えた問題をまとめて解く</span></span><span class="n">' + s.wrong + '問</span></button>' +
      '<button class="mode" data-go="star"><span class="ic">★</span><span><span class="t">講習で強調された問題</span><span class="d">「マーカー」「よく出る」の箇所</span></span><span class="n">' + stars + '問</span></button>' +
      '<button class="mode" data-go="exam"><span class="ic">試</span><span><span class="t">模擬試験（本番形式）</span><span class="d">36問・90分・最後に採点</span></span><span class="n">36問</span></button>' +
      '<button class="mode" data-go="ahead"><span class="ic">先</span><span><span class="t">先取り</span><span class="d">まだ解いていない問題を10問（1周目に数える）</span></span><span class="n">' + set.freshAll.length + '問</span></button>' +
      '</div><div class="section-label">分野別</div><div class="modes">';
    CATS.forEach(function (c, i) {
      var n = 0, ok = 0; QUESTIONS.forEach(function (q) { if (q.cat === c.id) { n += s.st[q.id].n; ok += s.st[q.id].ok; } });
      h += '<button class="mode" data-go="cat:' + c.id + '"><span class="ic">' + (i + 1) + '</span><span><span class="t">' + (i + 1) + '. ' + c.name + '</span><span class="d">' + c.desc + '</span></span><span class="n">' + catCount[c.id] + '問<br><span class="small muted">' + (n ? pct(ok, n) + "%" : "—") + '</span></span></button>';
    });
    return h + '</div>' + (ZUKAN.length ? zMenu() : "") + '<p class="small muted" style="margin-top:14px">どのモードも出題順はシャッフル。選択肢の並びも毎回入れ替わります。</p>';
  }

  function dayStats(p) {
    var evs = planEvents(p.id), by = {};
    evs.forEach(function (e) { var b = by[e.d] = by[e.d] || { n: 0, ok: 0, dn: 0, dok: 0 }; b.n++; if (e.ok) b.ok++; if (e.mode === "daily") { b.dn++; if (e.ok) b.dok++; } });
    Object.keys(by).forEach(function (d) {
      var set = daySet(p, d, evs), done = {};
      evs.forEach(function (e) { if (e.d === d && e.mode === "daily") done[e.qid] = 1; });
      by[d].planned = set.ids.length; by[d].done = set.ids.length > 0 && set.ids.every(function (id) { return done[id]; });
    });
    return by;
  }
  function tabLog(p) {
    var by = dayStats(p), days = Object.keys(by).sort().reverse();
    // 開始日〜目標日のカレンダー（7列）
    var cal = WD.map(function (w) { return "<b>" + w + "</b>"; }).join(""), d = p.startDate, t = today(), cells = 0;
    var pad = new Date(toUTC(p.startDate)).getUTCDay();
    for (var i = 0; i < pad; i++) { cal += '<span class="future" style="visibility:hidden"></span>'; cells++; }
    while (d <= p.endDate && cells < 7 * 20) {
      var b = by[d], lv = b ? (b.n >= 30 ? "l3" : b.n >= 10 ? "l2" : "l1") : "";
      cal += '<span class="' + lv + (b && b.done ? " done" : "") + (d > t ? " future" : "") + '" title="' + jp(d) + (b ? " " + b.n + "問 " + pct(b.ok, b.n) + "%" : "") + '"></span>';
      d = addDays(d, 1); cells++;
    }
    var list = days.length ? days.map(function (d) {
      var b = by[d];
      return '<div class="day"><span class="d">' + jpw(d) + (b.done ? '<span class="badge-done">完了</span>' : "") + '</span><span class="b"><i style="width:' + pct(b.ok, b.n) + '%"></i></span>' +
        '<span class="r">' + b.n + '問・' + pct(b.ok, b.n) + '%' + (b.dn ? '<br><span class="small muted">今日の演習 ' + pct(b.dok, b.dn) + '%</span>' : "") + '</span></div>';
    }).join("") : '<div class="empty"><b>まだ記録がありません</b><span>問題を解くと、日ごとの問題数と正答率がここにたまります。</span></div>';
    return '<div class="stack"><section class="card"><h2>カレンダー<span class="small muted">' + jp(p.startDate) + '〜' + jp(p.endDate) + '</span></h2>' +
      '<div class="heat" aria-label="日ごとの演習量">' + cal + '</div><p class="small muted" style="margin:10px 0 0">色が濃いほどたくさん解いた日。オレンジの枠は「その日の演習」を全部終えた日。</p></section>' +
      '<section><div class="section-label" style="margin-top:0">日ごとの記録</div><div class="days">' + list + '</div></section></div>';
  }

  function tabSettings(p) {
    var sc = schedule(p.startDate, p.endDate, p.laps);
    return '<div class="stack" style="max-width:640px"><section class="card"><h2>この勉強計画</h2>' +
      '<div class="preview"><div>' + jp(p.startDate) + '〜' + jp(p.endDate) + '（' + sc.days + '日）・<b>' + p.laps + '</b>周</div>' +
      '<div class="small">1周目は' + jp(p.introEnd) + 'までに全問。復習の間隔：' + (p.iv || BASE_IV).slice(0, Math.max(1, p.laps - 1)).join("日 → ") + '日後</div>' +
      '<div class="small">作成 ' + jpTime(p.createdAt) + '・最終更新 ' + jpTime(p.updatedAt) + '</div></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin-top:14px"><button class="btn" data-edit>名前・日程・周回数を変える</button><button class="btn" data-slots2>別の計画にきりかえる</button></div></section>' +
      '<section class="card"><h2>同期</h2><p style="margin:0 0 10px">' + syncPill() + '</p><button class="btn" data-setup2>同期の設定・バックアップ</button></section>' +
      '<section class="card"><h2>出題のしくみ</h2><ul class="small" style="margin:0;padding-left:1.2em">' +
      '<li>「今日の演習」は、まだ解いていない問題（1周目）と、復習日が来た問題（2周目以降）でできています。</li>' +
      '<li>正解すると次の復習日が 1日後 → 3日後 → 7日後… と延び、間違えると翌日にもう一度出ます。</li>' +
      '<li>周回数を達成した問題も、復習日が来たら出題されます（本番まで忘れないため）。</li>' +
      '<li>問題は網猟・わな猟の受験範囲（法令／網／わな／鳥獣／保護管理）に絞っています。銃猟の問題は入っていません。</li></ul></section></div>';
  }

  function bindTab(p) {
    app.querySelectorAll("[data-go]").forEach(function (b) { b.onclick = function () { startSession(p, b.dataset.go); }; });
    app.querySelectorAll("[data-zgo]").forEach(function (b) { b.onclick = function () { zStart(p, b.dataset.zgo); }; });
    var zl = app.querySelector("[data-zlist]"); if (zl) zl.onclick = function () { view = { name: "zlist", pid: p.id, g: "bird" }; render(); };
    var e = app.querySelector("[data-edit]"); if (e) e.onclick = function () { view = { name: "editplan", pid: p.id }; render(); };
    var sl = app.querySelector("[data-slots2]"); if (sl) sl.onclick = function () { view = { name: "slots" }; render(); };
    var st = app.querySelector("[data-setup2]"); if (st) st.onclick = function () { view = { name: "setup" }; render(); };
  }

  // ---------------- 演習 ----------------
  function startSession(p, go) {
    var s = summary(p), ids = [], title = "", mode = go, feedback = true, timer = null;
    if (go === "daily") {
      var done = {}; planEvents(p.id).forEach(function (e) { if (e.d === s.D && e.mode === "daily") done[e.qid] = 1; });
      ids = shuffle(s.set.ids.filter(function (id) { return !done[id]; }));
      title = jpw(s.D) + "の演習問題";
      if (!ids.length) { toast("今日の分は終わっています"); return; }
    } else if (go === "ahead") {
      var inSet = {}; s.set.ids.forEach(function (id) { inSet[id] = 1; });
      // 明日以降に出る予定の順番どおりに前倒しする（出題はシャッフル）
      ids = shuffle(s.set.freshAll.filter(function (id) { return !inSet[id]; }).slice(0, 10));
      if (!ids.length) ids = shuffle(s.set.freshAll.slice(0, 10));
      title = "先取り";
      if (!ids.length) { toast("まだ解いていない問題はありません"); return; }
    } else if (go === "wrong") {
      ids = shuffle(QUESTIONS.filter(function (q) { return s.st[q.id].last === false; }).map(function (q) { return q.id; }));
      title = "過去に間違った問題";
      if (!ids.length) { toast("間違えたままの問題はありません"); return; }
    } else if (go === "star") {
      ids = shuffle(QUESTIONS.filter(function (q) { return q.imp >= 2; }).map(function (q) { return q.id; }));
      title = "講習で強調された問題";
    } else if (go === "exam") {
      Object.keys(EXAM).forEach(function (c) { if (CATNAME[c]) ids = ids.concat(shuffle(QUESTIONS.filter(function (q) { return q.cat === c; }).map(function (q) { return q.id; })).slice(0, EXAM[c])); });
      ids = shuffle(ids); title = "模擬試験（36問・90分）"; feedback = false; timer = Date.now() + EXAM.minutes * 60000;
    } else if (go.indexOf("cat:") === 0) {
      var c = go.slice(4); mode = "cat";
      ids = shuffle(QUESTIONS.filter(function (q) { return q.cat === c; }).map(function (q) { return q.id; }));
      title = CATNAME[c];
    }
    session = { pid: p.id, mode: mode === "cat" ? "cat" : go, title: title, ids: ids, idx: 0, answers: [], feedback: feedback, deadline: timer, order: null, picked: null };
    view = { name: "session", pid: p.id }; render();
  }

  var tick = null;
  function renderSession() {
    var se = session, q = QMAP[se.ids[se.idx]];
    if (!q) return finishSession();
    if (!se.order) se.order = shuffle([0, 1, 2]);
    var answered = se.picked != null;
    var h = '<header class="topbar"><div class="wrap"><button class="iconbtn" data-quit aria-label="やめる">' + ICON.close + '</button><div class="ttl">' + esc(se.title) + '</div>' +
      (se.deadline ? '<span class="timer" data-timer></span>' : "") + '</div></header>' +
      '<div class="wrap" style="padding-block:16px 48px"><div class="session">' +
      '<div class="qhead"><span class="num small">' + (se.idx + 1) + ' / ' + se.ids.length + '</span><span class="qprog"><i style="width:' + pct(se.idx, se.ids.length) + '%"></i></span></div>' +
      '<div class="qmeta"><span class="chip">' + CATNAME[q.cat] + '</span>' + (q.imp >= 2 ? '<span class="chip star">★ 講習で強調</span>' : "") + '</div>' +
      '<h2 class="qtext">' + esc(q.q) + '</h2><div class="choices">';
    se.order.forEach(function (ci, pos) {
      var cls = "";
      if (answered && se.feedback) { if (ci === q.a) cls = " correct"; else if (ci === se.picked) cls = " wrong"; }
      else if (answered && ci === se.picked) cls = " picked";
      h += '<button class="choice' + cls + '" data-c="' + ci + '"' + (answered ? " disabled" : "") + '><span class="k">' + KANA[pos] + '</span><span>' + esc(q.c[ci]) + '</span></button>';
    });
    h += '</div>';
    if (answered && se.feedback) {
      var ok = se.picked === q.a;
      h += '<div class="feedback ' + (ok ? "ok" : "ng") + '" role="status"><div class="verdict">' + (ok ? "○ 正解" : "× 不正解") + '</div>' +
        (ok ? "" : '<p><b>正解：' + KANA[se.order.indexOf(q.a)] + '</b> ' + esc(q.c[q.a]) + '</p>') +
        '<p>' + esc(q.exp) + '</p><div class="ref">出典：' + esc(q.ref) + '</div></div>';
    }
    h += '<div class="qnav">' + (answered ? '<button class="btn primary" data-next>' + (se.idx + 1 < se.ids.length ? "次の問題" : "結果を見る") + '</button>' : "") + '</div>' +
      '<div class="kbdhint">キーボード：1〜3で解答、Enterで次へ</div></div></div>';
    app.innerHTML = h;
    app.querySelector("[data-quit]").onclick = quitSession;
    app.querySelectorAll("[data-c]").forEach(function (b) { b.onclick = function () { answer(+b.dataset.c); }; });
    var nx = app.querySelector("[data-next]"); if (nx) { nx.onclick = next; nx.focus(); }
    if (se.deadline) { clearInterval(tick); updTimer(); tick = setInterval(updTimer, 1000); }
  }
  function updTimer() {
    var el = document.querySelector("[data-timer]"); if (!el || !session || !session.deadline) { clearInterval(tick); return; }
    var ms = Math.max(0, session.deadline - Date.now()), m = Math.floor(ms / 60000), s = Math.floor(ms / 1000) % 60;
    el.textContent = "残り " + m + ":" + String(s).padStart(2, "0");
    if (ms <= 0) { clearInterval(tick); toast("時間切れです"); finishSession(); }
  }
  function answer(ci) {
    var se = session; if (se.picked != null) return;
    var q = QMAP[se.ids[se.idx]], ok = ci === q.a;
    se.picked = ci; se.answers.push({ qid: q.id, ok: ok, picked: ci });
    record(se.pid, q.id, ok, se.mode);
    if (!se.feedback) return next();
    renderSession();
  }
  function next() { var se = session; se.idx++; se.picked = null; se.order = null; if (se.idx >= se.ids.length) finishSession(); else { renderSession(); window.scrollTo(0, 0); } }
  function quitSession() {
    if (!session.answers.length) { view = { name: "plan", pid: session.pid, tab: "drill" }; session = null; return render(); }
    sheet('<h3>ここで終わりますか？</h3><p class="muted small" style="margin:0">解いた ' + session.answers.length + ' 問の記録は保存されています。</p><div class="acts"><button class="btn" data-x>続ける</button><button class="btn primary" data-y>終わって結果を見る</button></div>', function (el, close) {
      el.querySelector("[data-x]").onclick = close;
      el.querySelector("[data-y]").onclick = function () { close(); finishSession(); };
    });
  }
  function finishSession() { clearInterval(tick); view = { name: "result", pid: session.pid }; render(); }

  function renderResult() {
    var se = session, p = plans[se.pid];
    var n = se.answers.length, ok = se.answers.filter(function (a) { return a.ok; }).length, rate = pct(ok, n);
    var isExam = se.mode === "exam";
    var hero = '<div class="result-hero"><span class="eyebrow">' + esc(se.title) + '</span><span class="score">' + rate + '<small style="font-size:24px">%</small></span><span>' + n + '問中 ' + ok + '問 正解</span>';
    if (isExam) { var need = Math.ceil(se.ids.length * EXAM.pass); hero += '<span class="verdict ' + (ok >= need ? "pass" : "fail") + '">' + (ok >= need ? "合格ライン到達" : "あと" + (need - ok) + "問で合格ライン") + '</span><span class="small muted">合格ライン：' + se.ids.length + '問中' + need + '問（70%）</span>'; }
    hero += '</div>';
    // 今日の演習を全部終えたら、その日の記録をサーバーにも残す
    if (se.mode === "daily" && p) {
      var s = summary(p);
      if (s.set.ids.length && s.done >= s.set.ids.length) {
        hero += '<div class="note" style="text-align:center">' + jpw(s.D) + 'の演習をすべて終えました。今日の記録に残しました。</div>';
        var evs = planEvents(p.id).filter(function (e) { return e.d === s.D && e.mode === "daily"; });
        var dok = evs.filter(function (e) { return e.ok; }).length;
        queue.days.push({ pid: p.id, d: s.D, planned: s.set.ids.length, n: evs.length, ok: dok, rate: pct(dok, evs.length), ts: Date.now() });
        persist(); scheduleFlush(200);
      }
    }
    var list = se.answers.map(function (a) {
      var q = QMAP[a.qid];
      return '<div class="ritem"><span class="mk ' + (a.ok ? "ok" : "ng") + '">' + (a.ok ? "○" : "×") + '</span><span><span class="qq">' + esc(q.q) + '</span>' +
        '<details' + (a.ok ? "" : " open") + '><summary>答えと解説</summary><p style="margin:6px 0"><b>正解：</b>' + esc(q.c[q.a]) + (a.ok ? "" : '<br><b>あなたの答え：</b>' + esc(q.c[a.picked])) + '</p><p style="margin:0">' + esc(q.exp) + '</p><p class="small muted" style="margin:4px 0 0">出典：' + esc(q.ref) + '</p></details></span></div>';
    }).join("");
    var wrongN = se.answers.filter(function (a) { return !a.ok; }).length;
    app.innerHTML = '<header class="topbar"><div class="wrap"><div class="ttl">結果</div>' + syncPill() + '</div></header>' +
      '<div class="wrap" style="padding-block:16px 48px"><div class="session stack">' + hero +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">' + (wrongN ? '<button class="btn blaze" data-retry>間違えた ' + wrongN + ' 問をもう一度</button>' : "") + '<button class="btn primary" data-home>ホームへ</button><button class="btn" data-drill>演習メニュー</button></div>' +
      (n ? '<div class="section-label">ふりかえり</div><div class="rlist">' + list + '</div>' : "") + '</div></div>';
    var go = function (tab) { view = { name: "plan", pid: se.pid, tab: tab }; session = null; render(); };
    app.querySelector("[data-home]").onclick = function () { go("home"); };
    app.querySelector("[data-drill]").onclick = function () { go("drill"); };
    var rt = app.querySelector("[data-retry]");
    if (rt) rt.onclick = function () {
      var ids = shuffle(se.answers.filter(function (a) { return !a.ok; }).map(function (a) { return a.qid; }));
      session = { pid: se.pid, mode: "wrong", title: "間違えた問題をもう一度", ids: ids, idx: 0, answers: [], feedback: true, order: null, picked: null };
      view = { name: "session", pid: se.pid }; render();
    };
  }

  // ---------------- 鳥獣判別（技能試験の写真問題） ----------------
  // 写真は Wikipedia の各記事の代表写真を、開いたブラウザが直接読み込む（URL は端末に30日保存）。
  // 判別の成績は勉強計画の進捗とは別に、この端末だけに保存する。
  var ZUKAN = QB.zukan || [], ZMAP = {}, ZBYNAME = {};
  ZUKAN.forEach(function (z) { ZMAP[z.id] = z; ZBYNAME[z.name] = z; });
  var zstat = load("zstat", {});   // id -> {n, ok, last}
  var zimg = load("zimg", {});     // Wikipedia の記事名 -> {src, file, t} / {none:1, t}
  var zs = null;                   // 判別の出題中の状態
  var ZX = "×";
  var ZTTL = 30 * 864e5;

  function zImg(z) { for (var i = 0; i < z.wiki.length; i++) { var c = zimg[z.wiki[i]]; if (c && c.src) return c; } return null; }
  function zNeed(list) {
    var need = [];
    list.forEach(function (z) {
      if (zImg(z)) return;
      z.wiki.forEach(function (t) { var c = zimg[t]; if ((!c || Date.now() - c.t > ZTTL) && need.indexOf(t) < 0) need.push(t); });
    });
    return need;
  }
  function zFetch(list) {
    var need = zNeed(list), jobs = [];
    for (var i = 0; i < need.length; i += 20) jobs.push(need.slice(i, i + 20));
    return Promise.all(jobs.map(function (titles) {
      var url = "https://ja.wikipedia.org/w/api.php?action=query&format=json&origin=*&prop=pageimages&piprop=thumbnail%7Cname&pithumbsize=500&redirects=1&titles=" + encodeURIComponent(titles.join("|"));
      return fetch(url).then(function (r) { return r.json(); }).then(function (j) {
        var q = j.query || {}, map = {}, byTitle = {};
        (q.normalized || []).forEach(function (n) { map[n.from] = n.to; });
        (q.redirects || []).forEach(function (n) { map[n.from] = n.to; });
        Object.keys(q.pages || {}).forEach(function (k) { var pg = q.pages[k]; byTitle[pg.title] = pg; });
        titles.forEach(function (t) {
          var cur = t, guard = 0; while (map[cur] && guard++ < 5) cur = map[cur];
          var pg = byTitle[cur];
          zimg[t] = pg && pg.thumbnail ? { src: pg.thumbnail.source, file: pg.pageimage || "", t: Date.now() } : { none: 1, t: Date.now() };
        });
      });
    })).then(function () { save("zimg", zimg); }, function (e) { console.warn(e); });
  }
  function zPhoto(z, big) {
    var c = zImg(z);
    if (!c) return '<div class="zph empty' + (big ? " big" : "") + '"><span>写真を読み込めません<br><span class="small">（通信を確認してください）</span></span></div>';
    return '<div class="zph' + (big ? " big" : "") + '"><img src="' + esc(c.src) + '" alt="' + (big ? "問題の写真" : esc(z.name)) + '" loading="lazy" referrerpolicy="no-referrer"></div>';
  }
  function zCredit(z) {
    var c = zImg(z); if (!c || !c.file) return "";
    return '<a class="zcredit" href="https://ja.wikipedia.org/wiki/' + encodeURIComponent("ファイル:" + c.file) + '" target="_blank" rel="noopener">写真：Wikimedia Commons（撮影者・ライセンス）</a>';
  }
  function zTag(z) { return '<span class="ztag ' + (z.hunt ? "h" : "n") + '">' + (z.hunt ? "狩猟" + (z.g === "bird" ? "鳥" : "獣") : "非狩猟" + (z.g === "bird" ? "鳥" : "獣")) + '</span>'; }
  // 比べる相手：似ている種＋「この種と間違えやすい」として登録された非狩猟鳥獣
  function zPeers(z) {
    var out = [];
    z.sim.forEach(function (n) { if (ZBYNAME[n] && out.indexOf(ZBYNAME[n]) < 0) out.push(ZBYNAME[n]); });
    ZUKAN.forEach(function (o) { if (!o.hunt && o !== z && o.sim.indexOf(z.name) >= 0 && out.indexOf(o) < 0) out.push(o); });
    return out.slice(0, 3);
  }
  function zCompare(z, picked) {
    var list = [z].concat(zPeers(z));
    if (picked && picked !== ZX && ZBYNAME[picked] && list.indexOf(ZBYNAME[picked]) < 0) list.push(ZBYNAME[picked]);
    return '<div class="section-label" style="margin:14px 0 8px">見分け方（写真で比べる）</div><div class="zcmp">' + list.map(function (o) {
      return '<figure class="' + (o === z ? "me" : "") + '">' + zPhoto(o, false) + '<figcaption><b>' + esc(o.name) + '</b>' + zTag(o) + '<span class="pt">' + esc(o.pt) + '</span></figcaption></figure>';
    }).join("") + '</div>';
  }

  function zStart(p, go) {
    var pool;
    if (go === "bird" || go === "mammal") pool = shuffle(ZUKAN.filter(function (z) { return z.g === go; }));
    else if (go === "wrong") pool = shuffle(ZUKAN.filter(function (z) { return zstat[z.id] && zstat[z.id].last === false; }));
    else { // 本番形式：鳥8・獣8（うち非狩猟を各2〜3）
      var pick = function (g, n) {
        var non = shuffle(ZUKAN.filter(function (z) { return z.g === g && !z.hunt; })).slice(0, 2 + Math.floor(Math.random() * 2));
        return non.concat(shuffle(ZUKAN.filter(function (z) { return z.g === g && z.hunt; })).slice(0, n - non.length));
      };
      pool = shuffle(pick("bird", 8).concat(pick("mammal", 8)));
    }
    if (!pool.length) { toast(go === "wrong" ? "間違えたままの鳥獣はありません" : "問題がありません"); return; }
    var titles = { bird: "鳥獣判別：鳥類", mammal: "鳥獣判別：獣類", wrong: "鳥獣判別：間違えた鳥獣", exam: "鳥獣判別：本番形式16問" };
    zs = { pid: p.id, go: go, title: titles[go], ids: pool.map(function (z) { return z.id; }), idx: 0, answers: [], picked: null, opts: null, loading: true };
    view = { name: "zsession", pid: p.id }; render();
    zFetch(ZUKAN).then(function () { if (zs) { zs.loading = false; if (view.name === "zsession") renderZ(); } });
  }
  function zOpts(z) {
    var o = z.hunt ? [z.name, z.sim[0], z.sim[1], ZX] : [ZX].concat(z.sim.slice(0, 3));
    return shuffle(o);
  }
  function renderZ() {
    var s = zs, z = ZMAP[s.ids[s.idx]];
    if (!z) return zFinish();
    if (!s.opts) s.opts = zOpts(z);
    var ans = z.hunt ? z.name : ZX, done = s.picked != null;
    var h = '<header class="topbar"><div class="wrap"><button class="iconbtn" data-quit aria-label="やめる">' + ICON.close + '</button><div class="ttl">' + esc(s.title) + '</div></div></header>' +
      '<div class="wrap" style="padding-block:16px 48px"><div class="session">' +
      '<div class="qhead"><span class="num small">' + (s.idx + 1) + ' / ' + s.ids.length + '</span><span class="qprog"><i style="width:' + pct(s.idx, s.ids.length) + '%"></i></span></div>' +
      '<p class="small muted" style="margin:0 0 8px">狩猟鳥獣なら種名、狩猟鳥獣でなければ「×」。</p>' +
      (s.loading && !zImg(z) ? '<div class="zph big empty"><span>写真を読み込み中…</span></div>' : zPhoto(z, true)) +
      (done ? zCredit(z) : "") + '<div class="choices" style="margin-top:12px">';
    s.opts.forEach(function (o, i) {
      var cls = "";
      if (done) { if (o === ans) cls = " correct"; else if (o === s.picked) cls = " wrong"; }
      h += '<button class="choice' + cls + '" data-z="' + i + '"' + (done ? " disabled" : "") + '><span class="k">' + (i + 1) + '</span><span>' + (o === ZX ? "×（狩猟鳥獣ではない）" : esc(o)) + '</span></button>';
    });
    h += '</div>';
    if (done) {
      var ok = s.picked === ans;
      h += '<div class="feedback ' + (ok ? "ok" : "ng") + '" role="status"><div class="verdict">' + (ok ? "○ 正解" : "× 不正解") + '</div>' +
        '<p style="font-size:17px"><b>' + esc(z.name) + '</b> ' + zTag(z) + (z.note ? ' <span class="small">（' + esc(z.note) + '）</span>' : "") + '</p>' +
        '<p><b>答え方：</b>' + (z.hunt ? "種名「" + esc(z.name.replace(/（.*）/, "")) + "」を書く" : "「×」を書く（種名を書くと狩猟鳥獣と答えたことになる）") + '</p>' +
        '<p>' + esc(z.tip) + '</p>' + zCompare(z, s.picked) + '</div>';
    }
    h += '<div class="qnav">' + (done ? '<button class="btn primary" data-znext>' + (s.idx + 1 < s.ids.length ? "次の写真" : "結果を見る") + '</button>' : "") + '</div>' +
      '<div class="kbdhint">キーボード：1〜4で解答、Enterで次へ</div></div></div>';
    app.innerHTML = h;
    app.querySelector("[data-quit]").onclick = function () { if (zs.answers.length) zFinish(); else { zs = null; view = { name: "plan", pid: s.pid, tab: "drill" }; render(); } };
    app.querySelectorAll("[data-z]").forEach(function (b) { b.onclick = function () { zAnswer(+b.dataset.z); }; });
    var nx = app.querySelector("[data-znext]"); if (nx) { nx.onclick = zNext; nx.focus(); }
  }
  function zAnswer(i) {
    var s = zs; if (s.picked != null) return;
    var z = ZMAP[s.ids[s.idx]], o = s.opts[i], ok = o === (z.hunt ? z.name : ZX);
    s.picked = o; s.answers.push({ id: z.id, ok: ok, picked: o });
    var st = zstat[z.id] = zstat[z.id] || { n: 0, ok: 0, last: null };
    st.n++; if (ok) st.ok++; st.last = ok; save("zstat", zstat);
    renderZ();
  }
  function zNext() { zs.idx++; zs.picked = null; zs.opts = null; if (zs.idx >= zs.ids.length) zFinish(); else { renderZ(); window.scrollTo(0, 0); } }
  function zFinish() { view = { name: "zresult", pid: zs.pid }; render(); }
  function renderZResult() {
    var s = zs, n = s.answers.length, ok = s.answers.filter(function (a) { return a.ok; }).length;
    var list = s.answers.map(function (a) {
      var z = ZMAP[a.id];
      return '<div class="zr"><span class="mk ' + (a.ok ? "ok" : "ng") + '">' + (a.ok ? "○" : "×") + '</span>' + zPhoto(z, false) +
        '<span><b>' + esc(z.name) + '</b> ' + zTag(z) + (a.ok ? "" : '<br><span class="small">あなたの答え：' + (a.picked === ZX ? "×" : esc(a.picked)) + '</span>') + '<br><span class="small muted">' + esc(z.pt) + '</span></span></div>';
    }).join("");
    var wrong = s.answers.filter(function (a) { return !a.ok; });
    app.innerHTML = '<header class="topbar"><div class="wrap"><div class="ttl">結果</div></div></header>' +
      '<div class="wrap" style="padding-block:16px 48px"><div class="session stack"><div class="result-hero"><span class="eyebrow">' + esc(s.title) + '</span><span class="score">' + pct(ok, n) + '<small style="font-size:24px">%</small></span><span>' + n + '枚中 ' + ok + '枚 正解</span></div>' +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;justify-content:center">' + (wrong.length ? '<button class="btn blaze" data-zretry>間違えた ' + wrong.length + ' 枚をもう一度</button>' : "") + '<button class="btn primary" data-zback>演習メニュー</button></div>' +
      (n ? '<div class="section-label">ふりかえり</div><div class="zrlist">' + list + '</div>' : "") + '</div></div>';
    app.querySelector("[data-zback]").onclick = function () { view = { name: "plan", pid: s.pid, tab: "drill" }; zs = null; render(); };
    var rt = app.querySelector("[data-zretry]");
    if (rt) rt.onclick = function () { zs = { pid: s.pid, go: "wrong", title: "間違えた鳥獣をもう一度", ids: shuffle(wrong.map(function (a) { return a.id; })), idx: 0, answers: [], picked: null, opts: null, loading: false }; view = { name: "zsession", pid: s.pid }; render(); };
  }
  function renderZList() {
    var g = view.g || "bird";
    var list = ZUKAN.filter(function (z) { return z.g === g; });
    var card = function (z) { return '<figure>' + zPhoto(z, false) + '<figcaption><b>' + esc(z.name) + '</b>' + zTag(z) + '<span class="pt">' + esc(z.pt) + '</span></figcaption></figure>'; };
    app.innerHTML = '<header class="topbar"><div class="wrap"><button class="iconbtn" data-zlback aria-label="戻る">' + ICON.close + '</button><div class="ttl">鳥獣図鑑</div></div></header>' +
      '<div class="wrap" style="padding-block:16px 48px"><div class="seg" style="margin-bottom:12px"><button data-zg="bird" aria-pressed="' + (g === "bird") + '">鳥類</button><button data-zg="mammal" aria-pressed="' + (g === "mammal") + '">獣類</button></div>' +
      '<div class="section-label" style="margin-top:0">狩猟' + (g === "bird" ? "鳥 26種" : "獣 20種") + '</div><div class="zcmp grid">' + list.filter(function (z) { return z.hunt; }).map(card).join("") + '</div>' +
      '<div class="section-label">間違えやすい非狩猟' + (g === "bird" ? "鳥" : "獣") + '</div><div class="zcmp grid">' + list.filter(function (z) { return !z.hunt; }).map(card).join("") + '</div>' +
      '<p class="small muted">写真：Wikipedia／Wikimedia Commons の各記事の代表写真（撮影者・ライセンスは判別問題の解答後に出るリンクから確認できます）。</p></div>';
    app.querySelector("[data-zlback]").onclick = function () { view = { name: "plan", pid: view.pid, tab: "drill" }; render(); };
    app.querySelectorAll("[data-zg]").forEach(function (b) { b.onclick = function () { view.g = b.dataset.zg; renderZList(); }; });
    if (zNeed(list).length) zFetch(list).then(function () { if (view.name === "zlist") renderZList(); });
  }
  function zMenu() {
    var wrongN = ZUKAN.filter(function (z) { return zstat[z.id] && zstat[z.id].last === false; }).length;
    var rate = function (g) { var n = 0, ok = 0; ZUKAN.forEach(function (z) { if (z.g === g && zstat[z.id]) { n += zstat[z.id].n; ok += zstat[z.id].ok; } }); return n ? pct(ok, n) + "%" : "—"; };
    var nb = ZUKAN.filter(function (z) { return z.g === "bird"; }).length, nm = ZUKAN.length - nb;
    return '<div class="section-label">鳥獣判別（技能試験・写真）</div><div class="modes">' +
      '<button class="mode" data-zgo="exam"><span class="ic">判</span><span><span class="t">本番形式</span><span class="d">写真16枚（鳥8・獣8）。種名か「×」で答える</span></span><span class="n">16枚</span></button>' +
      '<button class="mode" data-zgo="bird"><span class="ic">鳥</span><span><span class="t">鳥類（網猟でよく出る）</span><span class="d">狩猟鳥26種＋間違えやすい非狩猟鳥</span></span><span class="n">' + nb + '枚<br><span class="small muted">' + rate("bird") + '</span></span></button>' +
      '<button class="mode" data-zgo="mammal"><span class="ic">獣</span><span><span class="t">獣類（わな猟でよく出る）</span><span class="d">狩猟獣20種＋間違えやすい非狩猟獣</span></span><span class="n">' + nm + '枚<br><span class="small muted">' + rate("mammal") + '</span></span></button>' +
      '<button class="mode" data-zgo="wrong"><span class="ic">×</span><span><span class="t">間違えた鳥獣</span><span class="d">最後に間違えた写真をまとめて</span></span><span class="n">' + wrongN + '枚</span></button>' +
      '<button class="mode" data-zlist><span class="ic">図</span><span><span class="t">鳥獣図鑑で覚える</span><span class="d">写真と見分けポイントの一覧</span></span><span class="n">' + ZUKAN.length + '種</span></button>' +
      '</div>';
  }

  // キーボード操作（PC）
  document.addEventListener("keydown", function (e) {
    if (view.name === "zsession" && zs && !e.target.matches("input,textarea,select")) {
      if (zs.picked == null && /^[1-4]$/.test(e.key) && zs.opts) { zAnswer(+e.key - 1); e.preventDefault(); }
      else if (zs.picked != null && (e.key === "Enter" || e.key === " ")) { zNext(); e.preventDefault(); }
      return;
    }
    if (view.name !== "session" || !session || e.target.matches("input,textarea,select")) return;
    if (session.picked == null && /^[1-3]$/.test(e.key)) { var ci = session.order[+e.key - 1]; if (ci != null) answer(ci); e.preventDefault(); }
    else if (session.picked != null && (e.key === "Enter" || e.key === " ")) { next(); e.preventDefault(); }
  });

  // ---------------- 起動 ----------------
  // 前の版で壊れた形のまま保存された計画・記録を、起動時に直す
  Object.keys(plans).forEach(function (id) { normPlan(plans[id]); });
  Object.keys(events).forEach(function (pid) { events[pid].forEach(normEvent); });
  persist();

  window.KARI = { schedule: schedule, fold: fold, daySet: daySet, addDays: addDays }; // テスト用
  render();
  if (apiReady()) pullPlans().then(function () { if (view.name === "slots") render(); });
})();
