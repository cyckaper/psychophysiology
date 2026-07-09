// netlify/functions/survey.mjs
// HEALS 景觀生心理研究 — 問卷定義端點（多語系版）
// 角色：面板問卷編輯頁 POST 存某專案的問卷；HealthProbe 收到「開始」時 GET 拉下來。
// 一個專案存兩份問卷：intake（入組，填一次）與 ema（現場，反應區觸發每次填）。
// 儲存：Netlify Blobs（store: "heals-surveys"，key = 專案名）。一個專案只寫一筆。
//
// 多語系（做法 A）：題目文字／選項標籤／量尺兩端都是語言物件 {zh, en, ja, …}。
//   手機依系統語言挑對應字；缺該語言時退回 defaultLang。答案永遠落在語言中立的
//   id（題）與 value（選項）欄位 → 跨國資料自動合併。
//
// 題型 type：
//   scale  量尺/Likert  { min, max, low:{lang}, high:{lang} }   答案：數字
//   single 單選         { choices:[{value, label:{lang}}] }       答案：value 字串
//   multi  複選         { choices:[{value, label:{lang}}] }       答案：value 字串陣列
//   text   開放填答      { multiline: bool }                       答案：文字
//   email  電子郵件      （前端驗格式）                             答案：文字
// 每題共通：id（英數短碼，資料欄位名）、text:{lang}（題目）、type、required（必填）
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const reply = (obj, status = 200) =>
  new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...CORS },
  });

const seg = (s, fb = "NA") => {
  const v = String(s ?? "").trim().replace(/[^\w#.-]/g, "_");
  return v.length ? v : fb;
};
// id / value：語言中立英數碼（資料欄位名，不可含中文或空白）
const cleanCode = (s, fb) => {
  const v = String(s ?? "").trim().replace(/[^A-Za-z0-9_-]/g, "");
  return v.length ? v : fb;
};
const str = (s) => String(s ?? "").trim();

const SUPPORTED_LANGS = ["zh", "en", "ja", "ko", "es", "fr", "de"];  // 可再擴充
const TYPES = ["scale", "single", "multi", "text", "email"];

// 清洗語言物件 {zh,en,...}；只留支援語言中非空的字。回傳物件（可能為空 {}）
function loc(obj) {
  const out = {};
  if (obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const k of SUPPORTED_LANGS) {
      const v = str(obj[k]);
      if (v) out[k] = v;
    }
  } else {
    // 容錯：若傳進來是純字串，當成預設語言先收著（前端理應傳物件）
    const v = str(obj);
    if (v) out.zh = v;
  }
  return out;
}
const locHasAny = (o) => o && Object.keys(o).length > 0;

// 清洗選項陣列：每個 {value, label:{lang}}。value 留空→自動 optN。回傳陣列
function sanitizeChoices(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  const seen = new Set();
  arr.forEach((c, i) => {
    const label = loc(c && (c.label ?? c.text ?? c));   // 容錯：可能直接傳字串
    if (!locHasAny(label)) return;                        // 沒任何語言的標籤 → 丟
    let value = cleanCode(c && c.value, "opt" + (i + 1));
    let v = value, k = 2;
    while (seen.has(v)) { v = value + "_" + k; k++; }      // 同題內 value 不得重複
    seen.add(v);
    out.push({ value: v, label });
  });
  return out.slice(0, 40);
}

// 清洗單一題目；不合法回 null
function sanitizeQuestion(q, idx) {
  if (!q || typeof q !== "object") return null;
  const type = TYPES.includes(q.type) ? q.type : null;
  if (!type) return null;
  const text = loc(q.text);
  if (!locHasAny(text)) return null;                       // 題目至少要有一種語言
  const id = cleanCode(q.id, "q" + (idx + 1));
  const base = { id, type, text, required: q.required === true };

  if (type === "scale") {
    let min = Number.isFinite(+q.min) ? Math.round(+q.min) : 1;
    let max = Number.isFinite(+q.max) ? Math.round(+q.max) : 5;
    if (max <= min) { min = 1; max = 5; }
    if (max - min > 20) max = min + 20;
    return { ...base, min, max, low: loc(q.low), high: loc(q.high) };
  }
  if (type === "single" || type === "multi") {
    const choices = sanitizeChoices(q.choices);
    if (choices.length < 2) return null;                   // 選項至少兩個
    return { ...base, choices };
  }
  if (type === "text") {
    return { ...base, multiline: q.multiline === true };
  }
  return base; // email
}

// 清洗一份問卷（intake 或 ema）；題目 id 去重
function sanitizeForm(form) {
  const title = loc(form && form.title);
  const arr = Array.isArray(form && form.questions) ? form.questions : [];
  const seen = new Set();
  const questions = [];
  arr.forEach((q, i) => {
    const c = sanitizeQuestion(q, i);
    if (!c) return;
    let id = c.id, k = 2;
    while (seen.has(id)) { id = c.id + "_" + k; k++; }
    seen.add(id);
    questions.push({ ...c, id });
  });
  return { title, questions };
}

// 清洗語言清單；確保 defaultLang 在清單內
function sanitizeLangs(langs, def) {
  let list = Array.isArray(langs) ? langs.filter((l) => SUPPORTED_LANGS.includes(l)) : [];
  if (!list.length) list = ["zh", "en"];
  let d = SUPPORTED_LANGS.includes(def) ? def : list[0];
  if (!list.includes(d)) d = list[0];
  return { languages: [...new Set(list)], defaultLang: d };
}

const EMPTY_FORM = { title: {}, questions: [] };

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });

  const store = getStore({ name: "heals-surveys", consistency: "strong" });
  const url = new URL(req.url);

  // POST /api/survey  body: { project, languages:[...], defaultLang, intake:{...}, ema:{...} }
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }
    const project = seg(body.project, "");
    if (!project) return reply({ error: "project required" }, 400);
    const { languages, defaultLang } = sanitizeLangs(body.languages, body.defaultLang);
    const intake = sanitizeForm(body.intake || {});
    const ema = sanitizeForm(body.ema || {});
    const record = {
      project, updatedAt: Date.now(), languages, defaultLang,
      counts: { intake: intake.questions.length, ema: ema.questions.length },
      intake, ema,
    };
    await store.setJSON(project, record);
    return reply({ ok: true, project, languages, defaultLang, counts: record.counts });
  }

  // GET /api/survey?project=X  → 一律回合法結構（沒設定過就回空）
  if (req.method === "GET") {
    const project = seg(url.searchParams.get("project"), "");
    if (!project) return reply({ error: "project required" }, 400);
    let v = null;
    try { v = await store.get(project, { type: "json" }); } catch { v = null; }
    if (!v) {
      return reply({ project, updatedAt: 0, languages: ["zh", "en"], defaultLang: "zh",
                     counts: { intake: 0, ema: 0 }, intake: EMPTY_FORM, ema: EMPTY_FORM });
    }
    v.intake = v.intake || EMPTY_FORM;
    v.ema = v.ema || EMPTY_FORM;
    if (!Array.isArray(v.languages)) v.languages = ["zh", "en"];
    if (!v.defaultLang) v.defaultLang = v.languages[0] || "zh";
    return reply(v);
  }

  return reply({ error: "method not allowed" }, 405);
};

export const config = { path: "/api/survey" };
