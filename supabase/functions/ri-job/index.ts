// Roofly server-side report jobs. The phone only uploads stills; everything else runs here,
// one small piece per invocation, so people can lock their phone or leave the page.
// Flow: create -> upload (many) -> start -> vision parts (parallel) + aerial roof measurement -> merge -> plan
//       -> write parts (DIY guide, note, estimates, DIY items per phase, in parallel) -> assemble -> done.
import { createClient } from "npm:@supabase/supabase-js@2";
import { encodeBase64 } from "jsr:@std/encoding@1/base64";
import * as P from "./prompts.ts";
// @ts-ignore plain JS module shared with the website (copy of js/measure-core.js)
import * as MC from "./measure-core.js";

const URL0 = Deno.env.get("SUPABASE_URL")!;
const db = createClient(URL0, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
const BUCKET = "ri-jobs";
const PUB = `${URL0}/storage/v1/object/public/${BUCKET}`;
const MONTHLY_CAP_USD = 200;
const JOBS_PER_IP_PER_DAY = 25;
const BATCH = 10; // small pieces: every AI call must finish well inside the 150 s server limit
const STALE_MS = 175_000; // a part "running" longer than this died; run it again
const MAX_ATTEMPTS = 4;
const SITE = "https://useroofly.com/";
const FROM = "Roofly <no-reply@mail.useroofly.com>";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-user-token", "Access-Control-Allow-Methods": "POST, OPTIONS" };
const out = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
const now = () => new Date().toISOString();
let TOKEN = "";
async function workerToken() {
  if (TOKEN) return TOKEN;
  const { data } = await db.from("admin_secrets").select("value").eq("name", "RI_WORKER_TOKEN").maybeSingle();
  return (TOKEN = data?.value || "");
}
async function secret(name: string) { const { data } = await db.from("admin_secrets").select("value").eq("name", name).maybeSingle(); return data?.value || ""; }

// ---------- helpers ----------
async function getJob(id: string) { const { data } = await db.from("ri_jobs").select("*").eq("id", id).maybeSingle(); return data; }
async function setJob(id: string, patch: any) { await db.from("ri_jobs").update({ ...patch, updated_at: now() }).eq("id", id); }
async function addParts(jobId: string, parts: { kind: string; idx: number; payload?: any }[]) {
  if (!parts.length) return;
  await db.from("ri_job_parts").upsert(parts.map((p) => ({ job_id: jobId, kind: p.kind, idx: p.idx, payload: p.payload ?? null, status: "pending", updated_at: now() })), { onConflict: "job_id,kind,idx", ignoreDuplicates: true });
}
async function kick(jobId: string, kind: string, idx: number) {
  try {
    await fetch(`${URL0}/functions/v1/ri-job`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "run", id: jobId, kind, idx, token: await workerToken() }) });
  } catch (_) { /* the watchdog will pick it up */ }
}
// claim the right to advance from one stage to the next (only one invocation wins)
async function claimStage(jobId: string, from: string, to: string, progress = "") {
  const { data } = await db.from("ri_jobs").update({ stage: to, progress, updated_at: now() }).eq("id", jobId).eq("stage", from).select("id");
  return !!(data && data.length);
}
async function partsLeft(jobId: string, kinds: string[]) {
  const { count } = await db.from("ri_job_parts").select("idx", { count: "exact", head: true }).eq("job_id", jobId).in("kind", kinds).neq("status", "done");
  return count || 0;
}
async function partResults(jobId: string, kind: string) {
  const { data } = await db.from("ri_job_parts").select("idx,result").eq("job_id", jobId).eq("kind", kind).order("idx");
  return (data || []).map((r: any) => r.result || {});
}
async function logUsage(ip: string, step: string, usage: any) {
  const cost = (usage.input_tokens || 0) * P.PRICE_IN + (usage.output_tokens || 0) * P.PRICE_OUT;
  await db.from("ri_usage").insert({ ip, step, input_tokens: usage.input_tokens || 0, output_tokens: usage.output_tokens || 0, cost_usd: cost });
}
async function ai(job: any, step: string, content: any[]) {
  let usage: any = {}, text = "";
  try { ({ text, usage } = await P.callClaude(content, P.MAX_OUT)); }
  catch (e) { throw new Error("AI: " + String((e as Error).message || e).slice(0, 200)); }
  await logUsage(job.ip || "job", step, usage);
  try { return P.parseJSON(text); } catch { throw new Error("PARSE"); }
}
async function imageBlock(jobId: string, id: string) {
  const { data, error } = await db.storage.from(BUCKET).download(`${jobId}/${id}.jpg`);
  if (error || !data) throw new Error("missing image " + id);
  return { type: "image", source: { type: "base64", media_type: "image/jpeg", data: encodeBase64(new Uint8Array(await data.arrayBuffer())) } };
}

