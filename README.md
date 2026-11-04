# Roof Inspector

Public tool: upload a roof video (plus optional photos), your logo, color and font, and get a branded roof inspection report in the Lucky Line package layout — cover, note, contents, findings with photos circled in red and captioned with the video time, interior leak report, DIY repair plan, materials + labor estimate (with or without profit margin), recommendation, acceptance page. Review and edit in the browser, then download a PDF or share a link.

## How it works
- **Front end** (this repo, static, GitHub Pages): `index.html`, `view.html` (shared reports), `js/`, `css/`.
- **Frames are pulled in the browser** — the video never leaves the user's phone. Pass 1: ~1 frame/sec scan (max 56 stills). Pass 2: frames every 0.5 s around each problem at full res; the sharpest is kept and circled.
- **Backend** (Supabase project `stars-and-shade`, everything prefixed `ri`):
  - `ri-analyze` edge function — calls Claude (Sonnet 5.5) for vision / DIY plan / estimate per roof type. Holds the Anthropic key (secret `ANTHROPIC_API_KEY`).
  - `ri-share` edge function — signed upload URL for share links. Reports stored in public bucket `ri-reports` under unguessable ids.
  - `ri_usage` table — every AI call's tokens + cost.

## Cost guards
- **$50/month cap** (`MONTHLY_CAP_USD` in `ri-analyze`). When hit, users see a friendly "limit reached this month" message.
- 40 AI calls per visitor IP per day (~8 reports); 30 share links per IP per day.
- A report costs roughly $0.15–$0.35 in AI (≈25–40k input tokens, ≈8–10k output at $2/$10 per million).

Check spend: `select date_trunc('day',created_at) d, count(*), sum(cost_usd) from ri_usage group by 1 order by 1 desc;`

## Limits to watch before going public
| Piece | Today | When hit | Next step |
|---|---|---|---|
| Supabase Free (shared with Stars & Shade) | pauses after 7 days idle; 1 GB storage; 500k function calls | site AI/share stops | Pro $25/mo org (+~$10/mo per extra project) |
| Edge function time | ~150 s per call on Free | very long videos may time out | calls are split; Pro raises limit |
| GitHub Pages | 100 GB/mo bandwidth, not for commercial use | | move to Cloudflare Pages when charging |
| AI spend | $50/mo cap | users see limit message | raise cap or add paid plans |
