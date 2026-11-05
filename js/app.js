import { FN, SUPABASE_ANON, SCAN_BUDGET, PHOTO_BUDGET, FONTS, ROOF_TYPES } from "./config.js";
import { loadVideo, grab, planScan, bestAround, circle, jpeg, fmtTime, loadImage, imageToCanvas } from "./frames.js";
import { render, fitPages, brandVars } from "./report.js";
import * as acct from "./account.js";

const $ = (id) => document.getElementById(id);
const state = { videos: [], photos: [], logo: "", model: null, user: null, reportId: null, dirty: false };
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
  };
  try { localStorage.setItem(BRAND_KEY, JSON.stringify({ ...brand, font: brand.fontIndex, references: $("references").value })); } catch {}
  const d = $("date").value ? new Date($("date").value + "T12:00:00") : new Date();
  const job = { address: $("address").value.trim(), client: $("client").value.trim(), date: d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), roofTypes, notes: $("notes").value.trim() };
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
  const [arr, i] = b.dataset.rm.split(".");
  if (arr === "findings") {
    const n = +i + 1; // keep DIY references pointing at the right photos
    state.model.diy.forEach((d) => (d.findings = (d.findings || []).filter((x) => x !== n).map((x) => (x > n ? x - 1 : x))));
  }
  state.model[arr].splice(+i, 1); markDirty();
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
  ["address", "client", "notes"].forEach((k) => ($(k).value = "")); document.querySelectorAll("#roofTypes input").forEach((i) => (i.checked = false));
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
acct.currentUser().then((u) => { setUser(u); if (u) applyProfile(u); }).catch(() => {});

// testing hook
window.__roofInspector = { state, openReview, draw };
