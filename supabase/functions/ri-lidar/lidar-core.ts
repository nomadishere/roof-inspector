// Roofly LiDAR roof measurement: pure geometry, no Deno/Node APIs so it runs in an edge function and in tests.
// Local metres: x east, y north, z up; origin = the address / building centre that was asked for.
// Method (see 03-build/lidar-benchmark.md): keep single-return, locally flat points above ground -> the building
// nearest the address -> fit roof planes (pitch, area per face) -> square the outline along the main direction,
// grow it 0.5 m, and use its perimeter as the drip edge.
export type Cloud = { n: number; x: ArrayLike<number>; y: ArrayLike<number>; z: ArrayLike<number>; rn: ArrayLike<number>; nr: ArrayLike<number>; cl: ArrayLike<number> };
export const M2FT = 3.28084, M2FT2 = 10.7639;
const key = (ix: number, iy: number) => (ix + 2048) * 4096 + (iy + 2048);

class Grid {
  m = new Map<number, number[]>(); X: ArrayLike<number>; Y: ArrayLike<number>; cs: number;
  constructor(X: ArrayLike<number>, Y: ArrayLike<number>, idx: ArrayLike<number>, cs: number) {
    this.X = X; this.Y = Y; this.cs = cs;
    for (let k = 0; k < idx.length; k++) { const i = idx[k], kk = key(Math.floor(X[i] / cs), Math.floor(Y[i] / cs)); const a = this.m.get(kk); if (a) a.push(i); else this.m.set(kk, [i]); }
  }
  near(x: number, y: number, r: number, cb: (i: number) => void) {
    const cs = this.cs, r2 = r * r, x0 = Math.floor((x - r) / cs), x1 = Math.floor((x + r) / cs), y0 = Math.floor((y - r) / cs), y1 = Math.floor((y + r) / cs);
    for (let ix = x0; ix <= x1; ix++) for (let iy = y0; iy <= y1; iy++) { const a = this.m.get(key(ix, iy)); if (!a) continue; for (const i of a) { const dx = this.X[i] - x, dy = this.Y[i] - y; if (dx * dx + dy * dy <= r2) cb(i); } }
  }
}

// least-squares plane z = a x + b y + c through the listed points
function fitPlane(idx: ArrayLike<number>, X: ArrayLike<number>, Y: ArrayLike<number>, Z: ArrayLike<number>) {
  const n = idx.length; if (n < 3) return null;
  let mx = 0, my = 0, mz = 0; for (let k = 0; k < n; k++) { const i = idx[k]; mx += X[i]; my += Y[i]; mz += Z[i]; } mx /= n; my /= n; mz /= n;
  let sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0;
  for (let k = 0; k < n; k++) { const i = idx[k], dx = X[i] - mx, dy = Y[i] - my, dz = Z[i] - mz; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; sxz += dx * dz; syz += dy * dz; }
  const det = sxx * syy - sxy * sxy; if (det < 1e-6 * (sxx + syy + 1e-9) * (sxx + syy + 1e-9)) return null;
  const a = (sxz * syy - syz * sxy) / det, b = (syz * sxx - sxz * sxy) / det, c = mz - a * mx - b * my;
  let ss = 0; for (let k = 0; k < n; k++) { const i = idx[k], e = Z[i] - (a * X[i] + b * Y[i] + c); ss += e * e; }
  return { a, b, c, rms: Math.sqrt(ss / n), n };
}
const rng = (s: number) => () => { s |= 0; s = (s + 0x6d2b79f5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

// ground height under every point: mean of ground-classified points per 2 m cell, holes filled from neighbours
function heightAboveGround(c: Cloud) {
  const W = 50, cs = 2, N = (2 * W) / cs, sum = new Float64Array(N * N), cnt = new Float64Array(N * N);
  const ci = (v: number) => Math.max(0, Math.min(N - 1, Math.floor((v + W) / cs)));
  let ng = 0; for (let i = 0; i < c.n; i++) if (c.cl[i] === 2) { const k = ci(c.y[i]) * N + ci(c.x[i]); sum[k] += c.z[i]; cnt[k]++; ng++; }
  const g = new Float64Array(N * N).fill(NaN);
  if (ng < 30) { const zs = Array.from({ length: c.n }, (_, i) => c.z[i]).sort((a, b) => a - b); g.fill(zs[Math.floor(zs.length * 0.05)]); }
  else { for (let k = 0; k < N * N; k++) if (cnt[k]) g[k] = sum[k] / cnt[k];
    for (let it = 0; it < 40; it++) { let left = 0; const nx = g.slice();
      for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) { if (!isNaN(g[y * N + x])) continue; let s = 0, m = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= N || yy >= N) continue; const v = g[yy * N + xx]; if (!isNaN(v)) { s += v; m++; } }
        if (m) nx[y * N + x] = s / m; else left++; }
      g.set(nx); if (!left) break; } }
  const h = new Float32Array(c.n); for (let i = 0; i < c.n; i++) h[i] = c.z[i] - g[ci(c.y[i]) * N + ci(c.x[i])]; return h;
}