// ---------- the pipeline, one part at a time ----------
async function runPart(jobId: string, kind: string, idx: number) {
  // claim the part (pending/error, or a running one that died)
  const { data: rows } = await db.from("ri_job_parts").select("*").eq("job_id", jobId).eq("kind", kind).eq("idx", idx);
  const part = rows?.[0]; if (!part || part.status === "done") return;
  if (part.status === "running" && part.started_at && Date.now() - new Date(part.started_at).getTime() < STALE_MS) return;
  if (part.attempts >= MAX_ATTEMPTS) { await setJob(jobId, { status: "error", error: `The ${kind} step kept failing. Please try again.` }); return; }
  const { data: got } = await db.from("ri_job_parts").update({ status: "running", attempts: part.attempts + 1, started_at: now(), updated_at: now() })
    .eq("job_id", jobId).eq("kind", kind).eq("idx", idx).eq("attempts", part.attempts).select("idx");
  if (!got?.length) return; // someone else took it

  const J = await getJob(jobId); if (!J || J.status !== "running") return;
  const inp = J.input || {}, job = inp.job || {}, st = J.state || {};
  try {
    let result: any = null;
    if (kind === "measure") result = await measureRoof(J);
    else if (kind === "vision") {
      const ids: { id: string; label: string }[] = part.payload.images;
      const content: any[] = [];
      for (const im of ids) { content.push({ type: "text", text: `${im.id} — ${im.label}` }); content.push(await imageBlock(jobId, im.id)); }
      content.push({ type: "text", text: P.visionPrompt(job, ids.map((i) => i.id).join(", "), part.payload.part) });
      result = await ai(J, "vision", content);
      const lab = Object.fromEntries(ids.map((i) => [i.id, i.label]));
      for (const f of [...(result.findings || []), ...(result.leaks || [])]) f.source = lab[f.image] || "";
    } else if (kind === "merge") {
      const { rawF, rawL, flat, covers, facts } = mergeInput(await partResults(jobId, "vision"));
      const slice = flat.slice(idx * MERGE_CHUNK, (idx + 1) * MERGE_CHUNK), ids = new Set(slice.map((x: any) => x.id));
      const M = await ai(J, "consolidate", [{ type: "text", text: P.consolidatePrompt(job, { items: slice, cover_candidates: covers.slice(0, 20), facts_seen: facts }) }]);
      const C: any = { cover: M.cover, roof_system: M.roof_system, facts: M.facts, size_squares: M.size_squares, findings: [], leaks: [] };
      const uF = new Set(), uL = new Set();
      for (const k of M.findings || []) { const f = rawF[k.use]; if (!f || !ids.has(k.use) || uF.has(k.use)) continue; uF.add(k.use); (k.also || []).forEach((x: string) => uF.add(x)); C.findings.push({ ...f, title: k.title || f.title, severity: k.severity || f.severity }); }
      for (const k of M.leaks || []) { const l = rawL[k.use]; if (!l || !ids.has(k.use) || uL.has(k.use)) continue; uL.add(k.use); (k.also || []).forEach((x: string) => uL.add(x)); C.leaks.push({ ...l, condition: k.condition || l.condition || "" }); }
      for (const id in rawF) if (ids.has(id) && !uF.has(id)) C.findings.push(rawF[id]);
      for (const id in rawL) if (ids.has(id) && !uL.has(id)) C.leaks.push(rawL[id]);
      result = C;
    } else if (kind === "plan") {
      const C = st.C;
      result = await ai(J, "plan", [{ type: "text", text: P.planPrompt(job, { roof_system: C.roof_system, facts: C.facts, findings: C.findings.map((f: any, i: number) => ({ n: i + 1, title: f.title, category: f.category, severity: f.severity, description: f.description })), leaks: C.leaks.map(({ location, condition, observed, significance }: any) => ({ location, condition, observed, significance })) }) }]);
      await setJob(jobId, { state: { ...st, P: result } });
    } else {
      const C = st.C, PL = st.P || {};
      const [MS] = await partResults(jobId, "measure");
      const cText: any = { roof_system: C.roof_system, summary: PL.summary, facts: C.facts, size_squares: MS?.summary ? MS.summary.squares : C.size_squares, measuredFor: (rt: string) => MS?.summary ? MC.summaryText(MS.summary, rt) : (MS?.error ? `NO AERIAL MEASUREMENT for this address (${MS.error}). Estimate quantities from the video and mark them (confirm).` : ""), findings: C.findings.map(({ title, category, severity, description }: any) => ({ title, category, severity, description })), leaks: C.leaks, repair_phases: PL.repair_phases };
      if (kind === "diy_guide") result = await ai(J, kind, [{ type: "text", text: P.diyGuidePrompt(job, cText) + (idx === 0
        ? `\n\nTHIS CALL: return ONLY these keys: intro, safety, material_rule, weather_window, basic_method.`
        : `\n\nTHIS CALL: return ONLY these keys: shopping_list, maintenance, winter, call_pro, disclaimer.`) }]);
      else if (kind === "note") result = await ai(J, kind, [{ type: "text", text: P.notePrompt(job, cText) }]);
      else if (kind === "estimate") result = await ai(J, kind, [{ type: "text", text: P.estimatePrompt(job, cText, part.payload.roofType) + (part.payload.only
        ? `\n\nTHIS CALL: a repair option is NOT being offered. Return the full JSON shape above, but "options" holds ONLY Option B. Set compare_rows to [], recommended to "B", and recommendation to ONE short paragraph on why a full replacement fits this roof (never mention an "Option A" or a repair option). Still fill quantities_note, assumptions, exclusions and payment.`
        : part.payload.key === "A"
        ? `\n\nTHIS CALL: return the full JSON shape above EXCEPT put only Option A in "options" (Option B is written separately). Still fill compare_rows, recommended, recommendation, quantities_note, assumptions, exclusions and payment for both options.`
        : `\n\nTHIS CALL: return ONLY {"options":[ Option B in the shape above ]}. Nothing else.`) }]);
      else if (kind === "diy_items") result = await ai(J, kind, [{ type: "text", text: P.diyItemsPrompt(job, { ...cText, phase: part.payload.phase, startAt: 1 }) }]);
      else if (kind === "assemble") result = await assemble(J);
    }
    await db.from("ri_job_parts").update({ status: "done", result, updated_at: now() }).eq("job_id", jobId).eq("kind", kind).eq("idx", idx);
    await advance(jobId);
  } catch (e) {
    const msg = String((e as Error).message || e);
    await db.from("ri_job_parts").update({ status: "error", result: { error: msg.slice(0, 300) }, updated_at: now() }).eq("job_id", jobId).eq("kind", kind).eq("idx", idx);
    if (part.attempts + 1 >= MAX_ATTEMPTS) await setJob(jobId, { status: "error", error: "Roofly couldn't finish this report. Please try again." });
    else { await new Promise((r) => setTimeout(r, 3000)); await kick(jobId, kind, idx); }
  }
}

