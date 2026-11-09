// Roofly address suggestions (drop-down while typing). Google Places Autocomplete (New), US addresses only.
// Capped: per visitor per day and per month overall, so it can never run up a bill.
import { createClient } from "npm:@supabase/supabase-js@2";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const PER_IP_PER_DAY = 400, PER_MONTH = 8000, COST_EACH = 0.00283;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return out({ error: "POST only" }, 405);
  const key = Deno.env.get("GOOGLE_MAPS_KEY"); if (!key) return out({ suggestions: [] });
  let b: any = {}; try { b = await req.json(); } catch {}
  const q = String(b.q || "").trim().slice(0, 120);
  if (q.length < 4) return out({ suggestions: [] });
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const ms = new Date(); ms.setUTCDate(1); ms.setUTCHours(0, 0, 0, 0);
  const { count: month } = await db.from("ri_usage").select("id", { count: "exact", head: true }).eq("step", "places").gte("created_at", ms.toISOString());
  if ((month || 0) >= PER_MONTH) return out({ suggestions: [] });
  const { count: day } = await db.from("ri_usage").select("id", { count: "exact", head: true }).eq("step", "places").eq("ip", ip).gte("created_at", new Date(Date.now() - 86400000).toISOString());
  if ((day || 0) >= PER_IP_PER_DAY) return out({ suggestions: [] });
  const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "suggestions.placePrediction.text.text" },
    body: JSON.stringify({ input: q, includedRegionCodes: ["us"], sessionToken: /^[A-Za-z0-9-]{8,64}$/.test(String(b.session || "")) ? b.session : undefined }),
  });
  const d = await r.json().catch(() => ({}));
  await db.from("ri_usage").insert({ ip, step: "places", input_tokens: 0, output_tokens: 0, cost_usd: COST_EACH });
  if (!r.ok) return out({ suggestions: [], error: String(d?.error?.message || r.status).slice(0, 200) });
  const list = (d.suggestions || []).map((s: any) => s.placePrediction?.text?.text).filter(Boolean).slice(0, 5);
  return out({ suggestions: list });
});
