/* Architect Radio hero: a service graph that boots, carries live traffic,
   breaks under load and gets fixed, one component at a time.
   Vanilla Canvas 2D. Pauses off-screen and in hidden tabs; draws one still,
   fully fixed frame under prefers-reduced-motion. */
(() => {
  'use strict';
  const stage = document.querySelector('[data-hero-stage]');
  const canvas = document.querySelector('[data-hero-canvas]');
  if (!stage || !canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const statusEl = document.querySelector('[data-hero-status]');
  const hero = stage.closest('.hero') || stage;
  const metricEls = {};
  for (const el of document.querySelectorAll('[data-metric]')) metricEls[el.dataset.metric] = { li: el, b: el.querySelector('b'), text: '', state: '' };
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const forceStill = /[?&]still\b/.test(location.search);
  let still = forceStill || mq.matches;

  const COL = {
    cyan: [86, 199, 232], ice: [190, 232, 248], amber: [232, 168, 56], amberHi: [245, 185, 66],
    red: [229, 86, 76], redHi: [255, 120, 108], text: [240, 244, 248], muted: [143, 163, 188], blue: [27, 152, 224],
  };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const back = (t) => { const c = 1.7; t -= 1; return 1 + (c + 1) * t * t * t + c * t * t; };
  const MONO = '"JetBrains Mono", ui-monospace, Menlo, monospace';

  /* ---------- the system ---------- */
  const NODES = {
    app:    { x: .03, y: .52, label: 'app', icon: 'phone', at: 0.20 },
    gw:     { x: .22, y: .52, label: 'gateway', icon: 'split', at: 0.36 },
    auth:   { x: .42, y: .30, label: 'auth', icon: 'shield', at: 0.52 },
    otp:    { x: .61, y: .10, label: 'otp', icon: 'code', at: 0.70 },
    sms:    { x: .97, y: .10, label: 'sms provider', short: 'sms', icon: 'signal', ext: true, at: 0.92 },
    sess:   { x: .77, y: .42, label: 'sessions', icon: 'db', at: 0.76 },
    ledger: { x: .66, y: .80, label: 'ledger', icon: 'book', at: 0.66 },
    db:     { x: .95, y: .80, label: 'db', icon: 'db', at: 0.96 },
    queue:  { x: .79, y: .10, label: 'queue', icon: 'queue', fix: 'A' },
    idem:   { x: .44, y: .80, label: 'idempotency key', short: 'idem key', icon: 'key', fix: 'B' },
  };
  const IDS = Object.keys(NODES);
  for (const id of IDS) Object.assign(NODES[id], { id, px: 0, py: 0, ox: 0, oy: 0, flash: 0, hurt: 0, hover: 0, a: 0, note: null, shake: 0, ringCd: 0 });

  const EDGES = [
    { a: 'app', b: 'gw' }, { a: 'gw', b: 'auth' }, { a: 'auth', b: 'otp' },
    { a: 'otp', b: 'sms', base: 'A' }, { a: 'otp', b: 'queue', fix: 'A' }, { a: 'queue', b: 'sms', fix: 'A' },
    { a: 'auth', b: 'sess' },
    { a: 'gw', b: 'ledger', base: 'B', mx: 'idem' }, { a: 'gw', b: 'idem', fix: 'B', hv: true }, { a: 'idem', b: 'ledger', fix: 'B' },
    { a: 'ledger', b: 'db' },
  ];
  const EDGE = {};
  for (const e of EDGES) { Object.assign(e, { path: null, draw: 0, alpha: 1, heat: 0 }); EDGE[e.a + '>' + e.b] = e; }

  /* ---------- story timeline (seconds into each loop) ---------- */
  const LOOP0 = 2.0;
  const T = { spikeA: 1.2, blockA: 2.0, fixA: 6.4, spikeEnd: 8.8, calmA: 9.4, stormB: 11.2, fixB: 14.8, stormEnd: 17.0, calmB: 17.6, reset: 20.4, end: 21.8 };
  const STATUS = [
    [-1e9, 'ok', 'Steady traffic: logins, sessions, payments'],
    [T.spikeA, 'load', 'Festival night: OTP requests triple'],
    [T.blockA, 'break', 'SMS provider times out. OTPs pile up.'],
    [T.fixA, 'fix', 'Fix: queue the OTPs, retry with backoff'],
    [T.calmA, 'ok', 'Steady again, under three times the load'],
    [T.stormB, 'break', 'Retry storm: one payment, charged twice'],
    [T.fixB, 'fix', 'Fix: an idempotency key on every payment'],
    [T.calmB, 'ok', 'Steady again: every payment charged once'],
    [T.reset, 'load', 'Next question'],
  ];
  const STILL_STATUS = ['fix', 'Fixed: OTPs queued, payments idempotent'];

  /* ---------- state ---------- */
  let W = 0, H = 0, DPR = 1, K = 1, FS = 12, S = 20, small = false;
  let padL = 30, padR = 50, padT = 56, padB = 96;
  let clock = 0, lt = -1, last = 0, raf = 0;
  let inView = true, pageVisible = !document.hidden;
  let pointer = null, mx = 0, my = 0, pmx = 0, pmy = 0;
  let packets = [], rings = [];
  const spawnAt = { login: 0, sess: 0.5, pay: 0.25 };
  let statusKey = '', lastScroll = -1, lastStageT = '', bounceCd = 0, metricsCd = 0;
  let incident = 0, incidentNode = null;
  const M = { rps: 1240, p99: 84, err: 0.1 };

  const fixProg = (f) => {
    const t0 = f === 'A' ? T.fixA : T.fixB;
    if (lt < t0) return 0;
    if (lt < T.reset) return clamp((lt - t0) / 0.9);
    return 1 - ease(clamp((lt - T.reset) / 0.9));
  };
  const fixOn = (f) => lt >= (f === 'A' ? T.fixA : T.fixB) + 0.5 && lt < T.reset;
  const blocked = () => lt >= T.blockA && lt < T.fixA + 0.6;
  const spike = () => lt >= T.spikeA && lt < T.spikeEnd;
  const storm = () => lt >= T.stormB && lt < T.stormEnd;

  /* ---------- glow sprites ---------- */
  const sprites = {};
  function makeSprite(name, c, hard) {
    const s = 64, cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, rgba(c, 1));
    gr.addColorStop(hard ? 0.12 : 0.2, rgba(c, hard ? 0.7 : 0.45));
    gr.addColorStop(0.5, rgba(c, 0.1));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
    sprites[name] = cv;
  }
  makeSprite('cyan', COL.cyan, true); makeSprite('ice', COL.ice, true); makeSprite('amber', COL.amberHi, true);
  makeSprite('red', COL.redHi, true); makeSprite('haloC', COL.cyan); makeSprite('haloA', COL.amber); makeSprite('haloR', COL.red);

  /* ---------- geometry ---------- */
  function layout() {
    const r = stage.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    small = W < 600;
    const cs0 = getComputedStyle(stage);
    const inner = W - (parseFloat(cs0.getPropertyValue('--bl')) || 0) - (parseFloat(cs0.getPropertyValue('--br')) || 0);
    K = clamp(inner / 760, 0.74, 1.12);
    FS = small ? 10.5 : 12.5;
    S = (small ? 16 : 23) * K;          // node card half-size
    padL = small ? 22 : 34; padR = small ? 24 : 56;
    padT = small ? 66 : 86; padB = small ? 64 : 112;
    padL += parseFloat(cs0.getPropertyValue('--bl')) || 0;
    padR += parseFloat(cs0.getPropertyValue('--br')) || 0;
    DPR = Math.min(window.devicePixelRatio || 1, W * H > 420000 ? 1.5 : 2);
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  }
  const bx = (n) => padL + n.x * (W - padL - padR);
  const by = (n) => padT + n.y * (H - padT - padB);

  function buildPath(pts, r) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      const l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      if (l1 < 0.01 || l2 < 0.01) continue;
      const rr = Math.min(r, l1 / 2, l2 / 2);
      const ax = p1[0] + (p0[0] - p1[0]) / l1 * rr, ay = p1[1] + (p0[1] - p1[1]) / l1 * rr;
      const cx = p1[0] + (p2[0] - p1[0]) / l2 * rr, cy = p1[1] + (p2[1] - p1[1]) / l2 * rr;
      for (let j = 0; j <= 6; j++) {
        const t = j / 6, u = 1 - t;
        out.push([u * u * ax + 2 * u * t * p1[0] + t * t * cx, u * u * ay + 2 * u * t * p1[1] + t * t * cy]);
      }
    }
    out.push(pts[pts.length - 1]);
    const cum = [0];
    for (let i = 1; i < out.length; i++) cum.push(cum[i - 1] + Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1]));
    return { pts: out, cum, len: cum[cum.length - 1] };
  }
  function pointAt(p, d) {
    if (d <= 0) return p.pts[0];
    if (d >= p.len) return p.pts[p.pts.length - 1];
    let i = 1;
    while (i < p.cum.length - 1 && p.cum[i] < d) i++;
    const s = p.cum[i] - p.cum[i - 1] || 1, t = (d - p.cum[i - 1]) / s;
    const a = p.pts[i - 1], b = p.pts[i];
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  }
  function routeEdges() {
    for (const e of EDGES) {
      const A = NODES[e.a], B = NODES[e.b];
      const ax = A.px, ay = A.py, bx2 = B.px, by2 = B.py;
      let pts;
      if (Math.abs(ay - by2) < 0.75) pts = [[ax, ay], [bx2, by2]];
      else if (e.hv) pts = [[ax, ay], [bx2, ay], [bx2, by2]];
      else {
        const m = e.mx ? NODES[e.mx].px : (ax + bx2) / 2;
        pts = [[ax, ay], [m, ay], [m, by2], [bx2, by2]];
      }
      e.path = buildPath(pts, 14 * K);
    }
  }

  /* ---------- traffic ---------- */
  function route(kind) {
    if (kind === 'login') return fixOn('A') ? ['app', 'gw', 'auth', 'otp', 'queue', 'sms'] : ['app', 'gw', 'auth', 'otp', 'sms'];
    if (kind === 'sess') return ['app', 'gw', 'auth', 'sess'];
    return fixOn('B') ? ['app', 'gw', 'idem', 'ledger', 'db'] : ['app', 'gw', 'ledger', 'db'];
  }
  function respRoute(kind) {
    if (kind === 'sess') return ['sess', 'auth', 'gw', 'app'];
    return fixOn('B') ? ['db', 'ledger', 'idem', 'gw', 'app'] : ['db', 'ledger', 'gw', 'app'];
  }
  const segEdge = (pk) => {
    const a = pk.route[pk.seg], b = pk.route[pk.seg + 1];
    const f = EDGE[a + '>' + b];
    return f ? [f, false] : [EDGE[b + '>' + a], true];
  };
  function spawn(kind, opts) {
    if (packets.length >= (small ? 48 : 76)) return null;
    const resp = !!(opts && opts.resp);
    const pk = {
      kind, resp, dup: false, bounce: 0,
      route: resp ? respRoute(kind) : route(kind),
      seg: 0, d: (opts && opts.d) || 0,
      speed: (resp ? 165 : 120) * (0.75 + Math.random() * 0.55),
      color: resp ? 'ice' : 'cyan', red: 0, stall: 0, dead: 0,
    };
    packets.push(pk);
    return pk;
  }
  function ring(x, y, c, r0, r1, dur, w) { if (rings.length < 30) rings.push({ x, y, c, r0, r1, t: 0, dur, w: w || 1.5 }); }
  function note(n, text, c, life) { n.note = { text, c, t: 0, life }; }

  function arrive(pk, id) {
    const n = NODES[id];
    n.flash = Math.min(1, n.flash + 0.7);
    if (n.ringCd <= 0) { ring(n.px, n.py, pk.red > 0.5 ? COL.red : pk.color === 'amber' ? COL.amber : COL.cyan, S * 0.9, S * 1.9, 0.5, 1.2); n.ringCd = 0.14; }
    if (n.fix && !pk.resp) pk.color = 'amber';
    if (pk.dup && id === 'idem') {
      pk.dead = 1e-3; ring(n.px, n.py, COL.amberHi, S, S * 2.6, 0.7, 2);
      note(n, 'duplicate dropped', COL.amberHi, 1.1); return true;
    }
    if (pk.dup && id === 'ledger' && !pk.resp && !fixOn('B')) {
      n.hurt = 1; n.shake = 1; pk.red = 1;
      ring(n.px, n.py, COL.red, S, S * 3.4, 0.8, 3);
      note(n, 'charged ×2', COL.redHi, 1.2);
    }
    return false;
  }

  /* ---------- update ---------- */
  function update(dt) {
    lt = clock < LOOP0 ? -1 : (clock - LOOP0) % T.end;
    const isBlocked = blocked();

    // incident spotlight: SMS during the block, ledger during the storm
    const inc = isBlocked ? 'sms' : (storm() && !fixOn('B')) ? 'ledger' : null;
    if (inc) incidentNode = inc;
    incident += ((inc ? 1 : 0) - incident) * Math.min(1, dt * (inc ? 2.2 : 1.4));

    // pointer parallax (smoothed)
    pmx += (mx - pmx) * Math.min(1, dt * 4); pmy += (my - pmy) * Math.min(1, dt * 4);

    for (const id of IDS) {
      const n = NODES[id];
      n.a = n.fix ? fixProg(n.fix) : clamp((clock - n.at) / 0.55);
      let tx = 0, ty = 0, hv = 0;
      const x0 = bx(n), y0 = by(n);
      if (pointer) {
        const dx = x0 - pointer[0], dy = y0 - pointer[1], d = Math.hypot(dx, dy) || 1, R = 160 * K;
        if (d < R) { const f = Math.pow(1 - d / R, 2) * 12 * K; tx = dx / d * f; ty = dy / d * f; }
        hv = d < S * 1.8 ? 1 : 0;
      }
      const s = Math.min(1, dt * 7);
      n.ox += (tx - n.ox) * s; n.oy += (ty - n.oy) * s;
      n.hover += (hv - n.hover) * Math.min(1, dt * 10);
      n.flash = Math.max(0, n.flash - dt * 2.6);
      n.hurt = Math.max(0, n.hurt - dt * 0.9);
      n.shake = Math.max(0, n.shake - dt * 2.2);
      n.ringCd -= dt;
      if (n.note) { n.note.t += dt; if (n.note.t > n.note.life) n.note = null; }
      const sh = n.shake * 3.2 * K;
      n.px = x0 + n.ox + (sh ? (Math.random() - 0.5) * sh : 0);
      n.py = y0 + n.oy + (sh ? (Math.random() - 0.5) * sh : 0);
    }
    // the SMS provider goes down: flash, shockwave, shake
    const sms = NODES.sms;
    if (isBlocked) {
      if (sms.hurt < 0.5) { sms.shake = 1; ring(sms.px, sms.py, COL.red, S, S * 5.5, 1.1, 3.5); ring(sms.px, sms.py, COL.red, S, S * 3.6, 0.8, 2); }
      sms.hurt = 1;
      if (Math.random() < dt * 1.3) ring(sms.px, sms.py, COL.red, S, S * 3.2, 0.9, 1.5);
      if (!sms.note && lt > T.blockA + 0.3) note(sms, 'timeout 30s', COL.redHi, 1.6);
    }
    routeEdges();
    for (const e of EDGES) {
      if (e.fix) { e.draw = ease(fixProg(e.fix)); e.alpha = 1; }
      else {
        const t0 = Math.max(NODES[e.a].at, NODES[e.b].at * 0.7) + 0.08;
        e.draw = ease(clamp((clock - t0) / 0.5));
        e.alpha = e.base ? 1 - 0.85 * fixProg(e.base) : 1;
      }
      e.heat = Math.max(0, e.heat - dt * 1.6);
    }

    // spawning
    if (clock > 1.25) {
      for (const kind of ['login', 'sess', 'pay']) {
        spawnAt[kind] -= dt;
        if (spawnAt[kind] > 0) continue;
        const base = kind === 'login' ? (spike() ? 0.17 : 0.7) : kind === 'sess' ? 1.1 : (storm() ? 0.7 : 0.95);
        spawnAt[kind] = base * (0.6 + Math.random() * 0.8);
        const pk = spawn(kind);
        if (pk && kind === 'pay' && storm()) {
          const twin = spawn('pay', { d: -18 * K });
          if (twin) { twin.dup = true; twin.route = pk.route; twin.speed = pk.speed; }
        }
      }
    }

    // movement
    const stalled = [];
    bounceCd -= dt;
    for (const pk of packets) {
      if (pk.dead) { pk.dead += dt; continue; }
      if (pk.bounce) {                       // rejected: fly back toward otp, fade out
        pk.bounce += dt; pk.d -= 190 * K * dt;
        if (pk.bounce > 0.75 || pk.d < 0) pk.dead = 1e-3;
        continue;
      }
      pk.d += pk.speed * K * dt;
      let [e] = segEdge(pk);
      while (e && pk.d >= e.path.len) {
        pk.d -= e.path.len; pk.seg++;
        if (arrive(pk, pk.route[pk.seg])) break;
        if (pk.seg >= pk.route.length - 1) {
          pk.dead = 1e-3;
          if (!pk.resp && !pk.dup && (pk.kind === 'sess' || pk.kind === 'pay')) spawn(pk.kind, { resp: true });
          break;
        }
        [e] = segEdge(pk);
      }
      if (pk.dead) continue;
      if (e) e.heat = Math.min(1, e.heat + dt * 3.2);
      if (isBlocked && pk.route[pk.seg] === 'otp' && pk.route[pk.seg + 1] === 'sms') stalled.push(pk);
      if (!isBlocked && pk.red > 0 && !(pk.dup && pk.kind === 'pay')) pk.red = Math.max(0, pk.red - dt * 1.2);
    }
    if (stalled.length) {
      const e = EDGE['otp>sms'], gap = 12 * K, end = e.path.len - S - 8 * K;
      stalled.sort((a, b) => b.d - a.d);
      stalled.forEach((pk, i) => {
        const lim = end - i * gap;
        if (pk.d >= lim) { pk.d = lim; pk.stall += dt; }
        pk.red = clamp(pk.stall / 0.5);
      });
      if (stalled.length > 7 && bounceCd <= 0 && stalled[0].stall > 0.5) {
        const pk = stalled[0], p = pointAt(e.path, pk.d);
        pk.bounce = 1e-3; pk.red = 1; bounceCd = 0.22;
        ring(p[0], p[1], COL.red, 3, 16 * K, 0.45, 1.5);
      }
    }
    packets = packets.filter((pk) => !pk.dead || pk.dead < 0.3);
    for (const r of rings) r.t += dt;
    rings = rings.filter((r) => r.t < r.dur);

    // metrics model
    const tgt = { rps: 1240, p99: 84, err: 0.1 };
    if (spike()) tgt.rps = 3720;
    if (storm()) { tgt.rps = 2310; tgt.p99 = fixOn('B') ? 96 : 410; tgt.err = 0.2; }
    if (isBlocked) { tgt.p99 = lt > T.blockA + 0.8 ? 2400 : 900; tgt.err = 38; }
    else if (spike()) { tgt.p99 = 128; tgt.err = 0.3; }
    const k = 1 - Math.exp(-dt * (isBlocked ? 2.5 : 1.6));
    for (const key of ['rps', 'p99', 'err']) M[key] += (tgt[key] - M[key]) * k;
  }

  /* ---------- drawing helpers ---------- */
  // incident focus: everything away from the failing node dims a little
  function dimAt(x, y) {
    if (incident < 0.01 || !incidentNode) return 1;
    const f = NODES[incidentNode];
    return 1 - 0.55 * incident * clamp((Math.hypot(x - f.px, y - f.py) - S * 3) / (240 * K));
  }
  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }
  function strokePartial(p, d) {
    ctx.beginPath();
    ctx.moveTo(p.pts[0][0], p.pts[0][1]);
    for (let i = 1; i < p.pts.length; i++) {
      if (p.cum[i] <= d) ctx.lineTo(p.pts[i][0], p.pts[i][1]);
      else { const q = pointAt(p, d); ctx.lineTo(q[0], q[1]); break; }
    }
    ctx.stroke();
  }
  function icon(type, x, y, z) {
    ctx.beginPath();
    switch (type) {
      case 'phone':
        roundRect(x - 0.3 * z, y - 0.48 * z, 0.6 * z, 0.96 * z, 0.13 * z); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(x - 0.09 * z, y + 0.32 * z); ctx.lineTo(x + 0.09 * z, y + 0.32 * z); break;
      case 'split':
        ctx.moveTo(x - 0.5 * z, y); ctx.lineTo(x - 0.06 * z, y);
        ctx.moveTo(x + 0.42 * z, y - 0.34 * z); ctx.lineTo(x + 0.12 * z, y - 0.34 * z); ctx.lineTo(x - 0.06 * z, y); ctx.lineTo(x + 0.12 * z, y + 0.34 * z); ctx.lineTo(x + 0.42 * z, y + 0.34 * z);
        ctx.moveTo(x - 0.06 * z, y); ctx.lineTo(x + 0.42 * z, y); break;
      case 'shield':
        ctx.moveTo(x, y - 0.5 * z); ctx.lineTo(x + 0.4 * z, y - 0.34 * z); ctx.lineTo(x + 0.4 * z, y);
        ctx.quadraticCurveTo(x + 0.38 * z, y + 0.36 * z, x, y + 0.52 * z);
        ctx.quadraticCurveTo(x - 0.38 * z, y + 0.36 * z, x - 0.4 * z, y);
        ctx.lineTo(x - 0.4 * z, y - 0.34 * z); ctx.closePath();
        ctx.moveTo(x - 0.16 * z, y + 0.02 * z); ctx.lineTo(x - 0.03 * z, y + 0.15 * z); ctx.lineTo(x + 0.18 * z, y - 0.12 * z); break;
      case 'code':
        roundRect(x - 0.5 * z, y - 0.27 * z, z, 0.54 * z, 0.12 * z); ctx.stroke();
        ctx.beginPath();
        for (const o of [-0.24, 0, 0.24]) { ctx.moveTo(x + (o + 0.07) * z, y); ctx.arc(x + o * z, y, 0.07 * z, 0, Math.PI * 2); }
        ctx.fill(); return;
      case 'signal':
        ctx.moveTo(x, y + 0.5 * z); ctx.lineTo(x, y + 0.06 * z);
        ctx.moveTo(x + 0.26 * z * Math.cos(-0.7), y + 0.06 * z + 0.26 * z * Math.sin(-0.7));
        ctx.arc(x, y + 0.06 * z, 0.26 * z, -0.7, -Math.PI + 0.7, true);
        ctx.moveTo(x + 0.48 * z * Math.cos(-0.6), y + 0.06 * z + 0.48 * z * Math.sin(-0.6));
        ctx.arc(x, y + 0.06 * z, 0.48 * z, -0.6, -Math.PI + 0.6, true); break;
      case 'db': {
        const w = 0.4 * z, e = 0.13 * z;
        ctx.ellipse(x, y - 0.32 * z, w, e, 0, 0, Math.PI * 2);
        ctx.moveTo(x - w, y - 0.32 * z); ctx.lineTo(x - w, y + 0.32 * z);
        ctx.moveTo(x + w, y - 0.32 * z); ctx.lineTo(x + w, y + 0.32 * z);
        ctx.moveTo(x + w, y + 0.32 * z); ctx.ellipse(x, y + 0.32 * z, w, e, 0, 0, Math.PI);
        ctx.moveTo(x + w, y); ctx.ellipse(x, y, w, e, 0, 0, Math.PI); break;
      }
      case 'book':
        roundRect(x - 0.36 * z, y - 0.48 * z, 0.72 * z, 0.96 * z, 0.08 * z); ctx.stroke();
        ctx.beginPath();
        for (const o of [-0.2, 0, 0.2]) { ctx.moveTo(x - 0.18 * z, y + o * z); ctx.lineTo(x + 0.18 * z, y + o * z); } break;
      case 'queue':
        for (const o of [-0.32, 0, 0.32]) { roundRect(x + o * z - 0.1 * z, y - 0.3 * z, 0.2 * z, 0.6 * z, 0.05 * z); ctx.stroke(); }
        return;
      case 'key':
        ctx.arc(x - 0.24 * z, y, 0.19 * z, 0, Math.PI * 2);
        ctx.moveTo(x - 0.05 * z, y); ctx.lineTo(x + 0.5 * z, y);
        ctx.moveTo(x + 0.3 * z, y); ctx.lineTo(x + 0.3 * z, y + 0.18 * z);
        ctx.moveTo(x + 0.45 * z, y); ctx.lineTo(x + 0.45 * z, y + 0.13 * z); break;
    }
    ctx.stroke();
  }

  function drawGridBoot() {
    // the blueprint wakes up: a cyan wavefront sweeps out from the client
    if (clock > 1.8) return;
    const o = NODES.app, ox = bx(o), oy = by(o);
    const R = ease(clamp(clock / 1.5)) * Math.hypot(W, H) * 1.05;
    const g = ctx.createRadialGradient(ox, oy, Math.max(0, R - 140 * K), ox, oy, R + 2);
    const fade = 1 - clamp((clock - 1.1) / 0.7);
    g.addColorStop(0, rgba(COL.cyan, 0.05 * fade));
    g.addColorStop(0.85, rgba(COL.cyan, 0.32 * fade));
    g.addColorStop(1, rgba(COL.cyan, 0));
    ctx.strokeStyle = g; ctx.lineWidth = 1;
    const step = small ? 24 : 32;
    ctx.beginPath();
    for (let x = (ox % step); x < W; x += step) { ctx.moveTo(x, 0); ctx.lineTo(x, H); }
    for (let y = (oy % step); y < H; y += step) { ctx.moveTo(0, y); ctx.lineTo(W, y); }
    ctx.stroke();
    // feather the stage edges so the grid never shows a hard rectangle
    ctx.save();
    ctx.globalCompositeOperation = 'destination-in';
    ctx.translate(W / 2, H / 2); ctx.scale(W / 2, H / 2);
    const m = ctx.createRadialGradient(0, 0, 0, 0, 0, 1);
    m.addColorStop(0, '#000'); m.addColorStop(0.62, '#000'); m.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = m; ctx.fillRect(-1, -1, 2, 2);
    ctx.restore();
  }

  function drawNode(n) {
    if (n.a <= 0.001) return;
    const sc = n.fix ? back(clamp(n.a * 1.25)) : back(n.a);
    const s = S * Math.max(0, sc);
    const x = n.px, y = n.py;
    const hurt = n.hurt, isFix = !!n.fix, glow = Math.max(n.flash, n.hover * 0.7);
    const tone = hurt > 0.05 ? COL.red : isFix ? COL.amber : COL.cyan;
    const dm = n.id === incidentNode ? 1 : dimAt(x, y);
    ctx.save();
    // halo
    ctx.globalCompositeOperation = 'lighter';
    const halo = hurt > 0.05 ? sprites.haloR : isFix ? sprites.haloA : sprites.haloC;
    const ha = (isFix ? 0.32 : 0.16) + 0.3 * glow + 0.5 * hurt;
    const hr = s * (2.5 + glow * 0.6 + hurt * 1.2);
    ctx.globalAlpha = clamp(n.a) * ha * dm;
    ctx.drawImage(halo, x - hr, y - hr, hr * 2, hr * 2);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = clamp(n.a * 1.5) * (0.35 + 0.65 * dm);
    // glass card
    const r = (n.id === 'app' ? s : 8 * K);
    const fg = ctx.createLinearGradient(0, y - s, 0, y + s);
    fg.addColorStop(0, hurt > 0.3 ? '#3a1a22' : '#1f3049');
    fg.addColorStop(1, hurt > 0.3 ? '#1d0f16' : '#0f1b2c');
    ctx.fillStyle = fg;
    if (n.id === 'app') { ctx.beginPath(); ctx.arc(x, y, s, 0, Math.PI * 2); }
    else roundRect(x - s, y - s, 2 * s, 2 * s, r);
    ctx.fill();
    if (n.ext) ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = rgba(hurt > 0.05 ? COL.redHi : isFix ? COL.amberHi : n.hover > 0.1 ? COL.text : COL.cyan, hurt > 0.05 ? 0.6 + 0.4 * hurt : isFix ? 0.95 : 0.42 + 0.45 * glow);
    ctx.stroke();
    ctx.setLineDash([]);
    // top sheen
    if (n.id !== 'app' && s > 4) {
      ctx.strokeStyle = 'rgba(255,255,255,0.07)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x - s + r, y - s + 1.5); ctx.lineTo(x + s - r, y - s + 1.5); ctx.stroke();
    }
    // icon
    ctx.lineWidth = Math.max(1.3, 1.6 * K); ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const ic = hurt > 0.05 ? COL.redHi : isFix ? COL.amberHi : glow > 0.15 ? COL.text : COL.ice;
    ctx.strokeStyle = rgba(ic, 0.9); ctx.fillStyle = rgba(ic, 0.9);
    icon(n.icon, x, y, s * 0.92);
    // fix badge: a check mark once the component is in service
    if (isFix && n.a > 0.6) {
      const t = clamp((n.a - 0.6) / 0.4), bxx = x + s * 0.95, byy = y - s * 0.95, br = 7 * K;
      ctx.fillStyle = '#e8a838'; ctx.beginPath(); ctx.arc(bxx, byy, br * ease(t), 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#0d1b2a'; ctx.lineWidth = 1.8 * K;
      ctx.beginPath(); ctx.moveTo(bxx - br * 0.45, byy); ctx.lineTo(bxx - br * 0.1, byy + br * 0.35); ctx.lineTo(bxx + br * 0.45, byy - br * 0.35);
      ctx.globalAlpha *= t; ctx.stroke();
    }
    // label
    ctx.globalAlpha = clamp(n.a * 1.3 - 0.3) * (0.3 + 0.7 * dm);
    const label = small && n.short ? n.short : n.label;
    ctx.font = `500 ${FS}px ${MONO}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    ctx.fillStyle = hurt > 0.3 ? '#ffb4ab' : isFix ? '#f5b942' : glow > 0.2 ? '#f0f4f8' : '#9fb3c8';
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, clamp(x, tw / 2 + 2, W - tw / 2 - 2), y + S + 8 * K);
    ctx.restore();
  }

  function drawPacket(pk) {
    const [e, rev] = segEdge(pk);
    if (!e) return;
    const L = e.path.len, d = clamp(pk.d, 0, L);
    const head = pointAt(e.path, rev ? L - d : d);
    let fade = (pk.dead ? 1 - pk.dead / 0.3 : pk.bounce ? 1 - pk.bounce / 0.75 : 1) * dimAt(head[0], head[1]);
    const stalled = pk.stall > 0.05 && !pk.bounce;
    if (stalled) fade *= 0.8;
    const sp = pk.red > 0.5 ? sprites.red : sprites[pk.color];
    const r = (small ? 13 : 16) * K * (pk.resp ? 0.8 : 1);
    const dir = pk.bounce ? -1 : 1;
    // comet tail
    const n = stalled ? 0 : small ? 6 : 8;
    for (let i = n; i >= 1; i--) {
      const dd = d - dir * i * 4.2 * K;
      if (dd < 0 || dd > L) continue;
      const p = pointAt(e.path, rev ? L - dd : dd);
      const k = 1 - i / (n + 1);
      ctx.globalAlpha = 0.5 * k * k * fade;
      const rr = r * (0.25 + 0.4 * k);
      ctx.drawImage(sp, p[0] - rr, p[1] - rr, rr * 2, rr * 2);
    }
    const p = head;
    ctx.globalAlpha = fade;
    ctx.drawImage(sp, p[0] - r, p[1] - r, r * 2, r * 2);
    ctx.fillStyle = pk.red > 0.5 ? '#ffe1dc' : pk.color === 'amber' ? '#fff0cc' : '#effbff';
    ctx.beginPath(); ctx.arc(p[0], p[1], (stalled ? 3.4 : pk.resp ? 1.8 : 2.4) * K, 0, Math.PI * 2); ctx.fill();
  }

  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    drawGridBoot();
    // camera: lean slightly toward the incident
    const fn = incidentNode ? NODES[incidentNode] : null;
    const z = 1 + incident * (small ? 0.03 : 0.05);
    if (fn && incident > 0.001) {
      const fx = W / 2 + (fn.px - W / 2) * 0.6, fy = H / 2 + (fn.py - H / 2) * 0.6;
      ctx.translate(fx, fy); ctx.scale(z, z); ctx.translate(-fx, -fy);
    }
    // incident glow under everything
    if (fn && incident > 0.01) {
      ctx.globalCompositeOperation = 'lighter';
      const pulse = 0.75 + 0.25 * Math.sin(clock * 7);
      const rr = S * 9;
      ctx.globalAlpha = 0.5 * incident * pulse;
      ctx.drawImage(sprites.haloR, fn.px - rr, fn.py - rr, rr * 2, rr * 2);
      ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
    }
    // edges: a soft conduit that warms as traffic passes, the wire, flow ticks
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    const sick = blocked();
    for (const e of EDGES) {
      if (e.draw <= 0.001 || e.alpha <= 0.01) continue;
      const p = e.path, hot = sick && e.a === 'otp' && e.b === 'sms';
      const mid = pointAt(p, p.len / 2), ea = e.alpha * (hot ? 1 : dimAt(mid[0], mid[1]));
      const tone = hot ? COL.red : e.fix ? COL.amber : COL.cyan;
      const dlen = p.len * e.draw;
      ctx.lineWidth = (small ? 8 : 11) * K;
      ctx.strokeStyle = rgba(tone, (0.035 + 0.11 * e.heat + (hot ? 0.12 : 0)) * ea);
      strokePartial(p, dlen);
      ctx.lineWidth = 1.5 * Math.max(0.9, K);
      ctx.strokeStyle = hot ? rgba(COL.red, 0.5) : e.fix ? rgba(COL.amber, 0.75) : rgba(COL.cyan, (0.26 + 0.34 * e.heat) * ea);
      strokePartial(p, dlen);
      if (e.draw < 1) {   // the pen tip while the wire draws in
        const q = pointAt(p, dlen), rr = 14 * K;
        ctx.globalCompositeOperation = 'lighter';
        ctx.drawImage(e.fix ? sprites.amber : sprites.cyan, q[0] - rr, q[1] - rr, rr * 2, rr * 2);
        ctx.globalCompositeOperation = 'source-over';
      } else if (!hot) {
        ctx.setLineDash([2, 16 * K]);
        ctx.lineDashOffset = -clock * 26 * K;
        ctx.lineWidth = 1.7 * K;
        ctx.strokeStyle = rgba(e.fix ? COL.amberHi : COL.ice, (0.22 + 0.25 * e.heat) * ea);
        strokePartial(p, p.len);
        ctx.setLineDash([]);
      }
    }
    // packets (additive)
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const pk of packets) drawPacket(pk);
    ctx.restore();
    // ripples and shockwaves
    for (const r of rings) {
      const t = r.t / r.dur, e = ease(t);
      ctx.strokeStyle = rgba(r.c, 0.75 * (1 - t));
      ctx.lineWidth = r.w * (1 - t * 0.6);
      ctx.beginPath(); ctx.arc(r.x, r.y, r.r0 + (r.r1 - r.r0) * e, 0, Math.PI * 2); ctx.stroke();
    }
    for (const id of IDS) drawNode(NODES[id]);
    for (const id of IDS) drawNote(NODES[id]);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }

  function drawNote(n) {
    const nt = n.note;
    if (!nt || n.a < 0.5) return;
    const a = Math.min(1, nt.t / 0.12, (nt.life - nt.t) / 0.3);
    const rise = ease(clamp(nt.t / 0.35)) * 6 * K;
    ctx.save();
    ctx.globalAlpha = clamp(a);
    ctx.font = `600 ${FS}px ${MONO}`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const tw = ctx.measureText(nt.text).width, h = FS + 12;
    const x = clamp(n.px, tw / 2 + 10, W - tw / 2 - 10), y = n.py - S - 12 * K - h / 2 - rise;
    ctx.fillStyle = 'rgba(9,20,32,0.92)';
    roundRect(x - tw / 2 - 8, y - h / 2, tw + 16, h, 6); ctx.fill();
    ctx.strokeStyle = rgba(nt.c, 0.75); ctx.lineWidth = 1; ctx.stroke();
    ctx.fillStyle = rgba(nt.c, 1);
    ctx.fillText(nt.text, x, y + 0.5);
    ctx.restore();
  }

  /* ---------- DOM: status line + live metrics ---------- */
  function setStatus(kind, text) {
    if (!statusEl) return;
    const key = kind + text;
    if (key === statusKey) return;
    statusKey = key;
    statusEl.dataset.kind = kind;
    statusEl.textContent = text;
  }
  function syncStatus() {
    let s = STATUS[0];
    for (const row of STATUS) if (lt >= row[0]) s = row;
    setStatus(s[1], s[2]);
  }
  function setMetric(key, text, state) {
    const m = metricEls[key];
    if (!m) return;
    if (m.text !== text) { m.text = text; m.b.textContent = text; }
    if (m.state !== state) { m.state = state; if (state) m.li.dataset.state = state; else delete m.li.dataset.state; }
  }
  function syncMetrics(dt, force) {
    metricsCd -= dt;
    if (metricsCd > 0 && !force) return;
    metricsCd = 0.12;
    const jit = (v, j) => (force ? v : v * (1 + (Math.random() - 0.5) * j));
    const rps = jit(M.rps, 0.04), p99 = jit(M.p99, 0.06), err = jit(M.err, 0.08);
    const fixing = (lt >= T.fixA && lt < T.calmA) || (lt >= T.fixB && lt < T.calmB);
    setMetric('rps', rps >= 1000 ? (rps / 1000).toFixed(2) + 'k' : Math.round(rps) + '', fixing ? 'fix' : '');
    setMetric('p99', p99 >= 1000 ? (p99 / 1000).toFixed(1) + ' s' : Math.round(p99) + ' ms', p99 > 500 ? 'bad' : fixing ? 'fix' : '');
    setMetric('err', (err >= 10 ? Math.round(err) : err.toFixed(1)) + '%', err > 2 ? 'bad' : fixing ? 'fix' : '');
  }

  function applyTransforms() {
    const y = window.scrollY || 0;
    const t = `translate3d(${(pmx * 6).toFixed(1)}px,${(y * 0.14 + pmy * 6).toFixed(1)}px,0)`;
    if (t !== lastStageT) {
      lastStageT = t;
      stage.style.transform = t;
      hero.style.setProperty('--mx', pmx.toFixed(3));
      hero.style.setProperty('--my', pmy.toFixed(3));
    }
    if (y !== lastScroll) {
      lastScroll = y;
      stage.style.opacity = y > 0 ? clamp(1 - y / ((hero.offsetHeight || 1) * 0.95)).toFixed(3) : '';
    }
  }

  /* ---------- loop control ---------- */
  function frame(now) {
    raf = 0;
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    clock += dt;
    update(dt);
    draw();
    syncStatus();
    syncMetrics(dt);
    applyTransforms();
    if (inView && pageVisible && !still) raf = requestAnimationFrame(frame);
  }
  function start() {
    if (raf || still || !inView || !pageVisible) return;
    last = performance.now();
    raf = requestAnimationFrame(frame);
  }
  function stop() { if (raf) cancelAnimationFrame(raf); raf = 0; }

  function renderStill() {
    stop();
    clock = 40; lt = T.calmB + 1.2; pointer = null; incident = 0; incidentNode = null;
    for (const id of IDS) {
      const n = NODES[id];
      Object.assign(n, { a: 1, ox: 0, oy: 0, flash: 0, hurt: 0, hover: 0, shake: 0, note: null });
      n.px = bx(n); n.py = by(n);
    }
    routeEdges();
    for (const e of EDGES) { e.draw = 1; e.alpha = e.base ? 0.15 : 1; e.heat = e.base ? 0 : 0.55; }
    packets = []; rings = [];
    const place = [['login', 0, .55], ['login', 1, .35], ['login', 2, .5], ['login', 3, .5], ['login', 4, .55], ['login', 1, .8],
      ['sess', 2, .6], ['sess', 0, .25], ['pay', 1, .55], ['pay', 2, .5], ['pay', 3, .45]];
    for (const [kind, seg, f] of place) {
      const pk = spawn(kind); if (!pk) continue;
      pk.seg = seg; const [e] = segEdge(pk); pk.d = e.path.len * f;
      if ((kind === 'login' && seg >= 4) || (kind === 'pay' && seg >= 2)) pk.color = 'amber';
    }
    for (const [kind, seg, f] of [['sess', 1, .45], ['pay', 0, .6], ['pay', 3, .4], ['sess', 2, .65]]) {
      const pk = spawn(kind, { resp: true }); if (!pk) continue;
      pk.seg = seg; const [e] = segEdge(pk); pk.d = e.path.len * f;
    }
    NODES.queue.flash = 0.5; NODES.idem.flash = 0.5; NODES.auth.flash = 0.4;
    draw();
    setStatus(STILL_STATUS[0], STILL_STATUS[1]);
    M.rps = 3720; M.p99 = 92; M.err = 0.1;
    syncMetrics(0, true);
  }

  function resize() {
    layout();
    if (still) renderStill();
    else if (!raf) { update(0); draw(); }
  }

  hero.addEventListener('pointermove', (ev) => {
    const r = canvas.getBoundingClientRect();
    pointer = [ev.clientX - r.left, ev.clientY - r.top];
    const hr = hero.getBoundingClientRect();
    mx = clamp(((ev.clientX - hr.left) / (hr.width || 1)) * 2 - 1, -1, 1);
    my = clamp(((ev.clientY - hr.top) / (hr.height || 1)) * 2 - 1, -1, 1);
  }, { passive: true });
  hero.addEventListener('pointerleave', () => { pointer = null; mx = my = 0; });

  if ('IntersectionObserver' in window) {
    new IntersectionObserver((entries) => {
      inView = entries[entries.length - 1].isIntersecting;
      inView ? start() : stop();
    }, { threshold: 0.02 }).observe(stage);
  }
  document.addEventListener('visibilitychange', () => {
    pageVisible = !document.hidden;
    pageVisible ? start() : stop();
  });
  const onMotionPref = () => {
    still = forceStill || mq.matches;
    if (still) renderStill(); else { packets = []; clock = LOOP0 + 0.01; start(); }
  };
  if (mq.addEventListener) mq.addEventListener('change', onMotionPref);

  if ('ResizeObserver' in window) new ResizeObserver(resize).observe(stage);
  else window.addEventListener('resize', resize);
  layout();
  if (still) renderStill(); else start();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { if (still) renderStill(); });
  window.addEventListener('scroll', () => { if (!raf && !still) applyTransforms(); }, { passive: true });
})();
