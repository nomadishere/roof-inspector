// Optional link from a CRM job into Roofly. Roofly stays its own tool; this file does nothing
// unless Roofly is opened with ?link=<code> by the CRM. With a link code, the finished report's
// findings, priced options and share link are attached to that one CRM job (code expires in 48h).
import { optionTotals } from "./report.js";

const SB_URL = "https://wwqjoagdnclaylllzcut.supabase.co";
const SB_KEY = "sb_publishable_AVIpI00DFiYwugP16-wMWQ_qENLObrc";
const P = new URLSearchParams(location.search);
const fromUrl = /^[0-9a-f]{20,64}$/i.test(P.get("link") || "") ? P.get("link") : null;
// Reports build on the server and can finish after you leave, so remember the link code for this device (48 hours).
let remembered = null; try { const r = JSON.parse(localStorage.getItem("roofly.crmLink") || "null"); if (r && Date.now() - r.at < 1728e5) remembered = r.code; } catch {}
if (fromUrl) try { localStorage.setItem("roofly.crmLink", JSON.stringify({ code: fromUrl, at: Date.now() })); } catch {}
const CODE = fromUrl || remembered;
let saved = false;

async function save(action, payload) {
  const r = await fetch(SB_URL + "/rest/v1/rpc/crm_roofly_save", { method: "POST", headers: { apikey: SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ p_code: CODE, p_action: action, p: payload }) });
  const d = await r.json().catch(() => null); if (!r.ok) throw new Error((d && d.message) || "Couldn't reach the CRM"); return d;
}
function note(html, bad) {
  let el = document.getElementById("crmNote");
  if (!el) { el = document.createElement("div"); el.id = "crmNote"; el.className = "tip"; (document.getElementById("form") || document.body).prepend(el); }
  el.innerHTML = html; el.style.borderColor = bad ? "#c0392b" : ""; return el;
}

export function prefill($) {
  if (!fromUrl) return;
  const set = (id, k) => { const v = P.get(k); if (v && $(id)) { $(id).value = v; $(id).dispatchEvent(new Event("input", { bubbles: true })); } };
  set("address", "address"); set("client", "client"); set("clientPhone", "phone"); set("clientEmail", "email"); set("notes", "notes");
  note("<b>Opened from a CRM job.</b> When this report is built, its findings and priced options are saved back to that job.");
}

export async function afterBuild(m, margin) {
  if (!CODE || !m || saved) return;
  try {
    const findings = (m.findings || []).slice(0, 40).map((f) => ({ area: f.location || f.category || "", issue: f.title || f.description || "", severity: /high|urgent|critical|severe/i.test(f.severity || f.priority || "") ? "high" : /med/i.test(f.severity || f.priority || "") ? "medium" : "low" }));
    const options = [];
    for (const est of m.estimates || []) for (const o of est.options || []) {
      let total = 0; try { total = optionTotals(o, margin || m.margin || { include: true, pct: 0 }).total || 0; } catch {}
      options.push({ name: (o.key ? o.key + " — " : "") + String(o.name || "Option").replace(/^Option [A-Z]:\s*/, "") + (est.roofType ? " (" + est.roofType + ")" : ""), total: Math.round(total), recommended: !!est.recommended && (est.recommended === o.key || est.recommended === o.name) });
    }
    const summary = (m.summary || []).filter(Boolean).join(" ");
    const best = options.find((o) => o.recommended) || options[0];
    const co = (m.brand && m.brand.company) || "our team", by = (m.brand && m.brand.preparedBy) || "", ph = (m.brand && m.brand.phone) || "";
    const draft = [
      `Hi ${String(m.job.client || "there").split(" ")[0]},`, "",
      `Thank you for having ${co} out to look at ${m.job.address || "your roof"}.`, "",
      summary ? "What we found: " + summary : "", "",
      options.length ? "Your options:\n" + options.map((o) => `• ${o.name}: $${o.total.toLocaleString()}${o.recommended ? " (our recommendation)" : ""}`).join("\n") : "", "",
      `The full inspection report with photos is linked below. Reply${ph ? " or call " + ph : ""} and we'll get you on the schedule.`, "",
      by, co,
    ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim();
    await save("report", { findings: { summary, findings, scope: options.map((o) => ({ item: o.name, detail: "$" + o.total.toLocaleString() })) }, options, best_total: best ? best.total : null, draft });
    saved = true;
    note(`<b>Saved to the CRM job.</b> Findings and ${options.length} priced option${options.length === 1 ? "" : "s"} are on the job. Tap <b>Share link</b> to attach the report too.`);
  } catch (e) { note(`<b>Couldn't save to the CRM:</b> ${e.message}`, true); }
}

export async function afterShare(link) {
  if (!CODE || !link) return;
  try {
    await save("share", { link });
    try { localStorage.removeItem("roofly.crmLink"); } catch {}
    note("<b>Report link saved to the CRM job.</b>");
  } catch (e) { note(`<b>Couldn't save the link to the CRM:</b> ${e.message}`, true); }
}
