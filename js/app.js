import { FN, SUPABASE_ANON, SCAN_FPS, SCAN_MAX, BATCH, PARALLEL, PHOTO_BUDGET, FONTS, ROOF_TYPES } from "./config.js";
import { loadVideo, grab, planScan, bestAround, circle, jpeg, fmtTime, loadImage, imageToCanvas } from "./frames.js";
import { render, fitPages, brandVars, parseRefs } from "./report.js";
import * as acct from "./account.js";

const $ = (id) => document.getElementById(id);
const state = { videos: [], photos: [], work: [], logo: "", model: null, user: null, reportId: null, dirty: false };
const BRAND_KEY = "roofInspector.brand.v1";

// ---------- setup ----------
FONTS.forEach((f, i) => $("font").insertAdjacentHTML("beforeend", `<option value="${i}">${f.name}</option>`));
ROOF_TYPES.forEach((r) => $("roofTypes").insertAdjacentHTML("beforeend", `<label><input type="checkbox" value="${r.id}"> ${r.label}</label>`));
$("date").value = new Date().toISOString().slice(0, 10);

try {
  const saved = JSON.parse(localStorage.getItem(BRAND_KEY) || "null");
  if (saved) {
    for (const k of ["company", "preparedBy", "phone", "email", "website", "tagline", "references", "about"]) if (saved[k]) $(k).value = saved[k];
    if (saved.color) { $("color").value = saved.color; $("colorHex").value = saved.color; }
    if (saved.font != null) $("font").value = saved.font;
    if (saved.logo) setLogo(saved.logo);
  }
} catch {}

