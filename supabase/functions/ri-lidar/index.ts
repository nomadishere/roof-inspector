// ri-lidar: free USGS 3DEP LiDAR roof measurement for one point (Roofly internal; token-locked).
// Finds the newest EPT point-cloud dataset covering the point, downloads only the tiles around it, decodes the LAZ with
// laz-perf (WASM), then lidar-core.ts fits roof planes and the squared drip-edge outline. ~0.6 s of CPU per roof.
import { createClient } from "npm:@supabase/supabase-js@2";
import { createLazPerf } from "npm:laz-perf@0.0.7";
import { analyze } from "./lidar-core.ts";
const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { "Content-Type": "application/json" } });
const S3 = "https://usgs-lidar-public.s3.amazonaws.com/";
// [dataset, year, xmin, ymin, xmax, ymax] in EPSG:3857 metres (cube bounds), newest first
const DATASETS: [string, number, number, number, number, number][] = [["MT_StatewideP4_1_B22", 2022, -12886471, 5883857, -12737915, 6032413], ["MT_StatewideP4_2_B22", 2022, -12224000, 5650513, -11970516, 5903997], ["MT_StatewideP4_3_B22", 2022, -12114272, 5717904, -12064102, 5768074], ["MT_StatewideP4_4_B22", 2022, -12647073, 5848168, -12396215, 6099026], ["MT_StatewideP4_5_B22", 2022, -12683418, 5577191, -12395396, 5865213], ["MT_StatewideP4_6_B22", 2022, -12634829, 5462515, -12397851, 5699493], ["MT_StatewideP4_7_B22", 2022, -12620418, 5594832, -12440448, 5774802], ["MT_StatewideP4_8_B22", 2022, -12104680, 5870834, -11852670, 6122844], ["MT_StatewideP4_9_B22", 2022, -11879283, 5867164, -11624395, 6122052], ["MT_HCW_1_2021", 2021, -12488142, 5964110, -12048804, 6403448], ["MT_HCW_2_2021", 2021, -11895258, 5883545, -11503702, 6275101], ["MT_Statewide_P3_1_B21", 2021, -12786737, 5881957, -12578041, 6090653], ["MT_Statewide_P3_2_B21", 2021, -12580068, 5894338, -12193158, 6281248], ["MT_Statewide_P3_3_B21", 2021, -12585503, 5578219, -12175065, 5988657], ["MT_Statewide_P3_4_B21", 2021, -12777417, 5726549, -12202571, 6301395], ["MT_Statewide_P3_5_B21", 2021, -12804238, 6065495, -12578700, 6291033], ["MT_Statewide_P2_1_2020", 2020, -11866415, 5964355, -11580209, 6250561], ["MT_Statewide_P2_2_2020", 2020, -12920282, 5950702, -12709556, 6161428], ["MT_Statewide_P2_3_2020", 2020, -12282614, 5959993, -12042102, 6200505], ["MT_Statewide_P2_4_2020", 2020, -12220447, 5791069, -11621527, 6389989], ["MT_Statewide_P2_5_2020", 2020, -12700067, 6069205, -12435673, 6333599], ["WY_YellowstoneNP_1RF_2020", 2020, -12299794, 5649790, -12298360, 5651224], ["WY_YellowstoneNP_1_2020", 2020, -12393295, 5621864, -12191047, 5824112], ["WY_YellowstoneNP_2RF_2020", 2020, -12336047, 5556619, -12288371, 5604295], ["WY_YellowstoneNP_2_2020", 2020, -12393202, 5509365, -12223708, 5678859], ["WY_YellowstoneNP_3_2020", 2020, -12367374, 5444375, -12242550, 5569199], ["MT_RavalliGraniteCusterPowderRiver_2_2019", 2019, -11832726, 5595948, -11685528, 5743146], ["MT_RavalliGraniteCusterPowder_1_2019", 2019, -12906531, 5539956, -12245881, 6200606], ["MT_RavalliGraniteCusterPowder_4_2019", 2019, -12754416, 5484591, -12279406, 5959601], ["MT_DNRC_1_2018", 2018, -11616299, 5828948, -11596217, 5849030], ["MT_NRCS_B1_QL1_2018", 2018, -12612588, 6171260, -12563336, 6220512], ["MT_NRCS_B1_QL2_2018", 2018, -12733479, 5521853, -11836493, 6418839], ["MT_NRCS_B2_2018", 2018, -11889119, 5575903, -11580115, 5884907], ["MT_Helena_2012", 2012, -12499835, 5856635, -12446753, 5909717], ["MT_SageGrouse_2010", 2010, -12165162, 5822226, -12099310, 5888078]];