// Aerial roof measurement (same tool as useroofly.com/measure). Never fails the report: on any problem it
// returns { error } and the estimate falls back to the video, marked (confirm).
async function measureRoof(J: any) {
  const address = String(J.input?.job?.address || "").trim();
  if (address.length < 5) return { error: "No property address was given, so the roof wasn't measured from the air." };
  try {
    const r = await fetch(`${URL0}/functions/v1/ri-measure`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address, token: await workerToken(), ip: J.ip || "job" }) });
    const d = await r.json().catch(() => ({ error: "BAD", message: "The measurement service didn't answer." }));
    if (d.error) return { error: d.message || "Couldn't measure this roof from the air." };
    if (!(d.roof?.areaFt2 > 0)) return { error: "Google's roof data for this address had no roof area." };
    const png = Uint8Array.from(atob(String(d.image).replace(/^data:image\/\w+;base64,/, "")), (c) => c.charCodeAt(0));
    await db.storage.from(BUCKET).upload(`${J.id}/aerial.png`, png, { upsert: true, contentType: "image/png" });
    return { summary: MC.reportSummary(d, J.input?.job?.roofTypes || []), img: `${PUB}/${J.id}/aerial.png`, check: d.check || null };
  } catch (e) { return { error: "Couldn't measure this roof from the air (" + String((e as Error).message || e).slice(0, 120) + ")." }; }
}