$("color").addEventListener("input", () => ($("colorHex").value = $("color").value));
$("colorHex").addEventListener("input", () => { const v = $("colorHex").value.trim(); if (/^#[0-9a-f]{6}$/i.test(v)) $("color").value = v; });
document.querySelectorAll('input[name=pricing]').forEach((r) => r.addEventListener("change", () => ($("pctWrap").hidden = pricing() !== "margin")));
const pricing = () => document.querySelector('input[name=pricing]:checked').value;

function listFiles(kind) {
  const ul = $({ videos: "videoList", photos: "photoList", work: "workList" }[kind]);
  ul.innerHTML = state[kind].map((f, i) => `<li><span>${f.name} · ${(f.size / 1048576).toFixed(1)} MB</span><button type="button" data-kind="${kind}" data-i="${i}" aria-label="Remove ${f.name}">Remove</button></li>`).join("");
}
$("workPhotos").addEventListener("change", (e) => { state.work.push(...e.target.files); e.target.value = ""; listFiles("work"); });
// iPhones copy (and sometimes download from iCloud or convert) a video before handing it to the page.
// That can take a while with no sign of life, so we show a "getting your video" note as soon as they come back.
let picking = null, pickTimer = null;
function pickNote(kind, on) {
  const el = $(kind === "videos" ? "videoWait" : "photoWait"); if (!el) return;
  el.hidden = !on; clearTimeout(pickTimer);
  if (on) pickTimer = setTimeout(() => (el.hidden = true), 240000);
}
const backFromPicker = () => { if (picking && document.visibilityState === "visible") { const k = picking; setTimeout(() => picking === k && pickNote(k, true), 250); } };
window.addEventListener("focus", backFromPicker);
document.addEventListener("visibilitychange", backFromPicker);
for (const kind of ["videos", "photos"]) {
  $(kind).addEventListener("click", () => { picking = kind; });
  $(kind).addEventListener("cancel", () => { picking = null; pickNote(kind, false); });
  $(kind).addEventListener("change", (e) => { picking = null; pickNote(kind, false); state[kind].push(...e.target.files); e.target.value = ""; listFiles(kind); });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".files button[data-kind]"); if (!b) return;
  state[b.dataset.kind].splice(+b.dataset.i, 1); listFiles(b.dataset.kind);
});

function setLogo(url) {
  state.logo = url;
  $("logoPrev").innerHTML = url ? `<img src="${url}" alt="Your logo">` : "";
  $("logoLabel").textContent = url ? "Change logo" : "Add logo";
}
$("logo").addEventListener("change", async (e) => {
  const f = e.target.files[0]; if (!f) return;
  try { const img = await loadImage(f); setLogo(imageToCanvas(img, 600).toDataURL("image/png")); } catch (err) { $("formErr").textContent = err.message; }
});

// ---------- API ----------
async function api(name, body, tries = 5) {
  for (let i = 1; ; i++) {
    try { return await api1(name, body); }
    catch (e) { if (i >= tries || !e.retry) throw e; await new Promise((r) => setTimeout(r, [2000, 5000, 10000, 20000][i - 1] || 20000)); }
  }
}
// XHR instead of fetch: on a phone, uploading stills over cell can be slow, so the clock only
// starts once the upload has finished, and we can show upload progress.
function api1(name, body, onUp) {
  return new Promise((resolve, reject) => {
    const fail = (msg, retry = true) => { const x = new Error(msg); x.retry = retry; reject(x); };
    const x = new XMLHttpRequest(); let to = null;
    x.open("POST", FN + name);
    x.setRequestHeader("Content-Type", "application/json"); x.setRequestHeader("apikey", SUPABASE_ANON); x.setRequestHeader("Authorization", "Bearer " + SUPABASE_ANON);
    x.upload.onprogress = (e) => onUp && e.lengthComputable && onUp(e.loaded, e.total);
    x.upload.onload = () => { to = setTimeout(() => x.abort(), 240000); };
    x.onerror = () => { clearTimeout(to); fail("Couldn't reach Roofly. Check your connection and try again."); };
    x.onabort = () => { clearTimeout(to); fail("One step took too long. Please try again."); };
    x.onload = () => {
      clearTimeout(to);
      let data; try { data = JSON.parse(x.responseText); } catch { data = { error: "AI", message: "The answer was cut off. Retrying…" }; }
      if (x.status >= 400 || data.error) {
        const e = new Error(data.message || "Something went wrong. Please try again.");
        e.retry = x.status >= 500 || ["AI", "PARSE", "AI_BUSY"].includes(data.error) || (!data.error && !data.result);
        return reject(e);
      }
      resolve(data);
    };
    x.send(JSON.stringify(body));
  });
}

// ---------- progress UI ----------
const STEPS = [
  ["scan", "Pulling every second of your video", "1 still per second"],
  ["vision", "Inspecting every frame", "Looking for every problem, batch by batch"],
  ["merge", "Putting the findings together", "Removing duplicates and rating priorities"],
  ["sharp", "Picking the sharpest shots", "2 frames per second around each problem, circled in red"],
  ["write", "Writing the repair plan, proposals and your note", "DIY plan, interior leak report, Options A and B"],
  ["build", "Building your report", ""],
];
function showSteps() { $("steps").innerHTML = STEPS.map(([id, t, d]) => `<li id="st-${id}"><span class="dot"></span><span>${t}<span class="det" id="det-${id}">${d}</span></span></li>`).join(""); }
function step(id, detail) {
  let passed = true;
  for (const [sid] of STEPS) { const li = $("st-" + sid); li.className = sid === id ? "on" : passed ? "done" : ""; if (sid === id) passed = false; }
  if (detail) $("det-" + id).textContent = detail;
}
const show = (which) => { for (const s of ["form", "work", "review", "account"]) $("step-" + s).hidden = s !== which; window.scrollTo(0, 0); };

// ---------- main pipeline ----------
$("form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const err = $("formErr"); err.textContent = "";
  const roofTypes = [...document.querySelectorAll("#roofTypes input:checked")].map((i) => i.value);
  if (!state.videos.length && !state.photos.length) return (err.textContent = "Add at least one video or photo.");
  if (!$("address").value.trim()) return (err.textContent = "Add the property address."), $("address").focus();
  if (!roofTypes.length) return (err.textContent = "Check at least one roof type.");
  if (!$("company").value.trim()) return (err.textContent = "Add your company name."), $("company").focus();

  const font = FONTS[+$("font").value] || FONTS[0];
  const brand = {
    company: $("company").value.trim(), preparedBy: $("preparedBy").value.trim(), phone: $("phone").value.trim(),
    email: $("email").value.trim(), website: $("website").value.trim(), tagline: $("tagline").value.trim(),
    color: $("colorHex").value.trim() || "#16603A", fontIndex: +$("font").value, fontStack: font.stack, logo: state.logo,
    about: $("about").value.trim(),
  };
  try { localStorage.setItem(BRAND_KEY, JSON.stringify({ ...brand, font: brand.fontIndex, references: $("references").value })); } catch {}
  const d = $("date").value ? new Date($("date").value + "T12:00:00") : new Date();
  const job = { company: brand.company, address: $("address").value.trim(), client: $("client").value.trim(), clientPhone: $("clientPhone").value.trim(), clientEmail: $("clientEmail").value.trim(), date: d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), roofTypes, notes: $("notes").value.trim() };
  const margin = { include: pricing() === "margin", pct: Math.max(0, Math.min(100, +$("pct").value || 0)) };

  // free account (before any AI spend, so a bad password doesn't waste a run)
  const aEmail = $("acctEmail").value.trim(), aPhone = $("acctPhone").value.trim();
  if (!state.user && $("makeAcct").checked) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(aEmail)) return (err.textContent = "Add your email for your free account, or uncheck \"Create my free account\"."), $("acctEmail").focus();
    if ($("acctPw").value.length < 6) return (err.textContent = "Choose a password with at least 6 characters."), $("acctPw").focus();
    const go = $("go"); go.disabled = true; go.textContent = "Creating your account…";
    try { const r = await acct.createOrSignIn(aEmail, $("acctPw").value, { phone: aPhone, company: brand.company }); setUser(r.user); }
    catch (ex) { err.textContent = ex.message; return; }
    finally { go.disabled = false; go.textContent = "Build my report"; }
  } else if (!state.user && (aEmail || aPhone)) {
    acct.saveLead({ email: aEmail, phone: aPhone, company: brand.company }).catch(() => {});
  }
  if (state.user) acct.saveProfile(state.user, { phone: aPhone || undefined, company: brand.company, brand }).catch(() => {});

  show("work"); showSteps(); $("workErr").textContent = ""; $("backBtn").hidden = true;
  try {
    state.model = await build({ brand, job, margin, references: $("references").value.trim() });
    state.reportId = null;
    openReview();
    await saveToAccount();
  } catch (ex) {
    console.error(ex);
    $("workErr").textContent = ex.message || "Something went wrong.";
    $("backBtn").hidden = false;
  }
});
$("backBtn").addEventListener("click", () => show("form"));

