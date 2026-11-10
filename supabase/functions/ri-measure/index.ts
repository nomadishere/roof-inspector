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

First trace the OUTLINE: the outer edge of the whole roof (including overhangs and every wing, porch and attached section of this building) as a closed polygon. Make sure no part of the roof is left outside it. Then trace the lines.

Return ONLY JSON:
{"outline":[[x,y],[x,y],[x,y]],
 "lines":[{"type":"eave","x1":0,"y1":0,"x2":0,"y2":0}],
 "style":"e.g. gable, hip, cross-gable, flat with parapet, mixed",
 "stories":1,
 "counts":{"chimneys":0,"skylights":0,"vents":0,"hvac":0},
 "confidence":"high|medium|low",
 "notes":"one or two sentences: anything hard to see (trees, shadows, old photo) that a person should double check"}`;

// ---- Learning from corrections ----
// People fix traced edge lengths on the measure page (or enter tape / EagleView numbers). For each edge type we take the
// median of corrected ÷ traced over past roofs (tape and EagleView count 3×), prefer roofs with the same photo quality,
// and only use a type once 3+ roofs agree. Factors are capped at 0.75–1.35 so a few bad entries can't wreck a measurement.
async function learned(quality: string, method = "google") {
  const { data } = await db.from("ri_corrections").select("traced,corrected,source,quality").gte("updated_at", new Date(Date.now() - 365 * 864e5).toISOString()).limit(2000);
  const isL = (c: any) => String(c.quality || "").toUpperCase() === "LIDAR"; // corrections are tagged with the method; each method only learns from its own
  const rows = (data || []).filter((c: any) => (method === "lidar" ? isL(c) : !isL(c)));
  const build = (list0: any[]) => { let list = list0;
    const r: Record<string, number[]> = {};
    // Eaves vs rakes are often mislabeled by the tracer, so learn them TOGETHER as one perimeter factor
    // (otherwise "too many eaves, no rakes" would teach it to shrink the drip edge).
    list = list.map((c: any) => { const tr = c.traced || {}, co = c.corrected || {};
      const tp = (+tr.eave || 0) + (+tr.rake || 0), cp = (+co.eave || 0) + (+co.rake || 0);
      const { eave: _e, rake: _r, ...trRest } = tr, { eave: _e2, rake: _r2, ...coRest } = co;
      return { ...c, traced: { ...trRest, ...(tp ? { perim: tp } : {}) }, corrected: { ...coRest, ...(cp && tp ? { perim: cp } : {}) } }; });
    for (const c of list) for (const t of Object.keys(c.corrected || {})) {
      const a = +c.traced?.[t] || 0, b = +c.corrected[t] || 0;
      if (a < 10 || b <= 0) continue;
      const q = b / a; if (q < 0.4 || q > 2.5) continue;
      for (let w = 0; w < (c.source === "tape" || c.source === "eagleview" ? 3 : 1); w++) (r[t] ||= []).push(q);
    }
    const out: Record<string, { f: number; n: number }> = {};
    for (const t in r) { const v = r[t].sort((x, y) => x - y); const n = list.filter((c) => +c.traced?.[t] >= 10 && c.corrected?.[t] != null).length; if (n < 3) continue;
      const med = v[Math.floor(v.length / 2)]; if (Math.abs(med - 1) < 0.03 && t !== "area") continue; /* a near-1 AREA factor still counts: Roofly is accurate, so the buffer can go */ out[t] = { f: Math.max(0.75, Math.min(1.35, +med.toFixed(3))), n }; }
    return out;
  };
  const same0 = build(rows.filter((c: any) => (c.quality || "").toUpperCase() === String(quality || "").toUpperCase()));
  const all = build(rows); const same = same0;
  const calib: Record<string, { f: number; n: number }> = { ...all, ...same };
  if (calib.perim) { calib.eave = calib.perim; calib.rake = calib.perim; delete calib.perim; }
  const NAME: any = { eave: "eaves", rake: "rakes", ridge: "ridges", hip: "hips", valley: "valleys", edge: "low-slope edges", parapet: "parapets", flashing: "wall flashing" };
  // roof AREA: learned factor once 3+ checked roofs agree; until then a +5% safety buffer (Justin, Nov 7 2026)
  const areaAdj = calib.area ? { f: calib.area.f, n: calib.area.n, kind: "learned" } : { f: 1.05, n: 0, kind: "buffer" };
  delete calib.area;
  const lessons = Object.entries(calib).map(([t, { f, n }]) => `${NAME[t] || t}: your traces came out ${Math.round(Math.abs(f - 1) * 100)}% too ${f > 1 ? "SHORT" : "LONG"} (people corrected ${n} roofs)`);
  return { calib, areaAdj, lessons: lessons.length ? `\nLESSONS FROM PEOPLE CORRECTING YOUR PAST TRACES (do better this time): ${lessons.join("; ")}. ${Object.values(calib).some((x) => x.f > 1) ? "You tend to miss parts of edges: follow every edge all the way to its corners." : ""}` : "" };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return out({ error: "POST only" }, 405);
  const key = Deno.env.get("GOOGLE_MAPS_KEY"); if (!key) return out({ error: "SETUP", message: "Measurements aren't set up yet." }, 503);
  let b: any = {}; try { b = await req.json(); } catch {}
  let ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  // called by Roofly's own report builder (ri-job): skip the per-visitor limit, log against the visitor's IP
  let internal = false, wtok = "";
  { const { data: t } = await db.from("admin_secrets").select("value").eq("name", "RI_WORKER_TOKEN").maybeSingle(); wtok = t?.value || "";
    if (b.token && wtok && b.token === wtok) { internal = true; ip = String(b.ip || "job").slice(0, 64); } }

  const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
  const { data: spent } = await db.from("ri_usage").select("cost_usd").gte("created_at", monthStart.toISOString());
  if ((spent || []).reduce((s: number, r: any) => s + Number(r.cost_usd || 0), 0) >= MONTHLY_CAP_USD) return out({ error: "CAP", message: "Roofly has reached its limit for this month." }, 402);
  const { count } = await db.from("ri_usage").select("id", { count: "exact", head: true }).eq("ip", ip).eq("step", "measure").gte("created_at", new Date(Date.now() - 86400000).toISOString());
  if (!internal && (count || 0) >= PER_IP_PER_DAY) return out({ error: "LIMIT", message: "Too many measurements today. Try again tomorrow." }, 429);

  // 1. where is it
  const address = String(b.address || "").slice(0, 200);
  let lat = +b.lat, lng = +b.lng, formatted = address;
  if (address && !(isFinite(lat) && isFinite(lng) && b.lat != null)) {
    const g = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(address)}&key=${key}`).then((r) => r.json());
    if (!g.results?.[0]) return out({ error: "NOT_FOUND", message: "Couldn't find that address. Check the spelling, or add the city and state." });
    const g0 = g.results[0], ty: string[] = g0.types || [];
    // a town, ZIP or street name alone points at the middle of an area, not a building: refuse instead of measuring the wrong roof
    const precise = ["street_address", "premise", "subpremise", "establishment", "point_of_interest"].some((t) => ty.includes(t)) && g0.geometry?.location_type !== "APPROXIMATE";
    // the town Google matched must be in what was typed (or the ZIP): "324 North 2nd Street" alone matched a house in Texas
    const comp = (k: string) => (g0.address_components || []).find((c: any) => (c.types || []).includes(k));
    const town = comp("locality") || comp("postal_town") || comp("administrative_area_level_3") || comp("sublocality");
    const zip = comp("postal_code")?.long_name || "", typed = address.toLowerCase();
    const townOk = !town || typed.includes(String(town.long_name).toLowerCase()) || typed.includes(String(town.short_name).toLowerCase()) || (zip && typed.includes(zip));
    const st = comp("administrative_area_level_1");
    const stateOk = !st || (zip && typed.includes(zip)) || typed.includes(String(st.long_name).toLowerCase()) || new RegExp(`(^|[\\s,])${String(st.short_name).toLowerCase()}([\\s,.]|$)`).test(typed);
    if (precise && (!townOk || !stateOk)) return out({ error: "NO_TOWN", message: `Add the city and state to the address. "${address}" matched ${g0.formatted_address}, which may not be the right place.`, formatted: g0.formatted_address });
    if (!precise) return out({ error: "NOT_PRECISE", message: `Couldn't pin down the exact building for "${address}" (Google only found ${g0.formatted_address}). Add the street number and street name, e.g. 123 Main St, Livingston, MT.`, formatted: g0.formatted_address });
    lat = g0.geometry.location.lat; lng = g0.geometry.location.lng; formatted = g0.formatted_address;
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
  const z = Math.max(17, Math.min(20, Math.floor(Math.log2((mPerPxAt0 * SIZE * SCALE) / span))));
  const fpp = ftPerPx(c.lat, z);
  const facets = (sp.roofSegmentStats || []).map((s: any, i: number) => {
    const sw = toPx(s.boundingBox.sw.latitude, s.boundingBox.sw.longitude, c, z), ne = toPx(s.boundingBox.ne.latitude, s.boundingBox.ne.longitude, c, z);
    return { n: i + 1, pitchDeg: s.pitchDegrees || 0, azimuthDeg: s.azimuthDegrees || 0, areaFt2: (s.stats?.areaMeters2 || 0) * 10.7639, groundFt2: (s.stats?.groundAreaMeters2 || 0) * 10.7639, heightFt: (s.planeHeightAtCenterMeters || 0) * 3.28084, box: [sw[0], ne[1], ne[0] - sw[0], sw[1] - ne[1]] };
  });

  // 3. aerial photo
  const img = await fetch(`https://maps.googleapis.com/maps/api/staticmap?center=${c.lat},${c.lng}&zoom=${z}&size=${SIZE}x${SIZE}&scale=${SCALE}&maptype=satellite&key=${key}`);
  if (!img.ok) return out({ error: "NO_IMAGE", message: "Couldn't load the aerial photo (Maps Static API). " + (await img.text()).slice(0, 200) });
  const b64 = encodeBase64(new Uint8Array(await img.arrayBuffer()));

  let lid: any = null, lidNote = "";

  // 4. Claude traces the edges, then we check the traced outline against Google's footprint and retry once if it's off
  let edges: any = { lines: [] }, cost = 0, check: any = null;
  const akey = Deno.env.get("ANTHROPIC_API_KEY");
  const groundFt2 = (sp.wholeRoofStats?.groundAreaMeters2 || 0) * 10.7639;
  const polyArea = (pts: any[]) => { let a = 0; for (let i = 0; i < pts.length; i++) { const [x1, y1] = pts[i], [x2, y2] = pts[(i + 1) % pts.length]; a += x1 * y2 - x2 * y1; } return Math.abs(a / 2) * fpp * fpp; };
  const ask = async (text: string) => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await fetch("https://api.anthropic.com/v1/messages", { method: "POST", headers: { "x-api-key": akey!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: "claude-opus-5-5", max_tokens: 8000, messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }, { type: "text", text }] }] }) });
      if (r.status === 429 || r.status >= 500) { await new Promise((s) => setTimeout(s, 2500)); continue; }
      const d = await r.json(); if (!r.ok) return { err: d?.error?.message || String(r.status) };
      cost += (d.usage?.input_tokens || 0) * 4e-6 + (d.usage?.output_tokens || 0) * 2e-5;
      const t = (d.content || []).map((x: any) => x.text || "").join("");
      try { return { j: JSON.parse(t.slice(t.indexOf("{"), t.lastIndexOf("}") + 1)) }; } catch { return { err: "unreadable answer" }; }
    }
    return { err: "AI busy" };
  };
  let L: any = await learned(sd.imageryQuality, "google").catch(() => ({ calib: {}, areaAdj: { f: 1.05, n: 0, kind: "buffer" }, lessons: "" }));
  if (akey) {
    const info = `Scale: 1 pixel = ${fpp.toFixed(3)} ft. Google measured this roof's footprint (seen from above) at about ${Math.round(groundFt2)} sq ft, which is about ${Math.round(groundFt2 / (fpp * fpp))} square pixels in this image. Google detected ${facets.length} roof planes (pixel boxes [x,y,width,height], pitch in degrees, facing = azimuth):\n` +
      facets.map((f: any) => `#${f.n}: box ${JSON.stringify(f.box)}, pitch ${f.pitchDeg.toFixed(1)}°, facing ${Math.round(f.azimuthDeg)}°, ${Math.round(f.areaFt2)} sq ft`).join("\n") + L.lessons;
    const first = await ask(EDGE_PROMPT(info));
    if (first.err) edges = { lines: [], notes: "Automatic tracing failed (" + first.err + "). Add the edges by hand." };
    else {
      let best = first.j, bestA = polyArea(best.outline || []);
      const off = (a: number) => (groundFt2 ? Math.abs(a / groundFt2 - 1) : 0);
      if (groundFt2 && off(bestA) > 0.12) {
        const fb = `${EDGE_PROMPT(info)}\n\nYOUR FIRST TRACE (below) has an outline of about ${Math.round(bestA)} sq ft, but Google's footprint for this roof is about ${Math.round(groundFt2)} sq ft. ${bestA < groundFt2 ? "Part of the roof is missing from your outline: look again at every edge, corner, wing and overhang (especially where the roof meets shadows or trees) and extend the outline and edges to the real roof edge." : "Your outline is too big: it probably includes ground, a neighbour, or shadow. Pull it in to the real roof edge."} Return the corrected full JSON.\nFirst trace: ${JSON.stringify(best)}`;
        const second = await ask(fb);
        if (second.j) { const a2 = polyArea(second.j.outline || []); if (off(a2) < off(bestA)) { best = second.j; bestA = a2; } }
      }
      edges = best;
      check = { tracedFt2: Math.round(bestA), googleFt2: Math.round(groundFt2), ok: !groundFt2 || off(bestA) <= 0.12 };
    }
  }
  // 3b. USGS LiDAR (opt-in: body.lidar === true; live site and reports stay on Google until Justin flips the default).
  // The roof outline Claude traced on the photo clips the LiDAR points, so a neighbouring roof that touches this one is not counted.
  if (b.lidar === true && wtok) {
    const mpp0 = fpp / 3.28084, clip = (edges.outline || []).filter((q: any) => Array.isArray(q) && q.length === 2).map((q: number[]) => [(q[0] - (SIZE * SCALE) / 2) * mpp0, -(q[1] - (SIZE * SCALE) / 2) * mpp0]);
    try { const lr = await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/ri-lidar`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: wtok, lat: c.lat, lng: c.lng, ...(clip.length >= 3 ? { clip, margin: 1.5 } : {}) }) });
      const lj = await lr.json().catch(() => ({})); if (lj.ok && lj.roof?.areaFt2 > 300) { lid = lj; lid.clipped = clip.length >= 3; } else lidNote = lj.reason || "LiDAR was not available for this address.";
    } catch { lidNote = "LiDAR was not available for this address."; }
  }
  if (lid) {
    L = await learned("LIDAR", "lidar").catch(() => L);
    const mpp = fpp / 3.28084, px = (p: number[]) => [Math.round((SIZE * SCALE) / 2 + p[0] / mpp), Math.round((SIZE * SCALE) / 2 - p[1] / mpp)];
    const keep = (edges.lines || []).filter((l: any) => !["eave", "rake", "edge"].includes(l.type));
    const ridges = keep.filter((l: any) => l.type === "ridge"), hipLen = keep.filter((l: any) => l.type === "hip").reduce((s: number, l: any) => s + Math.hypot(l.x2 - l.x1, l.y2 - l.y1), 0) * fpp;
    // direction of the traced ridges: outline edges that run along it are eaves; the ones across it are rakes (gable ends) unless the roof has hips
    let sx = 0, sy = 0; for (const l of ridges) { const a = Math.atan2(l.y2 - l.y1, l.x2 - l.x1), w = Math.hypot(l.x2 - l.x1, l.y2 - l.y1); sx += w * Math.cos(2 * a); sy += w * Math.sin(2 * a); }
    const ra = ridges.length ? Math.atan2(sy, sx) / 2 : null;
    const steepA = lid.faces.filter((f: any) => !f.flat).reduce((s: number, f: any) => s + f.areaFt2, 0), flat = steepA < 0.4 * lid.roof.areaFt2;
    const O = (lid.outline || []).map(px), ol: any[] = [];
    for (let i = 0; i < O.length; i++) { const a = O[i], z = O[(i + 1) % O.length]; if (Math.hypot(z[0] - a[0], z[1] - a[1]) < 1) continue;
      let type = "eave"; if (flat) type = "edge"; else if (ra !== null && hipLen < 15) { let d = Math.abs(Math.atan2(z[1] - a[1], z[0] - a[0]) - ra) % Math.PI; d = Math.min(d, Math.PI - d); if (d > Math.PI / 4) type = "rake"; }
      ol.push({ type, x1: a[0], y1: a[1], x2: z[0], y2: z[1] }); }
    const ratio = groundFt2 ? lid.roof.planFt2 / groundFt2 : 1;
    const warn = ratio > 1.35 ? ` LiDAR found ${Math.round((ratio - 1) * 100)}% more roof than Google's footprint (an attached section, addition or a neighbouring roof joined to this one): confirm which sections are part of this job. Ridge, hip and valley lines are traced only for the section Google found.` : "";
    edges = { ...edges, lines: [...keep, ...ol], notes: ((edges.notes || "") + " Area, pitch and edges come from USGS LiDAR (" + lid.year + ") with the 5% safety buffer; ridges, hips and valleys are traced from the photo." + warn).trim() };
    check = { ...(check || {}), lidarRatio: +ratio.toFixed(2) };
  }
  await db.from("ri_usage").insert({ ip, step: "measure", input_tokens: 0, output_tokens: 0, cost_usd: cost + 0.012 });

  return out({
    formatted, location: c, zoom: z, ftPerPx: fpp,
    quality: lid ? "LIDAR" : sd.imageryQuality, imageryDate: lid ? { year: lid.year, month: "LiDAR" } : sd.imageryDate, method: lid ? "lidar" : "google", lidar: lid ? { dataset: lid.dataset, year: lid.year, density: lid.density, coverage: lid.coverage, tiles: lid.tiles, dripEdgeFt: lid.roof.dripEdgeFt, eaveFt: lid.roof.eaveFt, rakeFt: lid.roof.rakeFt, planFt2: lid.roof.planFt2, outline: lid.outline, otherBuildings: lid.otherBuildings } : (lidNote ? { unavailable: lidNote } : null),
    roof: lid ? { areaFt2: lid.roof.areaFt2 * L.areaAdj.f, rawAreaFt2: lid.roof.areaFt2, groundFt2: lid.roof.planFt2, googleAreaFt2: (sp.wholeRoofStats?.areaMeters2 || 0) * 10.7639, googleGroundFt2: groundFt2 } : { areaFt2: (sp.wholeRoofStats?.areaMeters2 || 0) * 10.7639 * L.areaAdj.f, rawAreaFt2: (sp.wholeRoofStats?.areaMeters2 || 0) * 10.7639, groundFt2: (sp.wholeRoofStats?.groundAreaMeters2 || 0) * 10.7639 },
    facets: lid ? lid.faces.map((f: any) => ({ n: f.n, pitchDeg: f.tiltDeg, azimuthDeg: f.azimuth, areaFt2: f.areaFt2, groundFt2: f.planFt2, heightFt: 0, box: [0, 0, 0, 0] })) : facets, edges, check, calib: L.calib, areaAdj: L.areaAdj,
    image: "data:image/png;base64," + b64,
  });
});
