import { FN, SUPABASE_ANON, SCAN_BUDGET, PHOTO_BUDGET, FONTS, ROOF_TYPES } from "./config.js";
import { loadVideo, grab, planScan, bestAround, circle, jpeg, fmtTime, loadImage, imageToCanvas } from "./frames.js";
import { render, fitPages, brandVars } from "./report.js";

const $ = (id) => document.getElementById(id);
const state = { videos: [], photos: [], logo: "", model: null };
const BRAND_KEY = "roofInspector.brand.v1";

// ---------- setup ----------
FONTS.forEach((f, i) => $("font").insertAdjacentHTML("beforeend", `<option value="${i}">${f.name}</option>`));
ROOF_TYPES.forEach((r) => $("roofTypes").insertAdjacentHTML("beforeend", `<label><input type="checkbox" value="${r.id}"> ${r.label}</label>`));
$("date").value = new Date().toISOString().slice(0, 10);

try {
  const saved = JSON.parse(localStorage.getItem(BRAND_KEY) || "null");
  if (saved) {
    for (const k of ["company", "preparedBy", "phone", "email", "website", "tagline", "references"]) if (saved[k]) $(k).value = saved[k];
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
  const ul = $(kind === "videos" ? "videoList" : "photoList");
  ul.innerHTML = state[kind].map((f, i) => `<li><span>${f.name} · ${(f.size / 1048576).toFixed(1)} MB</span><button type="button" data-kind="${kind}" data-i="${i}" aria-label="Remove ${f.name}">Remove</button></li>`).join("");
}
for (const kind of ["videos", "photos"]) {
  $(kind).addEventListener("change", (e) => { state[kind].push(...e.target.files); e.target.value = ""; listFiles(kind); });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".files button"); if (!b) return;
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
async function api(name, body) {
  const ctrl = new AbortController(); const to = setTimeout(() => ctrl.abort(), 175000);
  let r;
  try {
    r = await fetch(FN + name, { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", apikey: SUPABASE_ANON, Authorization: "Bearer " + SUPABASE_ANON }, body: JSON.stringify(body) });
  } catch (e) { throw new Error(e.name === "AbortError" ? "That took too long. Please try again, maybe with a shorter video." : "Couldn't reach Roof Inspector. Check your connection and try again."); }
  finally { clearTimeout(to); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || "Something went wrong. Please try again.");
  return data;
}

// ---------- progress UI ----------
const STEPS = [
  ["scan", "Pulling stills from your video", "About 1 frame per second"],
  ["vision", "Finding the problems", "AI reviews every still"],
  ["sharp", "Picking the sharpest shots", "2 frames per second around each problem, circled in red"],
  ["write", "Writing the repair plan and estimate", "Materials and labor for each roof type"],
  ["build", "Building your report", ""],
];
function showSteps() { $("steps").innerHTML = STEPS.map(([id, t, d]) => `<li id="st-${id}"><span class="dot"></span><span>${t}<span class="det" id="det-${id}">${d}</span></span></li>`).join(""); }
function step(id, detail) {
  let passed = true;
  for (const [sid] of STEPS) { const li = $("st-" + sid); li.className = sid === id ? "on" : passed ? "done" : ""; if (sid === id) passed = false; }
  if (detail) $("det-" + id).textContent = detail;
}
const show = (which) => { for (const s of ["form", "work", "review"]) $("step-" + s).hidden = s !== which; window.scrollTo(0, 0); };

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
  };
  try { localStorage.setItem(BRAND_KEY, JSON.stringify({ ...brand, font: brand.fontIndex, references: $("references").value })); } catch {}
  const d = $("date").value ? new Date($("date").value + "T12:00:00") : new Date();
  const job = { address: $("address").value.trim(), client: $("client").value.trim(), date: d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), roofTypes, notes: $("notes").value.trim() };
  const margin = { include: pricing() === "margin", pct: Math.max(0, Math.min(100, +$("pct").value || 0)) };

  show("work"); showSteps(); $("workErr").textContent = ""; $("backBtn").hidden = true;
  try {
    state.model = await build({ brand, job, margin, references: $("references").value.trim() });
    openReview();
  } catch (ex) {
    console.error(ex);
    $("workErr").textContent = ex.message || "Something went wrong.";
    $("backBtn").hidden = false;
  }
});
$("backBtn").addEventListener("click", () => show("form"));