// Merge runs in chunks of MERGE_CHUNK raw items, each its own part, so one AI answer never runs past the
// 150 s limit (a 400-still walkthrough produced ~200 findings; one call for all of them timed out).
const MERGE_CHUNK = 60;
// Justin's focus rule (Nov 9 2026): never report tree limbs, gutter debris, rust or downspouts
const SKIP_TOPIC = /\b(tree|trees|branch|branches|limb|limbs|leaves|leaf|downspout|downspouts|rust|rusty|rusted|rust streak)\b|clogged gutter|packed with|filled with (leaves|debris)/i;
// strip inspector-only "(confirm)" notes out of anything a client reads
function stripConfirm(v: any): any {
  if (typeof v === "string") return v.replace(/\s*\((?:[^()]*\b)?(?:to be |to )?confirm(?:ed)?\b[^()]*\)/gi, "").replace(/\s+\(confirm\)/gi, "").replace(/\s*[,;]?\s*(?:age|style|size|layers?):\s*confirm\b/gi, "").replace(/\s{2,}/g, " ").trim();
  if (Array.isArray(v)) return v.map(stripConfirm);
  if (v && typeof v === "object") { const o: any = {}; for (const k of Object.keys(v)) o[k] = stripConfirm(v[k]); return o; }
  return v;
}
function mergeInput(raw: any[]) {
  const rawF: any = {}, rawL: any = {}, flat: any[] = [], covers: any[] = [], facts: string[] = [], other: string[] = [];
  raw.forEach((res: any) => {
    (res.findings || []).filter((f: any) => !SKIP_TOPIC.test(String(f.title || ""))).forEach((f: any) => { const id = "R" + (Object.keys(rawF).length + 1); rawF[id] = f; flat.push({ id, at: f.source, title: f.title, category: f.category, severity: f.severity, description: f.description }); });
    (res.leaks || []).forEach((l: any) => { const id = "L" + (Object.keys(rawL).length + 1); rawL[id] = l; flat.push({ id, at: l.source, location: l.location, observed: l.observed }); });
    covers.push(...(res.cover_candidates || [])); if (res.facts_seen) facts.push(res.facts_seen);
    for (const o of res.other_notes || []) { const t = String(o || "").trim(); if (t && !SKIP_TOPIC.test(t) && !other.some((x) => x.toLowerCase().slice(0, 40) === t.toLowerCase().slice(0, 40))) other.push(t.slice(0, 220)); }
  });
  return { rawF, rawL, flat, covers, facts, other };
}
// report size: the most findings that go in, worst first, kept in walkthrough order
const LEVEL_FINDINGS: Record<string, number> = { quick: 20, standard: 50, thorough: 100 };
const SEV: Record<string, number> = { Critical: 0, High: 1, Medium: 2, Low: 3 };
function capFindings(list: any[], n: number) {
  if (list.length <= n) return list;
  const keep = new Set(list.map((f, i) => ({ f, i })).sort((a, b) => (SEV[a.f.severity] ?? 2) - (SEV[b.f.severity] ?? 2) || a.i - b.i).slice(0, n).map((x) => x.i));
  return list.filter((_, i) => keep.has(i));
}
// put the finished merge chunks back together, in walkthrough order
async function combineMerge(jobId: string, J: any) {
  if (J.state?.C) return J.state.C;
  const parts = await partResults(jobId, "merge");
  const { other, covers } = mergeInput(await partResults(jobId, "vision"));
  const first = parts.find((p: any) => p.roof_system || p.facts) || parts[0] || {};
  const C: any = { cover: parts.find((p: any) => p.cover)?.cover || covers[0]?.image || J.input?.images?.[0]?.id, roof_system: first.roof_system, facts: first.facts, size_squares: first.size_squares, findings: capFindings(parts.flatMap((p: any) => p.findings || []), LEVEL_FINDINGS[J.input?.job?.level] || 50), leaks: parts.flatMap((p: any) => p.leaks || []), other: other.slice(0, 12) };
  await setJob(jobId, { state: { ...J.state, C } });
  return C;
}

