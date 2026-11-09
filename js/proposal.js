// Roofly on-screen proposal + inspection page (same design as the CLVR / Lucky Line CRM customer proposal).
// One page the client reads on any screen, signs with a finger, or saves as a PDF.
// Uses each roofer's own logo, brand color and font.
import { COL, NAMES, fmt, SYS_NAMES } from "./measure-core.js";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const money = (n) => "$" + Math.round(Number(n) || 0).toLocaleString("en-US");
const arr = (x) => (Array.isArray(x) ? x : x ? [x] : []);
const sev = (s) => ({ critical: "critical", high: "high", medium: "medium", low: "low" }[String(s || "").toLowerCase()] || "medium");
// strip test junk like "Client Billy Joe · 1 2 3 4 5 6 7 8 9 10" pieces that are only digits and spaces
const clean = (s) => String(s || "").split(/\s*·\s*/).filter((x) => x && !/^[\d\s]+$/.test(x)).join(" · ");

// ---- brand color: the roofer's own color. Neon colors (very bright and fully saturated, like pure #0000FF)
// are deepened a little so white text stays readable and the page looks professional; normal colors are untouched.
function hexToHsl(h) {
  h = String(h || "").replace("#", ""); if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  if (!/^[0-9a-f]{6}$/i.test(h)) return null;
  const n = parseInt(h, 16), r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, d = mx - mn;
  let H = 0, S = 0;
  if (d) { S = d / (1 - Math.abs(2 * l - 1)); H = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4; H *= 60; if (H < 0) H += 360; }
  return [H, S, l];
}
function hslToHex(H, S, L) {
  const c = (1 - Math.abs(2 * L - 1)) * S, x = c * (1 - Math.abs(((H / 60) % 2) - 1)), m = L - c / 2;
  const [r, g, b] = H < 60 ? [c, x, 0] : H < 120 ? [x, c, 0] : H < 180 ? [0, c, x] : H < 240 ? [0, x, c] : H < 300 ? [x, 0, c] : [c, 0, x];
  return "#" + [r, g, b].map((v) => Math.round((v + m) * 255).toString(16).padStart(2, "0")).join("");
}
// Terms text -> readable paragraphs: ALL-CAPS lines become headings, every other line its own paragraph.
function termsHtml(t) {
  return String(t || "").split(/\n+/).map((l) => l.trim()).filter(Boolean).map((l) => {
    if (/^[A-Z0-9 &|.,'()\/-]{4,}$/.test(l)) return `<h4 style="margin:20px 0 6px;font-size:13px;letter-spacing:.04em">${esc(l)}</h4>`;
    const i = l.indexOf(":"), lead = i > 0 && i <= 42 ? l.slice(0, i + 1) : "";
    return `<p style="margin:0 0 10px">${lead ? "<b>" + esc(lead) + "</b>" + esc(l.slice(i + 1)) : esc(l)}</p>`;
  }).join("");
}

export function brandColor(hex) {
  const hsl = hexToHsl(hex); if (!hsl) return "#16603A";
  let [H, S, L] = hsl;
  if (S > 0.75 && L > 0.38) { S = 0.72; L = Math.min(L, 0.36); }   // neon: deepen
  if (L > 0.45) L = 0.42;                                          // too light for white text
  return hslToHex(H, S, L);
}
export function brandStyle(b, fonts) {
  const c = brandColor(b.color);
  const f = (fonts || [])[b.fontIndex] || null;
  return { vars: `--brand:${c};--tint:color-mix(in srgb,${c} 10%,#fff);--cover:color-mix(in srgb,${c} 4%,#F4F5F4);--rfont:${b.fontStack || (f && f.stack) || '"Liberation Sans",Arial,sans-serif'}`, google: f && f.google };
}

export function optionTotals(opt, margin) {
  const lines = opt.lines || [];
  const mat = lines.filter((l) => l.kind !== "Labor").reduce((a, l) => a + (+l.qty || 0) * (+l.price || 0), 0);
  const lab = lines.filter((l) => l.kind === "Labor").reduce((a, l) => a + (+l.qty || 0) * (+l.price || 0), 0);
  const op = margin && margin.include ? (mat + lab) * (+margin.pct || 0) / 100 : 0;
  return { mat, lab, op, total: mat + lab + op };
}

function aerialSvg(MS) {
  const lines = MS.lines || [];
  const xs = lines.flatMap((l) => [l.x1, l.x2]), ys = lines.flatMap((l) => [l.y1, l.y2]), pad = 70;
  let x0 = Math.max(0, (xs.length ? Math.min(...xs) : 200) - pad), y0 = Math.max(0, (ys.length ? Math.min(...ys) : 200) - pad);
  let x1 = Math.min(1280, (xs.length ? Math.max(...xs) : 1080) + pad), y1 = Math.min(1280, (ys.length ? Math.max(...ys) : 1080) + pad);
  const W = x1 - x0, k = W / 1000;
  return `<svg viewBox="${x0} ${y0} ${W} ${y1 - y0}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Aerial photo with every roof edge traced and measured">
    <image href="${esc(MS.img)}" x="0" y="0" width="1280" height="1280"/>
    ${[0, 1].map((pass) => lines.map((l) => `<line x1="${l.x1}" y1="${l.y1}" x2="${l.x2}" y2="${l.y2}" stroke="${pass ? COL[l.type] || "#fff" : "#000"}" stroke-width="${(pass ? 7 : 12) * k}" stroke-linecap="round"/>`).join("")).join("")}
    ${lines.filter((l) => l.len >= 6).map((l) => { const cx = (l.x1 + l.x2) / 2, cy = (l.y1 + l.y2) / 2, t = l.len + "'", w = (t.length * 17 + 14) * k;
      return `<rect x="${cx - w / 2}" y="${cy - 19 * k}" width="${w}" height="${38 * k}" rx="${7 * k}" fill="#fff"/><text x="${cx}" y="${cy + 10 * k}" font-size="${29 * k}" font-weight="bold" text-anchor="middle" fill="#0B2545" font-family="Arial,sans-serif">${t}</text>`; }).join("")}
  </svg>`;
}

// m = report model; st = { pick: {estimateIndex: optionKey}, signed: {...} | null }
export function renderProposal(m, st = {}) {
  const b = m.brand || {}, j = m.job || {}, F = m.findings || [], L = m.leaks || [], D = m.diy || {}, G = D.guide || {};
  const company = b.company || "Your roofer";
  const roof = `<svg width="30" height="16" viewBox="0 0 30 16" aria-hidden="true"><path d="M1 9 L15 2 L29 9" fill="none" stroke="currentColor" stroke-width="2"/><line x1="7" y1="14" x2="23" y2="14" stroke="currentColor" stroke-width="2"/></svg>`;
  const hdr = (s) => `<div class="hdr"><div class="brand">${roof}<span>${esc(company)}</span></div><div class="section">${esc(s)}</div></div>`;
  const client = clean([j.client, j.clientPhone, j.clientEmail].filter(Boolean).join(" · "));
  const first = clean(j.client).split(/[ ,]/)[0] || "there";
  const contact = [b.phone, b.email, b.website].filter(Boolean).map(esc).join(" · ");
  const out = [];

  // band + title card
  out.push(`<div class="band"><div class="in"><div class="logo">${b.logo ? `<img src="${esc(b.logo)}" alt="${esc(company)}">` : `<div class="nologo">${esc(company)}</div>`}</div>
    <div class="who"><b>${esc(company)}</b>${contact ? "<br>" + contact : ""}${b.preparedBy ? "<br>" + esc(b.preparedBy) : ""}</div></div></div><div class="wrap">`);
  out.push(`<div class="titlecard"><h1>${esc(m.coverTitle || "Roof Inspection & Proposal")}</h1><div class="prop">${esc(j.address || "")}</div>
    <div class="meta">${client ? "Prepared for: " + esc(client) + "<br>" : ""}Prepared by: ${esc([b.preparedBy, company].filter(Boolean).join(", "))}<br>Date: ${esc(j.date || "")}</div>
    ${m.cover ? `<img class="cover" src="${esc(m.cover)}" alt="The roof">` : ""}${b.tagline ? `<div class="tag">${esc(b.tagline)}</div>` : ""}</div>`);

  // signed banner
  const S = st.signed;
  if (S) out.push(`<div class="sec ok"><h2>Signed. Thank you, ${esc(S.name.split(" ")[0])}!</h2><p>${esc(S.name)} accepted <b>${esc(S.option_name)}</b> (${money(S.total)}) on ${esc(new Date(S.created_at).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }))}.</p><p>${esc(company)} will reach out to set up the schedule. Keep this page for your records.</p></div>`);

  // note
  const note = m.note || {};
  out.push(`<div class="sec">${hdr("A note from us")}<p>${esc(note.salutation || "Hi " + first + ",")}</p>${arr(note.body).map((p) => `<p>${esc(p)}</p>`).join("")}
    <p style="margin-top:10px">${esc(note.signoff || "With gratitude,")}<br><b>${esc(b.preparedBy || company)}</b><br>${esc(company)}</p></div>`);

  // measurements
  const MS = m.measure;
  if (MS && MS.areaFt2) {
    const LEN = MS.lengths || {}, m0 = (MS.materials || [])[0] || {}, low = MS.pitch === "Low-slope";
    const kp = [["Roof area", fmt(MS.areaFt2) + " sq ft"], ["Squares", fmt(MS.squares, 1)], [`Squares + ${m0.waste || 10}% waste`, fmt(m0.squaresWaste, 1)], ["Roof faces", MS.faces], ["Main pitch", MS.pitch],
      ...(low ? [["Roof outline", fmt((LEN.edge || 0) + (LEN.parapet || 0) + (LEN.flashing || 0) + (LEN.eave || 0) + (LEN.rake || 0)) + " ft"], ["Wall flashing", fmt(LEN.flashing || 0) + " ft"], ["Parapet walls", fmt(LEN.parapet || 0) + " ft"]]
        : [["Drip edge (eaves + rakes)", fmt((LEN.eave || 0) + (LEN.rake || 0)) + " ft"], ["Ridges + hips", fmt((LEN.ridge || 0) + (LEN.hip || 0)) + " ft"], ["Valleys", fmt(LEN.valley || 0) + " ft"]])];
    const learned = (MS.learned || []).length ? ` Edge lengths adjusted using lessons from past corrected roofs.` : "";
    out.push(`<div class="sec">${hdr("Roof measurements")}<h2>${esc(MS.address || j.address)}</h2><p class="muted">Aerial imagery ${esc(MS.imagery)}${MS.quality ? " · " + esc(MS.quality) + " quality" : ""}${MS.style ? " · " + esc(MS.style) : ""}</p>
      <div class="aerial">${aerialSvg(MS)}</div>
      <div class="legend">${Object.keys(NAMES).filter((t) => LEN[t]).map((t) => `<span><i style="background:${COL[t]}"></i>${NAMES[t]}</span>`).join("")}</div>
      <div class="kpis">${kp.map(([a, v]) => `<div class="kpi"><b>${esc(v)}</b><span>${esc(a)}</span></div>`).join("")}</div>
      <details open><summary>Edge lengths and roof faces</summary><table><tr><th>Edge</th><th class="num">Feet</th></tr>${Object.keys(NAMES).filter((t) => LEN[t]).map((t) => `<tr><td>${NAMES[t]}</td><td class="num">${fmt(LEN[t])}</td></tr>`).join("")}</table>
        ${(MS.facets || []).length ? `<table><tr><th>Face</th><th>Pitch</th><th>Facing</th><th class="num">Sq ft</th></tr>${MS.facets.map((f) => `<tr><td>${f.n}</td><td>${esc(f.pitch)}</td><td>${esc(f.facing)}</td><td class="num">${fmt(f.areaFt2)}</td></tr>`).join("")}</table>` : ""}</details>
      ${(MS.materials || []).map((mt) => `<details open><summary>Materials list${(MS.materials || []).length > 1 ? " — " + esc(mt.roofType) : ""}</summary><p class="note">${esc(SYS_NAMES[mt.sys] || mt.roofType)}, full replacement, ${fmt(mt.squaresWaste, 1)} squares including ${mt.waste}% waste.</p>
        <table><tr><th>Item</th><th class="num">Qty</th></tr>${(mt.rows || []).map((r) => `<tr><td>${esc(r.item)}<div class="note">${esc(r.note)}</div></td><td class="num">${esc(r.qty)} ${esc(r.unit)}</td></tr>`).join("")}</table></details>`).join("")}
      <p class="note" style="margin-top:8px">Measured from aerial imagery and field-verified before materials are ordered.${learned}${(MS.areaAdj ? (MS.areaAdj.kind === "buffer" ? ` Roof area includes a +5% safety buffer (measured ${fmt(MS.rawAreaFt2)} sq ft) until Roofly has been checked against 3+ measured roofs.` : ` Roof area adjusted ${MS.areaAdj.f > 1 ? "+" : ""}${Math.round((MS.areaAdj.f - 1) * 100)}% using ${MS.areaAdj.n} roofs checked against EagleView or a tape measure.`) : "")}</p></div>`);
  } else if (MS && MS.error) {
    out.push(`<div class="sec">${hdr("Roof measurements")}<div class="box">${esc(MS.error)} Quantities below are estimated from the walkthrough and will be measured on site.</div></div>`);
  }

  // findings
  if (F.length) {
    const n = (s) => F.filter((f) => sev(f.severity) === s).length;
    out.push(`<div class="sec">${hdr("What we found")}<h2>Roof inspection</h2>${arr(m.summary).map((p) => `<p>${esc(p)}</p>`).join("")}
      <div class="counts">${["critical", "high", "medium", "low"].map((s) => `<div class="kpi"><b class="lvl ${s}">${n(s)}</b><span>${s[0].toUpperCase() + s.slice(1)}</span></div>`).join("")}</div>
      <p class="note"><b class="lvl critical">Critical</b>: open to water now. <b class="lvl high">High</b>: likely leak source, fix soon. <b class="lvl medium">Medium</b>: wear to fix in the normal course. <b class="lvl low">Low</b>: minor, monitor.</p>
      <div class="photos">${F.map((f, i) => `<div class="fcard">${f.img ? `<img src="${esc(f.img)}" alt="">` : ""}<div class="t"><span class="pill ${sev(f.severity)}">${esc(f.severity)}</span> <span class="n">#${i + 1} · ${esc(f.category || "")}${f.timeLabel ? " · " + esc(f.timeLabel) : ""}</span><b>${esc(f.title)}</b>${esc(f.description)}</div></div>`).join("")}</div>
      </div>`);
  }
  if (arr(m.other).length) out.push(`<div class="sec">${hdr("Other things we noticed")}<h2>Other things we noticed</h2><p class="muted">Not roof work and not included in our pricing. Just a heads-up so nothing surprises you.</p><ul>${m.other.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>`);
  if (L.length) out.push(`<div class="sec">${hdr("Inside the building")}<h2>Interior leaks</h2>${m.leak_summary ? `<p>${esc(m.leak_summary)}</p>` : ""}
    <div class="photos">${L.map((l, i) => `<div class="fcard">${l.img ? `<img src="${esc(l.img)}" alt="">` : ""}<div class="t"><span class="n">Leak ${i + 1}${l.timeLabel ? " · " + esc(l.timeLabel) : ""}</span><b>${esc(l.location)}</b>${l.observed ? esc(l.observed) : ""}${l.significance ? `<div class="note" style="margin-top:4px">${esc(l.significance)}</div>` : ""}</div></div>`).join("")}</div>
    ${arr(m.leak_next_steps).length ? `<h3>Next steps</h3><ul>${m.leak_next_steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</div>`);

  // DIY plan
  const phases = (D.phases || []).filter((p) => (p.items || []).length);
  if (phases.length || G.intro) {
    out.push(`<div class="sec">${hdr("Free repair plan")}<h2>Your DIY repair plan</h2><p class="muted">Yours to keep. Use it yourself, hand it to any contractor, or give it to someone handy.</p>${G.intro ? `<p>${esc(G.intro)}</p>` : ""}
      ${arr(G.safety).length ? `<div class="warn"><b>Safety first</b><ul>${G.safety.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div>` : ""}
      ${phases.map((ph) => `<details><summary>${esc(ph.name)} (${ph.items.length})</summary>${ph.items.map((d) => { const f = F[arr(d.findings)[0] - 1];
        return `<div class="item"><h4>${esc(d.title)}</h4><div class="note">Findings ${arr(d.findings).map((x) => "#" + x).join(", ") || "—"} · Difficulty: ${esc(d.difficulty || "")}</div>${f && f.img ? `<img src="${esc(f.img)}" alt="">` : ""}${d.why ? `<p>${esc(d.why)}</p>` : ""}
          ${arr(d.need).length ? `<b>What you'll need</b><ul>${d.need.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}${arr(d.steps).length ? `<b>Steps</b><ol>${d.steps.map((x) => `<li>${esc(x)}</li>`).join("")}</ol>` : ""}
          ${d.call_pro_if ? `<div><span class="callpro">Call a pro if:</span> ${esc(d.call_pro_if)}</div>` : ""}</div>`; }).join("")}</details>`).join("")}
      ${arr(G.shopping_list).length ? `<details><summary>Shopping list</summary><table><tr><th>Item</th><th>Used for</th><th class="num">Qty</th></tr>${G.shopping_list.map((s) => `<tr><td>${esc(s.item)}</td><td>${esc(s.used_for)}</td><td class="num">${esc(s.qty)}</td></tr>`).join("")}</table></details>` : ""}
      ${arr(G.maintenance).length ? `<details><summary>Keeping it healthy</summary><ul>${G.maintenance.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>` : ""}
      ${G.disclaimer ? `<p class="note" style="margin-top:8px">${esc(G.disclaimer)}</p>` : ""}</div>`);
  }

  // options
  const ests = m.estimates || [], margin = m.margin || {};
  ests.forEach((est, ei) => {
    const opts = est.options || [], pick = (st.pick || {})[ei];
    out.push(`<div class="sec">${hdr("Recommendation & proposals")}<h2>${ests.length > 1 ? "Your options — " + esc(est.roofType) : "Your options"}</h2>
      ${arr(est.recommendation).map((p) => `<p>${esc(p)}</p>`).join("")}${!S && opts.length > 1 ? `<p class="muted">Tap the option you want, then sign at the bottom.</p>` : ""}
      ${opts.map((o) => { const t = optionTotals(o, margin), on = pick === o.key || (S && S.option_key === `${ei}:${o.key}`);
        return `<label class="opt ${on ? "on" : ""}"><div class="top">${S ? "" : `<input type="radio" name="opt${ei}" data-ei="${ei}" value="${esc(o.key)}" ${on ? "checked" : ""}>`}<div style="flex:1;min-width:0"><div><span class="nm">${esc(o.name)}</span>${est.recommended === o.key ? `<span class="tier">Recommended</span>` : ""}</div>${o.subtitle ? `<div class="muted" style="font-size:13.5px">${esc(o.subtitle)}</div>` : ""}</div></div>
        <div class="scope"><table><thead><tr><th>Scope</th><th class="num">Qty</th><th class="num">Amount</th></tr></thead><tbody>
        ${(o.lines || []).map((l) => `<tr><td>${esc(l.desc)}</td><td class="num">${esc(+l.qty)} ${esc(l.unit || "")}</td><td class="num">${money((+l.qty || 0) * (+l.price || 0) * (margin.include ? 1 + (+margin.pct || 0) / 100 : 1))}</td></tr>`).join("")}
        <tr class="total"><td colspan="2">${margin.include || m.formatVersion >= 2 ? "TOTAL INVESTMENT" : "TOTAL (MATERIALS + LABOR)"}</td><td class="num">${money(t.total)}</td></tr></tbody></table></div>
        ${o.warranty || o.timeline ? `<p class="note" style="margin-top:8px">${o.warranty ? "<b>Warranty:</b> " + esc(o.warranty) + " " : ""}${o.timeline ? "<b>Schedule:</b> " + esc(o.timeline) : ""}</p>` : ""}</label>`; }).join("")}
      <div class="cols"><div class="box"><h4>Payment &amp; terms</h4>${esc(est.payment || m.terms || "50% deposit to schedule, balance due at substantial completion. Proposal good for 30 days.")}</div>
        <div class="box"><h4>Notes &amp; exclusions</h4><ul>${[...arr(est.assumptions), ...arr(est.exclusions)].map((x) => String(x).replace(/,?\s*before (overhead|profit)[^.]*/i, "")).filter((x) => !/overhead|profit/i.test(x)).slice(0, 12).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></div></div>
      ${est.quantities_note ? `<p class="note" style="margin-top:8px">${esc(est.quantities_note)}</p>` : ""}</div>`);
  });

  if (m.addendum) out.push(`<div class="sec">${hdr("Terms & conditions")}<div style="font-size:14px;line-height:1.55">${termsHtml(m.addendum)}</div></div>`);

  // acceptance
  const all = []; ests.forEach((est, ei) => (est.options || []).forEach((o) => all.push({ ei, o, est })));
  if (!S && all.length && st.canSign !== false) {
    const sel = all.find(({ ei, o }) => (st.pick || {})[ei] === o.key);
    out.push(`<div class="sec no-print" id="acc">${hdr("Acceptance")}<h2>Accept and sign</h2>
      <p>${sel ? `You're accepting <b>${esc(sel.o.name)}</b>${ests.length > 1 ? " (" + esc(sel.est.roofType) + ")" : ""} for <b>${money(optionTotals(sel.o, margin).total)}</b>.` : "<b>Pick an option above first.</b>"}</p>
      <label class="f" for="nm">Your full name</label><input type="text" id="nm" autocomplete="name" value="${esc(clean(j.client))}">
      <label class="f" for="em">Email (for your copy)</label><input type="email" id="em" autocomplete="email" value="${esc(j.clientEmail || "")}">
      <label class="f">Sign with your finger</label><div class="padwrap"><canvas class="pad" id="pad" aria-label="Signature box"></canvas><div class="padline"></div></div>
      <div class="row" style="margin-top:6px"><button class="btn" type="button" style="flex:0 1 auto;min-height:38px" id="clr">Clear signature</button></div>
      <label class="agree"><input type="checkbox" id="ag"><span>I accept this proposal and the payment terms above, and authorize ${esc(company)} to do the work.</span></label>
      <div class="err" id="err" role="alert"></div><div class="row"><button class="btn p" type="button" id="go">Sign &amp; accept</button></div></div>`);
  }

  out.push(`<div class="sec">${hdr("Questions?")}<div class="people"><div><b>${esc(b.preparedBy || company)}</b><br>${esc(company)}</div><div>${b.phone ? `<a href="tel:${esc(String(b.phone).replace(/[^\d+]/g, ""))}">${esc(b.phone)}</a><br>` : ""}${b.email ? `<a href="mailto:${esc(b.email)}">${esc(b.email)}</a><br>` : ""}${b.website ? esc(b.website) : ""}</div></div>
    <div class="ftr"><span>${b.tagline ? `<i>${esc(b.tagline)}</i>` : esc(company)}</span><span>Made with <a href="https://useroofly.com">Roofly</a> · Format v2</span></div></div></div>`);
  return out.join("");
}
