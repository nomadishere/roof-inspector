// Link between Roofly and Lucky Line CRM (useroofly.com/crm).
// Open Roofly from a CRM job with ?me=justin&crm=<job id>&address=…&client=…&phone=…&email=…
// The finished report (findings, options, prices, share link) is saved back onto that job.
// It uses the CRM sign-in stored on this same site (useroofly.com/crm), so no extra login.
import { optionTotals } from "./report.js";

const SB_URL = "https://wwqjoagdnclaylllzcut.supabase.co";
const SB_KEY = "sb_publishable_AVIpI00DFiYwugP16-wMWQ_qENLObrc";
const P = new URLSearchParams(location.search);
const fromUrl = /^[0-9a-f-]{36}$/i.test(P.get("crm") || "") ? P.get("crm") : null;
// Reports build on the server and can finish after you leave, so remember which CRM job this run belongs to (for 24 hours).
let remembered = null; try { const r = JSON.parse(localStorage.getItem("roofly.crmJob") || "null"); if (r && Date.now() - r.at < 864e5) remembered = r.id; } catch {}
if (fromUrl) try { localStorage.setItem("roofly.crmJob", JSON.stringify({ id: fromUrl, at: Date.now() })); } catch {}
export const CRM_JOB = fromUrl || remembered;
let inspectionId = null;

