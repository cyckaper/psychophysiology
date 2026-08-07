// drive-sync-cron.mjs — 每 5 分鐘觸發一輪 Drive 封存
// 實際工作在 /api/drive-sync（可手動開網址驗證）；本函式只負責定時敲門。
export default async () => {
  const base = process.env.URL || "";
  if (!base) return new Response("no site url", { status: 500 });
  try {
    await fetch(base + "/api/drive-sync", { method: "POST" });
  } catch (_) {
    /* 下一輪會再試；drive-sync 本身冪等 */
  }
  return new Response("ok");
};

export const config = { schedule: "*/5 * * * *" };
