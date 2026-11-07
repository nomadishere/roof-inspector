import { COL, NAMES, fmt, SYS_NAMES } from "./measure-core.js";
// Builds the report package pages, following the Lucky Line VFW Roof Package (35 pages, Oct 2026) section for section.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => "$" + (Math.round(Number(n) || 0)).toLocaleString("en-US");
const money2 = (n) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sevClass = (s) => ({ critical: "critical", high: "high", medium: "medium", low: "low" }[String(s).toLowerCase()] || "medium");
const diffClass = (d) => ({ easy: "easy", moderate: "medium", advanced: "high", "pro only": "critical" }[String(d).toLowerCase().split(" /")[0]] || "medium");
const SEV = ["Critical", "High", "Medium", "Low"];
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const pn = (n) => String(n).padStart(2, "0");

function hexToRgb(h) { h = String(h).replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join(""); const n = parseInt(h, 16) || 0; return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function mix(hex, withRgb, amt) { const a = hexToRgb(hex); return "rgb(" + a.map((v, i) => Math.round(v * (1 - amt) + withRgb[i] * amt)).join(",") + ")"; }
export function brandVars(b) {
  const c = /^#?[0-9a-f]{3,6}$/i.test(b.color || "") ? (b.color.startsWith("#") ? b.color : "#" + b.color) : "#16603A";
  return `--brand:${c};--tint:${mix(c, [255, 255, 255], 0.9)};--cover-bg:${mix(c, [244, 245, 244], 0.94)};--rfont:${b.fontStack || "Arial,Helvetica,sans-serif"}`;
}

export function optionTotals(opt, margin) {
  const lines = opt.lines || [];
  const mat = lines.filter((l) => l.kind !== "Labor").reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const lab = lines.filter((l) => l.kind === "Labor").reduce((a, l) => a + (Number(l.qty) || 0) * (Number(l.price) || 0), 0);
  const sub = mat + lab;
  const op = margin.include ? sub * (Number(margin.pct) || 0) / 100 : 0;
  return { mat, lab, sub, op, total: sub + op };
}

export function parseRefs(text) {
  return String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const parts = l.split(/\s*[|,–—]\s*|\s+-\s+/).filter(Boolean);
    const phone = parts.find((p) => /\d{3}.*\d{4}/.test(p)) || "";
    const rest = parts.filter((p) => p !== phone);
    return { name: rest[0] || l, role: rest.slice(1).join(", "), phone };
  });
}