const q = (v) => (v == null || v === "" ? "null" : "'" + String(v).replace(/'/g, "''") + "'");
function session() { try { return JSON.parse(localStorage.getItem("jcrm_session") || "null"); } catch { return null; } }
async function token() {
  let s = session(); if (!s) return null;
  if (s.expires_at - 90 < Date.now() / 1000) {
    const r = await fetch(SB_URL + "/auth/v1/token?grant_type=refresh_token", { method: "POST", headers: { apikey: SB_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ refresh_token: s.refresh_token }) });
    if (!r.ok) return null;
    const d = await r.json(); s = { ...s, access_token: d.access_token, refresh_token: d.refresh_token, expires_at: d.expires_at || Math.floor(Date.now() / 1000) + 3600 };
    try { localStorage.setItem("jcrm_session", JSON.stringify(s)); } catch {}
  }
  return s.access_token;
}
async function run(stmts) {
  const t = await token(); if (!t) throw new Error("Sign in to Lucky Line CRM on this phone to save reports to the job.");
  const r = await fetch(SB_URL + "/rest/v1/rpc/crm_run", { method: "POST", headers: { apikey: SB_KEY, Authorization: "Bearer " + t, "Content-Type": "application/json" }, body: JSON.stringify({ stmts }) });
  const d = await r.json().catch(() => null); if (!r.ok) throw new Error((d && d.message) || "CRM save failed"); return d;
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
  note(session()
    ? `<b>Linked to Lucky Line CRM.</b> When the report is built, its findings, options and prices go straight onto this job, and the 60-minute proposal clock starts. <a href="/crm/#job-${CRM_JOB}">Back to the job</a>`
    : `<b>Linked to a CRM job.</b> <a href="/crm/">Sign in to Lucky Line CRM</a> on this phone first so the report saves to the job.`, !session());
}

export async function afterBuild(m, margin) {
  if (!CRM_JOB || !m) return;
  try {
    const findings = (m.findings || []).slice(0, 40).map((f) => ({ area: f.location || f.category || "", issue: f.title || f.description || "", severity: /high|urgent|critical|severe/i.test(f.severity || f.priority || "") ? "high" : /med/i.test(f.severity || f.priority || "") ? "medium" : "low" }));
    const options = [];
    for (const est of m.estimates || []) for (const o of est.options || []) {
      let total = 0; try { total = optionTotals(o, margin || m.margin || { include: true, pct: 0 }).total || 0; } catch {}
      options.push({ name: (o.key ? o.key + " — " : "") + String(o.name || "Option").replace(/^Option [A-Z]:\s*/, "") + (est.roofType ? " (" + est.roofType + ")" : ""), total: Math.round(total), recommended: !!est.recommended && (est.recommended === o.key || est.recommended === o.name) });
    }
    const summary = (m.summary || []).filter(Boolean).join(" ");
    const best = options.find((o) => o.recommended) || options[0];
    const draft = [
      `Hi ${String(m.job.client || "there").split(" ")[0]},`, "",
      `Thank you for having Lucky Line Roofing out to look at ${m.job.address || "your roof"}.`, "",
      summary ? "What we found: " + summary : "", "",
      options.length ? "Your options:\n" + options.map((o) => `• ${o.name}: $${o.total.toLocaleString()}${o.recommended ? " (our recommendation)" : ""}`).join("\n") : "", "",
      "The full inspection report with photos is attached at the link below. Reply or call 406-609-9950 and we'll get you on the schedule.", "",
      "Justin Walton", "Lucky Line Roofing", "Shelter you can count on, service you'll remember.",
    ].filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
    const rows = await run([
      `insert into crm.inspections(job_id,source,video_name,recorded_at,status,findings,proposal_draft,estimate_total) values (${q(CRM_JOB)},'roofly','Roofly report',now(),'drafted',${q(JSON.stringify({ summary, findings, scope: options.map((o) => ({ item: o.name, detail: "$" + o.total.toLocaleString() })) }))}::jsonb,${q(draft)},${best ? best.total : "null"}) returning id`,
    ]);
    inspectionId = rows && rows[0] && rows[0].id;
    if (options.length) {
      await run([
        ...options.map((o, i) => `with e as (insert into crm.estimates(job_id,name,tier,summary,sort) values (${q(CRM_JOB)},${q(o.name)},${q(["Good", "Better", "Best"][i] || "Other")},${q(o.recommended ? "Recommended in the Roofly report" : "From the Roofly report")},${i + 1}) returning id) insert into crm.estimate_lines(estimate_id,item,qty,unit,unit_price) select id,${q(o.name)},1,'job',${o.total} from e`),
        `update crm.jobs set value=${best ? best.total : "value"}, proposal_text=${q(draft)} where id=${q(CRM_JOB)}`,
        `insert into crm.notes(job_id,contact_id,kind,body,author,source) select id,contact_id,'system','Roofly report built: '||${q(options.length + " option(s)" + (best ? ", recommended $" + best.total.toLocaleString() : ""))},'Roofly','Roofly' from crm.jobs where id=${q(CRM_JOB)} returning id`,
      ]);
    }
    try { localStorage.removeItem("roofly.crmJob"); } catch {}
    note(`<b>Saved to the CRM job.</b> Findings and ${options.length} priced option${options.length === 1 ? "" : "s"} are on the job, and the 60-minute clock is running. Tap <b>Share link</b> to attach the report, then send it. <a href="/crm/#job-${CRM_JOB}">Open the job</a>`);
  } catch (e) { note(`<b>Couldn't save to the CRM:</b> ${e.message}`, true); }
}

export async function afterShare(link) {
  if (!CRM_JOB || !link) return;
  try {
    await run([
      inspectionId ? `update crm.inspections set report_url=${q(link)}, proposal_draft=replace(coalesce(proposal_draft,''),'attached at the link below.','attached at the link below:'||chr(10)||${q(link)}) where id=${q(inspectionId)}` : `select 1`,
      `update crm.jobs set proposal_text=coalesce(proposal_text,'')||chr(10)||chr(10)||'Report: '||${q(link)} where id=${q(CRM_JOB)} and coalesce(proposal_text,'') not like '%'||${q(link)}||'%' returning id`,
    ]);
    note(`<b>Report link saved to the CRM job.</b> <a href="/crm/#job-${CRM_JOB}">Open the job to send the proposal</a>`);
  } catch (e) { note(`<b>Couldn't save the link to the CRM:</b> ${e.message}`, true); }
}
