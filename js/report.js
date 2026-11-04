// Builds the report pages (Lucky Line package layout) from the report model.
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const money = (n) => "$" + (Math.round(Number(n) || 0)).toLocaleString("en-US");
const money2 = (n) => "$" + (Number(n) || 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const sevClass = (s) => ({ critical: "critical", high: "high", medium: "medium", low: "low" }[String(s).toLowerCase()] || "medium");
const diffClass = (d) => ({ easy: "easy", moderate: "medium", advanced: "high", "pro only": "critical" }[String(d).toLowerCase()] || "medium");

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

export function render(m, { editable = true } = {}) {
  const E = (path, html, tag = "span", cls = "") =>
    `<${tag}${cls ? ` class="${cls}"` : ""}${editable ? ` contenteditable="true" data-k="${path}"` : ""}>${html}</${tag}>`;
  const b = m.brand, j = m.job;
  const company = b.company || "Your Company";
  const footLeft = [b.tagline, b.phone, b.website].filter(Boolean).map(esc).join(" &nbsp;|&nbsp; ");
  const pages = []; // {section, html, toc?}
  const roofIcon = `<svg width="30" height="16" viewBox="0 0 30 16" aria-hidden="true"><path d="M1 9 L15 2 L29 9" fill="none" stroke="currentColor" stroke-width="2"/><line x1="7" y1="14" x2="23" y2="14" stroke="currentColor" stroke-width="2"/></svg>`;
  const findings = m.findings || [];

  // ----- Note from us + contents (contents filled after pagination)
  pages.push({ section: "A Note From Us", toc: null, html: () => `
    <h2 class="title">A Note From Us</h2>
    ${E("note", esc(m.note).replace(/\n/g, "<br>"), "div")}
    <div class="note-sign">With gratitude,<br><b>${esc(b.preparedBy || company)}</b><br><span class="sub">${esc(company)}</span></div>
    <h3 style="margin-top:.32in">What's Inside</h3>
    <div class="toc">${tocHtml()}</div>` });

  // ----- Inspection report summary
  const atGlance = findings.map((f, i) => `<tr><td>${i + 1}</td><td>${esc(f.title)}</td><td>${esc(f.category)}</td><td class="${sevClass(f.severity)}">${esc(f.severity)}</td><td>${esc(f.timeLabel)}</td></tr>`).join("");
  pages.push({ section: "Roof Inspection Report", toc: ["Roof Inspection Report", "Summary, roof facts and findings at a glance"], html: () => `
    <h2 class="title">Roof Inspection Report</h2>
    <div class="sub">${esc(j.address)}${j.date ? " · Inspected " + esc(j.date) : ""}</div>
    <h3>Executive Summary</h3>
    ${E("summary", esc(m.summary), "p")}
    <div class="facts">${(m.facts || []).slice(0, 6).map((f, i) => `<div><b>${esc(f.label)}</b>${E(`facts.${i}.value`, esc(f.value))}</div>`).join("")}</div>
    <h3>Findings at a Glance</h3>
    ${findings.length ? `<table><tr><th>#</th><th>Finding</th><th>Area</th><th>Priority</th><th>Source</th></tr>${atGlance}</table>` : `<p>No significant problems were visible in the footage provided.</p>`}` });

  // ----- Photo documentation: 2 per page
  for (let i = 0; i < findings.length; i += 2) {
    const chunk = findings.slice(i, i + 2);
    pages.push({ section: "Photo Documentation", toc: i === 0 ? ["Photo Documentation", "Each problem, circled and captioned"] : null, html: () => `
      ${i === 0 ? `<h2 class="title">Photo Documentation</h2>` : ""}
      ${chunk.map((f, k) => { const n = i + k; return `
        <div class="finding">
          ${editable ? `<button class="rm" data-rm="findings.${n}" type="button">Remove</button>` : ""}
          <img class="ph" src="${f.img}" alt="">
          <div class="caption"><span class="lbl">Photo ${String(n + 1).padStart(2, "0")}</span>${E(`findings.${n}.title`, esc(f.title), "b")}
            <div class="meta">${esc(f.category)} | ${esc(f.timeLabel)} | <span class="${sevClass(f.severity)}">${esc(f.severity)}</span></div>
            ${E(`findings.${n}.description`, esc(f.description), "div")}</div>
        </div>`; }).join("")}` });
  }

  // ----- Interior leak report
  const leaks = m.leaks || [];
  if (leaks.length) {
    pages.push({ section: "Interior Leak Report", toc: ["Interior Leak Report", "Water evidence inside the building"], html: () => `
      <h2 class="title">Interior Leak Report</h2>
      <table><tr><th>#</th><th>Location</th><th>Source</th><th>Condition</th></tr>
      ${leaks.map((l, i) => `<tr><td>${i + 1}</td><td>${E(`leaks.${i}.location`, esc(l.location))}</td><td>${esc(l.timeLabel)}</td><td>${E(`leaks.${i}.condition`, esc(l.condition))}</td></tr>`).join("")}</table>
      <div class="grid2">${leaks.slice(0, 4).filter((l) => l.img).map((l, i) => `<div><img class="ph" src="${l.img}" alt=""><div class="caption"><span class="lbl">Leak ${i + 1}</span>${esc(l.location)}</div></div>`).join("")}</div>` });
  }

  // ----- DIY repair plan: 2 per page
  const diy = m.diy || [];
  for (let i = 0; i < diy.length; i += 2) {
    pages.push({ section: "DIY Repair Plan", toc: i === 0 ? ["DIY Repair Plan", "Step-by-step fixes you can use with anyone"] : null, html: () => `
      ${i === 0 ? `<h2 class="title">DIY Repair Plan</h2><p class="sub">You're welcome to use this plan with any contractor, or do the work yourself if it's safe to.</p>` : ""}
      ${diy.slice(i, i + 2).map((d, k) => { const n = i + k; const ref = (d.findings || [])[0]; const f = findings[ref - 1];
        return `<div class="item">
          ${editable ? `<button class="rm" data-rm="diy.${n}" type="button">Remove</button>` : ""}
          <div>${f ? `<img class="ph" src="${f.img}" alt=""><div class="mini">#${ref} Report photo</div>` : ""}</div>
          <div>
            ${E(`diy.${n}.title`, esc(d.title), "h4")}
            <div class="sub">Report findings ${(d.findings || []).map((x) => "#" + x).join(", ") || "—"} | Difficulty: <span class="${diffClass(d.difficulty)}">${esc(d.difficulty)}</span></div>
            <h5>What you'll need</h5><ul>${(d.need || []).map((x, q) => `<li>${E(`diy.${n}.need.${q}`, esc(x))}</li>`).join("")}</ul>
            <h5>Steps</h5><ol>${(d.steps || []).map((x, q) => `<li>${E(`diy.${n}.steps.${q}`, esc(x))}</li>`).join("")}</ol>
            <div><span class="callpro">Call a pro if:</span> ${E(`diy.${n}.call_pro_if`, esc(d.call_pro_if))}</div>
          </div></div>`; }).join("")}` });
  }

  // ----- Estimates: one page per option
  const ests = m.estimates || [];
  const allOpts = [];
  ests.forEach((est, ei) => (est.options || []).forEach((opt, oi) => allOpts.push({ est, ei, opt, oi })));
  allOpts.forEach(({ est, ei, opt, oi }, idx) => {
    const t = optionTotals(opt, m.margin);
    const rows = (opt.lines || []).map((l, li) => `<tr>
      <td><span class="tag">${l.kind === "Labor" ? "LABOR" : "MAT"}</span> ${E(`estimates.${ei}.options.${oi}.lines.${li}.desc`, esc(l.desc))}</td>
      <td class="num">${E(`estimates.${ei}.options.${oi}.lines.${li}.qty`, esc(l.qty), "span", "numfield")} ${esc(l.unit)}</td>
      <td class="num">${E(`estimates.${ei}.options.${oi}.lines.${li}.price`, money2(l.price), "span", "numfield")}</td>
      <td class="num">${money((Number(l.qty) || 0) * (Number(l.price) || 0))}</td></tr>`).join("");
    pages.push({ section: m.margin.include ? "Estimate" : "Cost Breakdown", toc: idx === 0 ? [m.margin.include ? "Estimate & Options" : "Cost Breakdown", m.margin.include ? "Repair and replacement pricing" : "Materials and labor, before overhead and profit"] : null, html: () => `
      ${idx === 0 ? `<h2 class="title">${m.margin.include ? "Estimate & Options" : "Cost Breakdown"}</h2>
        ${m.margin.include ? "" : `<p class="sub">Technical breakdown of materials and labor at typical cost, before any contractor overhead or profit.</p>`}` : ""}
      <h3>${E(`estimates.${ei}.options.${oi}.name`, esc(opt.name))}${ests.length > 1 ? ` <span class="sub">(${esc(est.roofType)})</span>` : ""}</h3>
      ${E(`estimates.${ei}.options.${oi}.scope`, esc(opt.scope), "p")}
      <table><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit price</th><th class="num">Amount</th></tr>${rows}
        <tr class="subt"><td colspan="3">Materials</td><td class="num">${money(t.mat)}</td></tr>
        <tr class="subt"><td colspan="3">Labor</td><td class="num">${money(t.lab)}</td></tr>
        ${m.margin.include ? `<tr class="subt"><td colspan="3">Overhead &amp; profit (${Number(m.margin.pct) || 0}%)</td><td class="num">${money(t.op)}</td></tr>` : ""}
        <tr class="total"><td colspan="3">${m.margin.include ? "TOTAL INVESTMENT" : "TOTAL COST (MATERIALS + LABOR)"}</td><td class="num">${money(t.total)}</td></tr></table>
      ${oi === 0 && (est.assumptions || []).length ? `<div class="box"><h5>Assumptions</h5><ul>${est.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul></div>` : ""}` });
  });

  // ----- Recommendation + terms
  if (allOpts.length) {
    pages.push({ section: "Recommendation", toc: ["Recommendation & Options", "Side-by-side comparison and terms"], html: () => `
      <h2 class="title">Recommendation &amp; Options</h2>
      <table><tr><th>Option</th><th>Scope</th><th class="num">${m.margin.include ? "Total" : "Cost"}</th></tr>
      ${allOpts.map(({ est, opt }) => `<tr><td><b>${esc(opt.name)}</b>${ests.length > 1 ? `<br><span class="sub">${esc(est.roofType)}</span>` : ""}</td><td>${esc(opt.scope)}</td><td class="num">${money(optionTotals(opt, m.margin).total)}</td></tr>`).join("")}</table>
      ${E("recommendation", esc(m.recommendation), "p")}
      <div class="cols" style="margin-top:.2in">
        <div class="box"><h5>Warranty, Payment &amp; Schedule</h5>${E("terms", esc(m.terms).replace(/\n/g, "<br>"), "div")}</div>
        <div class="box"><h5>Notes &amp; Exclusions</h5>${E("exclusions", esc(m.exclusions).replace(/\n/g, "<br>"), "div")}</div>
      </div>` });
    // ----- Acceptance
    pages.push({ section: "Acceptance", toc: ["Acceptance", "Choose an option and sign"], html: () => `
      <h2 class="title">Acceptance</h2>
      <p>Select the option you'd like and sign below. ${esc(company)} will reach out to schedule.</p>
      <table><tr><th>Select</th><th>Option</th><th class="num">${m.margin.include ? "Total" : "Cost"}</th></tr>
      ${allOpts.map(({ est, opt }) => `<tr><td><span class="selbox"></span></td><td>${esc(opt.name)}${ests.length > 1 ? " — " + esc(est.roofType) : ""}</td><td class="num">${money(optionTotals(opt, m.margin).total)}</td></tr>`).join("")}</table>
      <div class="box"><h5>Payment terms</h5>${esc(m.terms).split("\n")[0] || ""}</div>
      <div class="sig"><div>Owner signature</div><div>Date</div></div>
      <div class="sig"><div>${esc(company)}</div><div>Date</div></div>
      <div style="margin-top:.5in;text-align:center;color:var(--brand)"><b>${esc(company)}</b><br>${[b.preparedBy, b.phone, b.email, b.website].filter(Boolean).map(esc).join(" · ")}</div>` });
  }

  // ----- References
  if ((m.references || "").trim()) {
    pages.push({ section: "Client References", toc: ["Client References", "People we've worked for"], html: () => `
      <h2 class="title">Client References</h2>${E("references", esc(m.references).replace(/\n/g, "<br>"), "div")}` });
  }

  // contents: page numbers (cover = 1)
  function tocHtml() {
    let n = 0;
    return pages.map((p, i) => p.toc ? `<div class="row"><div class="n">${String(++n).padStart(2, "0")}</div><div class="t"><b>${esc(p.toc[0])}</b><span>${esc(p.toc[1])}</span></div><div class="p">${i + 2}</div></div>` : "").join("");
  }

  const cover = `<section class="page cover"><div class="fit">
    <div class="side"></div>
    <div class="logo-card">${b.logo ? `<img src="${b.logo}" alt="">` : `<div class="noLogo">${esc(company)}</div>`}</div>
    <div class="hero">${m.cover ? `<img src="${m.cover}" alt="">` : ""}</div>
    <div class="title-card">
      ${E("coverTitle", esc(m.coverTitle || "Roof Inspection Report"), "h1")}
      <div class="subtitle">${esc(j.address)}</div>
      <div class="meta">${j.client ? "Prepared for: " + esc(j.client) + "<br>" : ""}Prepared by: ${esc([b.preparedBy, company].filter(Boolean).join(", "))}<br>Report date: ${esc(j.date)}</div>
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
    if (h > avail) { const z = Math.max(0.6, avail / h); body.style.zoom = z; body.style.width = (100 / z) + "%"; }
  });
}
