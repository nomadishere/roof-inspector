// Roofly roof-measurement math, shared by the measure page (useroofly.com/measure), the report pages,
// and the server that writes the estimates. Plain JS, no DOM, so it runs in the browser and on Supabase.
// The server keeps a byte-for-byte copy at supabase/functions/ri-job/measure-core.js — change both together.

export const COL = { eave: "#2EA84A", rake: "#E67E22", ridge: "#D64541", hip: "#8E44AD", valley: "#2B6FD8", edge: "#16A2B8", parapet: "#FFFFFF", flashing: "#F1C40F" };
export const NAMES = { eave: "Eaves", rake: "Rakes", ridge: "Ridges", hip: "Hips", valley: "Valleys", edge: "Low-slope edges", parapet: "Parapet walls", flashing: "Wall / step flashing" };
export const SYS_NAMES = { shingle: "Asphalt shingle system", metal: "Metal roof system", lowslope: "EPDM / low-slope membrane system" };

export const p12 = (deg) => 12 * Math.tan((deg * Math.PI) / 180);
export const dirn = (a) => ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.floor((((a + 22.5) % 360) + 360) % 360 / 45)];
export const fmt = (n, d = 0) => Number(n || 0).toLocaleString("en-US", { maximumFractionDigits: d, minimumFractionDigits: d });
const ceil = (x) => Math.max(0, Math.ceil(x - 1e-9));

export function pitchInfo(m) {
  const all = m.facets || [], A = all.reduce((s, f) => s + f.areaFt2, 0) || 1;
  const avg = all.reduce((s, f) => s + f.pitchDeg * f.areaFt2, 0) / A;
  const steep = all.filter((f) => f.pitchDeg >= 9.5);
  const sA = steep.reduce((s, f) => s + f.areaFt2, 0);
  const sp = sA ? steep.reduce((s, f) => s + f.pitchDeg * f.areaFt2, 0) / sA : avg;
  return { avg, steep: sp, lowShare: 1 - sA / A };
}
export function pitchText(m) {
  const pi = pitchInfo(m);
  return pi.lowShare > 0.6 ? "Low-slope" : fmt(p12(pi.steep || pi.avg), 1) + "/12";
}

// true lengths in feet per edge type (rakes, hips and valleys corrected for pitch); also sets l._len on each line
export function lengths(m) {
  const k = p12(pitchInfo(m).steep) / 12, pf = Math.sqrt(1 + k * k), hf = Math.sqrt(1 + (k * k) / 2), t = {};
  for (const l of m.edges?.lines || []) {
    const pl = Math.hypot(l.x2 - l.x1, l.y2 - l.y1) * m.ftPerPx;
    const len = pl * (l.type === "rake" ? pf : l.type === "hip" || l.type === "valley" ? hf : 1);
    t[l.type] = (t[l.type] || 0) + len; l._len = len;
  }
  for (const x in t) t[x] = Math.round(t[x]);
  return t;
}

// "Asphalt shingles" / "EPDM (rubber membrane)" / "Metal" (report roof types) -> material system
export function sysFor(roofType, m) {
  const s = String(roofType || "").toLowerCase();
  if (/epdm|membrane|tpo|low.?slope|flat/.test(s)) return "lowslope";
  if (/metal/.test(s)) return "metal";
  if (/shingle/.test(s)) return "shingle";
  return m && pitchInfo(m).lowShare > 0.6 ? "lowslope" : "shingle";
}
export function wasteFor(sys, LEN) {
  if (sys === "lowslope") return 10;
  return (LEN.hip || 0) + (LEN.valley || 0) > 40 ? 15 : 10;
}