async function pool(items, n, fn) { // run fn over items, n at a time, keep order
  const out = new Array(items.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const k = next++; out[k] = await fn(items[k], k); } }));
  return out;
}

async function build({ brand, job, margin, references }) {
  // 1. every second of every video
  step("scan");
  const vids = [];
  for (const f of state.videos) vids.push(await loadVideo(f));
  const multi = vids.length > 1;
  const vLabel = (vi, t) => (multi ? `Video ${vi + 1} ` : "Video ") + fmtTime(t);
  const images = [], index = {};
  const totalSec = vids.reduce((a, v) => a + v.duration, 0);
  const { plan } = planScan(vids, Math.min(SCAN_MAX, Math.ceil(totalSec * SCAN_FPS) + vids.length));
  // skip stills that are nearly identical to the last one kept (camera paused), but keep one every 3 s
  const thumb = document.createElement("canvas"); thumb.width = 32; thumb.height = 18;
  const tctx = thumb.getContext("2d", { willReadFrequently: true });
  let last = null, lastT = -99, lastV = -1;
  for (let k = 0; k < plan.length; k++) {
    const { vi, t } = plan[k];
    const c = await grab(vids[vi], t, 768);
    tctx.drawImage(c, 0, 0, 32, 18); const px = tctx.getImageData(0, 0, 32, 18).data;
    const g = new Uint8Array(576); for (let i = 0; i < 576; i++) g[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
    let diff = 255; if (last && vi === lastV) { diff = 0; for (let i = 0; i < 576; i++) diff += Math.abs(g[i] - last[i]); diff /= 576; }
    if (k % 5 === 0) step("scan", `${k + 1} of ${plan.length} seconds`);
    if (diff < 5 && t - lastT < 3) continue;
    last = g; lastT = t; lastV = vi;
    const id = "F" + (images.length + 1);
    images.push({ id, label: vLabel(vi, t), data: jpeg(c, 0.62) });
    index[id] = { kind: "video", vi, t };
  }
  const photoImgs = [];
  for (let p = 0; p < Math.min(state.photos.length, PHOTO_BUDGET); p++) {
    const img = await loadImage(state.photos[p]); photoImgs.push(img);
    const id = "P" + (p + 1);
    images.push({ id, label: "Photo " + (p + 1), data: jpeg(imageToCanvas(img, 1024), 0.78) });
    index[id] = { kind: "photo", p };
  }
  step("scan", `${images.length} stills ready`);

  // 2. inspect every frame, in batches, several at once
  const batches = [];
  for (let i = 0; i < images.length; i += BATCH) batches.push(images.slice(i, i + BATCH));
  let done = 0;
  step("vision", `0 of ${batches.length} batches`);
  const raw = await pool(batches, PARALLEL, async (imgs, bi) => {
    const part = `batch ${bi + 1} of ${batches.length}, ${imgs[0].label} to ${imgs[imgs.length - 1].label}`;
    const r = await api("ri-report", { step: "vision", job, images: imgs, part });
    step("vision", `${++done} of ${batches.length} batches`);
    const res = r.result || {};
    // attach labels so the merge step knows where each image is in the video
    for (const f of [...(res.findings || []), ...(res.leaks || [])]) f.source = imgs.find((x) => x.id === f.image)?.label || "";
    return res;
  });

  // 3. merge into one inspection (the AI only picks and orders; descriptions stay as written)
  step("merge");
  const rawF = {}, rawL = {}, flat = [], covers = [], factsSeen = [];
  raw.forEach((res, bi) => {
    (res.findings || []).forEach((f) => { const id = "R" + (Object.keys(rawF).length + 1); rawF[id] = f; flat.push({ id, at: f.source, title: f.title, category: f.category, severity: f.severity, description: f.description }); });
    (res.leaks || []).forEach((l) => { const id = "L" + (Object.keys(rawL).length + 1); rawL[id] = l; flat.push({ id, at: l.source, location: l.location, observed: l.observed }); });
    covers.push(...(res.cover_candidates || [])); if (res.facts_seen) factsSeen.push(res.facts_seen);
  });
  const M = (await api("ri-report", { step: "consolidate", job, batches: { items: flat, cover_candidates: covers.slice(0, 20), facts_seen: factsSeen } })).result || {};
  const C = { cover: M.cover, roof_system: M.roof_system, facts: M.facts, size_squares: M.size_squares, findings: [], leaks: [] };
  const usedF = new Set(), usedL = new Set();
  for (const k of M.findings || []) { const f = rawF[k.use]; if (!f || usedF.has(k.use)) continue; usedF.add(k.use); (k.also || []).forEach((x) => usedF.add(x)); C.findings.push({ ...f, title: k.title || f.title, severity: k.severity || f.severity }); }
  for (const k of M.leaks || []) { const l = rawL[k.use]; if (!l || usedL.has(k.use)) continue; usedL.add(k.use); (k.also || []).forEach((x) => usedL.add(x)); C.leaks.push({ ...l, condition: k.condition || l.condition || "" }); }
  // safety net: nothing the camera found is silently lost
  for (const id in rawF) if (!usedF.has(id)) C.findings.push(rawF[id]);
  for (const id in rawL) if (!usedL.has(id)) C.leaks.push(rawL[id]);
  step("merge", `${C.findings.length} findings, ${C.leaks.length} interior leak locations`);
  const planP = api("ri-report", { step: "plan", job, c: { roof_system: C.roof_system, facts: C.facts, findings: C.findings.map((f, i) => ({ n: i + 1, title: f.title, category: f.category, severity: f.severity, description: f.description })), leaks: C.leaks.map(({ location, condition, observed, significance }) => ({ location, condition, observed, significance })) } });

  // 4. sharpest frames around each problem, circled
  step("sharp");
  const fullFor = async (ref, box) => {
    const r = index[ref]; if (!r) return null;
    if (r.kind === "photo") { const c = imageToCanvas(photoImgs[r.p], 1600); return { img: jpeg(box ? circle(c, box) : c, 0.82), label: "Photo " + (r.p + 1) }; }
    const { canvas, t } = await bestAround(vids[r.vi], r.t, 1600);
    return { img: jpeg(box ? circle(canvas, box) : canvas, 0.82), label: vLabel(r.vi, t) };
  };
  const findings = [];
  for (let i = 0; i < C.findings.length; i++) {
    const f = C.findings[i]; step("sharp", `Photo ${i + 1} of ${C.findings.length}`);
    const shot = (await fullFor(f.image, f.box)) || (await fullFor(images[0].id, null));
    findings.push({ title: f.title || "Finding", category: f.category || "Roof", severity: f.severity || "Medium", description: f.description || "", img: shot?.img || "", timeLabel: shot?.label || "" });
  }
  const leaks = [];
  for (const l of C.leaks) {
    const shot = await fullFor(l.image, l.box);
    leaks.push({ location: l.location || "", condition: l.condition || "", observed: l.observed || "", significance: l.significance || "", img: shot?.img || "", timeLabel: shot?.label || "" });
  }
  const coverShot = (await fullFor(C.cover, null)) || (await fullFor(images[0].id, null));

  // 5. write everything else at once
  step("write");
  const P = (await planP).result || {};
  Object.assign(C, { summary: P.summary, leak_summary: P.leak_summary, leak_next_steps: P.leak_next_steps, repair_phases: P.repair_phases, limitations: P.limitations });
  const cText = { roof_system: C.roof_system, summary: C.summary, facts: C.facts, size_squares: C.size_squares, findings: C.findings.map(({ title, category, severity, description }) => ({ title, category, severity, description })), leaks: C.leaks, repair_phases: C.repair_phases };
  const workPh = (C.repair_phases || []).filter((p) => (p.findings || []).length && !/ongoing/i.test(p.name || ""));
  let wrote = 0; const total = 2 + workPh.length + job.roofTypes.length;
  const tick = (r) => { step("write", `${++wrote} of ${total} sections written`); return r; };
  // each phase's repair items in its own call, so no single answer runs long
  const itemsP = Promise.all(workPh.map((ph, i) => api("ri-report", { step: "diy_items", job, c: { ...cText, phase: ph, startAt: 1 + workPh.slice(0, i).reduce((a, p) => a + Math.max(1, Math.round(p.findings.length / 2)), 0) } }).then(tick)));
  const [guide, itemsArr, note, ...ests] = await Promise.all([
    api("ri-report", { step: "diy_guide", job, c: cText }).then(tick),
    itemsP,
    api("ri-report", { step: "note", job, c: cText }).then(tick),
    ...job.roofTypes.map((rt) => api("ri-report", { step: "estimate", job, c: cText, roofType: rt }).then(tick)),
  ]);

  // past-work photos for the Our Work page
  const workPhotos = [];
  for (const f of state.work.slice(0, 8)) { try { workPhotos.push({ img: jpeg(imageToCanvas(await loadImage(f), 1200), 0.8), caption: "" }); } catch {} }

  step("build");
  const secs = Math.round(totalSec), src = state.videos.length ? `Walkthrough video${state.videos.length > 1 ? "s" : ""} ${state.videos.map((v) => v.name).join(", ")} (${Math.floor(secs / 60)} min ${secs % 60} s)` : `${state.photos.length} photos`;
  const nf = findings.length;
  return {
    v: 2, brand, job, margin, references, refs: parseRefs(references),
    cover: coverShot?.img || "", coverTitle: "Roof Report, Repair Plan & Proposals",
    source: src, roof_system: C.roof_system || "", summary: Array.isArray(C.summary) ? C.summary : [C.summary || ""],
    facts: Array.isArray(C.facts) ? C.facts : [], findings, leaks,
    leak_summary: C.leak_summary || "", leak_next_steps: C.leak_next_steps || [], limitations: C.limitations || [],
    phases: (C.repair_phases || []).map((p) => ({ name: p.name, covers: p.covers, when: p.when })),
    diy: { guide: guide.result || {}, phases: (() => { let n = 0; return itemsArr.map((r, i) => ({ name: workPh[i].name, items: ((r.result || {}).items || []).map((x) => ({ ...x, title: `${++n}. ` + String(x.title || "Repair").replace(/^\s*\d+[.)]\s*/, ""), findings: (x.findings || []).filter((n) => n >= 1 && n <= nf) })) })); })() },
    note: note.result || {},
    estimates: ests.map((r, i) => { const e = r.result || {}; return { roofType: job.roofTypes[i], options: (e.options || []).map(cleanOpt), compare_rows: e.compare_rows || [], recommended: e.recommended || "", recommendation: Array.isArray(e.recommendation) ? e.recommendation : [e.recommendation || ""], quantities_note: e.quantities_note || "", assumptions: e.assumptions || [], exclusions: e.exclusions || [], payment: e.payment || "" }; }),
    terms: "50% deposit to schedule, balance due at substantial completion. Proposal valid for 30 days. Changes by written change order.",
    workPhotos, createdAt: new Date().toISOString(), madeWith: "Roofly",
  };
}
function cleanOpt(o) {
  return { key: o.key || "", name: o.name || "Option", subtitle: o.subtitle || "", warranty: o.warranty || "", timeline: o.timeline || "", scope: o.scope || "", lines: (o.lines || []).map((l) => ({ kind: l.kind === "Labor" ? "Labor" : "Materials", desc: l.desc || "", qty: +l.qty || 0, unit: l.unit || "", price: +l.price || 0 })) };
}

