// Shared Lucky Line method + prompts (copied from ri-report so both stay identical).
export const MODEL = "claude-opus-5-5";
export const PRICE_IN = 4 / 1_000_000;
export const PRICE_OUT = 20 / 1_000_000;
export const MAX_OUT = 32000;
export const METHOD = `You work for a roofing company that produces the best inspection reports in the industry. House method (follow it exactly):
- Voice: plain, honest and neighborly. Short sentences, no hype, no sales pressure. Explain WHY each item matters. Lead with helping the owner even if they never hire anyone. Advice is always free.
- Scope (Justin's rule, Nov 7 2026): this is a ROOF inspection and roof proposal. Findings, repair steps and prices cover only the roof and the water path where the roof meets the building: the roof surface, ridges/hips/valleys, every flashing (walls, chimneys, skylights, curbs, step, kick-out, headwall), penetrations and vents, edges/drip edge/fascia and eave edge, soffit and attic ventilation, a gutter only when it is pulled away, sagging or leaving a gap at the roof edge, roof drains and scuppers, and interior water stains. Anything else on the building (siding, paint, windows and sills, doors, trim away from the roof edge, foundation, decks, landscaping) is NOT a finding and is never priced or put in the repair plan; at most it is a one-line "other thing we noticed".
- Focus (Justin's rule, Nov 9 2026): the report is client-ready and simple. List only real roof problems that a roofer would actually repair or replace: worn, curled, lifted, cracked, torn or patched shingles or panels, granule loss, exposed nails, poor or missing flashing, missing drip edge, open or unsealed penetrations, gaps at the roof edge, and active water entry. Do NOT list: leaves or debris in gutters, tree branches or limbs (hanging, touching or overhanging), downspout routing, rust, rust streaks or cosmetic staining on vents, pipes, flashing or metal, paint, or anything that is maintenance housekeeping and not a roof repair. Never mention these anywhere, not even as "other things we noticed". When unsure whether something is a real problem, leave it out. Never invent problems.
- Tone (Justin's rule): honest and calm. No scare tactics, no worst-case language, no "likely leak" or "will rot" unless the footage shows water entry. Say what you see, why it matters in plain words, and what the fix is. Do not pad: one problem, one finding.
- Priorities: Critical = active failure, water is likely getting in now. High = likely leak source if not fixed soon. Medium = wear or weakness to fix in the normal course. Low = minor, monitor.
- Categories for low-slope roofs: Parapet & Coping, Transitions & Edges, Field Membrane, Penetrations, Curbs & Equipment, Drainage, Water Evidence. For steep-slope (shingle/metal): Field (Shingles/Panels), Ridge & Hips, Valleys, Flashing & Walls, Penetrations, Edges & Gutters, Ventilation, Water Evidence. Use whichever fits; add one if truly needed.
- Client-facing text never contains "(confirm)", "to confirm", "style to confirm", "age: confirm" or similar notes to the inspector. If you are not sure of something (age, layers, size, exact product), say "about", "appears" or "looks like", or leave it out. Those details are entered later by the inspector in the CRM.
- Return ONLY valid JSON. No markdown fences, no commentary.`;

export const jobText = (job: any) => `Job:
- Property: ${job.address || "not given"}
- Client/owner: ${job.client || "not given"}
- Roof type(s) the inspector checked: ${(job.roofTypes || []).join(", ") || "not given"}
- Inspector notes: ${job.notes || "none"}
- Company: ${job.company || "the inspector's company"}`;

