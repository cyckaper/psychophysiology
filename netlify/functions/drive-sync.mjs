// drive-sync.mjs — 場次自動封存 Google Drive /api/drive-sync
// 掃描 heals-data 全部場次，尚未推送者以服務帳戶打包上傳：
//   Drive 根資料夾（GDRIVE_FOLDER_ID）／專案代號／編號_時間_場次短碼／
//     問卷.json（intake 含 email，＋ema 作答；兩者皆無則不建此檔）
//     生理.json、軌跡.json、環境.json（空流略過）
// 已推送清單記在 store: heals-drive-log（key 與場次相同），天生冪等、可重試。
// 由 drive-sync-cron.mjs 每 5 分鐘呼叫；也可直接開 /api/drive-sync 手動觸發驗證。
// 需要環境變數：GDRIVE_SA_KEY（服務帳戶金鑰 JSON 全文）、GDRIVE_FOLDER_ID（共享資料夾 ID）。
import { getStore } from "@netlify/blobs";
import { createSign } from "node:crypto";

const MAX_PER_RUN = 3;        // 每輪最多推送場次數（控制在函式時限內）
const TIME_BUDGET_MS = 7000;  // 逾時保護

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: HEADERS });

/* ---- 服務帳戶 → access token（RS256 JWT，無外部依賴） ---- */
function b64url(input) {
  return Buffer.from(input).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function getAccessTokenOAuth() {
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=refresh_token"
      + "&refresh_token=" + encodeURIComponent(process.env.GDRIVE_OAUTH_REFRESH_TOKEN)
      + "&client_id=" + encodeURIComponent(process.env.GDRIVE_OAUTH_CLIENT_ID)
      + "&client_secret=" + encodeURIComponent(process.env.GDRIVE_OAUTH_CLIENT_SECRET),
  });
  if (!resp.ok) throw new Error("OAuth 換 token 失敗 HTTP " + resp.status + "：" + (await resp.text()).slice(0, 200));
  const d = await resp.json();
  if (!d.access_token) throw new Error("OAuth 回應缺 access_token");
  return d.access_token;
}

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const input = header + "." + claims;
  const sig = b64url(createSign("RSA-SHA256").update(input).sign(sa.private_key));
  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: "grant_type=" + encodeURIComponent("urn:ietf:params:oauth:grant-type:jwt-bearer")
        + "&assertion=" + encodeURIComponent(input + "." + sig),
  });
  if (!resp.ok) throw new Error("取 token 失敗 HTTP " + resp.status + "：" + (await resp.text()).slice(0, 200));
  const d = await resp.json();
  if (!d.access_token) throw new Error("token 回應缺 access_token");
  return d.access_token;
}

/* ---- Drive 基本操作 ---- */
async function driveFindFolder(token, name, parentId) {
  const q = encodeURIComponent(
    "name='" + name.replace(/'/g, "\\'") + "'"
    + " and '" + parentId + "' in parents"
    + " and mimeType='application/vnd.google-apps.folder' and trashed=false");
  const r = await fetch("https://www.googleapis.com/drive/v3/files?q=" + q + "&fields=files(id)&pageSize=1", {
    headers: { Authorization: "Bearer " + token },
  });
  if (!r.ok) throw new Error("查資料夾失敗 HTTP " + r.status + "：" + (await r.text()).slice(0, 200));
  const d = await r.json();
  return (d.files && d.files[0] && d.files[0].id) || null;
}
async function driveCreateFolder(token, name, parentId) {
  const r = await fetch("https://www.googleapis.com/drive/v3/files?fields=id", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify({ name, mimeType: "application/vnd.google-apps.folder", parents: [parentId] }),
  });
  if (!r.ok) throw new Error("建資料夾失敗 HTTP " + r.status + "：" + (await r.text()).slice(0, 200));
  return (await r.json()).id;
}
async function driveEnsureFolder(token, name, parentId, cache) {
  const ck = parentId + "/" + name;
  if (cache.has(ck)) return cache.get(ck);
  let id = await driveFindFolder(token, name, parentId);
  if (!id) id = await driveCreateFolder(token, name, parentId);
  cache.set(ck, id);
  return id;
}
async function driveUploadJSON(token, name, obj, parentId) {
  const boundary = "heals" + Date.now() + Math.random().toString(36).slice(2, 8);
  const meta = JSON.stringify({ name, parents: [parentId] });
  const content = JSON.stringify(obj, null, 1);
  const body =
    "--" + boundary + "\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n" + meta +
    "\r\n--" + boundary + "\r\nContent-Type: application/json\r\n\r\n" + content +
    "\r\n--" + boundary + "--";
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "multipart/related; boundary=" + boundary },
    body,
  });
  if (!r.ok) throw new Error("上傳「" + name + "」失敗 HTTP " + r.status + "：" + (await r.text()).slice(0, 200));
  return (await r.json()).id;
}
async function driveUpdateJSON(token, fileId, obj) {
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files/" + fileId + "?uploadType=media&fields=id", {
    method: "PATCH",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(obj, null, 1),
  });
  if (!r.ok) throw new Error("更新檔案失敗 HTTP " + r.status + "：" + (await r.text()).slice(0, 200));
  return (await r.json()).id;
}