// materials list: rows of [item, qty, unit, note]
export function materials(m, LEN, sys, w) {
  const area = m.roof.areaFt2, sq = area / 100, sqw = sq * (1 + w / 100);
  const e = LEN.eave || 0, r = LEN.rake || 0, ri = LEN.ridge || 0, h = LEN.hip || 0, v = LEN.valley || 0, ed = LEN.edge || 0, pa = LEN.parapet || 0, fl = LEN.flashing || 0;
  const c = m.edges?.counts || {};
  const rows = [];
  if (sys === "lowslope") {
    rows.push(["EPDM membrane (10' × 100' rolls)", ceil((area * 1.1 + pa * 2) / 1000), "rolls", `${fmt(area * 1.1 + pa * 2)} sq ft incl. 10% laps + 2' up parapets`]);
    rows.push(["Cover board / insulation (4' × 8')", ceil((area * 1.05) / 32), "sheets", `${fmt(area)} sq ft`]);
    rows.push(["Bonding adhesive", ceil(area / 60), "gal", "about 60 sq ft per gallon"]);
    rows.push(["Edge metal / drip edge (10' sticks)", ceil(((ed + e + r) * 1.05) / 10), "pcs", `${fmt(ed + e + r)} ft of edge + 5%`]);
    if (pa) rows.push(["Parapet coping / termination bar", ceil((pa * 1.05) / 10), "pcs (10')", `${fmt(pa)} ft`]);
    if (fl) rows.push(["Wall flashing (membrane + termination bar)", fmt(fl), "ft", "where the roof meets taller walls"]);
    rows.push(["Seam tape (3\" × 100')", ceil((area / 100) * 10 / 100) || 1, "rolls", "rough: ~10 ft of seam per square"]);
    rows.push(["Pipe boots / pourable sealer pockets", (c.vents || 0) + (c.hvac || 0), "ea", "vents + equipment seen on the photo (confirm)"]);
  } else {
    if (sys === "metal") rows.push(["Metal panels (coverage)", fmt(sqw, 1), "squares", `${fmt(area)} sq ft + ${w}% waste`]);
    else rows.push(["Shingles (3 bundles per square)", ceil(sqw * 3), "bundles", `${fmt(sqw, 1)} squares incl. ${w}% waste`]);
    rows.push(["Synthetic underlayment (10-square rolls)", ceil(sqw / 10), "rolls", `${fmt(sqw, 1)} squares`]);
    rows.push(["Ice & water shield (2-square rolls)", ceil((e * 6 + v * 3) / 200), "rolls", `eaves ${fmt(e)} ft × 6' + valleys ${fmt(v)} ft × 3'`]);
    rows.push(["Drip edge (10' sticks)", ceil(((e + r) * 1.05) / 10), "pcs", `eaves + rakes ${fmt(e + r)} ft + 5%`]);
    if (sys !== "metal") rows.push(["Starter strip (~105 ft per bundle)", ceil((e + r) / 105), "bundles", `${fmt(e + r)} ft`]);
    rows.push([sys === "metal" ? "Ridge / hip cap (10' pcs)" : "Hip & ridge cap (~30 ft per bundle)", sys === "metal" ? ceil(((ri + h) * 1.05) / 10) : ceil((ri + h) / 30), sys === "metal" ? "pcs" : "bundles", `${fmt(ri + h)} ft`]);
    if (v) rows.push(["Valley metal / W-valley (10' pcs)", ceil((v * 1.05) / 10), "pcs", `${fmt(v)} ft`]);
    if (fl) rows.push(["Step / wall flashing", fmt(fl), "ft", "where the roof meets walls"]);
    if (ri) rows.push(["Ridge vent (4' pcs, optional)", ceil(ri / 4), "pcs", `${fmt(ri)} ft of ridge`]);
    rows.push(["Pipe boots", c.vents || 0, "ea", "vents seen on the photo (confirm)"]);
    if (sys !== "metal") rows.push(["Coil roofing nails (boxes)", ceil(sqw / 16), "boxes", "about 16 squares per box"]);
  }
  return { rows, sq, sqw, w, sys };
}

// everything a report needs from one measurement, for each roof type checked on the job
export function reportSummary(m, roofTypes) {
  const LEN = lengths(m);
  const types = (roofTypes && roofTypes.length ? roofTypes : [null]);
  const mats = types.map((rt) => { const sys = sysFor(rt, m), w = wasteFor(sys, LEN); return { roofType: rt || SYS_NAMES[sys], ...materials(m, LEN, sys, w) }; });
  return {
    address: m.formatted, imagery: `${m.imageryDate?.month || "?"}/${m.imageryDate?.year || "?"}`, quality: String(m.quality || "").toLowerCase(),
    areaFt2: Math.round(m.roof.areaFt2), squares: +(m.roof.areaFt2 / 100).toFixed(1), pitch: pitchText(m), faces: (m.facets || []).length,
    style: m.edges?.style || "", counts: m.edges?.counts || {}, notes: m.edges?.notes || "", confidence: m.edges?.confidence || "",
    lengths: LEN,
    facets: (m.facets || []).map((f) => ({ n: f.n, pitch: fmt(p12(f.pitchDeg), 1) + "/12", deg: Math.round(f.pitchDeg), facing: dirn(f.azimuthDeg), areaFt2: Math.round(f.areaFt2) })),
    lines: (m.edges?.lines || []).map((l) => ({ type: l.type, x1: l.x1, y1: l.y1, x2: l.x2, y2: l.y2, len: Math.round(l._len || 0) })),
    materials: mats.map((x) => ({ roofType: x.roofType, sys: x.sys, waste: x.w, squaresWaste: +x.sqw.toFixed(1), rows: x.rows.map(([item, qty, unit, note]) => ({ item, qty: String(qty), unit, note })) })),
  };
}

// plain-text version for the estimator AI
export function summaryText(s, roofType) {
  const mat = s.materials.find((x) => x.roofType === roofType) || s.materials[0];
  return [`MEASURED FROM AERIAL IMAGERY (Google roof data, imagery ${s.imagery}, ${s.quality} quality; field-verify before ordering):`,
    `Roof area ${fmt(s.areaFt2)} sq ft = ${s.squares} squares; ${mat.squaresWaste} squares with ${mat.waste}% waste. Main pitch ${s.pitch}. ${s.faces} roof faces. Style: ${s.style || "n/a"}.`,
    "Edge lengths (ft): " + Object.keys(NAMES).filter((k) => s.lengths[k]).map((k) => `${NAMES[k]} ${fmt(s.lengths[k])}`).join(", ") + ".",
    "Seen on the photo: " + (Object.entries(s.counts).filter(([, v]) => v).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing counted") + ".",
    `Materials for a full ${mat.roofType} replacement: ` + mat.rows.map((r) => `${r.item}: ${r.qty} ${r.unit}`).join("; ") + "."].join("\n");
}
