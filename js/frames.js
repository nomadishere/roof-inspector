// Pulls stills from videos right in the browser (the video never leaves the phone).
// Pass 1: about 1 frame per second to scan. Pass 2: every 0.5 s around each problem, keep the sharpest.

export const fmtTime = (t) => { t = Math.max(0, Math.round(t)); return Math.floor(t / 60) + ":" + String(t % 60).padStart(2, "0"); };

export function loadVideo(file) {
  return new Promise((resolve, reject) => {
    const v = document.createElement("video");
    v.muted = true; v.playsInline = true; v.preload = "auto"; v.crossOrigin = "anonymous";
    v.src = URL.createObjectURL(file);
    const fail = () => reject(new Error(`Couldn't open "${file.name}". Try an MP4 or MOV from your phone.`));
    v.onerror = fail;
    v.onloadedmetadata = async () => {
      // iOS needs a play/pause before frames can be drawn
      try { await v.play(); v.pause(); } catch {}
      if (!isFinite(v.duration) || !v.videoWidth) {
        // some files report duration late
        await new Promise((r) => setTimeout(r, 500));
      }
      if (!v.videoWidth) return fail();
      resolve(v);
    };
    setTimeout(() => { if (!v.videoWidth) fail(); }, 20000);
  });
}

function seek(v, t) {
  return new Promise((resolve) => {
    t = Math.min(Math.max(0, t), Math.max(0, v.duration - 0.05));
    if (Math.abs(v.currentTime - t) < 0.01) return resolve();
    const done = () => { v.removeEventListener("seeked", done); resolve(); };
    v.addEventListener("seeked", done);
    v.currentTime = t;
    setTimeout(done, 4000);
  });
}

function toCanvas(src, w, h, maxSide) {
  const s = Math.min(1, maxSide / Math.max(w, h));
  const c = document.createElement("canvas");
  c.width = Math.round(w * s); c.height = Math.round(h * s);
  c.getContext("2d").drawImage(src, 0, 0, c.width, c.height);
  return c;
}

export async function grab(v, t, maxSide) {
  await seek(v, t);
  return toCanvas(v, v.videoWidth, v.videoHeight, maxSide);
}

export function loadImage(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Couldn't open photo "${file.name}".`));
    img.src = URL.createObjectURL(file);
  });
}
export const imageToCanvas = (img, maxSide) => toCanvas(img, img.naturalWidth, img.naturalHeight, maxSide);

export const jpeg = (c, q = 0.8) => c.toDataURL("image/jpeg", q);

// Sharpness = variance of the Laplacian on a small grayscale copy
export function sharpness(c) {
  const s = toCanvas(c, c.width, c.height, 320);
  const { data, width: w, height: h } = s.getContext("2d").getImageData(0, 0, s.width, s.height);
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, L = 4 * g[i] - g[i - 1] - g[i + 1] - g[i - w] - g[i + w];
    sum += L; sum2 += L * L; n++;
  }
  const m = sum / n; return sum2 / n - m * m;
}

// Plan the 1-per-second scan across all videos, capped at `budget` frames total.
export function planScan(videos, budget) {
  const total = videos.reduce((a, v) => a + v.duration, 0);
  const step = Math.max(1, total / budget);
  const plan = [];
  videos.forEach((v, vi) => {
    for (let t = 0.3; t < v.duration; t += step) plan.push({ vi, t });
  });
  return { plan: plan.slice(0, budget), step };
}

// Pass 2: frames every 0.5 s from t-1 to t+1, full resolution, keep the sharpest.
export async function bestAround(v, t, maxSide = 1600) {
  let best = null, bestS = -1, bestT = t;
  for (const dt of [-1, -0.5, 0, 0.5, 1]) {
    const tt = t + dt; if (tt < 0 || tt > v.duration) continue;
    const c = await grab(v, tt, maxSide);
    const s = sharpness(c) * (dt === 0 ? 1.08 : 1); // slight preference for the exact frame the AI picked
    if (s > bestS) { best = c; bestS = s; bestT = tt; }
  }
  return { canvas: best, t: bestT };
}

// Red circle around the problem. box = [x, y, w, h] as 0-1 fractions.
export function circle(c, box) {
  if (!Array.isArray(box) || box.length < 4) return c;
  const out = document.createElement("canvas");
  out.width = c.width; out.height = c.height;
  const ctx = out.getContext("2d");
  ctx.drawImage(c, 0, 0);
  let [x, y, w, h] = box.map(Number);
  const cx = (x + w / 2) * c.width, cy = (y + h / 2) * c.height;
  const rx = Math.max(w * c.width * 0.62, c.width * 0.05), ry = Math.max(h * c.height * 0.62, c.height * 0.05);
  const lw = Math.max(4, c.width / 160);
  ctx.lineWidth = lw + 3; ctx.strokeStyle = "rgba(255,255,255,.55)";
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = lw; ctx.strokeStyle = "#E02424";
  ctx.beginPath(); ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2); ctx.stroke();
  return out;
}

// Choose the best `target` frames from scored candidates [{ k, vi, t, s, g }] (s = sharpness, g = tiny gray thumbnail).
// 1) drop blurry frames (much softer than their neighbors); 2) one sharpest frame per time slice so the whole
// walkthrough stays covered; 3) fill the rest with the frames least like anything already chosen (new views,
// new details). Returns the chosen frames in video order.
export function pickBest(frames, target) {
  if (frames.length <= target) return frames.slice();
  const med = (a) => { const b = a.slice().sort((x, y) => x - y); return b[b.length >> 1]; };
  const ok = frames.filter((f, i) => f.s >= 0.6 * med(frames.slice(Math.max(0, i - 3), i + 4).map((x) => x.s)));
  const pool = ok.length >= target ? ok : frames;
  const dist = (a, b) => { let d = 0; for (let i = 0; i < a.length; i++) d += Math.abs(a[i] - b[i]); return d / a.length; };
  const chosen = [], taken = new Set();
  const slices = Math.max(1, Math.floor(target / 2)), per = pool.length / slices;
  for (let i = 0; i < slices; i++) {
    const part = pool.slice(Math.floor(i * per), Math.floor((i + 1) * per)); if (!part.length) continue;
    const best = part.reduce((a, b) => (b.s > a.s ? b : a)); chosen.push(best); taken.add(best);
  }
  const minD = new Map(pool.map((f) => [f, chosen.length ? Math.min(...chosen.map((c) => (c.vi === f.vi ? dist(f.g, c.g) : 255))) : 255]));
  const medS = med(pool.map((x) => x.s)) || 1;
  while (chosen.length < target) {
    let best = null, bv = -1;
    for (const f of pool) { if (taken.has(f)) continue; const v = minD.get(f) * (0.5 + Math.min(1, f.s / medS) / 2); if (v > bv) { bv = v; best = f; } }
    if (!best) break;
    chosen.push(best); taken.add(best);
    for (const f of pool) if (!taken.has(f)) { const d = f.vi === best.vi ? dist(f.g, best.g) : 255; if (d < minD.get(f)) minD.set(f, d); }
  }
  return chosen.sort((a, b) => a.vi - b.vi || a.t - b.t);
}