const WRITE_KINDS = ["diy_guide", "note", "estimate", "diy_items"];
async function advance(jobId: string) {
  const J = await getJob(jobId); if (!J || J.status !== "running") return;
  if (J.stage === "vision") {
    const total = J.state?.nBatches || 0, left = await partsLeft(jobId, ["vision"]);
    await setJob(jobId, { progress: `${total - left} of ${total} batches` });
    if (left === 0 && await claimStage(jobId, "vision", "merge", "Removing duplicates and rating priorities")) {
      const n = Math.max(1, Math.ceil(mergeInput(await partResults(jobId, "vision")).flat.length / MERGE_CHUNK));
      const mp = Array.from({ length: n }, (_, i) => ({ kind: "merge", idx: i }));
      await setJob(jobId, { state: { ...(await getJob(jobId)).state, nMerge: n } });
      await addParts(jobId, mp); await Promise.all(mp.map((m) => kick(jobId, "merge", m.idx)));
    }
  } else if (J.stage === "merge") {
    if (await partsLeft(jobId, ["merge"]) === 0) {
      const C0 = await combineMerge(jobId, J);
      const n = (C0.findings || []).length, nl = (C0.leaks || []).length;
      if (await claimStage(jobId, "merge", "plan", `${n} findings, ${nl} interior leak locations`)) { await addParts(jobId, [{ kind: "plan", idx: 0 }]); await kick(jobId, "plan", 0); }
    }
  } else if (J.stage === "plan") {
    if (await partsLeft(jobId, ["plan", "measure"]) === 0 && await claimStage(jobId, "plan", "write", "Writing the DIY plan, proposals and your note")) {
      const phases = ((J.state?.P?.repair_phases) || []).filter((p: any) => (p.findings || []).length && !/ongoing/i.test(p.name || ""));
      const roofTypes = J.input?.job?.roofTypes || [];
      // DIY items: each phase in chunks of up to 6 findings, so no single answer runs long
      const chunks: any[] = [];
      phases.forEach((ph: any, pi: number) => { for (let k = 0; k < ph.findings.length; k += 6) chunks.push({ phase: { ...ph, findings: ph.findings.slice(k, k + 6) }, pi }); });
      const diy = J.input?.job?.diy === true; // the DIY repair guide is optional (off unless asked for)
      const repair = J.input?.job?.repair === true; // Option A (repair) is optional; by default the report offers full replacement only
      const parts = [...(diy ? [{ kind: "diy_guide", idx: 0 }, { kind: "diy_guide", idx: 1 }] : []), { kind: "note", idx: 0 },
        ...roofTypes.flatMap((rt: string, i: number) => repair ? [{ kind: "estimate", idx: i * 2, payload: { roofType: rt, key: "A" } }, { kind: "estimate", idx: i * 2 + 1, payload: { roofType: rt, key: "B" } }] : [{ kind: "estimate", idx: i, payload: { roofType: rt, key: "B", only: true } }]),
        ...(diy ? chunks.map((c: any, i: number) => ({ kind: "diy_items", idx: i, payload: c })) : [])];
      await addParts(jobId, parts);
      await setJob(jobId, { state: { ...J.state, nWrite: parts.length } });
      await Promise.all(parts.map((p) => kick(jobId, p.kind, p.idx)));
    }
  } else if (J.stage === "write") {
    const left = await partsLeft(jobId, WRITE_KINDS), total = J.state?.nWrite || 0;
    await setJob(jobId, { progress: `${total - left} of ${total} sections written` });
    if (left === 0 && await claimStage(jobId, "write", "build", "Putting the report together")) { await addParts(jobId, [{ kind: "assemble", idx: 0 }]); await kick(jobId, "assemble", 0); }
  }
}

