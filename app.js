// ============================================================
// スケジュールボード
// - 家族共通の合言葉でログイン(Firebase Auth 共有アカウント)
// - Firestoreでリアルタイム同期(オフライン対応)
// - B5(182×257mm)でホワイトボード風に印刷
// ============================================================

import { initializeApp } from "https://www.gstatic.com/firebasejs/12.16.0/firebase-app.js";
import {
  getAuth, onAuthStateChanged,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, getDoc, setDoc, onSnapshot, serverTimestamp
} from "https://www.gstatic.com/firebasejs/12.16.0/firebase-firestore.js";
import { firebaseConfig, FAMILY_EMAIL } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() })
});

// ---------------- 小さな道具 ----------------

const $ = (id) => document.getElementById(id);
const WD = ["日", "月", "火", "水", "木", "金", "土"];

function pad(n) { return String(n).padStart(2, "0"); }

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function parseDate(ds) {
  const [y, m, d] = ds.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function addDays(ds, n) {
  const d = parseDate(ds);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateJa(ds) {
  const d = parseDate(ds);
  return `${d.getMonth() + 1}/${d.getDate()}(${WD[d.getDay()]})`;
}

function dayClass(ds) {
  const w = parseDate(ds).getDay();
  return w === 0 ? "sun" : (w === 6 ? "sat" : "");
}

function newId() {
  return (crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).slice(2)).replace(/-/g, "").slice(0, 10);
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// ---------------- データ ----------------

// ============================================================
// ★ 毎日の基本テンプレート(自由に書き換えOK)
//    新しい日を開くと、最初からこの項目が並びます。
//    label: 緑ラベル名(空文字 "" ならラベルなしの枠)
//    items: その枠に最初から入れておく項目
//    ※「起きる」「お風呂」「就寝」は別枠で常に表示されます
// ============================================================
const DAY_TEMPLATE = [
  { label: "",     items: ["朝食", "昼食", "夕食", "ピアノ", "バイオリン"] },
  { label: "算数", items: ["計算", "テキスト"] },
  { label: "国語", items: ["漢字", "文章題"] },
  { label: "英語", items: ["テキスト", "単語"] }
];

function emptyDay(dateStr) {
  return {
    date: dateStr,
    wakeTime: "",
    bathTime: "",
    sleepTime: "",
    papaSchedule: "",
    mamaSchedule: "",
    nextTestDate: "",
    nextTestName: "",
    submissionDate: "",
    submissionHour: "",
    sections: DAY_TEMPLATE.map((t) => ({
      id: newId(), label: t.label, note: "", none: false,
      items: t.items.map((text) => ({ id: newId(), text: text, time: "", done: false }))
    }))
  };
}

function normalize(data, dateStr) {
  const d = data || {};
  return {
    date: dateStr,
    wakeTime: String(d.wakeTime ?? ""),
    bathTime: String(d.bathTime ?? ""),
    sleepTime: String(d.sleepTime ?? ""),
    papaSchedule: String(d.papaSchedule ?? ""),
    mamaSchedule: String(d.mamaSchedule ?? ""),
    nextTestDate: String(d.nextTestDate ?? ""),
    nextTestName: String(d.nextTestName ?? d.nextTest ?? ""),
    submissionDate: String(d.submissionDate ?? ""),
    submissionHour: String(d.submissionHour ?? ""),
    sections: Array.isArray(d.sections) ? d.sections.map((s) => ({
      id: String(s.id ?? newId()),
      label: String(s.label ?? ""),
      note: String(s.note ?? ""),
      none: Boolean(s.none),
      items: Array.isArray(s.items) ? s.items.map((it) => ({
        id: String(it.id ?? newId()),
        text: String(it.text ?? ""),
        time: String(it.time ?? ""),
        done: Boolean(it.done)
      })) : []
    })) : []
  };
}

// ---------------- 状態 ----------------

let uid = null;
let currentDate = todayStr();
let day = emptyDay(currentDate);
let unsub = null;
let saveTimer = null;
let dirty = false;

function dayRef(dateStr) {
  return doc(db, "families", uid, "days", dateStr);
}

function findSec(sid) { return day.sections.find((s) => s.id === sid); }

// ---------------- 保存 ----------------

function setStatus(t) { $("syncStatus").textContent = t; }

function scheduleSave() {
  dirty = true;
  setStatus(navigator.onLine ? "保存中…" : "オフライン(接続時に自動同期)");
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 700);
}

function saveNow() {
  clearTimeout(saveTimer);
  if (!uid || !dirty) return;
  dirty = false;
  const data = { ...day, updatedAt: serverTimestamp() };
  setDoc(dayRef(day.date), data)
    .then(() => { if (!dirty) setStatus("同期しました ✓"); })
    .catch(() => setStatus("保存できませんでした(通信を確認してください)"));
  if (!navigator.onLine) setStatus("オフラインに保存(接続時に自動同期)");
}

function flushSave() { if (dirty) saveNow(); }

// ---------------- 読み込み ----------------

function loadDay(dateStr) {
  flushSave();
  if (unsub) { unsub(); unsub = null; }
  currentDate = dateStr;
  day = emptyDay(dateStr);
  render();
  unsub = onSnapshot(dayRef(dateStr), (snap) => {
    if (snap.metadata.hasPendingWrites) return;      // 自分の書き込みの反響は無視
    const incoming = snap.exists() ? normalize(snap.data(), dateStr) : emptyDay(dateStr);
    if (stripIds(incoming) === stripIds(day)) return;   // 内容が同じなら何もしない
    day = incoming;
    renderPreserveFocus();
  }, () => setStatus("読み込みエラー(通信を確認してください)"));
}

// ---------------- 描画 ----------------

function itemHTML(sec, it) {
  return `
  <div class="item ${it.done ? "done" : ""}">
    <input type="checkbox" data-chk data-sid="${sec.id}" data-iid="${it.id}" ${it.done ? "checked" : ""} aria-label="できたらチェック">
    <input class="itText" data-k="it:${sec.id}:${it.id}:text" value="${esc(it.text)}" placeholder="やること">
    <input class="itTime" data-k="it:${sec.id}:${it.id}:time" value="${esc(it.time)}" placeholder="19:00〜">
    <div class="itBtns">
      <button class="iconBtn" data-act="itUp" data-sid="${sec.id}" data-iid="${it.id}" aria-label="上へ">↑</button>
      <button class="iconBtn" data-act="itDown" data-sid="${sec.id}" data-iid="${it.id}" aria-label="下へ">↓</button>
      <button class="iconBtn" data-act="itDel" data-sid="${sec.id}" data-iid="${it.id}" aria-label="削除">✕</button>
    </div>
  </div>`;
}

function secHTML(sec) {
  return `
  <section class="sec" data-sec="${sec.id}">
    <div class="secHead">
      <input class="secLabel ${sec.label.trim() ? "hasLabel" : ""}" data-k="sec:${sec.id}:label"
             value="${esc(sec.label)}" placeholder="ラベル(例: 算数)">
      <button class="chip ${sec.none ? "on" : ""}" data-act="secNone" data-sid="${sec.id}">なし</button>
      <button class="iconBtn" data-act="secUp" data-sid="${sec.id}" aria-label="上へ">↑</button>
      <button class="iconBtn" data-act="secDown" data-sid="${sec.id}" aria-label="下へ">↓</button>
      <button class="iconBtn" data-act="secDel" data-sid="${sec.id}" aria-label="削除">✕</button>
    </div>
    <input class="secNote" data-k="sec:${sec.id}:note" value="${esc(sec.note)}" placeholder="メモ(例: 漢字・文章)">
    <div class="items ${sec.none ? "isNone" : ""}">
      ${sec.items.map((it) => itemHTML(sec, it)).join("")}
    </div>
    ${sec.none ? `<div class="noneBadge">→ なし</div>` : ""}
    <button class="addItem" data-act="addItem" data-sid="${sec.id}">+ 項目を追加</button>
  </section>`;
}

function setIfNotFocused(sel, value) {
  const el = document.querySelector(sel);
  if (el && document.activeElement !== el) el.value = value;
}

function render() {
  const label = $("dateLabel");
  label.textContent = fmtDateJa(currentDate);
  label.className = `dateLabel ${dayClass(currentDate)}`;
  $("dateInput").value = currentDate;

  setIfNotFocused('[data-k="wakeTime"]', day.wakeTime);
  setIfNotFocused('[data-k="bathTime"]', day.bathTime);
  setIfNotFocused('[data-k="sleepTime"]', day.sleepTime);
  setIfNotFocused('[data-k="papaSchedule"]', day.papaSchedule);
  setIfNotFocused('[data-k="mamaSchedule"]', day.mamaSchedule);
  setIfNotFocused('[data-k="nextTestDate"]', day.nextTestDate);
  setIfNotFocused('[data-k="nextTestName"]', day.nextTestName);
  setIfNotFocused('[data-k="submissionDate"]', day.submissionDate);
  setIfNotFocused('[data-k="submissionHour"]', day.submissionHour);
  updateDateWeekdayHints();

  $("sections").innerHTML = day.sections.map(secHTML).join("");
}

function renderPreserveFocus() {
  const a = document.activeElement;
  const key = a && a.dataset ? a.dataset.k : null;
  let s = 0, e = 0;
  if (key) { try { s = a.selectionStart; e = a.selectionEnd; } catch (_) {} }
  render();
  if (key) {
    const n = document.querySelector(`[data-k="${key}"]`);
    if (n) { n.focus(); try { n.setSelectionRange(s, e); } catch (_) {} }
  }
}

function focusKey(key, toEnd = true) {
  const n = document.querySelector(`[data-k="${key}"]`);
  if (n) {
    n.focus();
    if (toEnd) { try { const L = n.value.length; n.setSelectionRange(L, L); } catch (_) {} }
  }
}

// ---------------- 編集アクション ----------------

function handleInput(ev) {
  const k = ev.target.dataset.k;
  if (!k) return;
  const v = ev.target.value;
  const p = k.split(":");
  if (p.length === 1) {
    day[k] = v;
  } else if (p[0] === "sec") {
    const sec = findSec(p[1]);
    if (!sec) return;
    sec[p[2]] = v;
    if (p[2] === "label") ev.target.classList.toggle("hasLabel", v.trim() !== "");
  } else if (p[0] === "it") {
    const sec = findSec(p[1]);
    const it = sec && sec.items.find((x) => x.id === p[2]);
    if (!it) return;
    it[p[3]] = v;
  }
  if (k === "nextTestDate" || k === "submissionDate") updateDateWeekdayHints();
  scheduleSave();
}

function handleCheck(ev) {
  const t = ev.target;
  if (!t.hasAttribute("data-chk")) return;
  const sec = findSec(t.dataset.sid);
  const it = sec && sec.items.find((x) => x.id === t.dataset.iid);
  if (!it) return;
  it.done = t.checked;
  scheduleSave();
  render();
}

function move(arr, i, delta) {
  const j = i + delta;
  if (i < 0 || j < 0 || j >= arr.length) return;
  const [x] = arr.splice(i, 1);
  arr.splice(j, 0, x);
}

function handleAction(act, ds) {
  const sec = ds.sid ? findSec(ds.sid) : null;

  if (act === "addSec") {
    const s = { id: newId(), label: ds.label || "", note: "", none: false,
                items: [{ id: newId(), text: "", time: "", done: false }] };
    day.sections.push(s);
    render(); scheduleSave();
    focusKey(s.label ? `it:${s.id}:${s.items[0].id}:text` : `sec:${s.id}:label`);
    return;
  }
  if (!sec) return;

  if (act === "addItem") {
    const it = { id: newId(), text: "", time: "", done: false };
    sec.items.push(it);
    render(); scheduleSave();
    focusKey(`it:${sec.id}:${it.id}:text`);
  } else if (act === "itDel") {
    sec.items = sec.items.filter((x) => x.id !== ds.iid);
    render(); scheduleSave();
  } else if (act === "itUp" || act === "itDown") {
    const i = sec.items.findIndex((x) => x.id === ds.iid);
    move(sec.items, i, act === "itUp" ? -1 : 1);
    render(); scheduleSave();
  } else if (act === "secNone") {
    sec.none = !sec.none;
    render(); scheduleSave();
  } else if (act === "secDel") {
    const hasContent = sec.label.trim() || sec.note.trim() || sec.items.some((x) => x.text.trim());
    if (hasContent && !confirm(`「${sec.label.trim() || "この枠"}」を削除しますか?`)) return;
    day.sections = day.sections.filter((s) => s.id !== sec.id);
    render(); scheduleSave();
  } else if (act === "secUp" || act === "secDown") {
    const i = day.sections.findIndex((s) => s.id === sec.id);
    move(day.sections, i, act === "secUp" ? -1 : 1);
    render(); scheduleSave();
  }
}

// ---------------- 前の日からコピー ----------------

async function copyPrev() {
  const pristine = stripIds(day) === stripIds(emptyDay(currentDate));
  if (!pristine && !confirm("今の内容を上書きしてコピーしますか?")) return;
  setStatus("さがしています…");
  for (let i = 1; i <= 14; i++) {
    const ds = addDays(currentDate, -i);
    let snap;
    try { snap = await getDoc(dayRef(ds)); }
    catch (_) { setStatus("通信エラーで確認できませんでした"); return; }
    if (snap.exists()) {
      const prev = normalize(snap.data(), ds);
      day = {
        date: currentDate,
        wakeTime: prev.wakeTime,
        bathTime: prev.bathTime,
        sleepTime: prev.sleepTime,
        papaSchedule: prev.papaSchedule,
        mamaSchedule: prev.mamaSchedule,
        nextTestDate: prev.nextTestDate,
        nextTestName: prev.nextTestName,
        submissionDate: prev.submissionDate,
        submissionHour: prev.submissionHour,
        sections: prev.sections.map((s) => ({
          id: newId(), label: s.label, note: s.note, none: false,
          items: s.items.map((it) => ({ id: newId(), text: it.text, time: it.time, done: false }))
        }))
      };
      render();
      dirty = true;
      saveNow();
      setStatus(`${fmtDateJa(ds)} の内容をコピーしました`);
      return;
    }
  }
  setStatus("直近14日に予定が見つかりませんでした");
}

// 「まっさらな状態か」を判定するための比較用(idを除いて比べる)
function stripIds(d) {
  return JSON.stringify({ ...d, sections: d.sections.map((s) => ({ ...s, id: "", items: s.items.map((it) => ({ ...it, id: "" })) })) });
}

// ---------------- 印刷 ----------------

function timeSortValue(value) {
  // 「8:00」「8：00」「19:00〜」など、先頭の時刻を並べ替えに使う。
  const m = String(value ?? "").trim().match(/^(\d{1,2})\s*[:：]\s*(\d{1,2})/);
  if (!m) return Number.POSITIVE_INFINITY;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return Number.POSITIVE_INFINITY;
  return h * 60 + min;
}

function formatMonthDayWithWeekday(value) {
  const raw = String(value ?? "").trim();
  const m = raw.match(/^(\d{1,2})\s*[\/／.-]\s*(\d{1,2})$/);
  if (!m) return raw;
  const month = Number(m[1]);
  const date = Number(m[2]);
  if (month < 1 || month > 12 || date < 1 || date > 31) return raw;

  const base = parseDate(currentDate);
  let year = base.getFullYear();
  let d = new Date(year, month - 1, date);
  if (d.getMonth() !== month - 1 || d.getDate() !== date) return raw;
  // 「次の」日付として、選択日より半年以上前なら翌年とみなす。
  if ((d - base) < -183 * 24 * 60 * 60 * 1000) {
    year += 1;
    d = new Date(year, month - 1, date);
  }
  return `${month}/${date}（${WD[d.getDay()]}）`;
}

function updateDateWeekdayHints() {
  const testEl = $("nextTestWeekday");
  const submitEl = $("submissionWeekday");
  if (testEl) {
    const formatted = formatMonthDayWithWeekday(day.nextTestDate);
    testEl.textContent = formatted && formatted !== String(day.nextTestDate ?? "").trim()
      ? formatted.replace(/^.*（/, "（")
      : "";
  }
  if (submitEl) {
    const formatted = formatMonthDayWithWeekday(day.submissionDate);
    submitEl.textContent = formatted && formatted !== String(day.submissionDate ?? "").trim()
      ? formatted.replace(/^.*（/, "（")
      : "";
  }
}

function cleanSubmissionHour(value) {
  return String(value ?? "").trim().replace(/時まで$/, "").replace(/時$/, "").trim();
}

function dailyPrintClass(text) {
  switch (String(text ?? "").trim()) {
    case "起きる": return "pWake";
    case "朝食":
    case "昼食":
    case "夕食": return "pMeal";
    case "お風呂": return "pBath";
    case "就寝": return "pSleep";
    default: return "";
  }
}

function buildPrintSheet() {
  const parts = [];
  parts.push(`<div class="pDateOnly ${dayClass(currentDate)}">${esc(fmtDateJa(currentDate))}</div>`);

  // 起床・各項目・お風呂・就寝を1つに集め、時刻順に並べる。
  const timeline = [];
  let order = 0;
  const pushTimeline = (label, text, time, kind = "item") => {
    const cleanText = String(text ?? "").trim();
    const cleanTime = String(time ?? "").trim();
    if (!cleanText && !cleanTime) return;
    timeline.push({ label, text: cleanText, time: cleanTime, kind, order: order++ });
  };

  pushTimeline("", "起きる", day.wakeTime, "daily");
  for (const sec of day.sections) {
    if (sec.none) {
      if (sec.label.trim() || sec.note.trim()) {
        pushTimeline(sec.label, `${sec.note.trim() ? `${sec.note.trim()} ` : ""}→ なし`, "", "none");
      }
      continue;
    }
    for (const it of sec.items) {
      if (!it.text.trim() && !it.time.trim()) continue;
      const meal = ["朝食", "昼食", "夕食"].includes(it.text.trim());
      pushTimeline(sec.label, it.text, it.time, meal ? "daily" : "item");
    }
  }
  pushTimeline("", "お風呂", day.bathTime, "daily");
  pushTimeline("", "就寝", day.sleepTime, "daily");

  timeline.sort((a, b) => {
    const av = timeSortValue(a.time);
    const bv = timeSortValue(b.time);
    if (av === bv) return a.order - b.order;
    return av - bv;
  });

  parts.push('<div class="pTimeline">');
  let previousLabel = null;
  for (const row of timeline) {
    if (row.kind === "daily") {
      // daily行は専用の2要素だけを出力する。非表示要素を残さないことで、
      // B5印刷時の列ずれ・不要な改行を防ぐ。
      parts.push(`
        <div class="pTimelineRow pDailyRow">
          <span class="pTime">${row.time ? esc(row.time) : ""}</span>
          <span class="pDailyMarker ${dailyPrintClass(row.text)}">${esc(row.text)}</span>
        </div>`);
      previousLabel = null;
      continue;
    }

    const showLabel = row.label && row.label !== previousLabel;
    if (row.label) previousLabel = row.label;
    else previousLabel = null;

    parts.push(`
      <div class="pTimelineRow ${row.kind === "none" ? "pNoneRow" : ""}">
        <span class="pTime">${row.time ? esc(row.time) : ""}</span>
        <div class="pTimelineLabel">${showLabel ? `<span class="pMagnet">${esc(row.label)}</span>` : ""}</div>
        <span class="pChk ${row.kind === "none" ? "pChkHidden" : ""}"></span>
        <span class="pTimelineText">${esc(row.text)}</span>
      </div>`);
  }
  parts.push('</div>');

  parts.push(`
    <div class="pFamilyPlans">
      <div class="pFamilyPlan pMamaPlan"><span class="pFamilyLabel">ママの予定</span><span>${esc(day.mamaSchedule).replace(/\n/g, "<br>") || "　"}</span></div>
      <div class="pFamilyPlan pPapaPlan"><span class="pFamilyLabel">パパの予定</span><span>${esc(day.papaSchedule).replace(/\n/g, "<br>") || "　"}</span></div>
      <div class="pNextTest"><span class="pNextTestLead">次のテストは</span><span class="pNextTestValue">${esc([formatMonthDayWithWeekday(day.nextTestDate), day.nextTestName].filter(Boolean).join(" ")) || "　　　　　　　　　"}</span></div>
      <div class="pSubmission"><span class="pSubmissionLead">提出予定日</span><span class="pSubmissionValue">${esc(formatMonthDayWithWeekday(day.submissionDate)) || "　　　　"}${cleanSubmissionHour(day.submissionHour) ? `　${esc(cleanSubmissionHour(day.submissionHour))}時まで` : ""}</span></div>
    </div>`);

  $("printSheet").innerHTML = parts.join("");
}
function printDay() {
  flushSave();
  buildPrintSheet();

  // iPhone/iPadのSafariは、タップ操作から時間を空けてwindow.print()を
  // 呼ぶとユーザー操作として認識されず、印刷画面が開かない場合がある。
  // 印刷DOMを同期的に作成し、強制レイアウト後すぐに印刷を呼び出す。
  const printSheet = $("printSheet");
  void printSheet.offsetHeight;

  const ua = navigator.userAgent;
  const isIOS = /iP(hone|ad|od)/.test(ua) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  const isSafari = /Safari/.test(ua) && !/(CriOS|FxiOS|EdgiOS|OPiOS)/.test(ua);

  if (isIOS && isSafari) {
    window.print();
    return;
  }

  requestAnimationFrame(() => window.print());
}

// Safariの共有メニューなど別経路から印刷された場合にも、
// 必ず最新内容で印刷用シートを作り直す。
window.addEventListener("beforeprint", buildPrintSheet);

// ---------------- ログイン ----------------

function authErrorJa(code) {
  switch (code) {
    case "auth/invalid-credential":
    case "auth/invalid-login-credentials":
    case "auth/wrong-password":
    case "auth/user-not-found":
      return "合言葉がちがうか、まだ登録されていません。初めての場合は下の「初回セットアップ」から登録してください。";
    case "auth/missing-password":
      return "合言葉を入力してください。";
    case "auth/weak-password":
      return "合言葉は6文字以上にしてください。";
    case "auth/email-already-in-use":
      return "すでに登録済みです。上のログイン欄に合言葉を入力してください。";
    case "auth/too-many-requests":
      return "試行回数が多すぎます。少し待ってからもう一度お試しください。";
    case "auth/network-request-failed":
      return "通信エラーです。接続を確認してください。";
    case "auth/invalid-email":
      return "設定エラー: firebase-config.js の FAMILY_EMAIL を確認してください。";
    case "auth/operation-not-allowed":
      return "設定エラー: Firebaseコンソールで「メール/パスワード」ログインを有効にしてください(README手順2)。";
    default:
      return `エラーが発生しました(${code || "不明"})。`;
  }
}

async function doLogin() {
  const btn = $("loginBtn");
  $("loginError").textContent = "";
  btn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, FAMILY_EMAIL, $("loginPass").value);
  } catch (e) {
    $("loginError").textContent = authErrorJa(e.code);
  } finally {
    btn.disabled = false;
  }
}