// ---------- review ----------
const rep = $("report");
function loadFont(b) {
  const f = FONTS[b.fontIndex]; if (!f?.google || document.getElementById("gf-" + b.fontIndex)) return;
  document.head.insertAdjacentHTML("beforeend", `<link id="gf-${b.fontIndex}" rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${f.google}&display=swap">`);
}
function scaleSheet() {
  const sheet = document.querySelector(".sheet"); const w = 816;
  const z = Math.min(1, (document.documentElement.clientWidth - 16) / w);
  sheet.style.width = w + "px"; sheet.style.zoom = z;
}
function draw() {
  const m = state.model;
  rep.setAttribute("style", brandVars(m.brand));
  rep.innerHTML = render(m, { editable: true });
  scaleSheet();
  const fit = () => fitPages(rep);
  fit(); document.fonts?.ready.then(fit);
  rep.querySelectorAll("img").forEach((im) => im.complete || im.addEventListener("load", fit, { once: true }));
}
function openReview() {
  const m = state.model;
  loadFont(m.brand);
  $("rvMargin").checked = m.margin.include; $("rvPct").value = m.margin.pct;
  $("shareOut").hidden = true;
  show("review"); draw();
}
window.addEventListener("resize", () => !$("step-review").hidden && scaleSheet());

const getPath = (o, p) => p.split(".").reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, p, v) { const ks = p.split("."); const last = ks.pop(); const t = ks.reduce((a, k) => a[k], o); t[last] = v; }
rep.addEventListener("input", (e) => {
  const el = e.target.closest("[data-k]"); if (!el || el.classList.contains("numfield")) return;
  setPath(state.model, el.dataset.k, el.innerText.trim()); markDirty();
});
rep.addEventListener("focusout", (e) => {
  const el = e.target.closest("[data-k]"); if (!el) return;
  if (el.classList.contains("numfield")) {
    const n = parseFloat(el.innerText.replace(/[^0-9.\-]/g, ""));
    if (!isNaN(n)) { setPath(state.model, el.dataset.k, n); markDirty(); }
    const y = window.scrollY; draw(); window.scrollTo(0, y);
  } else fitPages(rep);
});
rep.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.closest(".numfield")) { e.preventDefault(); e.target.blur(); } });
rep.addEventListener("click", (e) => {
  const b = e.target.closest("[data-rm]"); if (!b) return;
  const parts = b.dataset.rm.split("."), i = +parts.pop(), arr = parts.join(".");
  if (arr === "findings") {
    const n = +i + 1; // keep DIY references pointing at the right photos
    (state.model.diy.phases || []).forEach((ph) => (ph.items || []).forEach((d) => (d.findings = (d.findings || []).filter((x) => x !== n).map((x) => (x > n ? x - 1 : x)))));
  }
  getPath(state.model, arr).splice(i, 1); markDirty();
  const y = window.scrollY; draw(); window.scrollTo(0, y);
});
$("rvMargin").addEventListener("change", () => { state.model.margin.include = $("rvMargin").checked; draw(); markDirty(); });
$("rvPct").addEventListener("change", () => { state.model.margin.pct = Math.max(0, Math.min(100, +$("rvPct").value || 0)); if (state.model.margin.include) draw(); markDirty(); });