function cleanOpt(o: any) {
  return { key: o.key || "", name: o.name || "Option", subtitle: o.subtitle || "", warranty: o.warranty || "", timeline: o.timeline || "", scope: o.scope || "", lines: (o.lines || []).map((l: any) => ({ kind: l.kind === "Labor" ? "Labor" : "Materials", desc: l.desc || "", qty: +l.qty || 0, unit: l.unit || "", price: +l.price || 0 })) };
}
async function assemble(J: any) {
  const inp = J.input, st = J.state, C = st.C, PL = st.P || {};
  const lab = Object.fromEntries((inp.images || []).map((i: any) => [i.id, i.label]));
  const url = (id: string) => (id && lab[id] !== undefined ? `${PUB}/${J.id}/${id}.jpg` : "");
  const first = (inp.images || [])[0]?.id;
  const findings = C.findings.map((f: any) => ({ title: f.title || "Finding", category: f.category || "Roof", severity: f.severity || "Medium", description: f.description || "", img: url(f.image) || url(first), box: lab[f.image] !== undefined ? f.box : null, timeLabel: lab[f.image] || "" }));
  const leaks = C.leaks.map((l: any) => ({ location: l.location || "", condition: l.condition || "", observed: l.observed || "", significance: l.significance || "", img: url(l.image), box: lab[l.image] !== undefined ? l.box : null, timeLabel: lab[l.image] || "" }));
  const nf = findings.length;
  const phases = (PL.repair_phases || []).filter((p: any) => (p.findings || []).length && !/ongoing/i.test(p.name || ""));
  const { data: itemRows } = await db.from("ri_job_parts").select("idx,payload,result").eq("job_id", J.id).eq("kind", "diy_items").order("idx");
  let n = 0;
  const diyPhases = phases.map((ph: any, pi: number) => ({ name: ph.name, items: (itemRows || []).filter((r: any) => r.payload?.pi === pi).flatMap((r: any) => r.result?.items || []).map((x: any) => ({ ...x, title: `${++n}. ` + String(x.title || "Repair").replace(/^\s*\d+[.)]\s*/, ""), findings: (x.findings || []).filter((k: number) => k >= 1 && k <= nf) })) }));
  const estParts = await partResults(J.id, "estimate");
  const repairOn = inp.job?.repair === true;
  const ests = (inp.job.roofTypes || []).map((_: string, i: number) => { if (!repairOn) { const b = estParts[i] || {}; return { ...b, options: (b.options || []).slice(0, 1), compare_rows: [] }; } const a = estParts[i * 2] || {}, b = estParts[i * 2 + 1] || {}; return { ...a, options: [...(a.options || []).slice(0, 1), ...(b.options || []).slice(0, 1)] }; });
  const gParts = await partResults(J.id, "diy_guide"); const guide = { ...(gParts[0] || {}), ...(gParts[1] || {}) };
  const [note] = await partResults(J.id, "note");
  const [MS] = await partResults(J.id, "measure");
  const model = {
    v: 2, brand: inp.brand, job: inp.job, margin: inp.margin, references: inp.references || "", refs: inp.refs || [],
    cover: url(C.cover) || url(first), coverTitle: "Roof Report, Repair Plan & Proposals",
    source: inp.source || "", roof_system: C.roof_system || "", summary: Array.isArray(PL.summary) ? PL.summary : [PL.summary || ""],
    facts: Array.isArray(C.facts) ? C.facts : [], findings, leaks, other: C.other || [],
    leak_summary: PL.leak_summary || "", leak_next_steps: PL.leak_next_steps || [], limitations: PL.limitations || [],
    phases: (PL.repair_phases || []).map((p: any) => ({ name: p.name, covers: p.covers, when: p.when })),
    diy: { guide, phases: diyPhases },
    note: note || {},
    estimates: ests.map((e: any, i: number) => ({ roofType: inp.job.roofTypes[i], options: (e.options || []).map(cleanOpt), compare_rows: e.compare_rows || [], recommended: e.recommended || "", recommendation: Array.isArray(e.recommendation) ? e.recommendation : [e.recommendation || ""], quantities_note: e.quantities_note || "", assumptions: e.assumptions || [], exclusions: e.exclusions || [], payment: e.payment || "" })),
    terms: "50% deposit to schedule, balance due at substantial completion. Proposal valid for 30 days. Changes by written change order.",
    measure: MS?.summary ? { ...MS.summary, img: MS.img, check: MS.check || null } : { error: MS?.error || "No property address was given, so the roof wasn't measured from the air." },
    workPhotos: (inp.work || []).map((id: string) => ({ img: `${PUB}/${J.id}/${id}.jpg`, caption: "" })),
    createdAt: now(), madeWith: "Roofly", jobId: J.id,
  };
  const body = new Blob([JSON.stringify(stripConfirm(model))], { type: "application/json" });
  await db.storage.from(BUCKET).upload(`${J.id}/report.json`, body, { upsert: true, contentType: "application/json" });
  // save to the person's account
  let reportId: string | null = null;
  if (J.user_id) {
    const { data } = await db.from("ri_reports").insert({ user_id: J.user_id, address: (inp.job.address || "").slice(0, 300), client: (inp.job.client || "").slice(0, 200) }).select("id").single();
    if (data?.id) { reportId = data.id; await db.storage.from("ri-user").upload(`${J.user_id}/${reportId}.json`, new Blob([JSON.stringify({ ...stripConfirm(model), reportId })], { type: "application/json" }), { upsert: true, contentType: "application/json" }); }
  }
  await db.from("ri_jobs").update({ status: "done", stage: "done", progress: "Ready", report_id: reportId, updated_at: now() }).eq("id", J.id);
  await notify(J, nf);
  if (inp.job?.crm) await crmWriteback(J, model).catch(async (e) => { await db.from("ri_jobs").update({ error: "CRM: " + String(e).slice(0, 200) }).eq("id", J.id); });
  return { ok: true };
}
// JuicyCRM: when a report was started from a CRM job, put the report on that job
const CRM_URL = "https://wwqjoagdnclaylllzcut.supabase.co", CRM_KEY = "sb_publishable_AVIpI00DFiYwugP16-wMWQ_qENLObrc";
async function crmWriteback(J: any, m: any) {
  const tok = await secret("CRM_ROOFLY_TOKEN"); if (!tok || !/^[0-9a-f-]{36}$/.test(String(J.input.job.crm))) return;
  const sev: any = { Critical: "high", High: "high", Medium: "medium", Low: "low" };
  const a = m.estimates?.[0]?.options?.[0];
  const total = a ? Math.round(a.lines.reduce((s: number, l: any) => s + (l.qty || 0) * (l.price || 0), 0)) : null;
  const r = await fetch(`${CRM_URL}/rest/v1/rpc/roofly_report_ready`, { method: "POST", headers: { apikey: CRM_KEY, "Content-Type": "application/json" }, body: JSON.stringify({
    p_token: tok, p_job: J.input.job.crm, p_url: `${SITE}?job=${J.id}`, p_summary: (m.summary || []).join("\n\n"),
    p_findings: (m.findings || []).map((f: any) => ({ severity: sev[f.severity] || "medium", area: f.title, issue: f.description })),
    p_total: total, p_frames: (J.input.images || []).length, p_ref: J.id }) });
  const txt = (await r.text()).slice(0, 300);
  await db.from("ri_jobs").update({ progress: r.ok ? "Ready · added to JuicyCRM" : "Ready" , error: r.ok ? null : "CRM: " + txt }).eq("id", J.id);
}
async function notify(J: any, nf: number) {
  const to = String(J.notify_email || "").trim(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return;
  const key = await secret("RESEND_API_KEY"); if (!key) return;
  const link = `${SITE}?job=${J.id}`;
  const addr = J.input?.job?.address || "your roof";
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:auto;color:#2A2E2C"><h2 style="color:#0B2545">Your roof report is ready</h2><p>Roofly finished the report for <b>${addr.replace(/</g, "&lt;")}</b>: ${nf} findings, with a repair plan and proposals.</p><p><a href="${link}" style="display:inline-block;background:#0B2545;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:bold">Open the report</a></p><p style="color:#5F6763;font-size:13px">You can review and edit it, then download a PDF or share a link.</p></div>`;
  try { await fetch("https://api.resend.com/emails", { method: "POST", headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" }, body: JSON.stringify({ from: FROM, to: [to], subject: `Your roof report is ready: ${addr}`, html, text: `Your Roofly report is ready:\n${link}` }) }); } catch (_) {}
}

// re-run anything that stalled (called on every status check and every minute by the database)
async function watchdog(jobId?: string) {
  let q = db.from("ri_job_parts").select("job_id,kind,idx,status,started_at,updated_at,attempts").in("status", ["pending", "running", "error"]).lt("updated_at", new Date(Date.now() - 20_000).toISOString()).limit(50);
  if (jobId) q = q.eq("job_id", jobId);
  const { data } = await q;
  for (const p of data || []) {
    if (p.status === "running" && p.started_at && Date.now() - new Date(p.started_at).getTime() < STALE_MS) continue;
    await kick(p.job_id, p.kind, p.idx);
  }
  // a stage whose parts are all done but never advanced
  let jq = db.from("ri_jobs").select("id").eq("status", "running").lt("updated_at", new Date(Date.now() - 60_000).toISOString()).limit(20);
  if (jobId) jq = jq.eq("id", jobId);
  const { data: js } = await jq;
  for (const j of js || []) await advance(j.id);
}

async function userFrom(req: Request) {
  const t = (req.headers.get("x-user-token") || "").trim(); if (!t) return null;
  const { data } = await db.auth.getUser(t); return data?.user || null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return out({ error: "POST only" }, 405);
  let b: any = {}; try { b = await req.json(); } catch { return out({ error: "Bad request" }, 400); }
  const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "unknown";
  const a = b.action;

  if (a === "run" || a === "tick") {
    if (b.token !== await workerToken()) return out({ error: "no" }, 403);
    // @ts-ignore EdgeRuntime is provided by Supabase
    EdgeRuntime.waitUntil(a === "run" ? runPart(b.id, b.kind, b.idx) : watchdog());
    return out({ ok: true }, 202);
  }

  if (a === "create") {
    const monthStart = new Date(); monthStart.setUTCDate(1); monthStart.setUTCHours(0, 0, 0, 0);
    const { data: spent } = await db.from("ri_usage").select("cost_usd").gte("created_at", monthStart.toISOString());
    if ((spent || []).reduce((s: number, r: any) => s + Number(r.cost_usd || 0), 0) >= MONTHLY_CAP_USD) return out({ error: "CAP", message: "Roofly has reached its report limit for this month. Please check back on the 1st." }, 402);
    const { count } = await db.from("ri_jobs").select("id", { count: "exact", head: true }).eq("ip", ip).gte("created_at", new Date(Date.now() - 86400000).toISOString());
    if ((count || 0) >= JOBS_PER_IP_PER_DAY) return out({ error: "LIMIT", message: "You've made a lot of reports today. Please try again tomorrow." }, 429);
    const user = await userFrom(req);
    const input = b.input || {}; input.job = input.job || {}; input.job.roofTypes = (input.job.roofTypes || []).slice(0, 3).map(String);
    input.job.level = LEVEL_FINDINGS[input.job.level] ? input.job.level : "standard"; input.job.diy = input.job.diy === true; input.job.repair = input.job.repair === true;
    const { data, error } = await db.from("ri_jobs").insert({ ip, user_id: user?.id || null, notify_email: String(b.notify_email || "").slice(0, 200), input }).select("id").single();
    if (error) return out({ error: "DB", message: "Couldn't start the report. Please try again." }, 500);
    return out({ id: data.id });
  }

  if (a === "upload") {
    const J = await getJob(b.id); if (!J || J.status !== "uploading") return out({ error: "GONE", message: "This report upload expired. Please start again." }, 410);
    for (const im of (b.images || []).slice(0, 12)) {
      if (!/^[A-Z]\d{1,4}$/.test(im.id)) continue;
      const bytes = Uint8Array.from(atob(String(im.data).replace(/^data:image\/\w+;base64,/, "")), (c) => c.charCodeAt(0));
      const { error } = await db.storage.from(BUCKET).upload(`${b.id}/${im.id}.jpg`, bytes, { upsert: true, contentType: "image/jpeg" });
      if (error) return out({ error: "UPLOAD", message: "Upload hiccup. Retrying…" }, 502);
    }
    return out({ ok: true });
  }

  if (a === "start") {
    const J = await getJob(b.id); if (!J) return out({ error: "GONE", message: "Report not found." }, 404);
    if (J.status !== "uploading") return out({ ok: true });
    const images = (b.images || []).filter((i: any) => /^[A-Z]\d{1,4}$/.test(i.id)).slice(0, 1400);
    const work = (b.work || []).filter((id: string) => /^W\d{1,3}$/.test(id)).slice(0, 8);
    const input = { ...J.input, images, work, source: String(b.source || "").slice(0, 300) };
    const batches: any[] = [];
    for (let i = 0; i < images.length; i += BATCH) batches.push(images.slice(i, i + BATCH));
    if (!batches.length) return out({ error: "EMPTY", message: "No stills were uploaded." }, 400);
    await db.from("ri_jobs").update({ input, status: "running", stage: "vision", progress: `0 of ${batches.length} batches`, state: { nBatches: batches.length }, updated_at: now() }).eq("id", b.id);
    await addParts(b.id, batches.map((imgs, i) => ({ kind: "vision", idx: i, payload: { images: imgs, part: `batch ${i + 1} of ${batches.length}, ${imgs[0].label} to ${imgs[imgs.length - 1].label}` } })));
    await addParts(b.id, [{ kind: "measure", idx: 0 }]);
    // @ts-ignore
    EdgeRuntime.waitUntil(kick(b.id, "measure", 0));
    // start them a little apart so we don't hit the AI all at once
    // @ts-ignore
    EdgeRuntime.waitUntil((async () => { for (let i = 0; i < batches.length; i++) { await kick(b.id, "vision", i); if (i % 6 === 5) await new Promise((r) => setTimeout(r, 1500)); } })());
    return out({ ok: true, batches: batches.length });
  }

  if (a === "status") {
    const J = await getJob(b.id); if (!J) return out({ error: "GONE", message: "Report not found." }, 404);
    if (J.status === "running") {
      // @ts-ignore
      EdgeRuntime.waitUntil(watchdog(J.id));
    }
    return out({ status: J.status, stage: J.stage, progress: J.progress, error: J.error, report: J.status === "done" ? `${PUB}/${J.id}/report.json` : null, report_id: J.report_id, n: J.state?.nBatches || 0 });
  }

  return out({ error: "Unknown action" }, 400);
});
