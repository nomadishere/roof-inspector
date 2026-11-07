// Roofly: Google Solar "data layers" for a roof — 3D height map (DSM), roof mask and RGB photo as GeoTIFFs.
// Internal only (worker token). Costs ~$0.075 per request; capped at $75/month (Justin, Nov 7 2026).
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const COST = 0.075, MONTHLY_CAP_USD = 75;

Deno.serve(async (req) => {
  if (req.method !== "POST") return out({ error: "POST only" }, 405);
  let b: any = {}; try { b = await req.json(); } catch {}
  const { data: t } = await db.from("admin_secrets").select("value").eq("name", "RI_WORKER_TOKEN").maybeSingle();
  if (!t?.value || b.token !== t.value) return out({ error: "no" }, 403);
  const key = Deno.env.get("GOOGLE_MAPS_KEY"); if (!key) return out({ error: "SETUP" }, 503);

  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const { count } = await db.from("ri_usage").select("id", { count: "exact", head: true }).eq("step", "layers").gte("created_at", monthStart.toISOString());
  if ((count || 0) * COST >= MONTHLY_CAP_USD) return out({ error: "CAP", message: "Height-map limit for this month reached." }, 402);

  const lat = +b.lat, lng = +b.lng, radius = Math.max(10, Math.min(60, +b.radius || 30));
  if (!isFinite(lat) || !isFinite(lng)) return out({ error: "NO_LOCATION" }, 400);
  const r = await fetch(`https://solar.googleapis.com/v1/dataLayers:get?location.latitude=${lat}&location.longitude=${lng}&radiusMeters=${radius}&view=IMAGERY_LAYERS&requiredQuality=LOW&pixelSizeMeters=0.1&key=${key}`);
  const d = await r.json();
  if (!r.ok) return out({ error: "NO_LAYERS", status: r.status, message: d?.error?.message || "No height map for this location." });
  await db.from("ri_usage").insert({ ip: String(b.ip || "layers").slice(0, 64), step: "layers", input_tokens: 0, output_tokens: 0, cost_usd: COST });

  const get = async (u: string) => { if (!u) return null; const x = await fetch(`${u}&key=${key}`); return x.ok ? encodeBase64(new Uint8Array(await x.arrayBuffer())) : null; };
  const [dsm, mask, rgb] = await Promise.all([get(d.dsmUrl), get(d.maskUrl), get(d.rgbUrl)]);
  return out({ imageryDate: d.imageryDate, imageryProcessedDate: d.imageryProcessedDate, imageryQuality: d.imageryQuality, dsm, mask, rgb });
});