$("pdfBtn").addEventListener("click", () => {
  const t = document.title; document.title = `Roof Report - ${state.model.job.address}`.replace(/[\\/:*?"<>|]/g, "");
  fitPages(rep); window.print(); setTimeout(() => (document.title = t), 1000);
});
$("newBtn").addEventListener("click", () => {
  if (!confirmLeave()) return;
  state.model = null; state.videos = []; state.photos = []; listFiles("videos"); listFiles("photos");
  state.work = []; listFiles("work"); ["address", "client", "clientPhone", "clientEmail", "notes"].forEach((k) => ($(k).value = "")); document.querySelectorAll("#roofTypes input").forEach((i) => (i.checked = false));
  show("form");
});
function confirmLeave() { if (state.user && !state.dirty) return true; return window.confirm ? window.confirm("Start a new report? This one will be cleared unless you've shared or downloaded it.") : true; }

$("shareBtn").addEventListener("click", async () => {
  const btn = $("shareBtn"), out = $("shareOut");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const s = await api("ri-share", {});
    const body = JSON.stringify(state.model);
    const put = await fetch(s.signedUrl, { method: "PUT", headers: { "Content-Type": "application/json", "x-upsert": "false" }, body });
    if (!put.ok) throw new Error("Couldn't save the report for sharing. Please try again.");
    const link = new URL("view.html?id=" + s.id, location.href).href;
    state.model.shareId = s.id; markDirty();
    out.hidden = false;
    out.innerHTML = `<input id="shareLink" readonly value="${link}" aria-label="Share link"><button class="btn" id="copyBtn" type="button">Copy</button>${navigator.share ? `<button class="btn" id="nativeShare" type="button">Send…</button>` : ""}`;
    $("copyBtn").onclick = async () => { try { await navigator.clipboard.writeText(link); $("copyBtn").textContent = "Copied"; } catch { $("shareLink").select(); } };
    if ($("nativeShare")) $("nativeShare").onclick = () => navigator.share({ title: "Roof Inspection Report", text: `Roof inspection report for ${state.model.job.address}`, url: link }).catch(() => {});
  } catch (e) {
    out.hidden = false; out.innerHTML = `<span class="err">${e.message}</span>`;
  } finally { btn.disabled = false; btn.textContent = "Share link"; }
});

window.addEventListener("beforeunload", (e) => { if (state.model && (!state.user || state.dirty)) { e.preventDefault(); e.returnValue = ""; } });

$("pdfBtn2").addEventListener("click", () => $("pdfBtn").click());
$("shareBtn2").addEventListener("click", () => { window.scrollTo(0, 0); $("shareBtn").click(); });
$("topBtn").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

// ---------- accounts ----------
let saveTimer = null;
function markDirty() {
  if (!state.user || !state.model) return;
  state.dirty = true; $("saveNote").textContent = "Unsaved changes"; $("saveBtn").hidden = false;
  clearTimeout(saveTimer); saveTimer = setTimeout(saveToAccount, 4000);
}
async function saveToAccount() {
  $("saveRow").hidden = !state.user;
  if (!state.user || !state.model) return;
  clearTimeout(saveTimer);
  $("saveNote").textContent = "Saving to your account…"; $("saveBtn").hidden = true;
  try { state.reportId = await acct.saveReport(state.user, state.model, state.reportId); state.dirty = false; $("saveNote").textContent = "Saved to your account ✓"; }
  catch (e) { $("saveNote").textContent = e.message; $("saveBtn").hidden = false; }
}
$("saveBtn").addEventListener("click", saveToAccount);

function setUser(user) {
  state.user = user || null;
  $("acctBtn").textContent = user ? "My reports" : "Log in";
  $("acctSignedOut").hidden = !!user; $("acctSignedIn").hidden = !user;
  if (user) $("acctWho").textContent = user.email;
  $("saveRow").hidden = !(user && state.model);
}
async function applyProfile(user) {
  const p = await acct.loadProfile(user).catch(() => null);
  const b = p?.brand; if (!b) return;
  for (const k of ["company", "preparedBy", "phone", "email", "website", "tagline"]) if (b[k] && !$(k).value) $(k).value = b[k];
  if (b.color) { $("color").value = b.color; $("colorHex").value = b.color; }
  if (b.fontIndex != null) $("font").value = b.fontIndex;
  if (b.logo) setLogo(b.logo);
}
$("makeAcct").addEventListener("change", () => { const on = $("makeAcct").checked; $("pwWrap").hidden = !on; $("noAcctNote").hidden = on; });
$("email").addEventListener("change", () => { if (!$("acctEmail").value) $("acctEmail").value = $("email").value; });

async function showAccount() {
  show("account");
  $("loginBox").hidden = !!state.user; $("reportsBox").hidden = !state.user;
  if (!state.user) return;
  $("reportsWho").textContent = state.user.email; $("reportsErr").textContent = ""; $("reportsList").innerHTML = "<li><span>Loading…</span></li>";
  try {
    const rows = await acct.listReports();
    $("reportsList").innerHTML = rows.length ? rows.map((r) => `<li><span>${esc(r.address || "Untitled")}<span class="meta">${esc(r.client || "")}${r.client ? " · " : ""}${new Date(r.created_at).toLocaleDateString()}</span></span><span class="acts"><button type="button" class="open" data-open="${r.id}">Open</button><button type="button" data-del="${r.id}" aria-label="Delete report">Delete</button></span></li>`).join("") : "<li><span>No reports yet.</span></li>";
  } catch (e) { $("reportsErr").textContent = e.message; $("reportsList").innerHTML = ""; }
}
const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
$("acctBtn").addEventListener("click", async () => {
  if (!$("step-review").hidden && state.model) { if (state.user) { if (state.dirty) await saveToAccount(); } else if (!confirmLeave()) return; }
  showAccount();
});
$("loginBack").addEventListener("click", () => show(state.model ? "review" : "form"));
$("newFromList").addEventListener("click", () => { state.model = null; state.reportId = null; show("form"); });
$("loginForm").addEventListener("submit", async (e) => {
  e.preventDefault(); $("loginErr").textContent = ""; $("loginGo").disabled = true;
  try { const u = await acct.signIn($("loginEmail").value.trim(), $("loginPw").value); setUser(u); applyProfile(u); showAccount(); }
  catch (ex) { $("loginErr").textContent = ex.message; }
  finally { $("loginGo").disabled = false; }
});
$("signOutBtn").addEventListener("click", async () => { await acct.signOut(); setUser(null); state.model = null; state.reportId = null; show("form"); });
$("reportsList").addEventListener("click", async (e) => {
  const o = e.target.closest("[data-open]"), d = e.target.closest("[data-del]");
  if (o) {
    o.textContent = "Opening…";
    try { state.model = await acct.openReport(state.user, o.dataset.open); state.reportId = o.dataset.open; state.dirty = false; openReview(); $("saveRow").hidden = false; $("saveNote").textContent = "Saved to your account ✓"; $("saveBtn").hidden = true; }
    catch (ex) { $("reportsErr").textContent = ex.message; o.textContent = "Open"; }
  } else if (d) {
    if (window.confirm && !window.confirm("Delete this report? This can't be undone.")) return;
    await acct.deleteReport(state.user, d.dataset.del).catch(() => {}); showAccount();
  }
});
$("forgotBtn").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim(); $("loginErr").textContent = ""; $("forgotNote").textContent = "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $("loginErr").textContent = "Type your email above first, then tap Forgot password."; return; }
  try { await acct.sendReset(email); $("forgotNote").textContent = "Check your email for a link to choose a new password."; }
  catch (e) { $("loginErr").textContent = "Couldn't send the reset email right now. " + e.message; }
});
acct.sb.auth.onAuthStateChange((event, session) => {
  if (event === "PASSWORD_RECOVERY") { show("account"); $("loginBox").hidden = true; $("reportsBox").hidden = true; $("resetBox").hidden = false; setUser(session?.user); }
});
$("resetForm").addEventListener("submit", async (e) => {
  e.preventDefault(); $("resetErr").textContent = "";
  if ($("newPw").value.length < 6) { $("resetErr").textContent = "Use at least 6 characters."; return; }
  try { const u = await acct.setNewPassword($("newPw").value); setUser(u); $("resetBox").hidden = true; applyProfile(u); showAccount(); }
  catch (ex) { $("resetErr").textContent = ex.message; }
});
const resetToken = new URLSearchParams(location.search).get("reset_token");
if (resetToken) {
  history.replaceState(null, "", location.pathname);
  acct.useResetToken(resetToken).then((u) => { setUser(u); show("account"); $("loginBox").hidden = true; $("reportsBox").hidden = true; $("resetBox").hidden = false; })
    .catch((e) => { show("account"); $("reportsBox").hidden = true; $("loginBox").hidden = false; $("loginErr").textContent = e.message; });
} else acct.currentUser().then((u) => { setUser(u); if (u) applyProfile(u); }).catch(() => {});

// testing hook
window.__roofInspector = { state, openReview, draw };