async function build({ brand, job, margin, references }) {
  // 1. scan
  step("scan");
  const vids = [];
  for (const f of state.videos) vids.push(await loadVideo(f));
  const multi = vids.length > 1;
  const vLabel = (vi, t) => (multi ? `Video ${vi + 1} ` : "Video ") + fmtTime(t);
  const images = [], index = {};
  const { plan } = planScan(vids, SCAN_BUDGET);
  for (let k = 0; k < plan.length; k++) {
    const { vi, t } = plan[k];
    const c = await grab(vids[vi], t, 640);
    const id = "F" + (k + 1);
    images.push({ id, label: vLabel(vi, t), data: jpeg(c, 0.72) });
    index[id] = { kind: "video", vi, t };
    if (k % 4 === 0) step("scan", `${k + 1} of ${plan.length} stills`);
  }
  const photoImgs = [];
  for (let p = 0; p < Math.min(state.photos.length, PHOTO_BUDGET); p++) {
    const img = await loadImage(state.photos[p]); photoImgs.push(img);
    const id = "P" + (p + 1);
    images.push({ id, label: "Photo " + (p + 1), data: jpeg(imageToCanvas(img, 900), 0.75) });
    index[id] = { kind: "photo", p };
  }
  step("scan", `${images.length} stills ready`);

  // 2. vision
  step("vision");
  const { result: A } = await api("ri-analyze", { step: "vision", job, images });
  const findingsIn = Array.isArray(A.findings) ? A.findings : [];

  // 3. sharp frames + circles
  step("sharp");
  const fullFor = async (ref, box) => {
    const r = index[ref]; if (!r) return null;
    if (r.kind === "photo") { const c = imageToCanvas(photoImgs[r.p], 1600); return { img: jpeg(box ? circle(c, box) : c, 0.82), label: "Photo " + (r.p + 1) }; }
    const { canvas, t } = await bestAround(vids[r.vi], r.t, 1600);
    return { img: jpeg(box ? circle(canvas, box) : canvas, 0.82), label: vLabel(r.vi, t) };
  };
  const findings = [];
  for (let i = 0; i < findingsIn.length; i++) {
    const f = findingsIn[i];
    step("sharp", `Photo ${i + 1} of ${findingsIn.length}`);
    const shot = (await fullFor(f.image, f.box)) || (await fullFor(images[0].id, null));
    findings.push({ title: f.title || "Finding", category: f.category || "Roof", severity: f.severity || "Medium", description: f.description || "", img: shot?.img || "", timeLabel: shot?.label || "" });
  }
  const leaks = [];
  for (const l of Array.isArray(A.leaks) ? A.leaks : []) {
    const shot = await fullFor(l.image, null);
    leaks.push({ location: l.location || "", condition: l.condition || "", img: shot?.img || "", timeLabel: shot?.label || "" });
  }
  const coverShot = (await fullFor(A.cover, null)) || (await fullFor(images[0].id, null));

  // 4. DIY + estimates in parallel
  step("write");
  const analysis = { findings: findingsIn, summary: A.summary, size_squares: A.size_squares };
  const [diyR, ...estR] = await Promise.all([
    api("ri-analyze", { step: "diy", job, analysis }),
    ...job.roofTypes.map((rt) => api("ri-analyze", { step: "estimate", job, analysis, roofType: rt })),
  ]);

  // 5. assemble
  step("build");
  const company = brand.company;
  return {
    v: 1, brand, job, margin, references,
    cover: coverShot?.img || "",
    coverTitle: "Roof Inspection Report",
    summary: A.summary || "",
    facts: Array.isArray(A.roof_facts) ? A.roof_facts : [],
    findings, leaks,
    diy: (diyR.result.items || []).map((x) => ({ ...x, findings: (x.findings || []).filter((n) => n >= 1 && n <= findings.length) })),
    estimates: estR.map((r, i) => ({ roofType: job.roofTypes[i], options: (r.result.options || []).map(cleanOpt), assumptions: r.result.assumptions || [] })),
    note: `Thank you for the chance to look at the roof at ${job.address}.\n\nThis report shows what we found, in plain language, with every problem photographed and circled. We've also included a step-by-step repair plan you can use with anyone, even if you never hire us. Good advice should be free.\n\nIf anything here is unclear, call us. We're happy to walk the roof with you.`,
    recommendation: "We recommend handling the Critical and High items first, since those are the ones most likely to let water in. Medium and Low items can be planned and budgeted for.",
    terms: "50% deposit to schedule, balance due at substantial completion.\nWorkmanship warranty provided in writing at signing.\nProposal valid for 30 days.\nChanges by written change order.",
    exclusions: "Hidden damage found after tear-off (decking, framing) is priced separately and approved by you before work continues.\nInterior repairs are not included unless listed.\nQuantities marked \"confirm\" are estimated from video and will be verified on site.",
    createdAt: new Date().toISOString(), madeWith: "Roof Inspector",
    company,
  };
}
function cleanOpt(o) {
  return { name: o.name || "Option", scope: o.scope || "", lines: (o.lines || []).map((l) => ({ kind: l.kind === "Labor" ? "Labor" : "Materials", desc: l.desc || "", qty: +l.qty || 0, unit: l.unit || "", price: +l.price || 0 })) };
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
  setPath(state.model, el.dataset.k, el.innerText.trim());
});
rep.addEventListener("focusout", (e) => {
  const el = e.target.closest("[data-k]"); if (!el) return;
  if (el.classList.contains("numfield")) {
    const n = parseFloat(el.innerText.replace(/[^0-9.\-]/g, ""));
    if (!isNaN(n)) setPath(state.model, el.dataset.k, n);
    const y = window.scrollY; draw(); window.scrollTo(0, y);
  } else fitPages(rep);
});
rep.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.target.closest(".numfield")) { e.preventDefault(); e.target.blur(); } });
rep.addEventListener("click", (e) => {
  const b = e.target.closest("[data-rm]"); if (!b) return;
  const [arr, i] = b.dataset.rm.split(".");
  if (arr === "findings") {
    const n = +i + 1; // keep DIY references pointing at the right photos
    state.model.diy.forEach((d) => (d.findings = (d.findings || []).filter((x) => x !== n).map((x) => (x > n ? x - 1 : x))));
  }
  state.model[arr].splice(+i, 1);
  const y = window.scrollY; draw(); window.scrollTo(0, y);
});
$("rvMargin").addEventListener("change", () => { state.model.margin.include = $("rvMargin").checked; draw(); });
$("rvPct").addEventListener("change", () => { state.model.margin.pct = Math.max(0, Math.min(100, +$("rvPct").value || 0)); if (state.model.margin.include) draw(); });