// ---- small raster helpers (square kernels, radius in cells) ----
const dil = (m: Uint8Array, W: number, H: number, r: number) => { const t = new Uint8Array(W * H), o = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (m[y * W + x]) for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < W) t[y * W + xx] = 1; }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (t[y * W + x]) for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < H) o[yy * W + x] = 1; } return o; };
const ero = (m: Uint8Array, W: number, H: number, r: number) => { const inv = m.map((v) => 1 - v) as Uint8Array; const d = dil(inv, W, H, r); return d.map((v) => 1 - v) as Uint8Array; };
const majority = (m: Uint8Array, W: number, H: number) => { const o = new Uint8Array(W * H); for (let y = 1; y < H - 1; y++) for (let x = 1; x < W - 1; x++) { let s = 0; for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) s += m[(y + dy) * W + x + dx]; o[y * W + x] = s >= 5 ? 1 : 0; } return o; };
function fillHoles(m: Uint8Array, W: number, H: number) { const out = new Uint8Array(W * H).fill(1), st: number[] = [];
  const push = (x: number, y: number) => { if (x < 0 || y < 0 || x >= W || y >= H) return; const k = y * W + x; if (m[k] || !out[k]) return; out[k] = 0; st.push(k); };
  for (let x = 0; x < W; x++) { push(x, 0); push(x, H - 1); } for (let y = 0; y < H; y++) { push(0, y); push(W - 1, y); }
  while (st.length) { const k = st.pop()!, x = k % W, y = (k / W) | 0; push(x + 1, y); push(x - 1, y); push(x, y + 1); push(x, y - 1); } return out; }
function largestBlob(m: Uint8Array, W: number, H: number) { const lab = new Int32Array(W * H); let best = 0, bestN = 0, id = 0;
  for (let s = 0; s < W * H; s++) { if (!m[s] || lab[s]) continue; id++; let n = 0; const st = [s]; lab[s] = id;
    while (st.length) { const k = st.pop()!; n++; const x = k % W, y = (k / W) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const kk = yy * W + xx; if (m[kk] && !lab[kk]) { lab[kk] = id; st.push(kk); } } }
    if (n > bestN) { bestN = n; best = id; } }
  return m.map((_, k) => (lab[k] === best ? 1 : 0)) as Uint8Array; }

function hullMinRectAngle(pts: number[][]) { // angle (rad) of the minimum-area rectangle around the points
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]); if (p.length < 3) return 0;
  const cr = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: number[][] = [], up: number[][] = [];
  for (const q of p) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (const q of p.slice().reverse()) { while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  const h = lo.slice(0, -1).concat(up.slice(0, -1)); let best = 0, ba = Infinity;
  for (let i = 0; i < h.length; i++) { const a = Math.atan2(h[(i + 1) % h.length][1] - h[i][1], h[(i + 1) % h.length][0] - h[i][0]), c = Math.cos(a), s = Math.sin(a);
    let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9; for (const q of h) { const u = q[0] * c + q[1] * s, v = -q[0] * s + q[1] * c; u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v); }
    const ar = (u1 - u0) * (v1 - v0); if (ar < ba) { ba = ar; best = a; } }
  return best;
}

