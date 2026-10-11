/* Architect Radio hero: a service graph that drafts itself, carries live
   traffic, breaks under load and gets fixed, one component at a time.
   Vanilla Canvas 2D. Pauses off-screen and in hidden tabs; draws one still,
   fully-fixed frame under prefers-reduced-motion. */
(() => {
  'use strict';
  const stage = document.querySelector('[data-hero-stage]');
  const canvas = document.querySelector('[data-hero-canvas]');
  if (!stage || !canvas || !canvas.getContext) return;
  const ctx = canvas.getContext('2d');
  const statusEl = document.querySelector('[data-hero-status]');
  const hero = stage.closest('.hero') || stage;
  const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
  const forceStill = /[?&]still\b/.test(location.search);
  let still = forceStill || mq.matches;

  const COL = {
    amber: [232, 168, 56], amberHi: [245, 185, 66], blue: [27, 152, 224],
    red: [229, 86, 76], text: [240, 244, 248], muted: [143, 163, 188],
  };
  const rgba = (c, a) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
  const clamp = (v, a = 0, b = 1) => (v < a ? a : v > b ? b : v);
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  const back = (t) => { const c = 1.6; t -= 1; return 1 + (c + 1) * t * t * t + c * t * t; };

  /* ---------- the system ---------- */
  // kind: client | svc | store | ext. `at` = draft order (s) on arrival.
  const NODES = {
    app:    { x: .03, y: .52, label: 'app', kind: 'client', at: 0.00 },
    gw:     { x: .22, y: .52, label: 'gateway', kind: 'svc', at: 0.20 },
    auth:   { x: .42, y: .30, label: 'auth', kind: 'svc', at: 0.42 },
    otp:    { x: .61, y: .10, label: 'otp', kind: 'svc', at: 0.66 },
    sms:    { x: .97, y: .10, label: 'sms provider', short: 'sms', kind: 'ext', at: 0.92 },
    sess:   { x: .76, y: .42, label: 'sessions', kind: 'store', at: 0.72 },
    ledger: { x: .66, y: .78, label: 'ledger', kind: 'store', at: 0.62 },
    db:     { x: .95, y: .78, label: 'db', kind: 'store', at: 0.94 },
    queue:  { x: .79, y: .10, label: 'queue', kind: 'svc', fix: 'A' },
    idem:   { x: .44, y: .78, label: 'idempotency', short: 'idem key', kind: 'svc', fix: 'B' },
  };
  const IDS = Object.keys(NODES);
  for (const id of IDS) Object.assign(NODES[id], { id, px: 0, py: 0, ox: 0, oy: 0, flash: 0, hurt: 0, hover: 0, a: 0, note: null });

  const EDGES = [
    { a: 'app', b: 'gw' }, { a: 'gw', b: 'auth' }, { a: 'auth', b: 'otp' },
    { a: 'otp', b: 'sms', base: 'A' }, { a: 'otp', b: 'queue', fix: 'A' }, { a: 'queue', b: 'sms', fix: 'A' },
    { a: 'auth', b: 'sess' },
    { a: 'gw', b: 'ledger', base: 'B', mx: 'idem' }, { a: 'gw', b: 'idem', fix: 'B', hv: true }, { a: 'idem', b: 'ledger', fix: 'B' },
    { a: 'ledger', b: 'db' },
  ];
  const EDGE = {};
  for (const e of EDGES) { e.path = null; e.draw = 0; e.alpha = 1; EDGE[e.a + '>' + e.b] = e; }

  /* ---------- story timeline (seconds into each loop) ---------- */
  const LOOP0 = 2.2;
  const T = { spikeA: 1.2, blockA: 2.0, fixA: 6.2, spikeEnd: 8.6, calmA: 9.2, stormB: 11.0, fixB: 14.6, stormEnd: 16.8, calmB: 17.4, reset: 20.2, end: 21.6 };
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
  let W = 0, H = 0, DPR = 1, K = 1, FS = 12, small = false;
  let clock = 0, lt = -1, last = 0, raf = 0;
  let inView = true, pageVisible = !document.hidden;
  let pointer = null;
  let packets = [], rings = [];
  const spawnAt = { login: 0, sess: 0.5, pay: 0.25 };
  let statusKey = '';
  let lastScroll = -1;

  const fixProg = (f) => {
    const t0 = f === 'A' ? T.fixA : T.fixB;
    if (lt < t0) return 0;
    if (lt < T.reset) return ease(clamp((lt - t0) / 0.8));
    return 1 - ease(clamp((lt - T.reset) / 0.9));
  };
  const fixOn = (f) => lt >= (f === 'A' ? T.fixA : T.fixB) + 0.35 && lt < T.reset;
  const blocked = () => lt >= T.blockA && lt < T.fixA + 0.5;
  const spike = () => lt >= T.spikeA && lt < T.spikeEnd;
  const storm = () => lt >= T.stormB && lt < T.stormEnd;

  /* ---------- glow sprites ---------- */
  const sprites = {};
  function makeSprite(name, c) {
    const s = 64, cv = document.createElement('canvas');
    cv.width = cv.height = s;
    const g = cv.getContext('2d');
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, rgba(c, 1));
    gr.addColorStop(0.16, rgba(c, 0.55));
    gr.addColorStop(0.45, rgba(c, 0.12));
    gr.addColorStop(1, rgba(c, 0));
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
    sprites[name] = cv;
  }
  makeSprite('amber', COL.amberHi); makeSprite('blue', COL.blue); makeSprite('red', COL.red);

  /* ---------- geometry ---------- */
  let padL = 24, padR = 30, padT = 24, padB = 60;
  function layout() {
    const r = stage.getBoundingClientRect();
    W = Math.max(1, Math.round(r.width)); H = Math.max(1, Math.round(r.height));
    small = W < 560;
    K = clamp(W / 760, 0.74, 1.08);
    FS = small ? 10.5 : 12;
    padL = small ? 22 : 30; padR = small ? 26 : 44; padT = small ? 20 : 26; padB = small ? 54 : 74;
    const area = W * H;
    DPR = Math.min(window.devicePixelRatio || 1, area > 420000 ? 1.5 : 2);
    canvas.width = Math.round(W * DPR); canvas.height = Math.round(H * DPR);
  }
  const nx = (n) => padL + n.x * (W - padL - padR) + n.ox;
  const ny = (n) => padT + n.y * (H - padT - padB) + n.oy;

  function buildPath(pts, r) {
    const out = [pts[0]];
    for (let i = 1; i < pts.length - 1; i++) {
      const p0 = pts[i - 1], p1 = pts[i], p2 = pts[i + 1];
      const l1 = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]), l2 = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
      if (l1 < 0.01 || l2 < 0.01) continue;
      const rr = Math.min(r, l1 / 2, l2 / 2);
      const ax = p1[0] + (p0[0] - p1[0]) / l1 * rr, ay = p1[1] + (p0[1] - p1[1]) / l1 * rr;
      const bx = p1[0] + (p2[0] - p1[0]) / l2 * rr, by = p1[1] + (p2[1] - p1[1]) / l2 * rr;
      for (let j = 0; j <= 6; j++) {
        const t = j / 6, u = 1 - t;
        out.push([u * u * ax + 2 * u * t * p1[0] + t * t * bx, u * u * ay + 2 * u * t * p1[1] + t * t * by]);
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
      const ax = A.px, ay = A.py, bx = B.px, by = B.py;
      let pts;
      if (Math.abs(ay - by) < 0.75) pts = [[ax, ay], [bx, by]];
      else if (e.hv) pts = [[ax, ay], [bx, ay], [bx, by]];
      else {
        const mx = e.mx ? NODES[e.mx].px : (ax + bx) / 2;
        pts = [[ax, ay], [mx, ay], [mx, by], [bx, by]];
      }
      e.path = buildPath(pts, 12 * K);
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
    const cap = small ? 46 : 72;
    if (packets.length >= cap) return null;
    const resp = !!(opts && opts.resp);
    const pk = {
      kind, resp, dup: !!(opts && opts.dup),
      route: resp ? respRoute(kind) : route(kind),
      seg: 0, d: (opts && opts.d) || 0,
      speed: (resp ? 150 : 128) * (0.9 + Math.random() * 0.2),
      color: resp ? 'blue' : 'amber', stall: 0, dead: 0,
    };
    packets.push(pk);
    return pk;
  }
  function note(n, text, c, life) { n.note = { text, c, t: 0, life }; }
  function ring(x, y, c, r1, dur) { if (rings.length < 24) rings.push({ x, y, c, r1, t: 0, dur }); }

  function arrive(pk, id) {
    const n = NODES[id];
    n.flash = 1;
    if (pk.dup && id === 'idem') { pk.dead = 1e-3; ring(n.px, n.py, COL.amber, 30 * K, 0.7); note(n, 'duplicate dropped', COL.amberHi, 1.1); return true; }
    if (pk.dup && id === 'ledger' && !pk.resp) { n.hurt = 1; pk.color = 'red'; ring(n.px, n.py, COL.red, 38 * K, 0.8); note(n, 'charged ×2', COL.red, 1.2); }
    return false;
  }

  function update(dt) {
    lt = clock < LOOP0 ? -1 : (clock - LOOP0) % T.end;
    // node draft-in progress + pointer spring
    for (const id of IDS) {
      const n = NODES[id];
      n.a = n.fix ? fixProg(n.fix) : clamp((clock - n.at * 1.15) / 0.5);
      let tx = 0, ty = 0, hv = 0;
      if (pointer) {
        const bx = padL + n.x * (W - padL - padR), by = padT + n.y * (H - padT - padB);
        const dx = bx - pointer[0], dy = by - pointer[1], d = Math.hypot(dx, dy) || 1, R = 150 * K;
        if (d < R) { const f = Math.pow(1 - d / R, 2) * 12 * K; tx = dx / d * f; ty = dy / d * f; }
        hv = d < 40 * K ? 1 : 0;
      }
      const s = Math.min(1, dt * 7);
      n.ox += (tx - n.ox) * s; n.oy += (ty - n.oy) * s;
      n.hover += (hv - n.hover) * Math.min(1, dt * 10);
      n.flash = Math.max(0, n.flash - dt * 2.8);
      n.hurt = Math.max(0, n.hurt - dt * 1.1);
      if (n.note) { n.note.t += dt; if (n.note.t > n.note.life) n.note = null; }
      n.px = nx(n); n.py = ny(n);
    }
    if (blocked()) { NODES.sms.hurt = 1; if (!NODES.sms.note && lt > T.blockA + 0.4) note(NODES.sms, 'timeout', COL.red, 1.4); }
    routeEdges();
    for (const e of EDGES) {
      if (e.fix) { e.draw = fixProg(e.fix); e.alpha = 1; }
      else {
        const t0 = Math.max(NODES[e.a].at, NODES[e.b].at * 0.6) * 1.15 + 0.1;
        e.draw = ease(clamp((clock - t0) / 0.55));
        e.alpha = e.base ? 1 - 0.8 * fixProg(e.base) : 1;
      }
    }

    // spawning
    if (clock > 1.3) {
      for (const kind of ['login', 'sess', 'pay']) {
        spawnAt[kind] -= dt;
        if (spawnAt[kind] > 0) continue;
        const base = kind === 'login' ? (spike() ? 0.2 : 0.85) : kind === 'sess' ? 1.3 : (storm() ? 0.75 : 1.05);
        spawnAt[kind] = base * (0.7 + Math.random() * 0.6);
        const pk = spawn(kind);
        if (pk && kind === 'pay' && storm()) { const twin = spawn('pay', { d: -16 * K }); if (twin) { twin.dup = true; twin.route = pk.route; } }
      }
      if (blocked() && Math.random() < dt * 1.6) ring(NODES.sms.px, NODES.sms.py, COL.red, 26 * K, 0.9);
    }

    // movement
    const isBlocked = blocked();
    const stalled = [];
    for (const pk of packets) {
      if (pk.dead) { pk.dead += dt; continue; }
      pk.d += pk.speed * K * dt;
      let [e] = segEdge(pk);
      while (e && pk.d >= e.path.len) {
        pk.d -= e.path.len; pk.seg++;
        if (arrive(pk, pk.route[pk.seg])) break;
        if (pk.seg >= pk.route.length - 1) {
          pk.dead = 1e-3;
          if (!pk.resp && (pk.kind === 'sess' || pk.kind === 'pay') && !pk.dup) spawn(pk.kind, { resp: true });
          break;
        }
        [e] = segEdge(pk);
      }
      if (!pk.dead && isBlocked && pk.route[pk.seg] === 'otp' && pk.route[pk.seg + 1] === 'sms') stalled.push(pk);
    }
    if (stalled.length) {
      const e = EDGE['otp>sms'], gap = 9 * K, end = e.path.len - 22 * K;
      stalled.sort((a, b) => b.d - a.d);
      stalled.forEach((pk, i) => {
        const lim = end - i * gap;
        if (pk.d >= lim) { pk.d = lim; pk.stall += dt; } else pk.stall = Math.max(0, pk.stall - dt);
        if (pk.stall > 0.5) pk.color = 'red';
      });
      if (stalled.length > 9 && stalled[0].stall > 0.8) {
        const pk = stalled[0], p = pointAt(e.path, pk.d);
        pk.dead = 1e-3; ring(p[0], p[1], COL.red, 14 * K, 0.5);
      }
    }
    if (!isBlocked) for (const pk of packets) if (pk.color === 'red' && pk.kind === 'login') pk.color = 'amber';
    packets = packets.filter((pk) => !pk.dead || pk.dead < 0.35);
    for (const r of rings) r.t += dt;
    rings = rings.filter((r) => r.t < r.dur);
  }

  /* ---------- drawing ---------- */
  function guides(n, c) {
    const t = n.fix ? clamp((lt - (n.fix === 'A' ? T.fixA : T.fixB)) / 1.1) : clamp((clock - n.at * 1.15) / 1.1);
    if (t <= 0 || t >= 1) return;
    const a = Math.sin(Math.PI * t) * 0.32;
    ctx.save();
    ctx.strokeStyle = rgba(c, a); ctx.lineWidth = 1; ctx.setLineDash([3, 5]);
    const reach = ease(clamp(t * 1.6));
    ctx.beginPath();
    ctx.moveTo(n.px - W * reach, n.py); ctx.lineTo(n.px + W * reach, n.py);
    ctx.moveTo(n.px, n.py - H * reach); ctx.lineTo(n.px, n.py + H * reach);
    ctx.stroke();
    ctx.setLineDash([]);
    // corner ticks, like a drafting stamp
    const s = 15 * K * (1.6 - 0.6 * ease(t));
    ctx.strokeStyle = rgba(c, a * 2);
    ctx.beginPath();
    for (const [sx, sy] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      ctx.moveTo(n.px + sx * s, n.py + sy * (s - 5)); ctx.lineTo(n.px + sx * s, n.py + sy * s); ctx.lineTo(n.px + sx * (s - 5), n.py + sy * s);
    }
    ctx.stroke();
    ctx.restore();
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

  function roundRect(x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
  }

  function drawNode(n) {
    if (n.a <= 0.001) return;
    const sc = n.fix ? ease(n.a) : back(n.a);
    const s = (small ? 12.5 : 17) * K * Math.max(0, sc);
    const hurt = n.hurt, isFix = !!n.fix;
    let stroke = rgba(COL.muted, 0.75);
    if (isFix) stroke = rgba(COL.amber, 0.95);
    if (n.hover > 0.05) stroke = rgba(COL.amberHi, 0.6 + 0.4 * n.hover);
    if (hurt > 0.05) stroke = rgba(COL.red, 0.5 + 0.5 * hurt);
    ctx.save();
    ctx.globalAlpha = clamp(n.a * 1.4);
    ctx.lineWidth = 1.4;
    ctx.fillStyle = '#132136';
    ctx.strokeStyle = stroke;
    const x = n.px, y = n.py;
    if (n.kind === 'client') {
      ctx.beginPath(); ctx.arc(x, y, s, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    } else if (n.kind === 'store') {
      const w = s * 1.1, h = s * 0.95, e = s * 0.34;
      ctx.beginPath();
      ctx.moveTo(x - w, y - h); ctx.lineTo(x - w, y + h);
      ctx.ellipse(x, y + h, w, e, 0, Math.PI, 0, true);
      ctx.lineTo(x + w, y - h);
      ctx.ellipse(x, y - h, w, e, 0, 0, Math.PI, true);
      ctx.fill(); ctx.stroke();
      ctx.beginPath(); ctx.ellipse(x, y - h, w, e, 0, 0, Math.PI * 2); ctx.stroke();
    } else {
      if (n.kind === 'ext') ctx.setLineDash([3, 3]);
      roundRect(x - s, y - s, 2 * s, 2 * s, 6 * K); ctx.fill(); ctx.stroke();
      ctx.setLineDash([]);
    }
    // core light: flashes when traffic lands
    const glow = Math.max(n.flash, n.hover * 0.6);
    const core = hurt > 0.05 ? COL.red : isFix ? COL.amberHi : glow > 0.05 ? COL.amberHi : COL.muted;
    ctx.fillStyle = rgba(core, 0.55 + 0.45 * Math.max(glow, hurt));
    ctx.beginPath(); ctx.arc(x, y + (n.kind === 'store' ? s * 0.12 : 0), 2.6 * K + glow * 1.4, 0, Math.PI * 2); ctx.fill();
    if (glow > 0.05 || hurt > 0.05) {
      ctx.globalCompositeOperation = 'lighter';
      const sp = hurt > 0.05 ? sprites.red : sprites.amber, r = (16 + 10 * Math.max(glow, hurt)) * K;
      ctx.globalAlpha = 0.35 * Math.max(glow, hurt) * clamp(n.a);
      ctx.drawImage(sp, x - r, y - r, 2 * r, 2 * r);
      ctx.globalCompositeOperation = 'source-over';
    }
    // label
    ctx.globalAlpha = clamp(n.a * 1.2 - 0.2);
    const label = small && n.short ? n.short : n.label;
    ctx.font = `500 ${FS}px "JetBrains Mono", ui-monospace, Menlo, monospace`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    const lit = Math.max(n.hover, n.flash * 0.5, isFix ? 0.8 : 0);
    ctx.fillStyle = hurt > 0.3 ? rgba([246, 176, 168], 1) : isFix ? rgba(COL.amberHi, 1) : rgba(lit > 0.2 ? COL.text : COL.muted, 1);
    let lx = x;
    const tw = ctx.measureText(label).width;
    lx = clamp(lx, tw / 2 + 2, W - tw / 2 - 2);
    ctx.fillText(label, lx, y + (small ? 12.5 : 17) * K * 1.25 + 7);
    ctx.restore();
  }

  function drawPacket(pk) {
    const [e, rev] = segEdge(pk);
    if (!e) return;
    const L = e.path.len, d = clamp(pk.d, 0, L);
    const fade = pk.dead ? 1 - pk.dead / 0.35 : 1;
    const sp = sprites[pk.color];
    const r = (small ? 15 : 17) * K;
    for (let i = 5; i >= 0; i--) {
      const dd = d - i * 6.5 * K;
      if (dd < 0) continue;
      const p = pointAt(e.path, rev ? L - dd : dd);
      const a = (i === 0 ? 1 : 0.5 - i * 0.085) * fade;
      const rr = r * (i === 0 ? 1 : 0.62 - i * 0.07);
      ctx.globalAlpha = a;
      ctx.drawImage(sp, p[0] - rr, p[1] - rr, rr * 2, rr * 2);
    }
    const p = pointAt(e.path, rev ? L - d : d);
    ctx.globalAlpha = fade;
    ctx.fillStyle = pk.color === 'red' ? '#ffd2cc' : pk.color === 'blue' ? '#d6efff' : '#fff1d2';
    ctx.beginPath(); ctx.arc(p[0], p[1], 2.5 * K, 0, Math.PI * 2); ctx.fill();
  }

  function draw() {
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    ctx.clearRect(0, 0, W, H);
    for (const id of IDS) { const n = NODES[id]; if (n.a > 0) guides(n, n.fix ? COL.amber : COL.blue); }
    // edges
    ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    for (const e of EDGES) {
      if (e.draw <= 0.001 || e.alpha <= 0.01) continue;
      const p = e.path;
      const hot = e.a === 'otp' && e.b === 'sms' && blocked();
      const tone = e.fix ? COL.amber : hot ? COL.red : COL.blue;
      // conduit: a soft wide channel under the wire
      ctx.lineWidth = 9 * K;
      ctx.strokeStyle = rgba(tone, (e.fix || hot ? 0.09 : 0.05) * e.alpha);
      strokePartial(p, p.len * e.draw);
      ctx.lineWidth = (e.fix ? 1.6 : 1.3) * Math.max(0.9, K);
      ctx.strokeStyle = e.fix ? rgba(COL.amber, 0.7) : hot ? rgba(COL.red, 0.62) : rgba(COL.muted, 0.38 * e.alpha);
      strokePartial(p, p.len * e.draw);
      if (e.draw >= 1 && !hot) {
        // flow direction: slow dashes travelling along the wire
        ctx.setLineDash([2, 14 * K]);
        ctx.lineDashOffset = -clock * 22 * K;
        ctx.lineWidth = 1.6 * K;
        ctx.strokeStyle = rgba(e.fix ? COL.amberHi : COL.blue, 0.4 * e.alpha);
        strokePartial(p, p.len);
        ctx.setLineDash([]);
      }
    }
    // packets
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const pk of packets) drawPacket(pk);
    ctx.restore();
    // rings
    for (const r of rings) {
      const t = r.t / r.dur;
      ctx.strokeStyle = rgba(r.c, 0.7 * (1 - t));
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(r.x, r.y, 6 * K + (r.r1 - 6 * K) * ease(t), 0, Math.PI * 2); ctx.stroke();
    }
    for (const id of IDS) drawNode(NODES[id]);
    for (const id of IDS) {
      const n = NODES[id], nt = n.note;
      if (!nt || n.a < 0.5) continue;
      const a = Math.min(1, nt.t / 0.15, (nt.life - nt.t) / 0.3);
      const rise = ease(clamp(nt.t / 0.4)) * 6 * K;
      ctx.save();
      ctx.globalAlpha = clamp(a);
      ctx.font = `600 ${FS}px "JetBrains Mono", ui-monospace, Menlo, monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'bottom';
      const tw = ctx.measureText(nt.text).width;
      const x = clamp(n.px, tw / 2 + 8, W - tw / 2 - 8), y = n.py - (small ? 12.5 : 17) * K - 8 - rise;
      ctx.fillStyle = 'rgba(9,20,32,0.85)';
      roundRect(x - tw / 2 - 7, y - FS - 7, tw + 14, FS + 10, 5); ctx.fill();
      ctx.strokeStyle = rgba(nt.c, 0.6); ctx.lineWidth = 1; ctx.stroke();
      ctx.fillStyle = rgba(nt.c, 1);
      ctx.fillText(nt.text, x, y);
      ctx.restore();
    }
  }

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

  function parallax() {
    const y = window.scrollY || 0;
    if (y === lastScroll) return;
    lastScroll = y;
    const h = hero.offsetHeight || 1;
    stage.style.transform = y > 0 ? `translate3d(0,${(y * 0.14).toFixed(1)}px,0)` : '';
    stage.style.opacity = y > 0 ? clamp(1 - y / (h * 0.95)).toFixed(3) : '';
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
    parallax();
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
    clock = 40; lt = T.calmB + 1.2; pointer = null;
    for (const id of IDS) { const n = NODES[id]; n.a = 1; n.ox = n.oy = n.flash = n.hurt = n.hover = 0; n.px = nx(n); n.py = ny(n); }
    routeEdges();
    for (const e of EDGES) { e.draw = 1; e.alpha = e.base ? 0.2 : 1; }
    packets = []; rings = [];
    const place = [['login', 0, .3], ['login', 2, .5], ['login', 3, .45], ['login', 4, .6], ['login', 1, .7],
      ['sess', 2, .55], ['sess', 0, .65], ['pay', 0, .2], ['pay', 1, .45], ['pay', 3, .5], ['pay', 2, .7]];
    for (const [kind, seg, f] of place) {
      const pk = spawn(kind); if (!pk) continue;
      pk.seg = seg; const [e] = segEdge(pk); pk.d = e.path.len * f;
    }
    for (const [kind, seg, f] of [['sess', 1, .4], ['pay', 0, .6], ['pay', 3, .35], ['sess', 2, .7]]) {
      const pk = spawn(kind, { resp: true }); if (!pk) continue;
      pk.seg = seg; const [e] = segEdge(pk); pk.d = e.path.len * f;
    }
    NODES.queue.flash = 0.6; NODES.idem.flash = 0.6;
    draw();
    setStatus(STILL_STATUS[0], STILL_STATUS[1]);
  }

  function resize() {
    layout();
    if (still) renderStill();
    else if (!raf) { update(0); draw(); }
  }

  hero.addEventListener('pointermove', (ev) => {
    const r = canvas.getBoundingClientRect();
    pointer = [ev.clientX - r.left, ev.clientY - r.top];
  }, { passive: true });
  hero.addEventListener('pointerleave', () => { pointer = null; });

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
  window.addEventListener('scroll', () => { if (!raf && !still) parallax(); }, { passive: true });
})();