/* ---- 小工具 ---- */
function tpeStamp(ms) {
  // Asia/Taipei 的 YYYYMMDD-HHmm
  const s = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms || Date.now()));
  return s.replace(/[^\d]/g, "").slice(0, 12).replace(/^(\d{8})(\d{4})$/, "$1-$2");
}
function findEmail(obj) {
  // 深度掃描 intake 物件，抓出第一個像 email 的字串（不依賴特定欄位名）
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
  const stack = [obj];
  let guard = 0;
  while (stack.length && guard++ < 2000) {
    const cur = stack.pop();
    if (cur == null) continue;
    if (typeof cur === "string") { if (re.test(cur.trim())) return cur.trim(); continue; }
    if (Array.isArray(cur)) { for (const v of cur) stack.push(v); continue; }
    if (typeof cur === "object") { for (const k of Object.keys(cur)) stack.push(cur[k]); }
  }
  return null;
}
const sess6 = (s) => { s = String(s || ""); return s.length > 6 ? s.slice(-6) : s; };

/* ---- 主流程 ---- */
export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });

  const started = Date.now();
  const rootId = process.env.GDRIVE_FOLDER_ID;
  const oauthReady = !!(process.env.GDRIVE_OAUTH_REFRESH_TOKEN
    && process.env.GDRIVE_OAUTH_CLIENT_ID
    && process.env.GDRIVE_OAUTH_CLIENT_SECRET);
  const keyRaw = process.env.GDRIVE_SA_KEY;
  if (!rootId) return json({ error: "尚未設定 GDRIVE_FOLDER_ID 環境變數" }, 500);
  if (!oauthReady && !keyRaw) {
    return json({ error: "尚未設定授權：請提供 GDRIVE_OAUTH_CLIENT_ID / GDRIVE_OAUTH_CLIENT_SECRET / GDRIVE_OAUTH_REFRESH_TOKEN（建議，檔案歸你本人），或 GDRIVE_SA_KEY（僅適用共用雲端硬碟）" }, 500);
  }
  let sa = null;
  if (!oauthReady) {
    try { sa = JSON.parse(keyRaw); } catch { return json({ error: "GDRIVE_SA_KEY 不是有效 JSON" }, 500); }
    if (!sa.client_email || !sa.private_key) {
      return json({ error: "GDRIVE_SA_KEY 缺 client_email 或 private_key" }, 500);
    }
  }

  const dataStore = getStore({ name: "heals-data", consistency: "strong" });
  const logStore  = getStore({ name: "heals-drive-log", consistency: "strong" });
  const idxStore  = getStore({ name: "heals-data-index", consistency: "strong" });

  // 場次來源＝清單簿（上傳當下登記、強一致單筆讀、即時） ∪ list()（撈漏網）
  // 清單簿的值：舊式為上傳時間數字，新式為 {t, final}——final=false 代表走測中的定期備份
  const manifestInfo = {};
  try {
    const man = await idxStore.get("manifest", { type: "json" });
    if (man && man.keys && typeof man.keys === "object") {
      for (const k of Object.keys(man.keys)) {
        const v = man.keys[k];
        manifestInfo[k] = (v && typeof v === "object")
          ? { t: Number(v.t) || 0, final: v.final !== false }
          : { t: Number(v) || 0, final: true };
      }
    }
  } catch (_) { /* 尚無清單簿 */ }
  const { blobs } = await dataStore.list();
  const allKeys = Array.from(new Set([...Object.keys(manifestInfo), ...blobs.map((b) => b.key)]));

  const logDump = {};
  const pending = [];      // 定稿、尚未封存 → 建檔
  const updates = [];      // 封存後又補傳（如充電同步後補心率）→ 原地更新同名檔
  const inProgress = [];   // 走測中的定期備份 → 資料已在後端，Drive 等定稿
  for (const key of allKeys) {
    let done = null;
    try { done = await logStore.get(key, { type: "json" }); } catch (_) { /* 未推送 */ }
    logDump[key] = done;
    const info = manifestInfo[key] || { t: 0, final: true };
    if (done && done.skipped) continue;
    if (!done) {
      if (info.final === false) { inProgress.push(key); continue; }
      pending.push(key);
    } else if (info.final !== false && info.t > (done.syncedAt || 0)) {
      updates.push(key);
    }
  }
  pending.sort(); updates.sort();

  const url = new URL(req.url);
  const wantProbe = url.searchParams.get("probe");
  const redoKey = url.searchParams.get("redo");

  if (redoKey) {
    try { await logStore.delete(redoKey); } catch (_) {}
    return json({ ok: true, redo: redoKey, note: "已清除該場次的記帳；再開本網址（不帶參數）即重新推送" });
  }

  if (!pending.length && !updates.length && !wantProbe) {
    return json({
      ok: true, scanned: allKeys.length, pending: 0, synced: [], inProgress,
      note: "全部定稿場次皆已封存" + (inProgress.length ? "；走測中 " + inProgress.length + " 場定期備份中" : ""),
    });
  }

  let token;
  try { token = sa ? await getAccessToken(sa) : await getAccessTokenOAuth(); }
  catch (e) { return json({ error: String(e.message || e) }, 502); }

  // 開工前先驗證根資料夾：ID 錯、未分享、或 Drive API 未啟用都在這裡一次講清楚
  const chk = await fetch("https://www.googleapis.com/drive/v3/files/" + encodeURIComponent(rootId) + "?fields=id,name", {
    headers: { Authorization: "Bearer " + token },
  });
  if (!chk.ok) {
    const t = (await chk.text().catch(() => "")).slice(0, 300);
    return json({
      error: "根資料夾檢查失敗 HTTP " + chk.status + "：" + t,
      hint: "404＝GDRIVE_FOLDER_ID 不對（要抄進入資料夾後網址列 folders/ 後那串）或未分享給服務帳戶；403 且內文含 accessNotConfigured＝要到 Cloud 專案「API 和服務 → 程式庫」啟用 Google Drive API。",
    }, 502);
  }

  if (wantProbe) {
    const rootInfo = await chk.json().catch(() => null);
    const authH = { headers: { Authorization: "Bearer " + token } };
    const q1 = encodeURIComponent("'" + rootId + "' in parents and trashed=false");
    const kids = await fetch("https://www.googleapis.com/drive/v3/files?q=" + q1 + "&fields=files(id,name,mimeType,owners(emailAddress))&pageSize=50", authH)
      .then((r) => r.json()).catch((e) => ({ error: String(e) }));
    const q2 = encodeURIComponent("'root' in parents and trashed=false");
    const home = await fetch("https://www.googleapis.com/drive/v3/files?q=" + q2 + "&fields=files(id,name,mimeType)&pageSize=50", authH)
      .then((r) => r.json()).catch((e) => ({ error: String(e) }));
    return json({
      probe: true,
      authMode: sa ? "service-account" : "oauth-user",
      root: rootInfo,                      // 服務帳戶眼中的根資料夾（name 應為你的資料夾名）
      rootChildren: kids.files || kids,    // 它看到根資料夾底下有什麼
      saHome: home.files || home,          // 它「自己家」裡的流浪檔案
      log: logDump,                        // 記帳簿內容
      pendingKeys: pending,
      updateKeys: updates,
      inProgress,
    });
  }

  const folderCache = new Map();
  const synced = [], failed = [], skipped = [];
  const work = [
    ...pending.map((k) => ({ key: k, mode: "new" })),
    ...updates.map((k) => ({ key: k, mode: "update" })),
  ];

  for (const item of work) {
    const key = item.key;
    if (synced.length >= MAX_PER_RUN) break;
    if (Date.now() - started > TIME_BUDGET_MS) break;
    if (!/^[^/]+\/[^/]+\/[^/]+$/.test(key)) {
      // 早期版本殘留的畸形鍵（如「aa/」）：標記略過，永不重試
      await logStore.setJSON(key, { skipped: "malformed", at: Date.now() });
      skipped.push(key);
      continue;
    }
    try {
      const rec = await dataStore.get(key, { type: "json" });
      if (!rec) { failed.push({ key, error: "記錄讀取為空" }); continue; }

      // 更新模式沿用先前記帳的資料夾；建檔模式才找／建資料夾
      const prev = item.mode === "update" ? logDump[key] : null;
      let projFolder, sessFolder, folderName;
      if (prev && prev.folderId) {
        projFolder = prev.projectFolderId || null;
        sessFolder = prev.folderId;
        folderName = prev.folder || "";
      } else {
        projFolder = await driveEnsureFolder(token, rec.project || key.split("/")[0], rootId, folderCache);
        folderName = (rec.code || "NA") + "_" + tpeStamp(rec.uploadedAt) + "_" + sess6(rec.session);
        sessFolder = await driveEnsureFolder(token, folderName, projFolder, folderCache);
      }

      const files = [];
      const ema = Array.isArray(rec.ema) ? rec.ema : [];
      if (rec.intake || ema.length) {
        files.push(["問卷.json", {
          project: rec.project, code: rec.code, session: rec.session,
          uploadedAt: rec.uploadedAt,
          email: findEmail(rec.intake),
          intake: rec.intake || null,
          ema,
        }]);
      }
      if (Array.isArray(rec.physiology)  && rec.physiology.length)  files.push(["生理.json", rec.physiology]);
      if (Array.isArray(rec.location)    && rec.location.length)    files.push(["軌跡.json", rec.location]);
      if (Array.isArray(rec.environment) && rec.environment.length) files.push(["環境.json", rec.environment]);

      const prevFiles = new Map(((prev && prev.files) || []).map((f) => [f.name, f.id]));
      const uploaded = [];
      for (const [name, obj] of files) {
        const existingId = prevFiles.get(name);
        const fid = existingId
          ? await driveUpdateJSON(token, existingId, obj)     // 補傳：同名檔原地更新
          : await driveUploadJSON(token, name, obj, sessFolder);
        uploaded.push({ name, id: fid });
      }
      await logStore.setJSON(key, {
        syncedAt: Date.now(),
        folder: folderName,
        folderId: sessFolder,
        projectFolderId: projFolder,
        files: uploaded,
      });
      synced.push(item.mode === "update" ? key + "（更新）" : key);
    } catch (e) {
      failed.push({ key, error: String(e.message || e).slice(0, 200) });
    }
  }

  return json({
    ok: true,
    scanned: allKeys.length,
    pending: pending.length + updates.length,
    synced,
    skipped,
    inProgress,
    remaining: pending.length + updates.length - synced.length - skipped.length,
    failed,
  });
};

export const config = { path: "/api/drive-sync" };
