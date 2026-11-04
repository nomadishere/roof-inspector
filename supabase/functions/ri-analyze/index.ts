// Roof Inspector — AI step. Keeps the Anthropic key server-side and enforces
// the monthly spending cap + per-visitor limits before every AI call.
import { createClient } from "npm:@supabase/supabase-js@2";

const MODEL = "claude-sonnet-5-5";
const PRICE_IN = 2 / 1_000_000;   // $ per input token (Sonnet 5.5)
const PRICE_OUT = 10 / 1_000_000; // $ per output token
const MONTHLY_CAP_USD = 50;       // Justin's cap — AI pauses for the month when hit
const PER_IP_CALLS_PER_DAY = 40;  // ~8 reports per visitor per day
const MAX_IMAGES = 70;

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const VOICE = `Voice: plain, honest and neighborly. Short sentences, no hype. Explain why each item matters. Lead with helping the owner even if they never hire anyone.`;

function visionPrompt(job: any, frameList: string) {
  return `You are an experienced roofing inspector writing a professional roof inspection report.
The images are stills from the inspector's walk-around video(s) (scanned at about 1 frame per second) and any photos they uploaded. Each image is preceded by its ID and source, e.g. "F12 — Video 1 at 0:25" or "P3 — Photo 3".

Job info:
- Roof type(s) the inspector checked: ${job.roofTypes.join(", ") || "not given"}
- Property: ${job.address || "not given"}
- Inspector notes: ${job.notes || "none"}

Images provided: ${frameList}

Find every real problem you can see (damage, wear, missing/lifted material, flashing, penetrations, ponding, gutters, rot, interior water stains, etc.). For each, pick the single image that shows it best and give a tight bounding box around the problem in that image as fractions 0-1: [x, y, width, height] from the top-left. Do not invent problems you can't see; if unsure, say so in the description.

Return ONLY JSON, no markdown:
{
 "cover": "<image ID of the clearest, straight-on, whole-building shot>",
 "summary": "<3-5 sentence executive summary of the roof's condition>",
 "roof_facts": [{"label":"Roof type","value":"..."},{"label":"Approx. age","value":"... (confirm)"},{"label":"Layers","value":"..."},{"label":"Approx. size","value":"~N squares (confirm)"},{"label":"Pitch","value":"..."}],
 "size_squares": <your best number estimate of roof area in squares (100 sq ft), or null>,
 "findings": [{"image":"F12","box":[0.4,0.3,0.2,0.15],"title":"Lifted shingles at ridge","category":"Roof","severity":"Critical|High|Medium|Low","description":"<2-3 sentences: what it is and why it matters>"}],
 "leaks": [{"image":"F30","location":"<room/area>","condition":"<what you see>"}]
}
Order findings most severe first. Max 12 findings. "leaks" only for interior water evidence; empty array if none. ${VOICE}`;
}

function diyPrompt(job: any, analysis: any) {
  return `You are an experienced roofer writing the DIY repair plan section of an inspection report — a plan the owner can use with anyone, not just the inspector's company.
Roof type(s): ${job.roofTypes.join(", ") || "unknown"}. Property: ${job.address || "unknown"}.
Findings (numbered): ${JSON.stringify((analysis.findings || []).map((f: any, i: number) => ({ n: i + 1, title: f.title, severity: f.severity, description: f.description })))}

Group related findings into practical repair items (max 8). Return ONLY JSON, no markdown:
{"items":[{"title":"...","findings":[1,3],"difficulty":"Easy|Moderate|Advanced|Pro only","need":["tool or material", "..."],"steps":["...","..."],"call_pro_if":"..."}]}
Keep each step one short sentence; 3-6 steps per item. Include roof safety (fall protection, weather) where it matters. ${VOICE}`;
}

