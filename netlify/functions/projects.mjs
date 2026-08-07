// projects.mjs — 專案登記表 /api/projects
// GET            → { projects: [...] }（全部，含封存；依更新時間新→舊）
// GET ?id=aa     → { project: {...} } 或 404
// POST {id,name,note,status} → 建立或更新（id 必為英數短碼）
// DELETE ?id=aa  → 自登記表移除（不動 zones / survey / data 各 store）
// 約定：CORS *、Cache-Control no-store、strong consistency。
// 全部專案收在單一 key「registry」，一次寫一筆，避開 Blobs 連寫多 key 的 list() 漏筆問題。
import { getStore } from "@netlify/blobs";

const KEY = "registry";
const store = () => getStore({ name: "heals-projects", consistency: "strong" });

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: HEADERS });

async function readRegistry() {
  try {
    const raw = await store().get(KEY, { type: "json" });
    if (raw && Array.isArray(raw.projects)) return raw;
  } catch (_) {
    /* 首次讀取尚無資料，回空表 */
  }
  return { projects: [] };
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: HEADERS });
  }

  const url = new URL(req.url);
  const id = (url.searchParams.get("id") || "").trim();

  if (req.method === "GET") {
    const reg = await readRegistry();
    if (id) {
      const p = reg.projects.find((x) => x.id === id);
      return p ? json({ project: p }) : json({ error: "not found" }, 404);
    }
    reg.projects.sort((a, b) =>
      (b.updatedAt || "").localeCompare(a.updatedAt || "")
    );
    return json(reg);
  }

  if (req.method === "POST") {
    let body;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid json" }, 400);
    }
    const pid = String(body.id || "").trim();
    if (!/^[A-Za-z0-9_-]{1,32}$/.test(pid)) {
      return json(
        { error: "專案代號必須為 1–32 字元英數短碼（可含 - 與 _）" },
        400
      );
    }
    const reg = await readRegistry();
    const now = new Date().toISOString();
    const i = reg.projects.findIndex((x) => x.id === pid);
    const base = i >= 0 ? reg.projects[i] : { id: pid, createdAt: now };
    const status =
      body.status === "archived" ? "archived"
      : body.status === "active" ? "active"
      : base.status || "active";
    let trigger = base.trigger || { mode: "zone" };
    if (body.trigger && typeof body.trigger === "object") {
      const mode = ["zone", "timed", "both"].includes(body.trigger.mode)
        ? body.trigger.mode
        : "zone";
      const iv = Number(body.trigger.intervalMinutes);
      trigger =
        mode === "zone"
          ? { mode }
          : { mode, intervalMinutes: Number.isInteger(iv) && iv > 0 ? iv : 15 };
    }
    const next = {
      ...base,
      name:
        typeof body.name === "string" && body.name.trim()
          ? body.name.trim()
          : base.name || pid,
      note: typeof body.note === "string" ? body.note.trim() : base.note || "",
      status,
      trigger,
      updatedAt: now,
    };
    if (i >= 0) reg.projects[i] = next;
    else reg.projects.push(next);
    await store().setJSON(KEY, reg);
    return json({ ok: true, project: next });
  }

  if (req.method === "DELETE") {
    if (!id) return json({ error: "missing id" }, 400);
    const reg = await readRegistry();
    const before = reg.projects.length;
    reg.projects = reg.projects.filter((x) => x.id !== id);
    if (reg.projects.length === before) return json({ error: "not found" }, 404);
    await store().setJSON(KEY, reg);
    return json({ ok: true });
  }

  return json({ error: "method not allowed" }, 405);
};

export const config = { path: "/api/projects" };
