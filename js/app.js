import { FN, SUPABASE_ANON, SCAN_FPS, SCAN_MAX, STILL_TARGET, LEVELS, BATCH, PARALLEL, PHOTO_BUDGET, FONTS, ROOF_TYPES } from "./config.js";
import { loadVideo, grab, planScan, pickBest, sharpness, circle, jpeg, fmtTime, loadImage, imageToCanvas } from "./frames.js";
import { render, fitPages, brandVars, parseRefs } from "./report.js";
import * as acct from "./account.js";
import * as crm from "./crm-link.js";
import { attachPlaces } from "./places.js";

const $ = (id) => document.getElementById(id);
const state = { videos: [], photos: [], work: [], logo: "", model: null, user: null, reportId: null, dirty: false };
const BRAND_KEY = "roofInspector.brand.v1";

// ---------- setup ----------
FONTS.forEach((f, i) => $("font").insertAdjacentHTML("beforeend", `<option value="${i}">${f.name}</option>`));
ROOF_TYPES.forEach((r) => $("roofTypes").insertAdjacentHTML("beforeend", `<label><input type="checkbox" value="${r.id}"> ${r.label}</label>`));
$("date").value = new Date().toISOString().slice(0, 10);
attachPlaces($("address"));

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
async function api(name, body, tries = 5, userTok = "") {
  for (let i = 1; ; i++) {
    try { return await api1(name, body, null, userTok); }
    catch (e) { if (i >= tries || !e.retry) throw e; await new Promise((r) => setTimeout(r, [2000, 5000, 10000, 20000][i - 1] || 20000)); }
  }
}
// XHR instead of fetch: on a phone, uploading stills over cell can be slow, so the clock only
// starts once the upload has finished, and we can show upload progress.
function api1(name, body, onUp, userTok = "") {
  return new Promise((resolve, reject) => {
    const fail = (msg, retry = true) => { const x = new Error(msg); x.retry = retry; reject(x); };
    const x = new XMLHttpRequest(); let to = null;
    x.open("POST", FN + name);
    x.setRequestHeader("Content-Type", "application/json"); x.setRequestHeader("apikey", SUPABASE_ANON); x.setRequestHeader("Authorization", "Bearer " + SUPABASE_ANON); if (userTok) x.setRequestHeader("x-user-token", userTok);
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
  ["scan", "Pulling the sharpest still from every second", "and sending them to Roofly. Keep this page open for this step."],
  ["vision", "Inspecting every frame", "Looking for every problem, batch by batch"],
  ["merge", "Putting the findings together", "Removing duplicates and rating priorities"],
  ["plan", "Planning the repairs", "Summary, repair phases and interior leak report"],
  ["write", "Writing the repair plan, proposals and your note", "DIY plan, Options A and B"],
  ["build", "Building your report", "Circling every problem in red"],
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
  if (!$("address").value.trim() && !QUICK) return (err.textContent = "Add the property address."), $("address").focus();
  // the city/state must be typed: "324 North 2nd Street" alone matched a house in Texas
  if ($("address").value.trim() && !/\b\d{5}\b|[\s,](AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC)\.?\s*$|\b(alabama|alaska|arizona|arkansas|california|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|washington|west virginia|wisconsin|wyoming)\s*$/i.test($("address").value.trim())) return (err.textContent = "Add the city and state to the address (e.g. 324 N 2nd St, Livingston, MT) so Roofly can measure the right roof from the air."), $("address").focus();
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
  const job = { company: brand.company, address: $("address").value.trim(), client: $("client").value.trim(), clientPhone: $("clientPhone").value.trim(), clientEmail: $("clientEmail").value.trim(), date: d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }), roofTypes, notes: $("notes").value.trim(), level: (document.querySelector('input[name="level"]:checked') || {}).value || "standard", diy: !!$("diy").checked };
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

  show("work"); showSteps(); $("workErr").textContent = ""; $("backBtn").hidden = true; $("leaveNote").hidden = true; $("workHint").hidden = false;
  try {
    const notify = state.user?.email || aEmail || brand.email;
    const references = $("references").value.trim();
    const id = await uploadJob({ brand, job, margin, references, refs: parseRefs(references) }, notify);
    await followJob(id);
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

// ---------- server-side jobs ----------
// The phone pulls the sharpest still from every second and uploads them. Roofly's server does the rest,
// so the person can lock the phone or leave. We email them and save to their account when it's done.
const JOB_KEY = "roofly.job.v1";
async function jobApi(body) {
  const tok = state.user ? await acct.accessToken().catch(() => "") : "";
  return api("ri-job", body, 5, tok);
}
// Patient version for the upload step: a dropped signal never kills the run. It waits for the phone to
// get back online and keeps retrying (the server ignores re-sent stills, they just overwrite). Only real
// refusals from the server (caps, bad input) stop it.
async function jobApiPatient(body, onWait) {
  let waiting = false;
  for (let i = 0; ; i++) {
    try { const r = await jobApi(body); if (waiting && onWait) onWait(false); return r; }
    catch (e) {
      if (!e.retry) throw e;
      if (!waiting && onWait) { waiting = true; onWait(true); }
      await new Promise((res) => {
        const t = setTimeout(res, Math.min(30000, 3000 + i * 2000));
        window.addEventListener("online", () => { clearTimeout(t); res(); }, { once: true });
      });
    }
  }
}
// Saved upload progress: if the page is reloaded or the person goes back and presses Build again with the
// same files and details, we keep the same job and only send the stills the server doesn't have yet.
const UP_KEY = "roofly.upload.v1";
const hash = (str) => { let h = 5381; for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0; return String(h >>> 0); };
const fileSig = (f) => f.name + "|" + f.size + "|" + f.lastModified;
function loadUp(fp) {
  try { const u = JSON.parse(localStorage.getItem(UP_KEY) || "null"); if (u && u.fp === fp && Date.now() - u.at < 12 * 3600e3) return u; } catch {}
  return null;
}
function saveUp(u) { try { localStorage.setItem(UP_KEY, JSON.stringify({ ...u, at: u.at || Date.now() })); } catch {} }
async function uploadJob(input, notify) {
  step("scan", "Getting ready…");
  const fp = hash(JSON.stringify([input, state.videos.map(fileSig), state.photos.map(fileSig), state.work.map(fileSig)]));
  let up = loadUp(fp); // { fp, id, got: { stillId: label }, at }
  let id;
  if (up) id = up.id;
  else { const created = await jobApi({ action: "create", input, notify_email: notify }); id = created.id; up = { fp, id, got: {}, at: Date.now() }; saveUp(up); }
  const resumed = Object.keys(up.got).length;
  const vids = [];
  for (const f of state.videos) vids.push(await loadVideo(f));
  const multi = vids.length > 1;
  const vLabel = (vi, t) => (multi ? `Video ${vi + 1} ` : "Video ") + fmtTime(t);
  const totalSec = vids.reduce((a, v) => a + v.duration, 0);
  const { plan } = planScan(vids, Math.min(SCAN_MAX, Math.ceil(totalSec * SCAN_FPS) + vids.length));
  const manifest = [], queue = []; let sent = 0, failed = null, scanned = 0, done = false;
  let waiting = 0;
  const say = () => step("scan", (resumed ? "Picking up where you left off · " : "") + `${scanned} of ${plan.length} seconds checked · ${sent} of ${manifest.length} stills sent` + (waiting ? " · Waiting for signal… Roofly will pick up right where it left off. Keep this page open." : ""));
  const onWait = (w) => { const was = waiting; waiting = Math.max(0, waiting + (w ? 1 : -1)); if (!was !== !waiting) say(); };
  // upload workers: 6 stills per request, 3 requests at a time
  const uploader = async () => {
    while (!failed) {
      if (!queue.length) { if (done) return; await new Promise((r) => setTimeout(r, 150)); continue; }
      const chunk = queue.splice(0, 6);
      try { await jobApiPatient({ action: "upload", id, images: chunk }, onWait); sent += chunk.length; for (const c of chunk) up.got[c.id] = c.label; saveUp(up); say(); }
      catch (e) { failed = e; }
    }
  };
  const workers = [uploader(), uploader(), uploader()];
  // Step 1 (free, on the phone): look at every second in small size and score it.
  // Step 2: keep only the best STILL_TARGET (sharp, covers the whole walkthrough, most different views),
  // then pull those at full size and send them.
  const thumb = document.createElement("canvas"); thumb.width = 32; thumb.height = 18;
  const tctx = thumb.getContext("2d", { willReadFrequently: true });
  const scored = [];
  for (let k = 0; k < plan.length && !failed; k++) {
    const { vi, t } = plan[k];
    const c = await grab(vids[vi], t, 480);
    tctx.drawImage(c, 0, 0, 32, 18); const px = tctx.getImageData(0, 0, 32, 18).data;
    const g = new Uint8Array(576); for (let i = 0; i < 576; i++) g[i] = (px[i * 4] + px[i * 4 + 1] + px[i * 4 + 2]) / 3;
    scored.push({ k, vi, t, s: sharpness(c), g });
    scanned = k + 1; if (k % 3 === 0) say();
  }
  const picks = pickBest(scored, (LEVELS[input.job?.level] || {}).stills || STILL_TARGET);
  for (const { vi, t } of picks) {
    if (failed) break;
    let c = await grab(vids[vi], t, 1280);
    if (t + 0.5 < vids[vi].duration) { const c2 = await grab(vids[vi], t + 0.5, 1280); if (sharpness(c2) > sharpness(c) * 1.05) c = c2; }
    const sid = "F" + (manifest.length + 1);
    manifest.push({ id: sid, label: vLabel(vi, t) });
    if (up.got[sid] === vLabel(vi, t)) sent++; else queue.push({ id: sid, label: vLabel(vi, t), data: jpeg(c, 0.72) });
    say();
    while (queue.length > 30 && !failed) await new Promise((r) => setTimeout(r, 200)); // don't hold too much in memory
  }
  for (let p = 0; p < Math.min(state.photos.length, PHOTO_BUDGET) && !failed; p++) {
    const img = await loadImage(state.photos[p]); const sid = "P" + (p + 1);
    manifest.push({ id: sid, label: "Photo " + (p + 1) }); if (up.got[sid] === "Photo " + (p + 1)) sent++; else queue.push({ id: sid, label: "Photo " + (p + 1), data: jpeg(imageToCanvas(img, 1280), 0.78) });
  }
  const work = [];
  for (let w = 0; w < Math.min(state.work.length, 8) && !failed; w++) {
    try { const img = await loadImage(state.work[w]); const sid = "W" + (w + 1); work.push(sid); if (up.got[sid] === "work") sent++; else queue.push({ id: sid, label: "work", data: jpeg(imageToCanvas(img, 1200), 0.8) }); } catch {}
  }
  done = true; await Promise.all(workers);
  if (failed) { if (/expired/i.test(failed.message || "")) { try { localStorage.removeItem(UP_KEY); } catch {} } throw failed; }
  const secs = Math.round(totalSec);
  const source = state.videos.length ? `Walkthrough video${state.videos.length > 1 ? "s" : ""} ${state.videos.map((v) => v.name).join(", ")} (${Math.floor(secs / 60)} min ${secs % 60} s)` : `${state.photos.length} photos`;
  await jobApiPatient({ action: "start", id, images: manifest, work, source });
  try { localStorage.setItem(JOB_KEY, JSON.stringify({ id, at: Date.now() })); localStorage.removeItem(UP_KEY); } catch {}
  clearJobDraft();
  return id;
}
const STAGE_STEP = { upload: "scan", vision: "vision", merge: "merge", plan: "plan", write: "write", build: "build", done: "build" };
async function followJob(id) {
  show("work"); if (!$("steps").children.length) showSteps();
  $("workHint").hidden = true; $("leaveNote").hidden = false; $("backBtn").hidden = true; $("workErr").textContent = "";
  $("leaveWhere").textContent = state.user ? "It will be waiting in My reports, and we'll email you a link." : "We'll email you a link when it's ready. Or keep this page open and it will appear here.";
  let misses = 0;
  for (;;) {
    let s;
    try { s = await api("ri-job", { action: "status", id }, 2); misses = 0; }
    catch (e) { if (++misses > 20) throw e; await new Promise((r) => setTimeout(r, 6000)); continue; }
    if (s.status === "error") { try { localStorage.removeItem(JOB_KEY); } catch {} throw new Error(s.error || "Roofly couldn't finish this report. Please try again."); }
    step(STAGE_STEP[s.stage] || "vision", s.progress || undefined);
    if (s.status === "done") {
      // finished reports open in the on-screen proposal page (CRM design, share-to-sign, PDF)
      step("build", "Opening your report");
      try { localStorage.removeItem(JOB_KEY); } catch {}
      state.dirty = false; state.model = null;
      location.replace(new URL("p/?job=" + id, location.href).href);
      return;
      // eslint-disable-next-line no-unreachable
      const m = await fetch(s.report + "?t=" + Date.now()).then((r) => r.json());
      await circleModel(m);
      state.model = m; state.reportId = s.report_id || null; state.dirty = false;
      try { localStorage.removeItem(JOB_KEY); } catch {}
      openReview();
      crm.afterBuild(m, m.margin);
      if (state.user) { if (state.reportId) await saveToAccount(); }
      return;
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
// draw the red circles into the photos (server stores plain stills plus the box)
async function circleModel(m) {
  const one = async (o) => {
    if (!o || !o.img || o.img.startsWith("data:") || !Array.isArray(o.box)) return;
    try {
      const img = await new Promise((res, rej) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => res(i); i.onerror = rej; i.src = o.img; });
      o.img = jpeg(circle(imageToCanvas(img, 1600), o.box), 0.82); delete o.box;
    } catch {}
  };
  await pool([...(m.findings || []), ...(m.leaks || [])], 6, one);
}
// resume a report that was building when the page was closed (or opened from the email link)
async function resumeJob() {
  const q = new URLSearchParams(location.search).get("job");
  let saved = null; try { saved = JSON.parse(localStorage.getItem(JOB_KEY) || "null"); } catch {}
  const id = q || (saved && Date.now() - saved.at < 86400000 ? saved.id : null);
  if (!id || !/^[0-9a-f-]{36}$/.test(id)) return;
  // a saved job that already failed, was stopped or finished must never trap the page: clear it and show the form
  try {
    const s0 = await api("ri-job", { action: "status", id }, 1);
    if (s0.status === "error" || s0.status === "uploading" && !q) { try { localStorage.removeItem(JOB_KEY); } catch {} if (q) history.replaceState(null, "", location.pathname); return; }
    if (s0.status === "done") { try { localStorage.removeItem(JOB_KEY); } catch {} location.replace(new URL("p/?job=" + id, location.href).href); return; }
  } catch (e) { if (!q) { try { localStorage.removeItem(JOB_KEY); } catch {} return; } }
  showSteps();
  try { await followJob(id); }
  catch (ex) { $("workErr").textContent = ex.message || "Something went wrong."; $("backBtn").hidden = false; }
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
    const link = new URL("p/?id=" + s.id, location.href).href;
    state.model.shareId = s.id; markDirty();
    crm.afterShare(link);
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
  $("acctBtn").textContent = user ? "My reports" : "Log in / Sign up";
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
  catch (ex) { $("loginErr").textContent = ex.message + (/wrong/i.test(ex.message) ? " No account yet? Tap Create account." : ""); }
  finally { $("loginGo").disabled = false; }
});
$("signupGo").addEventListener("click", async () => {
  const email = $("loginEmail").value.trim(), pw = $("loginPw").value; $("loginErr").textContent = ""; $("forgotNote").textContent = "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { $("loginErr").textContent = "Type your email first."; return; }
  if (pw.length < 6) { $("loginErr").textContent = "Pick a password with at least 6 characters."; return; }
  $("signupGo").disabled = true; $("signupGo").textContent = "Creating…";
  try { const r = await acct.createOrSignIn(email, pw, {}); setUser(r.user); applyProfile(r.user); showAccount(); }
  catch (ex) { $("loginErr").textContent = ex.message; }
  finally { $("signupGo").disabled = false; $("signupGo").textContent = "Create account"; }
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
  try { await acct.sendReset(email); $("forgotNote").textContent = "If this email has a Roofly account, a reset link is on its way. Nothing in a few minutes? You may not have a Roofly account yet: pick a password and tap Create account."; }
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

// ---------- keep the form filled in ----------
// Everything except the videos and the password is remembered on this device, so a failed or
// repeated run never means typing it all again. Past-work photos are kept in IndexedDB.
const DRAFT_KEY = "roofly.draft.v2";
// move older saved drafts over without any customer details (they could hold a past client)
try { const old = JSON.parse(localStorage.getItem("roofly.draft.v1") || "null"); if (old && !localStorage.getItem(DRAFT_KEY)) { for (const k of ["address", "client", "clientPhone", "clientEmail", "notes", "date"]) delete old.fields[k]; old.jobCleared = true; localStorage.setItem(DRAFT_KEY, JSON.stringify(old)); } localStorage.removeItem("roofly.draft.v1"); } catch {}
var QUICK = new URLSearchParams(location.search).get("me") === "justin";
function saveDraft() {
  const d = { fields: {}, checks: {}, jobCleared: true };
  for (const el of $("form").querySelectorAll("input, textarea, select")) {
    if (el.type === "file" || el.type === "password") continue;
    const key = el.id || `${el.name}=${el.value}`;
    if (el.type === "checkbox" || el.type === "radio") d.checks[key] = el.checked;
    else if (el.id) d.fields[el.id] = el.value;
  }
  d.logo = state.logo || "";
  try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch {}
}
// Customer / job fields are only kept until that report is sent off (so a failed upload can be retried).
// After that the next report starts with a clean customer section; your company details stay.
const JOB_FIELDS = ["address", "client", "clientPhone", "clientEmail", "notes", "date"];
function clearJobDraft() {
  let d; try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch {}
  if (d) { for (const k of JOB_FIELDS) delete d.fields[k]; d.jobCleared = true; try { localStorage.setItem(DRAFT_KEY, JSON.stringify(d)); } catch {} }
  for (const k of JOB_FIELDS) if ($(k) && k !== "date") $(k).value = "";
}
function restoreDraft() {
  let d; try { d = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null"); } catch {}
  // the browser itself can bring back old typed values on reload; start the customer section clean unless this draft holds it
  for (const k of JOB_FIELDS) if (k !== "date" && $(k) && !(d && d.fields && d.fields[k])) $(k).value = "";
  if (!d) return;
  if (!d.jobCleared) { for (const k of JOB_FIELDS) delete d.fields[k]; d.jobCleared = true; } // one-time cleanup of older saved drafts
  for (const el of $("form").querySelectorAll("input, textarea, select")) {
    if (el.type === "file" || el.type === "password") continue;
    const key = el.id || `${el.name}=${el.value}`;
    if (el.type === "checkbox" || el.type === "radio") { if (key in d.checks) el.checked = d.checks[key]; }
    else if (el.id && el.id !== "date" && el.id in d.fields && d.fields[el.id] !== "") el.value = d.fields[el.id];
    if (el.type !== "file") el.dispatchEvent(new Event("change", { bubbles: true }));
  }
  if (d.logo) setLogo(d.logo);
}
const idb = () => new Promise((res, rej) => { const r = indexedDB.open("roofly", 1); r.onupgradeneeded = () => r.result.createObjectStore("kv"); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
async function idbSet(k, v) { try { const db = await idb(); db.transaction("kv", "readwrite").objectStore("kv").put(v, k); } catch {} }
async function idbGet(k) { try { const db = await idb(); return await new Promise((res) => { const q = db.transaction("kv").objectStore("kv").get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch { return null; } }
let draftT = null;
const queueDraft = () => { clearTimeout(draftT); draftT = setTimeout(() => { saveDraft(); idbSet("work", state.work.map((f) => new File([f], f.name, { type: f.type }))); }, 400); };
$("form").addEventListener("input", queueDraft);
$("form").addEventListener("change", queueDraft);
document.addEventListener("click", (e) => { if (e.target.closest(".files button[data-kind='work']")) queueDraft(); });
const _setLogo = setLogo;
setLogo = (url) => { _setLogo(url); queueDraft(); };
restoreDraft();
idbGet("work").then((w) => { if (Array.isArray(w) && w.length && !state.work.length) { state.work.push(...w); listFiles("work"); } });

// ---------- Justin's quick page: useroofly.com/justin ----------
// Everything pre-filled with Lucky Line's details; just add the videos and tap Build.
if (QUICK) {
  const fill = (id, v) => { if (!$(id).value.trim()) $(id).value = v; };
  fill("company", "Lucky Line Roofing"); fill("preparedBy", "Justin Walton"); fill("phone", "4153005496");
  fill("email", "nomadishere@gmail.com"); fill("website", "luckylineroofing.com");
  if (!$("colorHex").value || $("colorHex").value === "#16603A") { $("color").value = "#16603A"; $("colorHex").value = "#16603A"; }
  if (!document.querySelector("#roofTypes input:checked")) { const e = document.querySelector('#roofTypes input[value="EPDM (rubber membrane)"]'); if (e) e.checked = true; }
  $("makeAcct").checked = false; $("makeAcct").dispatchEvent(new Event("change"));
  $("address").placeholder = "Optional on your quick page";
  if (!state.logo) fetch("/justin/logo.png").then((r) => r.blob()).then((b) => new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(b); })).then(setLogo).catch(() => {});
  const banner = document.createElement("div"); banner.className = "tip";
  banner.innerHTML = "<b>Justin's quick page.</b> Your company, logo and colors are already filled in. Just add your videos below, then scroll down and tap <b>Build my report</b>. You can edit anything in the report afterward.";
  $("form").prepend(banner);
  saveDraft();
}

resumeJob();

// Lucky Line CRM link: prefill the job from the CRM and show the link banner.
crm.prefill($);
