// live.mjs — 走測即時回報 /api/live
// POST {project, code, session, lat, lng, hr, hrAt}
//   → 手機走測中每 ~30 秒回報一次；一專案一筆 blob，內含各裝置最新狀態（覆寫）。
// GET ?project=aa      → { project, devices:[{code,session,lat,lng,hr,hrAt,t,ageSec}] }（3 分鐘內視為在線）
// GET ?all=1           → { projects:[{id,name,devices:[...]}] }（讀專案登記表逐案彙整）
// 約定：CORS *、no-store、strong consistency；鍵剔除「#」。
import { getStore } from "@netlify/blobs";

const FRESH_MS = 3 * 60 * 1000;   // 超過 3 分鐘沒回報就視為離線，不顯示

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: HEADERS });

const liveStore = () => getStore({ name: "heals-live", consistency: "strong" });
const projStore = () => getStore({ name: "heals-projects", consistency: "strong" });

// 鍵片段清理（與 data.mjs 相同：# 會被 Blobs 底層截斷，一律剔除）
const seg = (s, fb = "NA") => {
  const v = String(s ?? "").trim().replace(/#/g, "").replace(/[^\w.-]/g, "_");
  return v.length ? v : fb;
};

function freshDevices(rec) {
  const now = Date.now();
  const out = [];
  const devices = (rec && rec.devices && typeof rec.devices === "object") ? rec.devices : {};
  for (const k of Object.keys(devices)) {
    const d = devices[k] || {};
    if (typeof d.t !== "number" || now - d.t > FRESH_MS) continue;
    out.push({ ...d, ageSec: Math.round((now - d.t) / 1000) });
  }
  out.sort((a, b) => String(a.code || "").localeCompare(String(b.code || "")));
  return out;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });

  const url = new URL(req.url);

  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return json({ error: "invalid json" }, 400); }
    const project = seg(body.project, "");
    if (!project) return json({ error: "missing project" }, 400);
    const codeKey = seg(body.code);
    const entry = {
      code: String(body.code ?? "").trim() || codeKey,   // 顯示用，保留 #
      session: String(body.session ?? "").trim(),
      lat: Number.isFinite(Number(body.lat)) ? Number(body.lat) : null,
      lng: Number.isFinite(Number(body.lng)) ? Number(body.lng) : null,
      hr:  Number.isFinite(Number(body.hr))  ? Math.round(Number(body.hr)) : null,
      hrAt: Number.isFinite(Number(body.hrAt)) ? Number(body.hrAt) : null,
      t: Date.now(),
    };
    const store = liveStore();
    let rec = null;
    try { rec = await store.get(project, { type: "json" }); } catch (_) { /* 首筆 */ }
    if (!rec || typeof rec !== "object" || !rec.devices) rec = { devices: {} };
    rec.devices[codeKey] = entry;
    // 順手清掉太久沒回報的殘留，避免 blob 無限長大
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const k of Object.keys(rec.devices)) {
      if ((rec.devices[k].t || 0) < cutoff) delete rec.devices[k];
    }
    await store.setJSON(project, rec);
    return json({ ok: true });
  }

  if (req.method === "GET") {
    if (url.searchParams.get("all")) {
      // 讀登記表 → 逐專案取即時狀態（只列進行中的專案）
      let registry = { projects: [] };
      try {
        const r = await projStore().get("registry", { type: "json" });
        if (r && Array.isArray(r.projects)) registry = r;
      } catch (_) {}
      const active = registry.projects.filter((p) => (p.status || "active") !== "archived");
      const out = [];
      for (const p of active) {
        let rec = null;
        try { rec = await liveStore().get(seg(p.id, ""), { type: "json" }); } catch (_) {}
        out.push({ id: p.id, name: p.name || p.id, devices: freshDevices(rec) });
      }
      return json({ projects: out, freshSec: FRESH_MS / 1000 });
    }

    const project = seg(url.searchParams.get("project"), "");
    if (!project) return json({ error: "missing project" }, 400);
    let rec = null;
    try { rec = await liveStore().get(project, { type: "json" }); } catch (_) {}
    return json({ project, devices: freshDevices(rec), freshSec: FRESH_MS / 1000 });
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = { path: "/api/live" };
