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

// key 片段清理：保留字母數字與 # . - _
const seg = (s, fb = "NA") => {
  const v = String(s ?? "").trim().replace(/[^\w#.-]/g, "_");
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
    const physiology  = Array.isArray(body.physiology)  ? body.physiology  : [];
    const location    = Array.isArray(body.location)    ? body.location    : [];
    const environment = Array.isArray(body.environment) ? body.environment : [];

    const key = `${project}/${code}/${session}`;
    const record = {
      project, code, session, uploadedAt: Date.now(),
      counts: { physiology: physiology.length, location: location.length, environment: environment.length },
      physiology, location, environment,
    };
    await store.setJSON(key, record);   // 單一寫入
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