export function visionPrompt(job: any, list: string, part: string) {
  return `${METHOD}

${jobText(job)}

These images are stills from the inspector's walkthrough video(s), taken every second, plus any photos (${part}). Each image is preceded by its ID and source, e.g. "F12 — Video 0:25" or "P3 — Photo 3". IDs in this batch: ${list}.

Find every problem visible in THIS batch: open joints, separated or open coping, cracked or spalling caps, split/peeling flashing, open or lifted seams, punctures, patches, failing sealant/mastic, unsealed penetrations, curb problems, ponding, water tracks, damaged shingles/panels, flashing, valleys, a gutter pulled away from the roof edge, interior ceiling stains, etc. Skip anything the Focus rule excludes (gutter debris, tree limbs, rust, downspouts). If the same problem shows in several frames, report it once using the frame that shows it best. For each, give a tight bounding box [x, y, width, height] as 0-1 fractions from the top-left of THAT image.

Interior water evidence (ceiling stains, tiles, drips) goes in "leaks", not "findings".
Problems that are NOT roof or water-path items (see Scope: siding, paint, windows, sills, trim away from the roof, foundation, decks) go ONLY in "other_notes" as one short plain sentence each, never in "findings". Items the Focus rule excludes (tree limbs, gutter debris, rust, downspouts) are left out entirely, including from "other_notes".

JSON shape:
{"findings":[{"image":"F12","box":[0.4,0.3,0.2,0.15],"title":"Open gap under metal coping","category":"Parapet & Coping","severity":"High","description":"2-3 sentences: what you see, where, and why it matters."}],
 "leaks":[{"image":"F3","box":[0.3,0.2,0.2,0.2],"location":"Main hall, near entrance","observed":"what the stain looks like","significance":"what it tells us about the source"}],
 "other_notes":["Peeling paint on the lower window sill on the front bay (not roof work)."],
 "cover_candidates":[{"image":"F1","why":"clear straight-on view of the whole building"}],
 "facts_seen":"short notes on roof system, materials, layers, age clues, size clues, drainage, building type"}`;
}

export function consolidatePrompt(job: any, batches: any) {
  return `${METHOD}

${jobText(job)}

Below is every raw finding and interior leak reported by several batches of video stills (each batch looked at a different stretch of the video, in order). Each has an ID like "R12" (finding) or "L3" (leak). Merge them into ONE inspection:
- Remove duplicates (the same problem seen in two batches or two frames): keep the one with the better description in "use", list the others in "also".
- Keep EVERY distinct problem. Do not drop real items to shorten the list.
- Keep walkthrough order (video time).
- Set final priorities consistently across the whole roof. Only give a "title" if the kept title needs fixing.

Raw items:
${JSON.stringify(batches)}

JSON shape (compact; do not rewrite descriptions):
{"cover":"<best image ID for the cover from cover_candidates: clean, straight-on, whole building>",
 "roof_system":"one line, e.g. 'White single-ply membrane (exact type unknown), concrete parapets with metal coping on some sections'",
 "facts":[{"label":"Roof system","value":"..."},{"label":"Drainage","value":"..."}],
 "size_squares": <number or null>,
 "findings":[{"use":"R12","also":["R40"],"severity":"Critical|High|Medium|Low"}],
 "leaks":[{"use":"L1","also":[],"condition":"short label, e.g. 'Heavy staining'"}]}`;
}

export function planPrompt(job: any, c: any) {
  return `${METHOD}

${jobText(job)}
Roof system: ${c.roof_system}
Facts: ${JSON.stringify(c.facts)}
Final findings (numbered, walkthrough order): ${JSON.stringify(c.findings)}
Interior leaks: ${JSON.stringify(c.leaks)}

Write the inspection's summary, leak report text, repair plan phases and limitations.
JSON shape:
{"summary":["paragraph 1: how many locations, where problems are concentrated, the big patterns, which items look like active leaks (cite #numbers)","paragraph 2: how this ties to interior evidence / prior repairs / climate / what it means and what to do first"],
 "leak_summary":"paragraph for the interior leak report (empty string if no leaks)",
 "leak_next_steps":["..."],
 "repair_phases":[{"name":"Phase 1: Stop Active Leaks","covers":"what it covers","when":"Next dry day above 40°F","findings":[1,2,5]},{"name":"Phase 2: ...","covers":"...","when":"...","findings":[...]},{"name":"Phase 3: ...","covers":"...","when":"...","findings":[...]},{"name":"Ongoing care","covers":"Twice-a-year inspection and cleaning","when":"Every spring and fall","findings":[]}],
 "limitations":["what the video could not show", "what needs field verification (measurements, deck, insulation, drains)", "..."]}
Every finding number must appear in exactly one repair phase (except Ongoing care).`;
}

