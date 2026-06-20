// netlify/functions/command.mjs
// HEALS 場域研究 — L3.1 指令通道
// 角色：總開關面板 POST 寫入專案 START/STOP；各 HealthProbe 裝置 GET 輪詢自己專案的狀態。
// 儲存：Netlify Blobs（store: "heals-commands"，key = 專案名）。
import { getStore } from "@netlify/blobs";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
const reply = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS } });

export default async (req) => {
  if (req.method === "OPTIONS") return new Response("", { status: 204, headers: CORS });

  const store = getStore("heals-commands");
  const url = new URL(req.url);

  // GET /api/command            → 列出所有專案狀態（面板用）
  // GET /api/command?project=X  → 單一專案狀態（裝置輪詢用）
  if (req.method === "GET") {
    const project = url.searchParams.get("project");
    if (project) {
      const v = await store.get(project, { type: "json" });
      return reply(v || { project, status: "stopped" });
    }
    const { blobs } = await store.list();
    const all = [];
    for (const b of blobs) {
      const v = await store.get(b.key, { type: "json" });
      if (v) all.push(v);
    }
    all.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return reply(all);
  }

  // POST /api/command  body: { project, action: "start" | "stop" }
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); } catch { return reply({ error: "invalid json" }, 400); }
    const project = String(body.project || "").trim();
    if (!project) return reply({ error: "project required" }, 400);

    const prev = (await store.get(project, { type: "json" })) || { project, status: "stopped" };
    const now = Date.now();
    let next;
    if (body.action === "start") {
      // 每次 START 給一個新 session，裝置才分得出是「新的一次研究」
      next = { project, status: "running", session: "s" + now, startedAt: now, stoppedAt: prev.stoppedAt ?? null, updatedAt: now };
    } else if (body.action === "stop") {
      next = { ...prev, status: "stopped", stoppedAt: now, updatedAt: now };
    } else {
      return reply({ error: "action must be 'start' or 'stop'" }, 400);
    }
    await store.setJSON(project, next);
    return reply(next);
  }

  return reply({ error: "method not allowed" }, 405);
};

export const config = { path: "/api/command" };