export function render(m, { editable = true } = {}) {
  const E = (path, html, tag = "span", cls = "") =>
    `<${tag}${cls ? ` class="${cls}"` : ""}${editable ? ` contenteditable="true" data-k="${path}"` : ""}>${html}</${tag}>`;
  const P = (path, list) => arr(list).map((t, i) => E(`${path}.${i}`, esc(t), "p")).join("");
  const LI = (path, list, tag = "ul") => `<${tag}>${arr(list).map((t, i) => `<li>${E(`${path}.${i}`, esc(t))}</li>`).join("")}</${tag}>`;
  const b = m.brand, j = m.job, F = m.findings || [], L = m.leaks || [], D = m.diy || {}, G = D.guide || {};
  const company = b.company || "Your Company";
  const footLeft = [b.tagline, b.phone, b.website].filter(Boolean).map(esc).join(" &nbsp;|&nbsp; ");
  const roofIcon = `<svg width="30" height="16" viewBox="0 0 30 16" aria-hidden="true"><path d="M1 9 L15 2 L29 9" fill="none" stroke="currentColor" stroke-width="2"/><line x1="7" y1="14" x2="23" y2="14" stroke="currentColor" stroke-width="2"/></svg>`;
  const pages = []; // {section, toc:[title, desc]|null, html()}
  const add = (section, html, toc = null) => pages.push({ section, html, toc });
  const preparedBy = [b.preparedBy, company].filter(Boolean).join(", ");
  const photoCap = (f, n, path, extra = "") => `<div class="caption"><span class="lbl">Photo ${pn(n)}</span>${E(`${path}.title`, esc(f.title), "b")}
      <div class="meta">${esc(f.category)} | ${esc(f.timeLabel)} | <span class="${sevClass(f.severity)}">${esc(f.severity)}</span></div>${E(`${path}.description`, esc(f.description), "div")}${extra}</div>`;

  // ----- 2. Note + contents
  const note = m.note || {};
  add("Welcome", () => `
    <h2 class="title">A Note From Us</h2>
    ${E("note.salutation", esc(note.salutation || (j.client ? j.client.split(/[ —-]/)[0] + "," : "Hello,")), "p")}
    ${P("note.body", note.body)}
    <div class="note-sign">${E("note.signoff", esc(note.signoff || "With gratitude,"))}<br><b>${esc(b.preparedBy || company)}</b><br><span class="sub">${esc(company)}</span></div>
    <h3 style="margin-top:.3in">What's Inside</h3>
    <div class="toc">${tocHtml()}</div>`);

  // ----- 3. Our Work
  const work = m.workPhotos || [];
  if ((b.about || "").trim() || work.length) {
    for (let i = 0; i < Math.max(1, Math.ceil(work.length / 4)); i++) {
      const chunk = work.slice(i * 4, i * 4 + 4);
      add("Our Work", () => `${i === 0 ? `<h2 class="title">Our Work</h2>${E("brand.about", esc(b.about || ""), "p")}` : `<h3>Project Photos</h3>`}
        <div class="grid2">${chunk.map((w, k) => `<div><img class="ph" src="${w.img}" alt=""><div class="caption"><span class="lbl">Photo ${String.fromCharCode(65 + i * 4 + k)}</span>${E(`workPhotos.${i * 4 + k}.caption`, esc(w.caption || ""))}</div></div>`).join("")}</div>`,
        i === 0 ? ["Our Work", "How we work, with project photos"] : null);
    }
  }

  // ----- 4. Client references
  const refs = m.refs || parseRefs(m.references);
  if (refs.length) add("Client References", () => `
    <h2 class="title">Client References</h2><p class="sub">Connect with clients about their experience with ${esc(company)}.</p>
    <div class="refs">${refs.map((r, i) => `<div class="ref"><span class="n">${pn(i + 1)}</span><span><b>${esc(r.name)}</b><br><span class="sub">${esc(r.role)}</span></span><span class="ph2">${esc(r.phone)}</span></div>`).join("")}</div>`,
    ["Client References", "Past clients you can call about their experience with us"]);

  // ----- 5. DIY Roof Repair Plan
  const phases = (D.phases || []).filter((p) => (p.items || []).length);
  if (phases.length || G.intro) {
    add("DIY Roof Repair Plan", () => `
      <h2 class="title">DIY Roof Repair Plan</h2>
      <p class="sub">A free, step-by-step guide to repairing the roof yourself or with a helper you trust</p>
      <h3>How to Use This Plan</h3>${E("diy.guide.intro", esc(G.intro || ""), "p")}
      <table><tr><th>Phase</th><th>What it covers</th><th>When</th></tr>
      ${(m.phases || []).map((p, i) => `<tr><td><b>${esc(p.name)}</b></td><td>${E(`phases.${i}.covers`, esc(p.covers))}</td><td>${E(`phases.${i}.when`, esc(p.when))}</td></tr>`).join("")}</table>
      ${arr(G.safety).length ? `<div class="warn"><h5>Before You Start: Safety First</h5>${LI("diy.guide.safety", G.safety)}</div>` : ""}`,
      ["DIY Roof Repair Plan", "Free step-by-step guide to repairing the roof yourself or with a helper"]);
    if (G.material_rule || G.weather_window) add("DIY Roof Repair Plan", () => `
      ${G.material_rule ? `<h3>${esc(G.material_rule.title || "The Most Important Material Rule")}</h3>${P("diy.guide.material_rule.paragraphs", G.material_rule.paragraphs)}` : ""}
      ${G.weather_window ? `<h3>Weather Window</h3>${E("diy.guide.weather_window", esc(G.weather_window), "p")}` : ""}
      ${G.basic_method ? `<h3>${esc(G.basic_method.title || "The Basic Method")}</h3>${E("diy.guide.basic_method.intro", esc(G.basic_method.intro || ""), "p")}
        <h5>What you'll need</h5>${LI("diy.guide.basic_method.need", G.basic_method.need)}<h5>Steps</h5>${LI("diy.guide.basic_method.steps", G.basic_method.steps, "ol")}` : ""}`);
    if (arr(G.shopping_list).length) add("DIY Roof Repair Plan", () => `
      <h3>Shopping List</h3><p class="sub">Quantities are rough. Buy a little extra of anything you are not sure about.</p>
      <table><tr><th>Item</th><th>Used for</th><th>Approx. quantity</th></tr>
      ${G.shopping_list.map((s, i) => `<tr><td>${E(`diy.guide.shopping_list.${i}.item`, esc(s.item))}</td><td>${E(`diy.guide.shopping_list.${i}.used_for`, esc(s.used_for))}</td><td>${E(`diy.guide.shopping_list.${i}.qty`, esc(s.qty))}</td></tr>`).join("")}</table>`);
    phases.forEach((ph, pi) => {
      for (let i = 0; i < ph.items.length; i += 2) {
        add("DIY Roof Repair Plan", () => `${i === 0 ? `<h3>${esc(ph.name)}</h3>` : ""}
          ${ph.items.slice(i, i + 2).map((d, k) => { const n = i + k, path = `diy.phases.${D.phases.indexOf(ph)}.items.${n}`; const ref = arr(d.findings)[0]; const f = F[ref - 1];
            return `<div class="item">
              ${editable ? `<button class="rm" data-rm="${path}" type="button">Remove</button>` : ""}
              <div>${f ? `<img class="ph" src="${f.img}" alt=""><div class="mini">#${ref} Report photo</div>` : ""}</div>
              <div>${E(`${path}.title`, esc(d.title), "h4")}
                <div class="sub">Report findings ${arr(d.findings).map((x) => "#" + x).join(", ") || "—"} | Difficulty: <span class="${diffClass(d.difficulty)}">${esc(d.difficulty)}</span></div>
                ${E(`${path}.why`, esc(d.why || ""), "p")}
                <h5>What you'll need</h5>${LI(`${path}.need`, d.need)}
                <h5>Steps</h5>${LI(`${path}.steps`, d.steps, "ol")}
                <div><span class="callpro">Call a pro if:</span> ${E(`${path}.call_pro_if`, esc(d.call_pro_if))}</div></div></div>`; }).join("")}`);
      }
    });
    add("DIY Roof Repair Plan", () => `
      ${arr(G.maintenance).length ? `<h3>Keeping It Healthy</h3>${LI("diy.guide.maintenance", G.maintenance)}` : ""}
      ${arr(G.winter).length ? `<h3>If Winter Arrives Before You Finish</h3>${LI("diy.guide.winter", G.winter)}` : ""}
      ${G.call_pro ? `<h3>Know When to Call a Pro</h3>${E("diy.guide.call_pro", esc(G.call_pro), "p")}` : ""}
      <div class="box" style="margin-top:.18in"><h5>We are always just a phone call away.</h5>Whether you hire us, someone else, or do it yourself, if you have a question about a product, a step, or something you find up there, call or email. We are happy to help, and it will not cost you a thing.<br><b>${[company, b.phone, b.email].filter(Boolean).map(esc).join(" | ")}</b></div>
      ${G.disclaimer ? `<p class="sub" style="margin-top:.14in">${E("diy.guide.disclaimer", esc(G.disclaimer))}</p>` : ""}`);
  }

  // ----- 6. Interior Leak Inspection Report
  if (L.length) {
    add("Interior Leak Inspection Report", () => `
      <h2 class="title">Interior Leak Inspection Report</h2><p class="sub">Photo documentation of ceiling water damage</p>
      <table class="prop"><tr><td>Property</td><td>${esc(j.address)}</td></tr><tr><td>Source</td><td>${esc(m.source || "Walkthrough video")}</td></tr><tr><td>Prepared by</td><td>${esc(preparedBy)}</td></tr><tr><td>Locations identified</td><td>${L.length}</td></tr></table>
      <h3>Executive Summary</h3>${E("leak_summary", esc(m.leak_summary || ""), "p")}
      <h3>Leak Locations</h3><table><tr><th>#</th><th>Location</th><th>Video</th><th>Condition</th></tr>
      ${L.map((l, i) => `<tr><td>${i + 1}</td><td>${E(`leaks.${i}.location`, esc(l.location))}</td><td>${esc(l.timeLabel)}</td><td>${E(`leaks.${i}.condition`, esc(l.condition || ""))}</td></tr>`).join("")}</table>`,
      ["Interior Leak Inspection Report", `${L.length} water-stained ceiling location${L.length === 1 ? "" : "s"}`]);
    for (let i = 0; i < L.length; i += 2) {
      const last = i + 2 >= L.length;
      add("Interior Leak Inspection Report", () => `${i === 0 ? `<h3>Photo Documentation</h3>` : ""}<div class="grid2 tall">${L.slice(i, i + 2).map((l, k) => { const n = i + k; return `<div class="finding">
        <img class="ph" src="${l.img}" alt=""><div class="caption"><span class="lbl">Photo ${pn(n + 1)}</span><b>${esc(l.location)}</b> <span class="meta">(${esc(l.timeLabel)})</span>
        <div><b>Observed:</b> ${E(`leaks.${n}.observed`, esc(l.observed || ""))}</div><div><b>Significance:</b> ${E(`leaks.${n}.significance`, esc(l.significance || ""))}</div></div></div>`; }).join("")}</div>
        ${last && arr(m.leak_next_steps).length ? `<h3>Recommended Next Steps</h3>${LI("leak_next_steps", m.leak_next_steps)}` : ""}`);
    }
  }

  // ----- 7. Roof Inspection Report
  const cats = [...new Set(F.map((f) => f.category || "Other"))];
  const cnt = (c, s) => F.filter((f) => (f.category || "Other") === c && (!s || String(f.severity).toLowerCase() === s.toLowerCase())).length;
  add("Roof Inspection Report", () => `
    <h2 class="title">Roof Inspection Report</h2><p class="sub">Photo documentation of all potential leak points on the roof</p>
    <table class="prop"><tr><td>Property</td><td>${esc(j.address)}</td></tr><tr><td>Roof system</td><td>${E("roof_system", esc(m.roof_system || ""))}</td></tr>
      <tr><td>Source</td><td>${esc(m.source || "Walkthrough video")}${j.date ? ", reviewed " + esc(j.date) : ""}</td></tr>
      ${L.length ? `<tr><td>Related report</td><td>Interior Leak Inspection Report (${L.length} ceiling leak location${L.length === 1 ? "" : "s"})</td></tr>` : ""}
      <tr><td>Prepared by</td><td>${esc(preparedBy)}</td></tr></table>
    <h3>Executive Summary</h3>${P("summary", m.summary)}
    <h3>Findings at a Glance</h3>
    <table><tr><th>Category</th>${SEV.map((s) => `<th class="num">${s}</th>`).join("")}<th class="num">Total</th></tr>
      ${cats.map((c) => `<tr><td>${esc(c)}</td>${SEV.map((s) => `<td class="num">${cnt(c, s) || ""}</td>`).join("")}<td class="num"><b>${cnt(c)}</b></td></tr>`).join("")}
      <tr class="subt"><td>Total</td>${SEV.map((s) => `<td class="num">${F.filter((f) => String(f.severity).toLowerCase() === s.toLowerCase()).length || ""}</td>`).join("")}<td class="num">${F.length}</td></tr></table>
    <p class="sub"><span class="critical">Critical</span>: open to water now, likely active leak. <span class="high">High</span>: likely leak source, fix soon. <span class="medium">Medium</span>: wear to fix in the normal course. <span class="low">Low</span>: minor, monitor.</p>`,
    ["Roof Inspection Report", `${F.length} potential leak point${F.length === 1 ? "" : "s"} on the roof, circled and rated by priority`]);
  for (let i = 0; i < F.length; i += 30) add("Roof Inspection Report", () => `<h3>Findings Index</h3>
    <table><tr><th>#</th><th>Finding</th><th>Category</th><th>Priority</th><th>Video</th></tr>
    ${F.slice(i, i + 30).map((f, k) => `<tr><td>${i + k + 1}</td><td>${esc(f.title)}</td><td>${esc(f.category)}</td><td class="${sevClass(f.severity)}">${esc(f.severity)}</td><td>${esc(f.timeLabel)}</td></tr>`).join("")}</table>`);
  for (let i = 0; i < F.length; i += 3) add("Roof Inspection Report", () => `${i === 0 ? `<h3>Photo Documentation</h3>` : ""}
    <div class="grid3">${F.slice(i, i + 3).map((f, k) => { const n = i + k; return `<div class="finding">${editable ? `<button class="rm" data-rm="findings.${n}" type="button">Remove</button>` : ""}<img class="ph" src="${f.img}" alt="">${photoCap(f, n + 1, `findings.${n}`)}</div>`; }).join("")}</div>`);
  if (arr(m.limitations).length) add("Roof Inspection Report", () => `<h3>Limitations and Further Verification</h3>
    <p>This report is based on a walkthrough video. It documents conditions visible on camera and does not include moisture testing, core samples, measurements or a hands-on inspection. Before final pricing or repair work, we recommend:</p>${LI("limitations", m.limitations)}`);

  if (arr(m.other).length) add("Roof Inspection Report", () => `<h3>Other Things We Noticed</h3><p class="sub">Not roof work and not included in our pricing. Just a heads-up so nothing surprises you.</p>${LI("other", m.other)}`);

  // ----- 7b. Roof Measurements (aerial, same as useroofly.com/measure)
  const MS = m.measure;
  if (MS && MS.areaFt2) {
    const LEN = MS.lengths || {}, lines = MS.lines || [];
    const xs = lines.flatMap((l) => [l.x1, l.x2]), ys = lines.flatMap((l) => [l.y1, l.y2]);
    const pad = 70;
    let x0 = Math.max(0, (xs.length ? Math.min(...xs) : 200) - pad), y0 = Math.max(0, (ys.length ? Math.min(...ys) : 200) - pad);
    let x1 = Math.min(1280, (xs.length ? Math.max(...xs) : 1080) + pad), y1 = Math.min(1280, (ys.length ? Math.max(...ys) : 1080) + pad);
    // keep the crop no taller than 4:3 wide so it fits the page
    if ((y1 - y0) > (x1 - x0) * 1.05) { const cx = (x0 + x1) / 2, w = Math.min(1280, (y1 - y0) / 1.05); x0 = Math.max(0, cx - w / 2); x1 = Math.min(1280, x0 + w); }
    const W = x1 - x0, k = W / 1000; // label size relative to the crop
    const svg = `<svg class="aerial" viewBox="${x0} ${y0} ${W} ${y1 - y0}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Aerial photo with the roof edges traced">
      <image href="${MS.img}" x="0" y="0" width="1280" height="1280"/>
      ${[0, 1].map((pass) => lines.map((l) => `<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="${pass ? COL[l.type] || "#fff" : "#000"}" stroke-width="${(pass ? 7 : 12) * k}" stroke-linecap="round"/>`).join("")).join("")}
      ${lines.filter((l) => l.len >= 6).map((l) => { const cx = (l.x1 + l.x2) / 2, cy = (l.y1 + l.y2) / 2, t = l.len + "'", w = (t.length * 17 + 14) * k;
        return `<rect x="${cx - w / 2}" y="${cy - 19 * k}" width="${w}" height="${38 * k}" rx="${7 * k}" fill="#fff"/><text x="${cx}" y="${cy + 10 * k}" font-size="${29 * k}" font-weight="bold" text-anchor="middle" fill="#0B2545" font-family="Arial,sans-serif">${t}</text>`; }).join("")}
    </svg>`;
    const legend = Object.keys(NAMES).filter((t) => LEN[t]).map((t) => `<span><i style="background:${COL[t]}"></i>${NAMES[t]}</span>`).join("");
    const ck = MS.check ? (MS.check.ok ? `Outline check passed: the traced roof matches Google's footprint (${fmt(MS.check.tracedFt2)} vs ${fmt(MS.check.googleFt2)} sq ft from above).` : `Outline check: the traced roof covers ${fmt(MS.check.tracedFt2)} sq ft from above vs Google's ${fmt(MS.check.googleFt2)} sq ft, so part of the roof may be missing from the drawing. Verify edge lengths on site.`) : "";
    const m0 = (MS.materials || [])[0] || {};
    const kp = [["Roof area", fmt(MS.areaFt2) + " sq ft"], ["Squares", fmt(MS.squares, 1)], [`With ${m0.waste || 10}% waste`, fmt(m0.squaresWaste, 1)], ["Main pitch", MS.pitch], ["Roof faces", MS.faces],
      ...(MS.pitch === "Low-slope"
        ? [["Roof outline (edges + walls)", fmt((LEN.edge || 0) + (LEN.parapet || 0) + (LEN.flashing || 0) + (LEN.eave || 0) + (LEN.rake || 0)) + " ft"], ["Wall flashing", fmt(LEN.flashing || 0) + " ft"], ["Parapet walls", fmt(LEN.parapet || 0) + " ft"]]
        : [["Drip edge (eaves + rakes)", fmt((LEN.eave || 0) + (LEN.rake || 0)) + " ft"], ["Ridges + hips", fmt((LEN.ridge || 0) + (LEN.hip || 0)) + " ft"], ["Valleys", fmt(LEN.valley || 0) + " ft"]])];
    add("Roof Measurements", () => `
      <h2 class="title">Roof Measurements</h2><p class="sub">${esc(MS.address)} · measured from aerial imagery (${esc(MS.imagery)}${MS.quality ? ", " + esc(MS.quality) + " quality" : ""})${MS.style ? " · " + esc(MS.style) + " roof" : ""}</p>
      <div class="aerialwrap">${svg}</div>
      <div class="mlegend">${legend}</div>
      <div class="kpis">${kp.map(([a, v]) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(a)}</span></div>`).join("")}</div>`,
      ["Roof Measurements", "Aerial photo with every edge traced, squares, pitch and a materials list"]);
    add("Roof Measurements", () => `
      <div class="cols"><div><h3>Edge Lengths</h3><table><tr><th>Edge</th><th class="num">Feet</th></tr>
        ${Object.keys(NAMES).filter((t) => LEN[t]).map((t) => `<tr><td><span class="msw" style="background:${COL[t]}"></span>${NAMES[t]}</td><td class="num">${fmt(LEN[t])}</td></tr>`).join("")}</table></div>
      <div><h3>Roof Faces</h3><table><tr><th>#</th><th>Pitch</th><th>Facing</th><th class="num">Sq ft</th></tr>
        ${(MS.facets || []).slice(0, 16).map((f) => `<tr><td>${f.n}</td><td>${esc(f.pitch)}</td><td>${esc(f.facing)}</td><td class="num">${fmt(f.areaFt2)}</td></tr>`).join("")}
        ${(MS.facets || []).length > 16 ? `<tr><td colspan="4" class="sub">+ ${(MS.facets || []).length - 16} smaller faces</td></tr>` : ""}</table></div></div>
      ${(MS.materials || []).map((mt, mi) => `<h3>Materials${(MS.materials || []).length > 1 ? " — " + esc(mt.roofType) : ""}</h3><p class="sub">${esc(SYS_NAMES[mt.sys] || mt.roofType)}, full replacement, ${fmt(mt.squaresWaste, 1)} squares incl. ${mt.waste}% waste.</p>
        <table><tr><th>Item</th><th class="num">Qty</th><th>Unit</th><th>Based on</th></tr>
        ${(mt.rows || []).map((r, ri) => `<tr><td>${esc(r.item)}</td><td class="num">${E(`measure.materials.${mi}.rows.${ri}.qty`, esc(r.qty))}</td><td>${esc(r.unit)}</td><td class="sub">${esc(r.note)}</td></tr>`).join("")}</table>`).join("")}
      <p class="sub">${esc(ck)} ${(MS.learned || []).length ? "Edge lengths adjusted using lessons from past corrected roofs: " + MS.learned.map((x) => `${(NAMES[x.type] || x.type).toLowerCase()} ${x.factor > 1 ? "+" : ""}${Math.round((x.factor - 1) * 100)}% (${x.roofs} roofs)`).join(", ") + ". " : ""}${MS.notes ? "Note: " + esc(MS.notes) : ""} Measurements are from aerial imagery and are field-verified before materials are ordered.</p>`);
  } else if (MS && MS.error) {
    add("Roof Measurements", () => `<h2 class="title">Roof Measurements</h2>
      <div class="box">${esc(MS.error)} The quantities in the proposals below are estimated from the walkthrough video and are marked "(confirm)" until the roof is measured on site.</div>`);
  }

  // ----- 8. Recommendation & Proposals (one block per roof type)
  const ests = m.estimates || [];
  const allOpts = [];
  ests.forEach((est, ei) => {
    const opts = est.options || [];
    opts.forEach((opt, oi) => allOpts.push({ est, ei, opt, oi }));
    const label = ests.length > 1 ? ` — ${esc(est.roofType)}` : "";
    add("Recommendation & Proposals", () => `
      <h2 class="title">Our Recommendation${label}</h2>
      ${P(`estimates.${ei}.recommendation`, est.recommendation)}
      <table><tr><th></th>${opts.map((o) => `<th>${esc(o.name.split(":")[0])}${est.recommended === o.key ? " (Recommended)" : ""}</th>`).join("")}</tr>
      ${(est.compare_rows || []).map((r, ri) => `<tr><td><b>${esc(r.label)}</b></td><td>${E(`estimates.${ei}.compare_rows.${ri}.a`, esc(r.a))}</td><td>${E(`estimates.${ei}.compare_rows.${ri}.b`, esc(r.b))}</td></tr>`).join("")}
      <tr class="subt"><td>${m.margin.include ? "Investment" : "Cost (materials + labor)"}</td>${opts.map((o) => `<td>${money(optionTotals(o, m.margin).total)}</td>`).join("")}</tr></table>
      ${est.quantities_note ? `<div class="box"><b>About the quantities.</b> ${E(`estimates.${ei}.quantities_note`, esc(est.quantities_note))}</div>` : ""}`,
      ei === 0 ? ["Recommendation & Proposals", opts.map((o) => o.name).join(", ") + ", and acceptance"] : null);
    opts.forEach((opt, oi) => {
      const lines = opt.lines || [], per = 16, t = optionTotals(opt, m.margin);
      for (let s = 0; s < Math.max(1, lines.length); s += per) {
        const last = s + per >= lines.length;
        add("Recommendation & Proposals", () => `${s === 0 ? `${E(`estimates.${ei}.options.${oi}.name`, esc(opt.name) + label, "h2", "title")}
          ${est.recommended === opt.key ? `<p class="easy">Recommended.</p>` : ""}${E(`estimates.${ei}.options.${oi}.subtitle`, esc(opt.subtitle || ""), "p", "sub")}
          ${E(`estimates.${ei}.options.${oi}.scope`, esc(opt.scope || ""), "p")}<h3>Scope of Work &amp; Pricing</h3>` : `<h3>Scope of Work &amp; Pricing (continued)</h3>`}
          <table><tr><th>#</th><th>Description</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr>
          ${lines.slice(s, s + per).map((l, k) => { const li = s + k, p = `estimates.${ei}.options.${oi}.lines.${li}`; return `<tr><td>${li + 1}</td>
            <td><span class="tag">${l.kind === "Labor" ? "LABOR" : "MAT"}</span> ${E(`${p}.desc`, esc(l.desc))}</td>
            <td class="num">${E(`${p}.qty`, esc(l.qty), "span", "numfield")} ${esc(l.unit)}</td>
            <td class="num">${E(`${p}.price`, money2(l.price), "span", "numfield")}</td>
            <td class="num">${money((Number(l.qty) || 0) * (Number(l.price) || 0))}</td></tr>`; }).join("")}
          ${last ? `<tr class="subt"><td></td><td colspan="3">Materials</td><td class="num">${money(t.mat)}</td></tr>
            <tr class="subt"><td></td><td colspan="3">Labor</td><td class="num">${money(t.lab)}</td></tr>
            ${m.margin.include ? `<tr class="subt"><td></td><td colspan="3">Overhead &amp; profit (${Number(m.margin.pct) || 0}%)</td><td class="num">${money(t.op)}</td></tr>` : ""}
            <tr class="total"><td></td><td colspan="3">${m.margin.include ? "TOTAL INVESTMENT" : "TOTAL COST (MATERIALS + LABOR)"}</td><td class="num">${money(t.total)}</td></tr>` : ""}</table>
          ${last ? `<div class="cols"><div class="box"><h5>Warranty, Payment &amp; Schedule</h5>
              ${opt.warranty ? `<p><b>Warranty:</b> ${E(`estimates.${ei}.options.${oi}.warranty`, esc(opt.warranty))}</p>` : ""}
              <p><b>Payment:</b> ${E(`estimates.${ei}.payment`, esc(est.payment || m.terms || ""))}</p>
              ${opt.timeline ? `<p><b>Schedule:</b> ${E(`estimates.${ei}.options.${oi}.timeline`, esc(opt.timeline))}</p>` : ""}</div>
            <div class="box"><h5>Notes &amp; Exclusions</h5>${LI(`estimates.${ei}.exclusions`, [...arr(est.assumptions), ...arr(est.exclusions)])}</div></div>` : ""}`);
      }
    });
  });

  // ----- 9. Acceptance
  if (allOpts.length) add("Acceptance", () => `
    <h2 class="title">Acceptance</h2><p>Select the option you would like and sign below. ${esc(company)} will reach out to schedule.</p>
    <table><tr><th>Option</th><th>Description</th><th class="num">${m.margin.include ? "Investment" : "Cost"}</th><th>Select</th></tr>
    ${allOpts.map(({ est, opt }) => `<tr><td><b>${esc(opt.key || "")}</b></td><td>${esc(opt.name.replace(/^Option [A-Z]:\s*/, ""))}${ests.length > 1 ? " — " + esc(est.roofType) : ""}${est.recommended === opt.key ? " (Recommended)" : ""}</td><td class="num">${money(optionTotals(opt, m.margin).total)}</td><td><span class="selbox"></span></td></tr>`).join("")}</table>
    <p><b>Payment terms:</b> ${esc((ests[0] && ests[0].payment) || m.terms || "")}</p>
    <p>By signing below, the owner or authorized representative accepts the selected option, scope and terms above and authorizes ${esc(company)} to proceed. Final quantities are confirmed by field measurement before work begins.</p>
    ${j.client || j.clientPhone || j.clientEmail ? `<p class="sub">Owner: ${[j.client, j.clientPhone, j.clientEmail].filter(Boolean).map(esc).join(" · ")}</p>` : ""}
    <div class="sig"><div>Owner / Authorized Representative</div><div>Date</div></div>
    <div class="sig"><div>Printed Name &amp; Title</div><div></div></div>
    <div class="sig"><div>${esc(company)}</div><div>Date</div></div>
    <div class="box" style="margin-top:.35in"><b>${esc(company)}</b><br>${[b.preparedBy, b.phone, b.email, b.website].filter(Boolean).map(esc).join(" · ")}</div>`);

  function tocHtml() {
    let n = 0;
    return pages.map((p, i) => p.toc ? `<div class="row"><div class="n">${pn(++n)}</div><div class="t"><b>${esc(p.toc[0])}</b><span>${esc(p.toc[1])}</span></div><div class="p">Page ${i + 2}</div></div>` : "").join("");
  }

  const cover = `<section class="page cover"><div class="fit">
    <div class="side"></div>
    <div class="logo-card">${b.logo ? `<img src="${b.logo}" alt="">` : `<div class="noLogo">${esc(company)}</div>`}</div>
    <div class="hero">${m.cover ? `<img src="${m.cover}" alt="">` : ""}</div>
    <div class="title-card">
      ${E("coverTitle", esc(m.coverTitle || "Roof Report, Repair Plan & Proposals"), "h1")}
      <div class="subtitle">${esc(j.address)}</div>
      <div class="meta">${j.client || j.clientPhone || j.clientEmail ? "Prepared for: " + [j.client, j.clientPhone, j.clientEmail].filter(Boolean).map(esc).join(" · ") + "<br>" : ""}Prepared by: ${esc(preparedBy)}<br>Report date: ${esc(j.date)}</div>
      ${b.tagline ? `<div class="tagline">${esc(b.tagline)}</div>` : ""}
    </div>
    <div class="side-contact">${[b.website, b.phone, b.email].filter(Boolean).map(esc).join("<br>")}</div>
  </div></section>`;

  return cover + pages.map((p, i) => `<section class="page inner"><div class="fit">
    <div class="hdr"><div class="brandname">${roofIcon}${esc(company)}</div><div class="section">${esc(p.section)}</div></div>
    <div class="body">${p.html()}</div>
    </div><div class="ftr"><span>${footLeft}</span><span>Page ${i + 2}</span></div></section>`).join("");
}

// Shrink any page whose content runs past the footer (scales the whole page body).
export function fitPages(root) {
  root.querySelectorAll(".page.inner .fit").forEach((fit) => {
    const body = fit.querySelector(".body"); if (!body) return;
    body.style.zoom = ""; body.style.width = "";
    const cs = getComputedStyle(fit);
    const hdr = fit.querySelector(".hdr");
    const avail = fit.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) - (hdr ? hdr.offsetHeight + 21 : 0);
    const h = body.scrollHeight;
    if (h > avail) { const z = Math.max(0.55, avail / h); body.style.zoom = z; body.style.width = (100 / z) + "%"; }
  });
}