$("pdfBtn").addEventListener("click", () => {
  const t = document.title; document.title = `Roof Report - ${state.model.job.address}`.replace(/[\\/:*?"<>|]/g, "");
  fitPages(rep); window.print(); setTimeout(() => (document.title = t), 1000);
});
$("newBtn").addEventListener("click", () => {
  if (!confirmLeave()) return;
  state.model = null; state.videos = []; state.photos = []; listFiles("videos"); listFiles("photos");
  ["address", "client", "notes"].forEach((k) => ($(k).value = "")); document.querySelectorAll("#roofTypes input").forEach((i) => (i.checked = false));
  show("form");
});
function confirmLeave() { return window.confirm ? window.confirm("Start a new report? This one will be cleared unless you've shared or downloaded it.") : true; }

$("shareBtn").addEventListener("click", async () => {
  const btn = $("shareBtn"), out = $("shareOut");
  btn.disabled = true; btn.textContent = "Saving…";
  try {
    const s = await api("ri-share", {});
    const body = JSON.stringify(state.model);
    const put = await fetch(s.signedUrl, { method: "PUT", headers: { "Content-Type": "application/json", "x-upsert": "false" }, body });
    if (!put.ok) throw new Error("Couldn't save the report for sharing. Please try again.");
    const link = new URL("view.html?id=" + s.id, location.href).href;
    out.hidden = false;
    out.innerHTML = `<input id="shareLink" readonly value="${link}" aria-label="Share link"><button class="btn" id="copyBtn" type="button">Copy</button>${navigator.share ? `<button class="btn" id="nativeShare" type="button">Send…</button>` : ""}`;
    $("copyBtn").onclick = async () => { try { await navigator.clipboard.writeText(link); $("copyBtn").textContent = "Copied"; } catch { $("shareLink").select(); } };
    if ($("nativeShare")) $("nativeShare").onclick = () => navigator.share({ title: "Roof Inspection Report", text: `Roof inspection report for ${state.model.job.address}`, url: link }).catch(() => {});
  } catch (e) {
    out.hidden = false; out.innerHTML = `<span class="err">${e.message}</span>`;
  } finally { btn.disabled = false; btn.textContent = "Share link"; }
});

window.addEventListener("beforeunload", (e) => { if (state.model) { e.preventDefault(); e.returnValue = ""; } });

$("pdfBtn2").addEventListener("click", () => $("pdfBtn").click());
$("shareBtn2").addEventListener("click", () => { window.scrollTo(0, 0); $("shareBtn").click(); });
$("topBtn").addEventListener("click", () => window.scrollTo({ top: 0, behavior: "smooth" }));

// testing hook
window.__roofInspector = { state, openReview, draw };