export function diyGuidePrompt(job: any, c: any) {
  return `${METHOD}

${jobText(job)}
Roof system: ${c.roof_system}
Findings: ${JSON.stringify((c.findings || []).map((f: any, i: number) => ({ n: i + 1, title: f.title, category: f.category, severity: f.severity })))}
Repair phases: ${JSON.stringify(c.repair_phases)}

Write the general sections of a FREE DIY Roof Repair Plan the owner can use with anyone (themselves, a handy friend, or another contractor). It must be genuinely useful and specific to THIS roof system and climate (${job.address || "Montana"}).

JSON shape:
{"intro":"one paragraph: how this plan relates to the inspection report and how to use it",
 "safety":["Never work alone...","Watch the edges...", "... (6-9 specific rules for this roof)"],
 "material_rule":{"title":"The Most Important Material Rule","paragraphs":["e.g. for single-ply: only use products made for that membrane; asphalt products ruin it", "..."]},
 "weather_window":"paragraph: temperature, dry-surface and seasonal rules for the products involved",
 "shopping_list":[{"item":"...","used_for":"...","qty":"approx. quantity"}],
 "basic_method":{"title":"The Basic ... Method","intro":"used in many of the repairs below","need":["..."],"steps":["..."]},
 "maintenance":["twice-a-year checks specific to this roof"],
 "winter":["if winter arrives before you finish ..."],
 "call_pro":"paragraph: when to stop and bring in a professional",
 "disclaimer":"one sentence: general guidance based on a video inspection; conditions may differ; work at your own risk; follow product instructions."}`;
}

export function diyItemsPrompt(job: any, c: any) {
  return `${METHOD}

${jobText(job)}
Roof system: ${c.roof_system}
Findings (numbered): ${JSON.stringify((c.findings || []).map((f: any, i: number) => ({ n: i + 1, title: f.title, category: f.category, severity: f.severity, description: f.description })))}
This phase of the repair plan: ${JSON.stringify(c.phase)}
(Whole plan, for context: ${JSON.stringify((c.repair_phases || []).map((p: any) => p.name))})

Write the repair items for THIS PHASE ONLY of the FREE DIY Roof Repair Plan, covering the finding numbers listed in this phase. Group closely related findings into one repair item where a person would fix them together. Every finding number of this phase appears in at least one item. Number items starting at ${c.startAt || 1}. Each item is complete enough that a careful, handy person could actually do the repair.

JSON shape:
{"items":[{"title":"${c.startAt || 1}. Roof-to-roof transitions","findings":[13,22],"difficulty":"Easy|Moderate|Advanced|Pro only","why":"1-2 sentences: what is wrong and why it lets water in","need":["each tool or material"],"steps":["clear, specific numbered steps"],"call_pro_if":"..."}]}`;
}