async function doSetup() {
  const btn = $("setupBtn");
  $("setupError").textContent = "";
  btn.disabled = true;
  try {
    await createUserWithEmailAndPassword(auth, FAMILY_EMAIL, $("setupPass").value);
  } catch (e) {
    $("setupError").textContent = authErrorJa(e.code);
  } finally {
    btn.disabled = false;
  }
}

// ---------------- 画面の切り替えとイベント ----------------

onAuthStateChanged(auth, (user) => {
  if (user) {
    uid = user.uid;
    $("loginView").classList.add("hidden");
    $("appView").classList.remove("hidden");
    loadDay(currentDate);
  } else {
    uid = null;
    if (unsub) { unsub(); unsub = null; }
    $("appView").classList.add("hidden");
    $("loginView").classList.remove("hidden");
  }
});

$("loginBtn").addEventListener("click", doLogin);
$("setupBtn").addEventListener("click", doSetup);
$("loginPass").addEventListener("keydown", (e) => { if (e.key === "Enter") doLogin(); });
$("setupPass").addEventListener("keydown", (e) => { if (e.key === "Enter") doSetup(); });
$("loginShow").addEventListener("change", (e) => {
  $("loginPass").type = e.target.checked ? "text" : "password";
});

$("prevDay").addEventListener("click", () => loadDay(addDays(currentDate, -1)));
$("nextDay").addEventListener("click", () => loadDay(addDays(currentDate, 1)));
$("dateInput").addEventListener("change", (e) => { if (e.target.value) loadDay(e.target.value); });
$("printBtn").addEventListener("click", printDay);
$("copyPrev").addEventListener("click", copyPrev);
$("logoutBtn").addEventListener("click", async () => { flushSave(); await signOut(auth); });

const appView = $("appView");
appView.addEventListener("input", handleInput);
appView.addEventListener("change", handleCheck);
appView.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (btn) handleAction(btn.dataset.act, btn.dataset);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") flushSave();
});
window.addEventListener("pagehide", flushSave);
window.addEventListener("online", () => { if (dirty) saveNow(); });

render();
