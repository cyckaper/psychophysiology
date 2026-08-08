// netlify/functions/data.mjs
// HEALS 場域研究 — L3.3 資料端點（v2）
// v2 重點：一個「場次」只寫一筆 blob（三條流包在一起），避免連續寫多筆時
//          Netlify Blobs 的 list 只認到最後一筆、前面被漏掉的問題。
// 儲存：Netlify Blobs（store: "heals-data"，key = 專案/編號/場次）。
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

// key 片段清理：僅保留字母數字與 . - _
// 「#」一律剔除——Blobs 以 URL 路徑存取鍵，# 之後會被當片段截斷，鍵會塌縮互相覆蓋
const seg = (s, fb = "NA") => {
  const v = String(s ?? "").trim().replace(/#/g, "").replace(/[^\w.-]/g, "_");
  return v.length ? v : fb;
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });

  const store = getStore({ name: "heals-data", consistency: "strong" });
  const url = new URL(req.url);

  // POST /api/data
  // body: { project, code, session, physiology:[...], location:[...], environment:[...] }
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }
    const project = seg(body.project, "");
    if (!project) return reply({ error: "project required" }, 400);
    const code = seg(body.code);
    const session = seg(body.session);
    const codeRaw = String(body.code ?? "").trim() || code;         // 記錄內保留原樣（如 #1）
    const sessionRaw = String(body.session ?? "").trim() || session;
    const physiology  = Array.isArray(body.physiology)  ? body.physiology  : [];
    const location    = Array.isArray(body.location)    ? body.location    : [];
    const environment = Array.isArray(body.environment) ? body.environment : [];
    const ema         = Array.isArray(body.ema)         ? body.ema         : [];   // 現場問卷作答（舊版 App 未送 → 空陣列）

    const key = `${project}/${code}/${session}`;
    const intake = (body.intake && typeof body.intake === "object") ? body.intake : null;
    const record = {
      project, code: codeRaw, session: sessionRaw, uploadedAt: Date.now(),
      counts: { physiology: physiology.length, location: location.length, environment: environment.length, ema: ema.length },
      physiology, location, environment, ema,
      intake,                                    // 受測者入組基本資料（可能為 null）
    };
    await store.setJSON(key, record);   // 單一寫入
    // 場次清單簿登記：繞開 list() 最終一致的延遲；drive-sync 以清單簿為主、list() 為輔
    try {
      const idx = getStore({ name: "heals-data-index", consistency: "strong" });
      let man = null;
      try { man = await idx.get("manifest", { type: "json" }); } catch (_) { /* 首次尚無清單簿 */ }
      if (!man || typeof man !== "object" || !man.keys || typeof man.keys !== "object") man = { keys: {} };
      man.keys[key] = record.uploadedAt;
      await idx.setJSON("manifest", man);
    } catch (_) { /* 登記失敗不影響上傳本體；drive-sync 仍可靠 list() 撈到 */ }
    return reply({ ok: true, key, counts: record.counts });
  }

  // GET /api/data?project=X  → 該專案所有場次（每筆含三條流與 counts）
  if (req.method === "GET") {
    const project = seg(url.searchParams.get("project"), "");
    if (!project) return reply({ error: "project required" }, 400);
    const { blobs } = await store.list({ prefix: `${project}/` });
    const out = [];
    for (const b of blobs) {
      const v = await store.get(b.key, { type: "json" });
      if (v) out.push(v);
    }
    out.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
    return reply(out);
  }

  return reply({ error: "method not allowed" }, 405);
};

export const config = { path: "/api/data" };
