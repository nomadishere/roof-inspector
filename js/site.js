/* Roofly site: reveals, counters, measure demo, timeline, hero film, brand try-on, sticky CTA, CTA tracking */
(function () {
  const calm = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (calm) document.documentElement.classList.add('calm');
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const track = (name, data) => { try { (window.dataLayer = window.dataLayer || []).push({ event: name, ...data }); } catch (e) {} };

  // nav goes solid after scrolling; sticky mobile CTA shows once past the hero and hides at the final CTA
  const nav = $('#nav'), mbar = $('#mbar'), start = $('#start');
  let startVisible = false;
  const onScroll = () => {
    nav.classList.toggle('solid', scrollY > 20);
    mbar.classList.toggle('on', scrollY > innerHeight * .7 && !startVisible);
  };
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
  new IntersectionObserver(es => { startVisible = es[0].isIntersecting; onScroll(); }, { threshold: .15 }).observe(start);

  // counters
  const countUp = (el, to, fmt, dur = 1400) => {
    if (calm) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const step = t => { const k = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - k, 3); el.textContent = fmt(to * e); if (k < 1) requestAnimationFrame(step); };
    requestAnimationFrame(step);
  };
  const fmts = { int: v => Math.round(v).toLocaleString('en-US'), 1: v => v.toFixed(1) };

  // one-shot triggers
  const once = new Map();
  once.set('race', () => $$('#race .bar i').forEach(i => i.style.width = i.dataset.w + '%'));
  once.set('roofbox', () => {
    $('#roofbox').classList.add('on');
    $$('#roofbox .edge').forEach((p, i) => {
      const L = p.getTotalLength(); p.style.strokeDasharray = L; p.style.strokeDashoffset = calm ? 0 : L;
      if (!calm) { p.style.transition = `stroke-dashoffset 1.1s cubic-bezier(.4,.1,.2,1) ${.5 + i * .28}s`; requestAnimationFrame(() => requestAnimationFrame(() => p.style.strokeDashoffset = 0)); }
    });
    setTimeout(() => $$('#roofbox [data-to]').forEach(b => countUp(b, +b.dataset.to, fmts[b.dataset.fmt] || fmts.int, 1600)), calm ? 0 : 1600);
  });
  once.set('tl', () => { const i = $('#tl'); i.style.transition = calm ? 'none' : 'width 3.2s cubic-bezier(.3,.6,.2,1)'; i.style.width = '100%'; });

  const io = new IntersectionObserver(es => es.forEach(e => {
    if (!e.isIntersecting) return;
    const el = e.target; el.classList.add('in'); io.unobserve(el);
    const fn = once.get(el.id); if (fn) { once.delete(el.id); fn(); }
  }), { threshold: .25, rootMargin: '0px 0px -8% 0px' });
  $$('.rv, #race, #roofbox, #tl').forEach(el => io.observe(el));

  // CTA tracking + section views
  $$('[data-cta]').forEach(a => a.addEventListener('click', () => track('cta_click', { cta: a.dataset.cta })));
  const seen = new Set();
  const sio = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting && !seen.has(e.target.id)) { seen.add(e.target.id); track('section_view', { section: e.target.id }); } }), { threshold: .4 });
  $$('main section[id]').forEach(s => sio.observe(s));

  // brand try-on
  const tn = $('#tn'), cover = $('#cover');
  const initials = s => (s.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('') || 'R').toUpperCase();
  const paint = () => { const v = tn.value.trim() || 'Your Roofing Co.'; $('#cName').textContent = v; $('#cLogo').textContent = initials(v); };
  tn.addEventListener('input', paint);
  $$('input[name="c"]').forEach(r => r.addEventListener('change', () => { cover.style.setProperty('--brand', r.value); track('brand_color', { color: r.value }); }));
  paint();

  // hero film: scenes cycle, words animate in, pause control, pauses when off screen or tab hidden
  const film = $('#film'); if (!film) return;
  const scenes = $$('#film .f-scene'), segs = $$('#film .segs button'), pp = $('#reelPP');
  const DUR = calm ? 8000 : 5200;
  let cur = 0, timer = null, paused = false, remain = DUR, t0 = 0;
  scenes.forEach(sc => {   // split headlines into words for the entrance
    const h = sc.querySelector('.f-h'); let n = 0;
    const wrap = node => { [...node.childNodes].forEach(c => {
      if (c.nodeType === 3) { const f = document.createDocumentFragment(); c.textContent.split(/(\s+)/).forEach(t => { if (!t) return; if (/^\s+$/.test(t)) f.append(t); else { const s = document.createElement('span'); s.className = 'w'; s.style.setProperty('--d', n++); s.textContent = t; f.append(s); } }); c.replaceWith(f); }
      else wrap(c); }); };
    wrap(h);
  });
  const show = i => {
    const prev = scenes[cur]; if (prev && i !== cur) { prev.classList.remove('on'); prev.classList.add('out'); setTimeout(() => prev.classList.remove('out'), 320); }
    cur = i; scenes[i].classList.remove('out'); void scenes[i].offsetWidth; scenes[i].classList.add('on');
    segs.forEach((b, k) => { b.classList.remove('run', 'done'); b.removeAttribute('aria-current'); if (k < i) b.classList.add('done'); });
    const s = segs[i]; void s.offsetWidth; s.classList.add('run'); s.setAttribute('aria-current', 'true');
    remain = DUR; schedule();
  };
  const schedule = () => { clearTimeout(timer); t0 = performance.now(); if (!paused && !film.classList.contains('held') && !film.classList.contains('offscreen')) timer = setTimeout(() => show((cur + 1) % scenes.length), remain); };
  const hold = () => { clearTimeout(timer); remain = Math.max(300, remain - (performance.now() - t0)); };
  const setPaused = p => { if (p === paused) return; paused = p; film.classList.toggle('paused', p); pp.setAttribute('aria-label', p ? 'Play' : 'Pause'); p ? hold() : schedule(); };
  pp.addEventListener('click', () => setPaused(!paused));
  segs.forEach((b, i) => b.addEventListener('click', () => { if (i !== cur) show(i); }));
  new IntersectionObserver(es => { const off = !es[0].isIntersecting; if (off === film.classList.contains('offscreen')) return; film.classList.toggle('offscreen', off); off ? hold() : schedule(); }, { threshold: .2 }).observe(film);
  document.addEventListener('visibilitychange', () => { const h = document.hidden; if (h === film.classList.contains('held')) return; film.classList.toggle('held', h); h ? hold() : schedule(); });
  show(0);
})();
