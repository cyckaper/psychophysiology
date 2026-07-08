// netlify/functions/zones.mjs
// HEALS 景觀生心理研究 — 反應區（不規則多邊形）端點
// 角色：面板繪圖頁 POST 存某專案的反應區；HealthProbe 收到「開始」時 GET 拉下來。
// 儲存：Netlify Blobs（store: "heals-zones"，key = 專案名）。一個專案只寫一筆，避免多筆寫入被 list 漏掉。
//
// 格式：GeoJSON FeatureCollection，與 HEALS hub contract 的邊界格式一致。
//   Feature.geometry = Polygon，coordinates = [[ [lng,lat], ... , [lng,lat] ]]（注意是 lng,lat）
//   Feature.properties = { zoneId, name, survey, repeatMinutes }
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

const EMPTY = { type: "FeatureCollection", features: [] };

// 只留下合法的 Polygon Feature，並補正屬性
function sanitize(geojson) {
  if (!geojson || geojson.type !== "FeatureCollection" || !Array.isArray(geojson.features)) return null;
  const features = [];
  for (const f of geojson.features) {
    const g = f && f.geometry;
    if (!g || g.type !== "Polygon" || !Array.isArray(g.coordinates) || !g.coordinates.length) continue;
    const ring = g.coordinates[0];
    if (!Array.isArray(ring) || ring.length < 4) continue;              // 至少 3 頂點 + 閉合點
    const ok = ring.every(p => Array.isArray(p) && p.length >= 2 &&
      Number.isFinite(p[0]) && Number.isFinite(p[1]) &&
      Math.abs(p[0]) <= 180 && Math.abs(p[1]) <= 90);
    if (!ok) continue;
    const pr = (f.properties && typeof f.properties === "object") ? f.properties : {};
    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring.map(p => [Number(p[0]), Number(p[1])])] },
      properties: {
        zoneId: String(pr.zoneId ?? `z${features.length + 1}`),
        name: String(pr.name ?? `區域 ${features.length + 1}`),
        survey: String(pr.survey ?? ""),
        repeatMinutes: Number.isFinite(Number(pr.repeatMinutes)) ? Number(pr.repeatMinutes) : 0,
      },
    });
  }
  return { type: "FeatureCollection", features };
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });

  const store = getStore({ name: "heals-zones", consistency: "strong" });
  const url = new URL(req.url);

  // POST /api/zones   body: { project, geojson }
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }
    const project = seg(body.project, "");
    if (!project) return reply({ error: "project required" }, 400);
    const clean = sanitize(body.geojson);
    if (!clean) return reply({ error: "geojson must be a FeatureCollection" }, 400);

    const record = { project, updatedAt: Date.now(), count: clean.features.length, geojson: clean };
    await store.setJSON(project, record);      // 單一寫入
    return reply({ ok: true, project, count: record.count });
  }

  // GET /api/zones?project=X  → 一律回合法結構（沒設定過就回空 FeatureCollection）
  if (req.method === "GET") {
    const project = seg(url.searchParams.get("project"), "");
    if (!project) return reply({ error: "project required" }, 400);
    let v = null;
    try { v = await store.get(project, { type: "json" }); } catch { v = null; }
    if (!v) return reply({ project, updatedAt: 0, count: 0, geojson: EMPTY });
    return reply(v);
  }

  return reply({ error: "method not allowed" }, 405);
};

export const config = { path: "/api/zones" };
