// ai-survey.mjs — 問卷解析代理 /api/ai-survey
// POST {text, languages:["zh","en",...], defaultLang}
//   → {ok:true, title:{lang:...}, questions:[{id, text:{lang:...}}]}
// 把 PDF/Word 抽出的問卷原文交給 claude-haiku，抽出題項並翻成所選語言（草稿性質）。
// 需要環境變數 ANTHROPIC_API_KEY（Netlify → Site configuration → Environment variables）。
// 約定：CORS *、Cache-Control no-store。

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
  "Content-Type": "application/json; charset=utf-8",
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: HEADERS });

const MAX_TEXT = 12000;   // 原文截長，控制時間與費用
const MAX_Q = 60;

const ID_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

function sanitizeLoc(obj, langs) {
  const out = {};
  if (obj && typeof obj === "object") {
    langs.forEach((l) => {
      if (typeof obj[l] === "string" && obj[l].trim()) out[l] = obj[l].trim();
    });
  }
  return out;
}

export default async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: HEADERS });
  }
  if (req.method !== "POST") return json({ error: "method not allowed" }, 405);

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return json({ error: "後端尚未設定 ANTHROPIC_API_KEY 環境變數" }, 500);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const text = String(body.text || "").slice(0, MAX_TEXT).trim();
  if (!text) return json({ error: "缺少問卷原文" }, 400);

  const langs =
    Array.isArray(body.languages) && body.languages.length
      ? body.languages.filter((l) => typeof l === "string").slice(0, 7)
      : ["zh"];
  const defaultLang = langs.includes(body.defaultLang) ? body.defaultLang : langs[0];

  const system = [
    "你是問卷量表解析器。輸入是從 PDF 或 Word 抽出的問卷原文。",
    "任務：抽出「題項」——受測者要逐題作答的敘述句或問句。",
    "忽略：填答說明、計分方式、量尺刻度行、版權宣告、文獻引用、標號雜訊。",
    "不要編造原文沒有的題目；題項順序照原文。",
    "每題給一個語意化英數 id：小寫開頭、可含數字與底線（如 mood、fascination_1）。",
    "text 需涵蓋語言代碼：" + langs.join("、") + "。原文語言照抄原句，其餘語言翻譯（草稿即可）。",
    "只輸出 JSON，無任何其他文字、無 markdown 圍欄，格式：",
    '{"title":{"' + defaultLang + '":"問卷標題"},"questions":[{"id":"mood","text":{"zh":"...","en":"..."}}]}',
    "title 若原文沒有明確標題可省略。題數上限 " + MAX_Q + "。",
  ].join("\n");

  let resp;
  try {
    resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5",
        max_tokens: 5000,
        system,
        messages: [{ role: "user", content: "問卷原文如下：\n\n" + text }],
      }),
    });
  } catch (e) {
    return json({ error: "無法連線 AI 服務：" + e.message }, 502);
  }

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    return json({ error: "AI 服務回應 " + resp.status + "：" + errText.slice(0, 300) }, 502);
  }

  let data;
  try {
    data = await resp.json();
  } catch {
    return json({ error: "AI 回應非 JSON" }, 502);
  }

  const raw = (Array.isArray(data.content) ? data.content : [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .replace(/```json|```/g, "")
    .trim();

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "AI 輸出無法解析，請縮短或整理原文後重試" }, 502);
  }

  const seen = new Set();
  const questions = (Array.isArray(parsed.questions) ? parsed.questions : [])
    .slice(0, MAX_Q)
    .map((q) => {
      let id = typeof q.id === "string" ? q.id.trim() : "";
      if (!ID_RE.test(id) || seen.has(id)) id = "";   // 不合規或重複 → 留空給後端自動編號
      if (id) seen.add(id);
      return { id, text: sanitizeLoc(q.text, langs) };
    })
    .filter((q) => Object.keys(q.text).length > 0);

  if (!questions.length) {
    return json({ error: "原文中沒有解析出題項，請確認內容或手動貼入題目文字" }, 422);
  }

  return json({
    ok: true,
    title: sanitizeLoc(parsed.title, langs),
    questions,
  });
};

export const config = { path: "/api/ai-survey" };