const HALF = 45; // metres around the point
function to3857(lng: number, lat: number) { return [(lng * 20037508.34) / 180, (Math.log(Math.tan(((90 + lat) * Math.PI) / 360)) / (Math.PI / 180)) * 20037508.34 / 180]; }

// walk the EPT hierarchy and list the nodes that overlap the window, with how much of each node is inside it
async function nodesFor(ds: string, B: number[], x0: number, y0: number, half: number) {
  const SIZE = B[2] - B[0], cache = new Map<string, Record<string, number> | null>(); const res: { key: string; d: number; est: number }[] = [];
  const hier = async (k: string) => { if (!cache.has(k)) { const r = await fetch(`${S3}${ds}/ept-hierarchy/${k}.json`); cache.set(k, r.ok ? await r.json() : null); } return cache.get(k)!; };
  const visit = async (key: string, sub: string): Promise<void> => {
    const [d, x, y, z] = key.split("-").map(Number), s = SIZE / 2 ** d, nx0 = B[0] + x * s, ny0 = B[1] + y * s;
    if (nx0 > x0 + half || nx0 + s < x0 - half || ny0 > y0 + half || ny0 + s < y0 - half) return;
    const h = await hier(sub); if (!h) return; const n = h[key]; if (n === undefined) return; if (n === -1) return visit(key, key);
    if (n > 0) { const ov = (Math.min(nx0 + s, x0 + half) - Math.max(nx0, x0 - half)) * (Math.min(ny0 + s, y0 + half) - Math.max(ny0, y0 - half)); res.push({ key, d, est: n * Math.min(1, ov / (s * s)) }); }
    const kids: Promise<void>[] = [];
    for (let dx = 0; dx < 2; dx++) for (let dy = 0; dy < 2; dy++) for (let dz = 0; dz < 2; dz++) kids.push(visit(`${d + 1}-${2 * x + dx}-${2 * y + dy}-${2 * z + dz}`, sub));
    await Promise.all(kids);
  };
  await visit("0-0-0-0", "0-0-0-0"); return res;
}
// dense surveys (e.g. 18 points per m2) would blow the edge CPU limit: add depth levels only until ~6 points per m2 are in the window
function limitDepth(ns: { key: string; d: number; est: number }[], windowM2: number) {
  const byD = new Map<number, number>(); ns.forEach((n) => byD.set(n.d, (byD.get(n.d) || 0) + n.est));
  let acc = 0, maxD = 0; for (const d of [...byD.keys()].sort((a, b) => a - b)) { acc += byD.get(d)!; maxD = d; if (acc / windowM2 >= 6) break; }
  return ns.filter((n) => n.d <= maxD);
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return out({ error: "POST only" }, 405);
  let b: any = {}; try { b = await req.json(); } catch {}
  const { data: t } = await db.from("admin_secrets").select("value").eq("name", "RI_WORKER_TOKEN").maybeSingle();
  if (!t?.value || b.token !== t.value) return out({ error: "no" }, 403);
  const T: Record<string, number> = {}; let t0 = performance.now(); const lap = (k: string) => { const n = performance.now(); T[k] = Math.round(n - t0); t0 = n; };
  let lat = +b.lat, lng = +b.lng;
  if (!(isFinite(lat) && isFinite(lng) && b.lat != null) && b.address) { // test / bench use: geocode here
    const g = await fetch(`https://maps.googleapis.com/maps/api/geocode/json?address=${encodeURIComponent(String(b.address))}&key=${Deno.env.get("GOOGLE_MAPS_KEY")}`).then((r) => r.json());
    const l = g.results?.[0]?.geometry?.location; if (!l) return out({ ok: false, reason: "Address not found." }); lat = l.lat; lng = l.lng; }
  if (!isFinite(lat) || !isFinite(lng)) return out({ ok: false, reason: "No location." }, 400);
  const [x0, y0] = to3857(lng, lat), k = 1 / Math.cos((lat * Math.PI) / 180);
  const cands = DATASETS.filter((d) => x0 > d[2] && x0 < d[4] && y0 > d[3] && y0 < d[5]);
  if (!cands.length) return out({ ok: false, reason: "No USGS LiDAR dataset covers this location.", lat, lng });
  let chosen: any = null, keys: string[] = [];
  let bestDepth = -1; // newest dataset with deep (dense) tiles here; a dataset whose box merely touches the area only has coarse tiles
  for (const d of cands.slice(0, 6)) { const all = await nodesFor(d[0], [d[2], d[3], d[4], d[5]], x0, y0, (HALF + 6) * k); const md = Math.max(0, ...all.map((q) => q.d)); if (all.length >= 3 && md > bestDepth) { chosen = d; keys = limitDepth(all, (2 * HALF) ** 2).map((q) => q.key); bestDepth = md; } if (md >= 9) break; }
  lap("hierarchy_ms");
  if (!chosen) return out({ ok: false, reason: "The LiDAR datasets listed for this area have no points at this address.", lat, lng });
  const bufs = await Promise.all(keys.map(async (kk) => new Uint8Array(await (await fetch(`${S3}${chosen[0]}/ept-data/${kk}.laz`)).arrayBuffer())));
  lap("fetch_ms");
  const LP: any = await createLazPerf(); lap("wasm_ms");
  const xs: number[] = [], ys: number[] = [], zs: number[] = [], rn: number[] = [], nr: number[] = [], cl: number[] = [];
  let total = 0;
  for (const buf of bufs) {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength), fmt = dv.getUint8(104) & 0x3f;
    const sx = dv.getFloat64(131, true), sy = dv.getFloat64(139, true), sz = dv.getFloat64(147, true), ox = dv.getFloat64(155, true), oy = dv.getFloat64(163, true), oz = dv.getFloat64(171, true);
    const lz = new LP.LASZip(); const fp = LP._malloc(buf.byteLength); LP.HEAPU8.set(buf, fp); lz.open(fp, buf.byteLength);
    const cnt = lz.getCount(), plen = lz.getPointLength(), dp = LP._malloc(plen);
    for (let i = 0; i < cnt; i++) {
      lz.getPoint(dp); const p = new DataView(LP.HEAPU8.buffer, dp, plen); total++;
      const x = (p.getInt32(0, true) * sx + ox - x0) / k, y = (p.getInt32(4, true) * sy + oy - y0) / k; if (Math.abs(x) > HALF || Math.abs(y) > HALF) continue;
      const rb = p.getUint8(14); xs.push(x); ys.push(y); zs.push(p.getInt32(8, true) * sz + oz);
      if (fmt >= 6) { rn.push(rb & 15); nr.push(rb >> 4); cl.push(p.getUint8(16)); } else { rn.push(rb & 7); nr.push((rb >> 3) & 7); cl.push(p.getUint8(15) & 31); }
    }
    lz.delete(); LP._free(fp); LP._free(dp);
  }
  lap("decode_ms");
  const b64 = (a: ArrayBufferView) => { const u = new Uint8Array(a.buffer, a.byteOffset, a.byteLength); let s = ""; for (let i = 0; i < u.length; i += 8192) s += String.fromCharCode(...u.subarray(i, i + 8192)); return btoa(s); };
  if (b.points) return out({ lat, lng, dataset: chosen[0], year: chosen[1], n: xs.length, x: b64(Float32Array.from(xs)), y: b64(Float32Array.from(ys)), z: b64(Float64Array.from(zs)), rn: b64(Uint8Array.from(rn)), nr: b64(Uint8Array.from(nr)), cl: b64(Uint8Array.from(cl)) });
  const cloud = { n: xs.length, x: Float32Array.from(xs), y: Float32Array.from(ys), z: Float64Array.from(zs), rn, nr, cl };
  const clip = Array.isArray(b.clip) && b.clip.length >= 3 && b.clip.length <= 400 && b.clip.every((q: any) => Array.isArray(q) && isFinite(q[0]) && isFinite(q[1])) ? b.clip.map((q: number[]) => [+q[0], +q[1]]) : undefined;
  const r = analyze(cloud, { clip, margin: isFinite(+b.margin) ? Math.max(0, Math.min(4, +b.margin)) : 1.5 }); lap("analyze_ms");
  return out({ ...r, lat, lng, dataset: chosen[0], year: chosen[1], tiles: keys.length, pointsRead: total, pointsInWindow: xs.length, T });
});
