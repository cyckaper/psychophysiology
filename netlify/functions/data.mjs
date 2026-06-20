// netlify/functions/data.mjs
// HEALS 場域研究 — L3.3 資料端點
// 角色：HealthProbe 裝置 POST 上傳一場資料（生理／軌跡／環境）；面板 GET 抓取某專案所有資料。
// 儲存：Netlify Blobs（store: "heals-data"，key = 專案/編號/場次/種類）。
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const reply = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

const KINDS = ["physiology", "location", "environment"];
// key 片段清理：去掉斜線/空白等，保留字母數字與 # . - _
const seg = (s, fallback = "NA") => {
  const v = String(s ?? "").trim().replace(/[^\w#.-]/g, "_");
  return v.length ? v : fallback;
};

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });

  // 強一致：上傳後面板馬上抓得到
  const store = getStore({ name: "heals-data", consistency: "strong" });
  const url = new URL(req.url);

  // POST /api/data  body: { project, code, session, kind, data: [...] }
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }
    const project = seg(body.project, "");
    if (!project) return reply({ error: "project required" }, 400);
    const kind = seg(body.kind, "");
    if (!KINDS.includes(kind)) return reply({ error: "kind must be physiology|location|environment" }, 400);
    const code = seg(body.code);
    const session = seg(body.session);
    const data = Array.isArray(body.data) ? body.data : [];

    const key = `${project}/${code}/${session}/${kind}`;
    const record = { project, code, session, kind, count: data.length, uploadedAt: Date.now(), data };
    await store.setJSON(key, record);
    return reply({ ok: true, key, count: data.length });
  }

  // GET /api/data?project=X          → 該專案所有上傳（含 data）
  // GET /api/data?project=X&meta=1   → 只回清單（不含 data，較輕）
  if (req.method === "GET") {
    const project = seg(url.searchParams.get("project"), "");
    if (!project) return reply({ error: "project required" }, 400);
    const metaOnly = url.searchParams.get("meta") === "1";
    const { blobs } = await store.list({ prefix: `${project}/` });
    const out = [];
    for (const b of blobs) {
      const v = await store.get(b.key, { type: "json" });
      if (!v) continue;
      if (metaOnly) out.push({ project: v.project, code: v.code, session: v.session, kind: v.kind, count: v.count, uploadedAt: v.uploadedAt });
      else out.push(v);
    }
    out.sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
    return reply(out);
  }

  return reply({ error: "method not allowed" }, 405);
};

export const config = { path: "/api/data" };
