// Roofly roof measurements: address -> Google roof data (Solar API) + aerial photo (Static Maps)
// -> Claude traces the roof edges on the photo -> lengths in feet. The page does the math for materials.
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const MONTHLY_CAP_USD = 200, PER_IP_PER_DAY = 60;
const SIZE = 640, SCALE = 2; // Static Maps: 640x640 at scale 2 = 1280x1280 pixels

const R = 6378137;
const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
function toPx(lat: number, lng: number, c: { lat: number; lng: number }, z: number) {
  const world = 256 * Math.pow(2, z) * SCALE; // pixels around the world at this zoom (scaled)
  const x = ((lng - c.lng) / 360) * world + (SIZE * SCALE) / 2;
  const y = -((mercY(lat) - mercY(c.lat)) / (2 * Math.PI)) * world + (SIZE * SCALE) / 2;
  return [Math.round(x), Math.round(y)];
}
const ftPerPx = (lat: number, z: number) => ((2 * Math.PI * R * Math.cos((lat * Math.PI) / 180)) / (256 * Math.pow(2, z) * SCALE)) * 3.28084;

const EDGE_PROMPT = (info: string) => `You are an expert roof measurer (like EagleView). The image is a top-down satellite photo, 1280 x 1280 pixels, north up.
${info}

Trace the roof of the MAIN building at the center (and attached garages/porches that share its roof). Google's roof planes (boxes above) mark the building being measured: trace the roof those planes cover, and treat a neighbouring taller or separate building as a wall ("flashing"), not as part of this roof. For every roof edge and line, return a straight segment in pixel coordinates of THIS image:
- "ridge": the level top line where two slopes meet
- "hip": a sloped external corner line running down from a ridge to an eave corner
- "valley": a sloped internal corner where two slopes meet and water flows together
- "eave": the lower, level edge of a slope (where gutters go)
- "rake": the sloped edge at a gable end
- "flashing": where a roof meets a wall that rises above it (step/headwall flashing)
- "edge": the perimeter of a flat / low-slope roof section (edge metal), when it is not a parapet
- "parapet": a low wall around a flat roof
Follow the real roof outline closely. Split long edges where their direction or type changes. Do not include trees, shadows or neighbouring buildings.
Also count what you can see: chimneys, skylights, plumbing vents, roof vents/turtle vents, satellite dishes, HVAC units, and say the roof style.

Return ONLY JSON:
{"lines":[{"type":"eave","x1":0,"y1":0,"x2":0,"y2":0}],
 "style":"e.g. gable, hip, cross-gable, flat with parapet, mixed",
 "stories":1,
 "counts":{"chimneys":0,"skylights":0,"vents":0,"hvac":0},
 "confidence":"high|medium|low",
 "notes":"one or two sentences: anything hard to see (trees, shadows, old photo) that a person should double check"}`;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return out({ error: "POST only" }, 405);
  const key = Deno.env.get("GOOGLE_MAPS_KEY"); if (!key) return out({ error: "SETUP", message: "Measurements aren't set up yet." }, 503);
  let b: any = {}; try { b = await req.json(); } catch {}
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";

  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const { data: spent } = await db.from("ri_usage").select("cost_usd").gte("created_at", monthStart.toISOString());
  if ((spent || []).reduce((s: number, r: any) => s + Number(r.cost_usd || 0), 0) >= MONTHLY_CAP_USD) return out({ error: "CAP", message: "Roofly has reached its limit for this month." }, 402);
  const { count } = await db.from("ri_usage").select("id", { count: "exact", head: true }).eq("ip", ip).eq("step", "measure").gte("created_at", new Date(Date.now() - 86400000).toISOString());
  if ((count || 0) >= PER_IP_PER_DAY) return out({ error: "LIMIT", message: "Too many measurements today. Try again tomorrow." }, 429);

  // 1. where is it
  const address = String(b.address || "").slice(0, 200);
  let lat = +b.lat, lng = +b.lng, formatted = address;
  if (address && !(isFinite(lat) && isFinite(lng) && b.lat != null)) {
    const g = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`).then((r) => r.json());
    if (!g.results?.[0]) return out({ error: "NOT_FOUND", message: "Couldn't find that address. Check the spelling, or add the city and state." });
    lat = g.results[0].geometry.location.lat; lng = g.results[0].geometry.location.lng; formatted = g.results[0].formatted_address;
  }
  if (!isFinite(lat) || !isFinite(lng)) return out({ error: "NO_LOCATION", message: "Enter an address." }, 400);

  // 2. Google's roof data
  const sr = await fetch(`https://solar.googleapis.com/v1/buildingInsights:findClosest?location.latitude=${lat}&location.longitude=${lng}&requiredQuality=LOW&key=${key}`);
  const sd = await sr.json();
  if (!sr.ok) {
    const msg = sr.status === 404 ? "Google doesn't have roof data for this building yet, so it can't be measured automatically. Try the address of the building next door to check, or measure on site." : sr.status === 429 ? "Roofly's free measurements for today are used up. Please try again tomorrow." : "Google's roof data isn't available right now. Please try again in a few minutes.";
    return out({ error: "NO_ROOF", message: msg, location: { lat, lng }, formatted });
  }
  const sp = sd.solarPotential || {};
  const c = { lat: sd.center?.latitude ?? lat, lng: sd.center?.longitude ?? lng };
  const bb = sd.boundingBox;
  // zoom so the building fills about 60% of the photo
  const wM = Math.abs(bb.ne.longitude - bb.sw.longitude) * 111320 * Math.cos((c.lat * Math.PI) / 180);
  const hM = Math.abs(bb.ne.latitude - bb.sw.latitude) * 110574;
  const span = Math.max(wM, hM, 12) / 0.6;
  const mPerPxAt0 = (2 * Math.PI * R * Math.cos((c.lat * Math.PI) / 180)) / (256 * SCALE);
  const z = Math.max(17, Math.min(21, Math.floor(Math.log2((mPerPxAt0 * SIZE * SCALE) / span))));
  const fpp = ftPerPx(c.lat, z);
  const facets = (sp.roofSegmentStats || []).map((s: any, i: number) => {
    const sw = toPx(s.boundingBox.sw.latitude, s.boundingBox.sw.longitude, c, z), ne = toPx(s.boundingBox.ne.latitude, s.boundingBox.ne.longitude, c, z);
    return { n: i + 1, pitchDeg: s.pitchDegrees || 0, azimuthDeg: s.azimuthDegrees || 0, areaFt2: (s.stats?.areaMeters2 || 0) * 10.7639, groundFt2: (s.stats?.groundAreaMeters2 || 0) * 10.7639, heightFt: (s.planeHeightAtCenterMeters || 0) * 3.28084, box: [sw[0], ne[1], ne[0] - sw[0], sw[1] - ne[1]] };
  });

  // 3. aerial photo
  const img = await fetch(`https://maps.googleapis.com/maps/api/staticmap?center=${c.lat},${c.lng}&zoom=${z}&size=${SIZE}x${SIZE}&scale=${SCALE}&maptype=satellite&key=${key}`);
  if (!img.ok) return out({ error: "NO_IMAGE", message: "Couldn't load the aerial photo (Maps Static API). " + (await img.text()).slice(0, 200) });
  const b64 = encodeBase64(new Uint8Array(await img.arrayBuffer()));

  // 4. Claude traces the edges
  let edges: any = { lines: [] }, cost = 0;
  const akey = Deno.env.get("ANTHROPIC_API_KEY");
  if (akey) {
    const info = `Scale: 1 pixel = ${fpp.toFixed(3)} ft. Google detected ${facets.length} roof planes (pixel boxes [x,y,width,height], pitch in degrees, facing = azimuth):\n` +
      facets.map((f: any) => `#${f.n}: box ${JSON.stringify(f.box)}, pitch ${f.pitchDeg.toFixed(1)}°, facing ${Math.round(f.azimuthDeg)}°, ${Math.round(f.areaFt2)} sq ft`).join("\n");
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": akey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 8000, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }, { type: "text", text: EDGE_PROMPT(info) }] }] }) });
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 2500)); continue; }
      const d = await r.json(); if (!r.ok) { edges = { lines: [], notes: "Automatic tracing failed (" + (d?.error?.message || r.status) + "). Add the edges by hand." }; break; }
      cost = (d.usage?.input_tokens || 0) * 4e-6 + (d.usage?.output_tokens || 0) * 2e-5;
      const t = (d.content || []).map((x: any) => x.text || "").join("");
      try { edges = JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)); } catch { edges = { lines: [], notes: "Couldn't trace the edges automatically. Add them by hand." }; }
      break;
    }
  }
  await db.from("ri_usage").insert({ ip, step: "measure", input_tokens: 0, output_tokens: 0, cost_usd: cost + 0.012 });

  return out({
    formatted, location: c, zoom: z, ftPerPx: fpp,
    quality: sd.imageryQuality, imageryDate: sd.imageryDate,
    roof: { areaFt2: (sp.wholeRoofStats?.areaMeters2 || 0) * 10.7639, groundFt2: (sp.wholeRoofStats?.groundAreaMeters2 || 0) * 10.7639 },
    facets, edges,
    image: "data:image/png;base64," + b64,
  });
});