const FACING = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
export type Face = { n: number; pitch: number; tiltDeg: number; azimuth: number; facing: string; planFt2: number; areaFt2: number; points: number; rms: number; flat: boolean };
export type LidarResult = {
  ok: boolean; reason?: string;
  roof?: { areaFt2: number; planFt2: number; squares: number; dripEdgeFt: number; eaveFt: number; rakeFt: number; edgeFt: number; mainPitch: number };
  faces?: Face[]; outline?: number[][]; // outline polygon in local metres (x east, y north)
  density?: number; coverage?: number; direction?: number; buildingPts?: number; otherBuildings?: number;
  debug?: { planes: { a: number; b: number; c: number; idx: number[] }[]; kept: number[]; comp: number[] };
};

export function analyze(c: Cloud, opt: { debug?: boolean; clip?: number[][]; margin?: number } = {}): LidarResult {
  const { n, x: X, y: Y, z: Z } = c;
  const h = heightAboveGround(c);
  // 1. candidate roof points: single return, 2 m to 15 m above ground, not ground / noise
  const cand: number[] = [];
  for (let i = 0; i < n; i++) if (c.cl[i] !== 2 && c.cl[i] !== 7 && c.cl[i] !== 18 && c.nr[i] === 1 && h[i] >= 2 && h[i] <= 15) cand.push(i);
  // optional clip: polygon in local metres (the roof outline traced on the photo), grown by `margin`. Neighbour roofs that touch the building but lie outside it are dropped.
  if (opt.clip && opt.clip.length >= 3) { const P = opt.clip, mg = opt.margin ?? 1.5;
    const inside = (x: number, y: number) => { let ins = false; for (let a = 0, b = P.length - 1; a < P.length; b = a++) { if ((P[a][1] > y) !== (P[b][1] > y) && x < ((P[b][0] - P[a][0]) * (y - P[a][1])) / (P[b][1] - P[a][1]) + P[a][0]) ins = !ins; } return ins; };
    const dist = (x: number, y: number) => { let d = Infinity; for (let a = 0, b = P.length - 1; a < P.length; b = a++) { const dx = P[b][0] - P[a][0], dy = P[b][1] - P[a][1], L = dx * dx + dy * dy, t = L ? Math.max(0, Math.min(1, ((x - P[a][0]) * dx + (y - P[a][1]) * dy) / L)) : 0; d = Math.min(d, Math.hypot(x - (P[a][0] + t * dx), y - (P[a][1] + t * dy))); } return d; };
    for (let q = cand.length - 1; q >= 0; q--) { const i = cand[q]; if (!inside(X[i], Y[i]) && dist(X[i], Y[i]) > mg) cand.splice(q, 1); } }
  if (cand.length < 30) return { ok: false, reason: "No building-height points found at this address." };
  // 2. keep points whose neighbourhood is a flat plane (drops trees, ridges and edges)
  const gc = new Grid(X, Y, cand, 2);
  const kept: number[] = [];
  for (const i of cand) { const nb: number[] = []; gc.near(X[i], Y[i], 1.1, (j) => nb.push(j)); if (nb.length < 6) continue;
    const f = fitPlane(nb, X, Y, Z); if (f && f.rms < 0.09 && Math.hypot(f.a, f.b) < 1.8) kept.push(i); }
  if (kept.length < 25) return { ok: false, reason: "Not enough clean roof points (trees or very sparse LiDAR)." };
  // 3. buildings = connected groups of kept points; take the one nearest the address
  const gk = new Grid(X, Y, kept, 2), comp = new Map<number, number>(); let nc = 0; const groups: number[][] = [];
  for (const s of kept) { if (comp.has(s)) continue; const id = nc++, g: number[] = [s]; comp.set(s, id);
    for (let q = 0; q < g.length; q++) { const i = g[q]; gk.near(X[i], Y[i], 2.0, (j) => { if (!comp.has(j)) { comp.set(j, id); g.push(j); } }); } groups.push(g); }
  let pick = -1, pd = Infinity; const big = groups.filter((g) => g.length >= 30).length;
  groups.forEach((g, gi) => { if (g.length < 30) return; let d = Infinity; for (const i of g) d = Math.min(d, Math.hypot(X[i], Y[i])); if (d < pd) { pd = d; pick = gi; } });
  if (pick < 0 || pd > 25) return { ok: false, reason: "No building found near this address in the LiDAR." };
  const B = groups[pick];
  // 4. roof planes: sequential RANSAC inside the building group
  const gb = new Grid(X, Y, B, 2.5), rand = rng(7); let rest = B.slice(); const planes: { a: number; b: number; c: number; idx: number[]; rms: number }[] = []; let fails = 0;
  while (rest.length >= 12 && planes.length < 14 && fails < 4) {
    const inRest = new Set(rest); let best: number[] = [], bp: any = null;
    for (let t = 0; t < 350; t++) {
      const i = rest[Math.floor(rand() * rest.length)], nb: number[] = []; gb.near(X[i], Y[i], 2.5, (j) => { if (inRest.has(j) && j !== i) nb.push(j); }); if (nb.length < 4) continue;
      const j = nb[Math.floor(rand() * nb.length)], k = nb[Math.floor(rand() * nb.length)]; if (j === k) continue;
      const ux = X[j] - X[i], uy = Y[j] - Y[i], uz = Z[j] - Z[i], vx = X[k] - X[i], vy = Y[k] - Y[i], vz = Z[k] - Z[i];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx; if (Math.abs(nz) < 0.25 * Math.hypot(nx, ny, nz)) continue;
      const a = -nx / nz, b = -ny / nz, cc = Z[i] - a * X[i] - b * Y[i], sl = Math.hypot(a, b); if (sl > 1.9) continue;
      const den = Math.sqrt(1 + a * a + b * b), inl: number[] = []; for (const q of rest) if (Math.abs(Z[q] - (a * X[q] + b * Y[q] + cc)) / den < 0.07) inl.push(q);
      if (inl.length > best.length) { best = inl; bp = { a, b, cc }; } }
    if (!bp || best.length < 12) { fails++; continue; }
    let f = fitPlane(best, X, Y, Z)!; let den = Math.sqrt(1 + f.a * f.a + f.b * f.b), inl: number[] = []; for (const q of rest) if (Math.abs(Z[q] - (f.a * X[q] + f.b * Y[q] + f.c)) / den < 0.08) inl.push(q);
    // keep the connected piece around the best seed
    const sg = new Grid(X, Y, inl, 2), seen = new Set<number>([inl[0]]), grp = [inl[0]]; for (let q = 0; q < grp.length; q++) { const i = grp[q]; sg.near(X[i], Y[i], 2.0, (j) => { if (!seen.has(j)) { seen.add(j); grp.push(j); } }); }
    const g2 = new Set<number>(); // the largest connected piece
    { const left = new Set(inl); let bestG: number[] = []; while (left.size) { const s0 = left.values().next().value as number; const gg = [s0]; left.delete(s0); for (let q = 0; q < gg.length; q++) { const i = gg[q]; sg.near(X[i], Y[i], 2.0, (j) => { if (left.has(j)) { left.delete(j); gg.push(j); } }); } if (gg.length > bestG.length) bestG = gg; } bestG.forEach((v) => g2.add(v)); }
    const fin = Array.from(g2); f = fitPlane(fin, X, Y, Z)!;
    if (!f || fin.length < 12 || f.rms > 0.09) { fails++; const drop = new Set(best.slice(0, 3)); rest = rest.filter((q) => !drop.has(q)); continue; }
    planes.push({ a: f.a, b: f.b, c: f.c, idx: fin, rms: f.rms }); rest = rest.filter((q) => !g2.has(q)); fails = 0; }
  if (!planes.length) return { ok: false, reason: "Couldn't fit roof planes to the LiDAR points." };
  // 5. footprint points = plane points + nearby single-return points at roof height (ridge / valley bands the flatness test dropped)
  const pl = new Uint16Array(n).fill(0); planes.forEach((p, k) => p.idx.forEach((i) => (pl[i] = k + 1)));
  const gp = new Grid(X, Y, planes.flatMap((p) => p.idx), 2); const foot = new Set<number>(planes.flatMap((p) => p.idx));
  for (const i of cand) { if (foot.has(i)) continue; let ok = false; gp.near(X[i], Y[i], 1.3, (j) => { if (!ok && Math.abs(Z[j] - Z[i]) < 1.3) ok = true; }); if (ok) foot.add(i); }
  const fp = Array.from(foot);
  // 6. main direction of the building (ridge / eave direction), from face azimuths; flat roofs use the minimum-area rectangle
  let sc = 0, ss = 0, sw = 0; for (const p of planes) { const sl = Math.hypot(p.a, p.b); if (sl < 0.12) continue; const phi = Math.atan2(-p.b, -p.a) + Math.PI / 2; sc += p.idx.length * Math.cos(4 * phi); ss += p.idx.length * Math.sin(4 * phi); sw += p.idx.length; }
  const hullA = hullMinRectAngle(fp.map((i) => [X[i], Y[i]])); const dir = sw > 0 && Math.hypot(sc, ss) / sw > 0.35 ? Math.atan2(ss, sc) / 4 : hullA;
  const cd = Math.cos(dir), sd = Math.sin(dir);
  // 7. squared outline: raster in the rotated frame (0.5 m cells), close gaps, fill holes, smooth, grow 0.5 m
  const CS = 0.5; let u0 = 1e9, u1 = -1e9, v0 = 1e9, v1 = -1e9; const U = (i: number) => X[i] * cd + Y[i] * sd, V = (i: number) => -X[i] * sd + Y[i] * cd;
  for (const i of fp) { u0 = Math.min(u0, U(i)); u1 = Math.max(u1, U(i)); v0 = Math.min(v0, V(i)); v1 = Math.max(v1, V(i)); }
  u0 -= 5; v0 -= 5; const W = Math.ceil((u1 - u0 + 5) / CS), H = Math.ceil((v1 - v0 + 5) / CS); let m = new Uint8Array(W * H);
  for (const i of fp) m[Math.floor((V(i) - v0) / CS) * W + Math.floor((U(i) - u0) / CS)] = 1;
  m = ero(dil(m, W, H, 2), W, H, 2); m = fillHoles(m, W, H); m = majority(majority(m, W, H), W, H); m = largestBlob(m, W, H); const m0 = m.slice(); m = dil(m, W, H, 1); // m0 = where the laser hit; m = grown 0.5 m (drip edge only)
  // 8. label every outline cell with its roof face (nearest plane points), then area per face
  const lab = new Int16Array(W * H).fill(-1), q: number[] = [];
  for (const i of fp) { if (!pl[i]) continue; const k = Math.floor((V(i) - v0) / CS) * W + Math.floor((U(i) - u0) / CS); if (m[k] && lab[k] < 0) { lab[k] = pl[i] - 1; q.push(k); } }
  for (let s = 0; s < q.length; s++) { const k = q[s], x = k % W, y = (k / W) | 0; for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue; const kk = yy * W + xx; if (m[kk] && lab[kk] < 0) { lab[kk] = lab[k]; q.push(kk); } } }
  // roof AREA comes from the un-grown outline (matches EagleView within ~5-9%); only the drip-edge length uses the grown one
  const plan = new Float64Array(planes.length); let cells = 0, cells0 = 0; for (let k = 0; k < W * H; k++) if (m[k]) { cells++; if (m0[k]) { cells0++; if (lab[k] >= 0) plan[lab[k]] += CS * CS; } }
  const faces: Face[] = planes.map((p, k) => { const sl = Math.hypot(p.a, p.b), tilt = Math.atan(sl), az = ((Math.atan2(-p.a, -p.b) * 180) / Math.PI + 360) % 360, flat = sl < 1 / 12;
    return { n: k + 1, pitch: Math.round(sl * 12 * 10) / 10, tiltDeg: (tilt * 180) / Math.PI, azimuth: Math.round(az), facing: flat ? "flat" : FACING[Math.round(az / 45) % 8], planFt2: plan[k] * M2FT2, areaFt2: (plan[k] / Math.cos(tilt)) * M2FT2, points: p.idx.length, rms: p.rms, flat }; })
    .filter((f) => f.planFt2 > 8).sort((a, b) => b.areaFt2 - a.areaFt2).map((f, i) => ({ ...f, n: i + 1 }));
  // 9. outline perimeter split by what the face above it does (eave = slopes down off the edge, rake = runs up the slope)
  let eave = 0, rake = 0, edgeFlat = 0; const segs: number[][] = [];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const k = y * W + x; if (!m[k]) continue; const cell = lab[k] >= 0 ? planes[lab[k]] : null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H && m[yy * W + xx]) continue;
      if (!cell) { rake += CS; continue; } const sl = Math.hypot(cell.a, cell.b); if (sl < 1 / 12) { edgeFlat += CS; continue; }
      // outward normal in rotated frame -> world; downslope direction is (-a,-b)
      const nxw = dx * cd - dy * sd, nyw = dx * sd + dy * cd, dot = (-cell.a * nxw - cell.b * nyw) / sl; if (dot > 0.5) eave += CS; else rake += CS; } }
  // outline polygon (outer boundary) for drawing
  const edges = new Map<string, number[]>(); const P = (x: number, y: number) => x + "," + y;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { if (!m[y * W + x]) continue;
    if (y === 0 || !m[(y - 1) * W + x]) edges.set(P(x, y), [x + 1, y]); if (x === W - 1 || !m[y * W + x + 1]) edges.set(P(x + 1, y), [x + 1, y + 1]);
    if (y === H - 1 || !m[(y + 1) * W + x]) edges.set(P(x + 1, y + 1), [x, y + 1]); if (x === 0 || !m[y * W + x - 1]) edges.set(P(x, y + 1), [x, y]); }
  let loop: number[][] = []; { const seen = new Set<string>(); let bestL: number[][] = [];
    for (const k0 of edges.keys()) { if (seen.has(k0)) continue; const L: number[][] = []; let k = k0; while (edges.has(k) && !seen.has(k)) { seen.add(k); const [px, py] = k.split(",").map(Number); L.push([px, py]); const nx = edges.get(k)!; k = P(nx[0], nx[1]); } if (L.length > bestL.length) bestL = L; } loop = bestL; }
  const simp = loop.filter((p, i) => { const a = loop[(i + loop.length - 1) % loop.length], b = loop[(i + 1) % loop.length]; return (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]) !== 0; });
  const outline = simp.map(([gx, gy]) => { const u = u0 + gx * CS, v = v0 + gy * CS; return [Math.round((u * cd - v * sd) * 100) / 100, Math.round((u * sd + v * cd) * 100) / 100]; });
  const areaFt2 = faces.reduce((s, f) => s + f.areaFt2, 0) || cells0 * CS * CS * M2FT2, planFt2 = cells0 * CS * CS * M2FT2;
  // main pitch = area-weighted most common pitch (rounded to 1/12)
  const pb = new Map<number, number>(); faces.forEach((f) => pb.set(Math.round(f.pitch), (pb.get(Math.round(f.pitch)) || 0) + f.areaFt2)); let mp = 0, mw = -1; pb.forEach((w, p) => { if (w > mw) { mw = w; mp = p; } });
  const covered = fp.filter((i) => pl[i]).length / fp.length;
  return { ok: true, faces, outline, direction: (dir * 180) / Math.PI, buildingPts: B.length, otherBuildings: big - 1, coverage: covered, density: fp.length / (cells * CS * CS),
    roof: { areaFt2, planFt2, squares: areaFt2 / 100, dripEdgeFt: (eave + rake + edgeFlat) * M2FT, eaveFt: eave * M2FT, rakeFt: rake * M2FT, edgeFt: edgeFlat * M2FT, mainPitch: mp },
    debug: opt.debug ? { planes: planes.map((p) => ({ a: p.a, b: p.b, c: p.c, idx: p.idx })), kept, comp: B } : undefined };
}