function estimatePrompt(job: any, analysis: any, roofType: string) {
  return `You are a roofing estimator. Build a realistic estimate for the work on this roof, using current typical contractor prices for the property's region (${job.address || "Montana, USA"}). Do your best from the inspection; quantities you can't confirm should still be estimated and marked "(confirm)" in the description.
Roof system for this estimate: ${roofType}.
Approx. roof size: ${analysis.size_squares ? analysis.size_squares + " squares" : "unknown — estimate from the findings and typical building size"}.
Inspector notes: ${job.notes || "none"}
Findings: ${JSON.stringify((analysis.findings || []).map((f: any) => f.title + " (" + f.severity + ")"))}
Summary: ${analysis.summary || ""}

Give two options: Option A = repair the findings; Option B = full replacement with a ${roofType} system (tear-off, underlayment, flashing, disposal, etc.).
Split every line into Materials or Labor. Prices are COST (no profit or overhead — that is added separately).
Return ONLY JSON, no markdown:
{"options":[{"name":"Option A — Repairs","scope":"<1-2 sentences>","lines":[{"kind":"Materials","desc":"...","qty":12,"unit":"bundles","price":45.5},{"kind":"Labor","desc":"...","qty":16,"unit":"hrs","price":85}]},{"name":"Option B — Full ${roofType} replacement","scope":"...","lines":[...]}],
 "assumptions":["...","..."]}
6-14 lines per option. qty and price are numbers.`;
}

async function callClaude(content: any[], maxTokens: number) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("NO_KEY");
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error("AI_ERROR: " + (data?.error?.message || r.status));
  const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
  return { text, usage: data.usage || {} };
}

function parseJSON(text: string) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  return JSON.parse(text.slice(s, e + 1));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Bad request" }, 400); }
  const { step, job = {}, images = [], analysis = {}, roofType = "" } = body;
  job.roofTypes = Array.isArray(job.roofTypes) ? job.roofTypes.slice(0, 3).map(String) : [];

  // ---- cost guards ----
  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const { data: spent } = await db.from("ri_usage").select("cost_usd").gte("created_at", monthStart.toISOString());
  const total = (spent || []).reduce((a: number, r: any) => a + Number(r.cost_usd || 0), 0);
  if (total >= MONTHLY_CAP_USD) {
    return json({ error: "CAP", message: "Roof Inspector has reached its free report limit for this month. Please check back on the 1st, or contact us to get a report made." }, 402);
  }
  const dayAgo = new Date(Date.now() - 86400000).toISOString();
  const { count } = await db.from("ri_usage").select("id", { count: "exact", head: true }).eq("ip", ip).gte("created_at", dayAgo);
  if ((count || 0) >= PER_IP_CALLS_PER_DAY) {
    return json({ error: "LIMIT", message: "You've made several reports today. Please try again tomorrow." }, 429);
  }

  try {
    let content: any[] = [], maxTokens = 4000;
    if (step === "vision") {
      const imgs = (images as any[]).slice(0, MAX_IMAGES);
      if (!imgs.length) return json({ error: "No images" }, 400);
      for (const im of imgs) {
        content.push({ type: "text", text: `${im.id} — ${im.label}` });
        content.push({ type: "image", source: { type: "base64", media_type: "image/jpeg", data: String(im.data).replace(/^data:image\/\w+;base64,/, "") } });
      }
      content.push({ type: "text", text: visionPrompt(job, imgs.map((i) => i.id).join(", ")) });
      maxTokens = 4500;
    } else if (step === "diy") {
      content = [{ type: "text", text: diyPrompt(job, analysis) }];
    } else if (step === "estimate") {
      content = [{ type: "text", text: estimatePrompt(job, analysis, roofType || job.roofTypes[0] || "asphalt shingle") }];
      maxTokens = 3500;
    } else return json({ error: "Unknown step" }, 400);

    const { text, usage } = await callClaude(content, maxTokens);
    const cost = (usage.input_tokens || 0) * PRICE_IN + (usage.output_tokens || 0) * PRICE_OUT;
    await db.from("ri_usage").insert({ ip, step, input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, cost_usd: cost });
    let result;
    try { result = parseJSON(text); } catch { return json({ error: "PARSE", message: "The AI response was incomplete. Please try again." }, 502); }
    return json({ result });
  } catch (e) {
    const msg = String((e as Error).message || e);
    if (msg === "NO_KEY") return json({ error: "SETUP", message: "Roof Inspector isn't fully set up yet (AI key missing)." }, 503);
    return json({ error: "AI", message: "The AI service had a problem. Please try again in a minute." , detail: msg.slice(0, 200) }, 502);
  }
});