export function estimatePrompt(job: any, c: any, roofType: string) {
  return `${METHOD}

You are also the company's estimator. Use current typical contractor COST for materials and labor in ${job.address || "Montana, USA"} (no overhead or profit; that is added separately).
${jobText(job)}
Roof system found: ${c.roof_system}
Approx. size: ${c.size_squares ? c.size_squares + " squares" : "estimate from what you know"}
${c.measuredFor ? c.measuredFor(roofType) : ""}
${c.measuredFor && /^MEASURED/.test(c.measuredFor(roofType)) ? `USE THE AERIAL MEASUREMENTS ABOVE: Option B materials lines must use exactly these quantities (shingles/panels/membrane, underlayment, ice & water, drip edge, starter, ridge cap, valley metal, flashing, boots) and tear-off/install labor by these squares. Option A uses the measured lengths wherever a repair runs along an edge, ridge, valley or wall. Do not mark measured quantities as unconfirmed; quantities_note says they come from aerial measurements and will be field-verified.` : ""}
Facts: ${JSON.stringify(c.facts)}
Findings: ${JSON.stringify((c.findings || []).map((f: any, i: number) => ({ n: i + 1, title: f.title, category: f.category, severity: f.severity })))}
Interior leaks: ${(c.leaks || []).length}

Build two proposals for a ${roofType} system:
- Option A — Comprehensive Repair: repair every finding, bringing the existing roof back to watertight.
- Option B — Full Replacement: complete tear-off (or recover if appropriate, say which) and a new ${roofType} system with all flashings, edge metal, penetrations, insulation/underlayment as appropriate, disposal, permits.
Every line is either Materials or Labor. Be detailed and realistic (8-24 lines per option). Quantities you are unsure of are written as approximate ("about 40 ft"), never with "(confirm)".

JSON shape:
{"options":[
  {"key":"A","name":"Option A: Comprehensive Roof Repair","subtitle":"Repair and seal all N documented leak locations on the existing roof","scope":"1-2 sentences","lines":[{"kind":"Materials","desc":"...","qty":12,"unit":"LF","price":4.5},{"kind":"Labor","desc":"...","qty":16,"unit":"hrs","price":85}],"warranty":"what warranty is reasonable","timeline":"e.g. 3-4 working days, weather permitting"},
  {"key":"B","name":"Option B: Full Roof Replacement","subtitle":"...","scope":"...","lines":[...],"warranty":"...","timeline":"..."}],
 "compare_rows":[{"label":"Addresses all N findings","a":"Yes","b":"Yes"},{"label":"Flashing","a":"...","b":"..."},{"label":"Membrane / roofing","a":"...","b":"..."},{"label":"Edges / coping","a":"...","b":"..."},{"label":"Insulation / underlayment","a":"...","b":"..."},{"label":"Expected service life","a":"...","b":"..."},{"label":"Workmanship warranty","a":"...","b":"..."},{"label":"Manufacturer warranty","a":"...","b":"..."}],
 "recommended":"A or B",
 "recommendation":["paragraph: which option we recommend and why, honestly, for THIS roof","paragraph: what the other option is good for"],
 "quantities_note":"one sentence: quantities are from the video walkthrough and will be field-measured before the final contract",
 "assumptions":["..."],
 "exclusions":["..."],
 "payment":"e.g. 50% deposit to schedule, balance due at substantial completion. Proposal valid for 30 days. Changes by written change order."}`;
}

export function notePrompt(job: any, c: any) {
  return `${METHOD}

${jobText(job)}
Inspection summary: ${JSON.stringify(c.summary)}
Number of findings: ${(c.findings || []).length}; interior leak locations: ${(c.leaks || []).length}

Write "A Note From Us" for the front of the report package: a warm, honest, personal letter from the company to ${job.client || "the owner"}. Say the most valuable thing we can offer is honest information, freely given; whether or not they choose us, we want the roof fixed; the repair plan is theirs to keep, no strings attached; they can use it themselves, hand it to a contractor, or give it to someone handy; if they get stuck, call us, advice is always free. Mention the property naturally. 120-200 words. If the inspector notes mention something personal about the client or the community, weave it in sincerely.
JSON shape: {"salutation":"Melody,","body":["paragraph", "..."],"signoff":"With gratitude,"}`;
}

export async function callClaude(content: any[], maxTokens: number) {
  const key = Deno.env.get("ANTHROPIC_API_KEY");
  if (!key) throw new Error("NO_KEY");
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: maxTokens, messages: [{ role: "user", content }] }),
    });
    if (r.status === 429 || r.status === 529 || r.status >= 500) { await new Promise((s) => setTimeout(s, 2000 * (attempt + 1))); continue; }
    const data = await r.json();
    if (!r.ok) throw new Error("AI_ERROR: " + (data?.error?.message || r.status));
    const text = (data.content || []).filter((b: any) => b.type === "text").map((b: any) => b.text).join("");
    return { text, usage: data.usage || {}, stop: data.stop_reason };
  }
  throw new Error("AI_BUSY");
}

export function parseJSON(text: string) {
  const s = text.indexOf("{"), e = text.lastIndexOf("}");
  return JSON.parse(text.slice(s, e + 1));
}

