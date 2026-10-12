// Cursor paths: a mouse movement captured over the page (⇧⌘E), fitted into an
// editable Bézier path, and played back into the page while recording.
//
// A path lives in viewport space, CSS px of the page view, the same box the
// recording sees. Scrolling is its own track on the same clock, so moving the
// path never touches the scroll and scrubbing to a moment puts both back as
// they were.
//
// path = {
//   version, viewport: { width, height }, duration (recorded ms),
//   anchors: [{
//     x, y, t,       // where, and when the pointer got there (recorded ms)
//     dwell,         // recorded ms it stayed put there
//     pause,         // extra ms added after it while editing; everything waits
//     hin, hout,     // Bézier handles, relative to the anchor
//     buttons,       // [{ at, wait, type: 'down' | 'up', button, count }]: at
//                    // is recorded ms after arriving, wait extra played ms
//   }],
//   segments: [{     // the move from anchors[i] to anchors[i + 1]
//     profile,       // fraction of the curve's length covered at evenly spaced
//                    // moments of the move, as recorded; null for linear
//     ease,          // 'recorded' | 'ease' | 'out' | 'linear'
//     scale,         // played duration / recorded duration
//   }],
//   scroll: [[t, y], ...] // the page's scroll position over recorded time
// }
//
// Edits only ever stretch or pause the shared clock, so the pointer and the
// scroll stay in step whatever is changed.
(function (root) {
  const PROFILE_POINTS = 25;
  const FIT_ERROR = 4; // px the fitted curve may stray from the hand's path
  const STILL_PX = 2; // movement under this is the hand at rest
  const DWELL_MS = 120; // resting at least this long makes an anchor
  const CLICK_SLOP = 4; // px a click may wander between down and up
  const LUT_STEPS = 64;
  const EASES = {
    ease: [0.65, 0, 0.35, 1],
    out: [0.22, 1, 0.36, 1],
  };

  // ---- Vectors and cubics ----------------------------------------------------
  const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
  const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
  const mul = (a, k) => ({ x: a.x * k, y: a.y * k });
  const dot = (a, b) => a.x * b.x + a.y * b.y;
  const len = (a) => Math.hypot(a.x, a.y);
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const norm = (a) => {
    const l = len(a);
    return l > 1e-9 ? mul(a, 1 / l) : { x: 0, y: 0 };
  };
  const lerp = (a, b, k) => a + (b - a) * k;
  const clamp01 = (v) => Math.max(0, Math.min(1, v));

  function bez(c, u) {
    const v = 1 - u;
    const b0 = v * v * v, b1 = 3 * v * v * u, b2 = 3 * v * u * u, b3 = u * u * u;
    return { x: c[0].x * b0 + c[1].x * b1 + c[2].x * b2 + c[3].x * b3, y: c[0].y * b0 + c[1].y * b1 + c[2].y * b2 + c[3].y * b3 };
  }

  function bezD1(c, u) {
    const v = 1 - u;
    const d = (i) => sub(c[i + 1], c[i]);
    return add(add(mul(d(0), 3 * v * v), mul(d(1), 6 * v * u)), mul(d(2), 3 * u * u));
  }

  function bezD2(c, u) {
    const a = sub(add(c[2], c[0]), mul(c[1], 2));
    const b = sub(add(c[3], c[1]), mul(c[2], 2));
    return add(mul(a, 6 * (1 - u)), mul(b, 6 * u));
  }

  // de Casteljau: the two halves of `c` either side of u.
  function splitCubic(c, u) {
    const p01 = add(c[0], mul(sub(c[1], c[0]), u));
    const p12 = add(c[1], mul(sub(c[2], c[1]), u));
    const p23 = add(c[2], mul(sub(c[3], c[2]), u));
    const a = add(p01, mul(sub(p12, p01), u));
    const b = add(p12, mul(sub(p23, p12), u));
    const m = add(a, mul(sub(b, a), u));
    return [[c[0], p01, a, m], [m, b, p23, c[3]]];
  }

  // Cumulative length along the curve, for moving along it by distance.
  function lengthTable(c) {
    const lut = [0];
    let prev = c[0];
    let total = 0;
    for (let i = 1; i <= LUT_STEPS; i++) {
      const p = bez(c, i / LUT_STEPS);
      total += dist(prev, p);
      lut.push(total);
      prev = p;
    }
    return { lut, total };
  }

  // The parameter u at fraction f of the curve's length.
  function uAt(table, f) {
    const { lut, total } = table;
    if (total <= 1e-9) return f;
    const target = clamp01(f) * total;
    let lo = 0, hi = LUT_STEPS;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (lut[mid] < target) lo = mid;
      else hi = mid;
    }
    const span = lut[hi] - lut[lo];
    return (lo + (span > 0 ? (target - lut[lo]) / span : 0)) / LUT_STEPS;
  }

  function fractionAt(table, u) {
    const { lut, total } = table;
    if (total <= 1e-9) return u;
    const i = Math.min(LUT_STEPS - 1, Math.floor(u * LUT_STEPS));
    return lerp(lut[i], lut[i + 1], u * LUT_STEPS - i) / total;
  }

  function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sx = (t) => ((ax * t + bx) * t + cx) * t;
    const sy = (t) => ((ay * t + by) * t + cy) * t;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let lo = 0, hi = 1, t = x;
      for (let i = 0; i < 40 && hi - lo > 1e-6; i++) {
        if (sx(t) < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
      return sy(t);
    };
  }
  const easeFns = Object.fromEntries(Object.entries(EASES).map(([k, v]) => [k, cubicBezier(...v)]));

  // ---- Profiles: fraction of the distance covered over a move's time -------
  function sampleProfile(profile, p) {
    if (!profile) return clamp01(p);
    const x = clamp01(p) * (profile.length - 1);
    const i = Math.min(profile.length - 2, Math.floor(x));
    return lerp(profile[i], profile[i + 1], x - i);
  }

  // Monotonic, from 0 to 1, at PROFILE_POINTS even steps of `fn` over [0, 1].
  function buildProfile(fn) {
    const out = [];
    let max = 0;
    for (let i = 0; i < PROFILE_POINTS; i++) {
      max = Math.max(max, clamp01(fn(i / (PROFILE_POINTS - 1))));
      out.push(max);
    }
    const end = out[out.length - 1];
    if (end <= 1e-6) return null;
    return out.map((v) => Math.round((v / end) * 1e4) / 1e4);
  }

  // ---- Fitting (Schneider, "An Algorithm for Automatically Fitting Digitized
  // Curves", Graphics Gems) -------------------------------------------------
  function chordParams(pts, first, last) {
    const u = [0];
    for (let i = first + 1; i <= last; i++) u.push(u[u.length - 1] + dist(pts[i], pts[i - 1]));
    const total = u[u.length - 1] || 1;
    return u.map((v) => v / total);
  }

  function generateBezier(pts, first, last, u, t1, t2) {
    const p0 = pts[first], p3 = pts[last];
    let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
    for (let i = 0; i < u.length; i++) {
      const v = 1 - u[i];
      const b0 = v * v * v, b1 = 3 * v * v * u[i], b2 = 3 * v * u[i] * u[i], b3 = u[i] * u[i] * u[i];
      const a0 = mul(t1, b1), a1 = mul(t2, b2);
      c00 += dot(a0, a0);
      c01 += dot(a0, a1);
      c11 += dot(a1, a1);
      const tmp = sub(pts[first + i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
      x0 += dot(a0, tmp);
      x1 += dot(a1, tmp);
    }
    const det = c00 * c11 - c01 * c01;
    let al = det ? (x0 * c11 - x1 * c01) / det : 0;
    let ar = det ? (c00 * x1 - c01 * x0) / det : 0;
    const seg = dist(p0, p3);
    if (al < 1e-6 * seg || ar < 1e-6 * seg) al = ar = seg / 3;
    return [p0, add(p0, mul(t1, al)), add(p3, mul(t2, ar)), p3];
  }

  function maxError(pts, first, last, c, u) {
    let max = 0;
    let split = Math.floor((last - first + 1) / 2) + first;
    for (let i = first + 1; i < last; i++) {
      const d = dist(bez(c, u[i - first]), pts[i]);
      if (d > max) {
        max = d;
        split = i;
      }
    }
    return { max, split };
  }

  function reparameterize(pts, first, c, u) {
    return u.map((ui, i) => {
      const d = sub(bez(c, ui), pts[first + i]);
      const d1 = bezD1(c, ui);
      const d2 = bezD2(c, ui);
      const den = dot(d1, d1) + dot(d, d2);
      return den ? clamp01(ui - dot(d, d1) / den) : ui;
    });
  }

  // Cubics through pts[first..last], with the index each ends at.
  function fitCubic(pts, first, last, t1, t2, out) {
    if (last - first === 1) {
      const d = dist(pts[first], pts[last]) / 3;
      out.push({ c: [pts[first], add(pts[first], mul(t1, d)), add(pts[last], mul(t2, d)), pts[last]], first, last });
      return;
    }
    let u = chordParams(pts, first, last);
    let c = generateBezier(pts, first, last, u, t1, t2);
    let { max, split } = maxError(pts, first, last, c, u);
    if (max < FIT_ERROR) {
      out.push({ c, first, last });
      return;
    }
    if (max < FIT_ERROR * 4) {
      for (let i = 0; i < 12; i++) {
        u = reparameterize(pts, first, c, u);
        c = generateBezier(pts, first, last, u, t1, t2);
        ({ max, split } = maxError(pts, first, last, c, u));
        if (max < FIT_ERROR) {
          out.push({ c, first, last });
          return;
        }
      }
    }
    const center = norm(sub(pts[split - 1], pts[split + 1]));
    fitCubic(pts, first, split, t1, center, out);
    fitCubic(pts, split, last, mul(center, -1), t2, out);
  }

  // Where along `c` (as a fraction of its length) each sample lies, walking
  // forward so a path that crosses itself doesn't jump back.
  function sampleFractions(c, samples) {
    const table = lengthTable(c);
    const pts = [];
    for (let i = 0; i <= LUT_STEPS * 2; i++) pts.push(bez(c, i / (LUT_STEPS * 2)));
    let from = 0;
    return samples.map((s) => {
      let best = from, bestD = Infinity;
      for (let i = from; i < pts.length && i <= from + LUT_STEPS; i++) {
        const d = dist(pts[i], s);
        if (d < bestD) {
          bestD = d;
          best = i;
        }
      }
      from = best;
      return fractionAt(table, best / (pts.length - 1));
    });
  }

  // The recorded timing of a move along `c` through samples[a..b].
  function recordedProfile(c, samples, a, b) {
    const t0 = samples[a].t, t1 = samples[b].t;
    if (t1 - t0 <= 0) return null;
    const run = samples.slice(a, b + 1);
    const f = sampleFractions(c, run);
    f[0] = 0;
    f[f.length - 1] = 1;
    const times = run.map((s) => (s.t - t0) / (t1 - t0));
    return buildProfile((p) => {
      let i = 0;
      while (i < times.length - 2 && times[i + 1] < p) i++;
      const span = times[i + 1] - times[i];
      return span > 0 ? lerp(f[i], f[i + 1], (p - times[i]) / span) : f[i + 1];
    });
  }

  // Drop points that move the scroll track by less than eps (Ramer–Douglas–Peucker).
  function simplifyTrack(track, eps) {
    if (track.length < 3) return track;
    const keep = new Array(track.length).fill(false);
    keep[0] = keep[track.length - 1] = true;
    const stack = [[0, track.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop();
      let max = 0, idx = -1;
      for (let i = a + 1; i < b; i++) {
        const k = (track[i][0] - track[a][0]) / (track[b][0] - track[a][0] || 1);
        const d = Math.abs(track[i][1] - lerp(track[a][1], track[b][1], k));
        if (d > max) {
          max = d;
          idx = i;
        }
      }
      if (max > eps) {
        keep[idx] = true;
        stack.push([a, idx], [idx, b]);
      }
    }
    return track.filter((_, i) => keep[i]);
  }

  // capture = { viewport, samples: [[t, x|null, y|null, scrollY]], clicks: [{ t, type, x, y, button, count }] }
  function fit(capture) {
    const raw = capture.samples || [];
    const firstIn = raw.findIndex((s) => s[1] != null);
    if (firstIn < 0 || raw.length < 2) return null;
    // Before the pointer first comes over the page, it waits where it enters.
    let last = { x: raw[firstIn][1], y: raw[firstIn][2] };
    const t0 = raw[0][0];
    const samples = raw.map((s) => {
      if (s[1] != null) last = { x: s[1], y: s[2] };
      return { t: s[0] - t0, x: last.x, y: last.y, sy: s[3] };
    });
    const n = samples.length;
    const indexAt = (t) => {
      let i = 0;
      while (i < n - 1 && samples[i].t < t) i++;
      return i;
    };

    // Stations: the stretches of samples the pointer rests on. Everything in
    // between becomes curves.
    const stations = [[0, 0], [n - 1, n - 1]];
    for (let i = 0; i < n - 1;) {
      let j = i;
      while (j + 1 < n && dist(samples[j + 1], samples[i]) <= STILL_PX) j++;
      if (j > i && samples[j].t - samples[i].t >= DWELL_MS) {
        stations.push([i, j]);
        i = j;
      } else i++;
    }
    const clicks = (capture.clicks || []).map((c) => ({ ...c, t: c.t - t0, i: indexAt(c.t - t0) }));
    for (const c of clicks) {
      samples[c.i] = { ...samples[c.i], x: c.x, y: c.y };
    }
    for (const c of clicks) {
      if (c.type !== 'down') {
        stations.push([c.i, c.i]);
        continue;
      }
      // A click holds the pointer still from down to up, unless it's a drag.
      const up = clicks.find((u) => u.type === 'up' && u.t >= c.t && u.button === c.button);
      const still = up && samples.slice(c.i, up.i + 1).every((s) => dist(s, samples[c.i]) <= CLICK_SLOP);
      stations.push(still ? [c.i, up.i] : [c.i, c.i]);
    }
    stations.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const s of stations) {
      const prev = merged[merged.length - 1];
      if (prev && s[0] <= prev[1]) prev[1] = Math.max(prev[1], s[1]);
      else merged.push([...s]);
    }
    // Snap each resting stretch onto the spot it started from.
    for (const [a, b] of merged) {
      for (let i = a + 1; i <= b; i++) samples[i] = { ...samples[i], x: samples[a].x, y: samples[a].y };
    }

    const anchors = [];
    const segments = [];
    const station = (a, b) => {
      const s = samples[a];
      const buttons = clicks
        .filter((c) => c.i >= a && c.i <= b)
        .map((c) => ({ at: Math.max(0, Math.round(c.t - s.t)), wait: 0, type: c.type, button: c.button || 'left', count: c.count || 1 }));
      return { x: s.x, y: s.y, t: s.t, dwell: samples[b].t - s.t, pause: 0, hin: { x: 0, y: 0 }, hout: { x: 0, y: 0 }, buttons };
    };
    anchors.push(station(...merged[0]));
    for (let k = 1; k < merged.length; k++) {
      const a = merged[k - 1][1], b = merged[k][0];
      // The run of distinct points between the two stations, keeping which
      // sample each came from for its time.
      const pts = [];
      const idx = [];
      for (let i = a; i <= b; i++) {
        const p = { x: samples[i].x, y: samples[i].y };
        if (pts.length && dist(p, pts[pts.length - 1]) < 0.5) {
          // The run ends on b even when it's a hair from the last point kept.
          if (i === b && pts.length > 1) {
            pts[pts.length - 1] = p;
            idx[idx.length - 1] = b;
          }
          continue;
        }
        pts.push(p);
        idx.push(i);
      }
      const cubics = [];
      if (pts.length < 2) {
        // Didn't move: a move of no length that still takes its time.
        const p = pts[0];
        cubics.push({ c: [p, p, p, p], first: 0, last: 1 });
        idx[1] = b;
      } else {
        const t1 = norm(sub(pts[Math.min(2, pts.length - 1)], pts[0]));
        const t2 = norm(sub(pts[Math.max(0, pts.length - 3)], pts[pts.length - 1]));
        fitCubic(pts, 0, pts.length - 1, t1, t2, cubics);
      }
      cubics.forEach((cu, ci) => {
        const sa = idx[cu.first], sb = idx[cu.last];
        const prev = anchors[anchors.length - 1];
        prev.hout = sub(cu.c[1], cu.c[0]);
        segments.push({ profile: recordedProfile(cu.c, samples, sa, sb), ease: 'recorded', scale: 1 });
        const next = ci === cubics.length - 1
          ? station(...merged[k])
          : { x: cu.c[3].x, y: cu.c[3].y, t: samples[sb].t, dwell: 0, pause: 0, hin: { x: 0, y: 0 }, hout: { x: 0, y: 0 }, buttons: [] };
        next.hin = sub(cu.c[2], cu.c[3]);
        anchors.push(next);
      });
    }

    const round = (v) => Math.round(v * 100) / 100;
    for (const an of anchors) {
      for (const k of ['x', 'y', 't', 'dwell']) an[k] = round(an[k]);
      an.hin = { x: round(an.hin.x), y: round(an.hin.y) };
      an.hout = { x: round(an.hout.x), y: round(an.hout.y) };
    }
    const scroll = simplifyTrack(samples.map((s) => [Math.round(s.t), round(s.sy)]), 0.5);
    return trimRest({
      version: 1,
      viewport: capture.viewport,
      duration: Math.round(samples[n - 1].t),
      anchors,
      segments,
      scroll,
    });
  }

  // ---- Playback ---------------------------------------------------------------
  const cubicOf = (path, i) => {
    const a = path.anchors[i], b = path.anchors[i + 1];
    return [{ x: a.x, y: a.y }, add(a, a.hout), add(b, b.hin), { x: b.x, y: b.y }];
  };

  function scrollAt(path, t) {
    const s = path.scroll;
    if (!s.length) return 0;
    if (t <= s[0][0]) return s[0][1];
    if (t >= s[s.length - 1][0]) return s[s.length - 1][1];
    let lo = 0, hi = s.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (s[mid][0] <= t) lo = mid;
      else hi = mid;
    }
    const span = s[hi][0] - s[lo][0];
    return lerp(s[lo][1], s[hi][1], span > 0 ? (t - s[lo][0]) / span : 0);
  }

  const segmentEase = (seg) => (seg.ease === 'recorded' ? (p) => sampleProfile(seg.profile, p) : seg.ease === 'linear' ? clamp01 : easeFns[seg.ease] || clamp01);

  // Fraction of a move's time at which it has covered fraction f of the curve.
  function invertEase(fn, f) {
    let lo = 0, hi = 1;
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (fn(mid) < f) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }

  // Lays the path out in played time. Each anchor plays its dwell (as
  // recorded), then its pause (frozen), then the move to the next anchor
  // (recorded time stretched by the segment's scale).
  function timeline(path) {
    const pieces = [];
    const arrivals = [];
    const tables = [];
    let T = 0;
    path.anchors.forEach((a, i) => {
      arrivals.push(T);
      if (a.dwell > 0) pieces.push({ kind: 'dwell', i, start: T, len: a.dwell, r0: a.t, r1: a.t + a.dwell });
      T += a.dwell;
      if (a.pause > 0) pieces.push({ kind: 'pause', i, start: T, len: a.pause, r0: a.t + a.dwell, r1: a.t + a.dwell });
      T += a.pause;
      if (i < path.anchors.length - 1) {
        const r0 = a.t + a.dwell, r1 = path.anchors[i + 1].t;
        const seg = path.segments[i];
        const c = cubicOf(path, i);
        const table = lengthTable(c);
        tables.push(table);
        const plen = Math.max(0, (r1 - r0) * (seg.scale || 1));
        pieces.push({ kind: 'move', i, start: T, len: plen, r0, r1, c, table, ease: segmentEase(seg) });
        T += plen;
      }
    });
    const total = T;

    function pieceAt(t) {
      for (const p of pieces) if (t < p.start + p.len) return p;
      return pieces[pieces.length - 1] || null;
    }

    // Pointer and scroll at played time t.
    function at(t) {
      t = Math.max(0, Math.min(total, t));
      const p = pieceAt(t);
      if (!p) {
        const a = path.anchors[0];
        return { x: a.x, y: a.y, sy: scrollAt(path, 0), anchor: 0 };
      }
      const k = p.len > 0 ? clamp01((t - p.start) / p.len) : 1;
      const rt = lerp(p.r0, p.r1, k);
      if (p.kind !== 'move') {
        const a = path.anchors[p.i];
        return { x: a.x, y: a.y, sy: scrollAt(path, rt), anchor: p.i };
      }
      const pt = bez(p.c, uAt(p.table, p.ease(k)));
      return { x: pt.x, y: pt.y, sy: scrollAt(path, rt), segment: p.i };
    }

    // Played time of recorded time r, at the start of any pause there.
    function playedAt(r) {
      for (const p of pieces) {
        if (p.kind === 'pause') {
          if (r <= p.r0) return p.start - (p.r0 - r);
          continue;
        }
        if (r <= p.r1) return p.r1 > p.r0 ? p.start + ((r - p.r0) / (p.r1 - p.r0)) * p.len : p.start;
      }
      return total;
    }

    // Button presses and releases, in played time.
    const events = [];
    path.anchors.forEach((a, i) => {
      for (const b of a.buttons || []) {
        events.push({ T: Math.min(total, playedAt(a.t + b.at) + (b.wait || 0)), type: b.type, button: b.button, count: b.count, anchor: i });
      }
    });
    events.sort((a, b) => a.T - b.T || (a.type === 'down' ? -1 : 1));
    // A click that navigated away often ends the capture before its release.
    const held = new Map();
    for (const e of events) held.set(e.button, e.type === 'down' ? e : null);
    for (const e of held.values()) {
      if (e) events.push({ ...e, T: e.T + 80, type: 'up' });
    }
    const end = Math.max(total, ...events.map((e) => e.T));

    // The moment on the path nearest (x, y): { t, d, segment, f }.
    function nearest(x, y) {
      let best = null;
      const q = { x, y };
      pieces.forEach((p) => {
        if (p.kind !== 'move') {
          const a = path.anchors[p.i];
          const d = dist(a, q);
          if (!best || d < best.d) best = { t: p.start, d, anchor: p.i };
          return;
        }
        for (let s = 0; s <= LUT_STEPS; s++) {
          const u = s / LUT_STEPS;
          const d = dist(bez(p.c, u), q);
          if (!best || d < best.d) best = { d, segment: p.i, u, piece: p };
        }
      });
      if (best && best.piece) {
        const p = best.piece;
        best.f = fractionAt(p.table, best.u);
        best.t = p.start + invertEase(p.ease, best.f) * p.len;
        delete best.piece;
      }
      if (best && path.anchors.length === 1) best.t = 0;
      return best;
    }

    return { total, end, pieces, arrivals, events, at, nearest, playedAt };
  }

  // ---- Editing ----------------------------------------------------------------
  const clone = (path) => JSON.parse(JSON.stringify(path));

  // A new anchor on segment i, f of the way along it. The curve keeps its shape.
  function insertAnchor(path, i, f) {
    const out = clone(path);
    const seg = out.segments[i];
    const c = cubicOf(out, i);
    const table = lengthTable(c);
    const [left, right] = splitCubic(c, uAt(table, f));
    const fn = segmentEase(seg);
    const p = invertEase(fn, f);
    const a = out.anchors[i], b = out.anchors[i + 1];
    const r0 = a.t + a.dwell;
    const t = r0 + p * (b.t - r0);
    a.hout = sub(left[1], left[0]);
    b.hin = sub(right[2], right[3]);
    const anchor = { x: left[3].x, y: left[3].y, t, dwell: 0, pause: 0, hin: sub(left[2], left[3]), hout: sub(right[1], right[0]), buttons: [] };
    // The original timing, cut in two. Out of 'recorded', a split eased move
    // just plays each half linearly in arc, so keep the fraction curve exact.
    const profile = (lo, hi, flo, fhi) => buildProfile((q) => (fhi - flo > 1e-9 ? (fn(lerp(lo, hi, q)) - flo) / (fhi - flo) : q));
    const first = { ...seg, profile: profile(0, p, 0, f), ease: 'recorded' };
    const second = { ...seg, profile: profile(p, 1, f, 1), ease: 'recorded' };
    out.anchors.splice(i + 1, 0, anchor);
    out.segments.splice(i, 1, first, second);
    return out;
  }

  // Drop an anchor; its neighbours join up with their own handles. The moves
  // either side, and its dwell, become one move over the same recorded time,
  // so the scroll and everything after keep their time, but the pointer no
  // longer stops where it was: between two points it has to stop at anyway
  // (the ends, clicks, pauses) it glides from one to the other; otherwise it
  // keeps the recorded pace either side, without the rest. Two moves with the
  // same ease keep it.
  function removeAnchor(path, i) {
    if (i <= 0 || i >= path.anchors.length - 1) return path;
    const out = clone(path);
    const a = out.anchors[i - 1], m = out.anchors[i], b = out.anchors[i + 1];
    const s1 = out.segments[i - 1], s2 = out.segments[i];
    const L1 = lengthTable(cubicOf(out, i - 1)).total;
    const L2 = lengthTable(cubicOf(out, i)).total;
    const d1 = m.t - (a.t + a.dwell), dw = m.dwell, d2 = b.t - (m.t + m.dwell);
    const D = d1 + dw + d2;
    const f1 = segmentEase(s1), f2 = segmentEase(s2);
    const L = L1 + L2;
    const stop = (j) => j === 0 || j === out.anchors.length - 1 || out.anchors[j].pause > 0 || (out.anchors[j].buttons || []).length > 0;
    const same = s1.ease === s2.ease && s1.ease !== 'recorded';
    let ease = same ? s1.ease : 'recorded';
    let profile = null;
    if (!same && L > 1e-9 && D > 0) {
      if (stop(i - 1) && stop(i + 1)) profile = buildProfile(glide);
      else {
        const run = d1 + d2;
        profile = run > 0
          ? buildProfile((q) => {
            const t = q * run;
            if (t < d1) return (f1(d1 > 0 ? t / d1 : 1) * L1) / L;
            return (L1 + f2(d2 > 0 ? (t - d1) / d2 : 1) * L2) / L;
          })
          : null;
      }
    }
    if (!same && !profile) ease = 'linear';
    const scale = D > 0 ? (d1 * (s1.scale || 1) + dw + d2 * (s2.scale || 1)) / D : 1;
    out.anchors.splice(i, 1);
    out.segments.splice(i - 1, 2, { profile, ease, scale: Math.round(scale * 1000) / 1000 });
    return out;
  }

  // The path without the rest at either end: the hand sitting still before
  // it first moves, and after its last move (or its last click there). The
  // clock (and the scroll on it) starts at the first move.
  function trimRest(path) {
    const A = path.anchors;
    if (!A || A.length < 2) return path;
    const first = A[0], last = A[A.length - 1];
    const lead = (first.buttons || []).length ? 0 : first.dwell;
    const lastUp = Math.max(0, ...(last.buttons || []).map((b) => b.at + 250));
    const tail = (last.buttons || []).length ? Math.max(0, last.dwell - lastUp) : last.dwell;
    if (!lead && !tail) return path;
    const out = clone(path);
    const round = (v) => Math.round(v * 100) / 100;
    out.anchors.forEach((a, i) => i && (a.t = round(a.t - lead)));
    out.anchors[0].dwell -= lead;
    out.anchors[out.anchors.length - 1].dwell -= tail;
    out.scroll = (out.scroll || []).map(([t, y]) => [Math.round(t - lead), y]).filter(([t]) => t >= 0);
    if (out.scroll.length && out.scroll[0][0] > 0) out.scroll.unshift([0, scrollAt(path, lead)]);
    out.duration = Math.round(Math.max(0, path.duration - lead - tail));
    return out;
  }

  // A button's played ms after its point is arrived at.
  const pressAt = (b) => b.at + (b.wait || 0);

  // The rest after the last point: its dwell and pause, in played ms.
  function tail(path) {
    const a = path.anchors[path.anchors.length - 1];
    return a.dwell + a.pause;
  }

  // The shortest that rest can be: until its last click lets go.
  function tailMin(path) {
    const bs = path.anchors[path.anchors.length - 1].buttons || [];
    return bs.length ? Math.max(...bs.map(pressAt)) + 80 : 0;
  }

  // The rest after the last point made ms long. Shorter cuts the added pause,
  // then the recorded rest; longer adds pause. Its clicks keep their moment.
  function setTail(path, ms) {
    const out = clone(path);
    const a = out.anchors[out.anchors.length - 1];
    ms = Math.round(Math.max(tailMin(path), ms));
    if (ms >= a.dwell) a.pause = ms - a.dwell;
    else {
      a.pause = 0;
      a.dwell = ms;
      out.duration = Math.round(Math.min(out.duration, a.t + ms));
    }
    for (const b of a.buttons || []) {
      const off = pressAt(b);
      b.at = Math.min(off, a.dwell);
      b.wait = Math.round(off - b.at);
    }
    return out;
  }

  // Point i's clicks moved by d played ms, kept within its rest (dwell, then
  // pause) and keeping their spacing.
  function moveClicks(path, i, d) {
    const out = clone(path);
    const a = out.anchors[i];
    const bs = a.buttons || [];
    if (!bs.length) return out;
    const offs = bs.map(pressAt);
    d = Math.min(d, a.dwell + a.pause - Math.max(...offs));
    d = Math.max(d, -Math.min(...offs));
    bs.forEach((b, k) => {
      const off = Math.round(offs[k] + d);
      b.at = Math.min(off, a.dwell);
      b.wait = off - b.at;
    });
    return out;
  }

  // Recorded time at played time T (the start of a pause for any moment in it).
  function recordedAt(tl, T) {
    for (const p of tl.pieces) {
      if (T <= p.start + p.len) return p.len > 0 ? lerp(p.r0, p.r1, clamp01((T - p.start) / p.len)) : p.r0;
    }
    const last = tl.pieces[tl.pieces.length - 1];
    return last ? last.r1 : 0;
  }

  // Minimum jerk: how a hand eases into and out of a reach.
  const glide = (k) => k * k * k * (10 + k * (6 * k - 15));

  // One unbroken movement: the pointer eases out of each point it has to stop
  // at (the first, the last, clicks and pauses) and sweeps through every
  // point between without slowing, its handles lined up so the curve has no
  // corners. A wait before the first move goes too. Each stretch keeps its
  // played length, so the path takes as long as before and the scroll stays
  // in step, spread evenly over the stretch.
  function smooth(path) {
    const out = clone(path);
    const A = out.anchors;
    if (A.length < 2) return out;
    const tl = timeline(path);
    const clicks = (a) => (a.buttons || []).length > 0;
    const stop = (i) => i === 0 || i === A.length - 1 || A[i].pause > 0 || clicks(A[i]);
    for (let j = 1; j < A.length - 1; j++) {
      if (stop(j)) continue;
      const a = A[j];
      let dir = norm(sub(a.hout, a.hin));
      if (!len(dir)) dir = norm(sub(A[j + 1], A[j - 1]));
      const lin = len(a.hin) || dist(a, A[j - 1]) / 3;
      const lout = len(a.hout) || dist(a, A[j + 1]) / 3;
      a.hin = mul(dir, -lin);
      a.hout = mul(dir, lout);
    }
    const round = (v) => Math.round(v * 100) / 100;
    for (const an of A) {
      an.hin = { x: round(an.hin.x), y: round(an.hin.y) };
      an.hout = { x: round(an.hout.x), y: round(an.hout.y) };
    }
    let a = 0;
    for (let b = 1; b < A.length; b++) {
      if (!stop(b)) continue;
      const fold = a === 0 && !clicks(A[0]) ? A[0].dwell : 0;
      const keep = A[a].dwell - fold;
      const P = tl.arrivals[b] - (tl.arrivals[a] + A[a].dwell + A[a].pause) + fold;
      const R0 = A[a].t + keep, R = A[b].t - R0;
      const lens = [];
      for (let k = a; k < b; k++) lens.push(lengthTable(cubicOf(out, k)).total);
      const L = lens.reduce((s, v) => s + v, 0);
      if (P > 0 && R > 0 && L > 1e-6) {
        A[a].dwell = keep;
        const F = [0];
        for (const l of lens) F.push(F[F.length - 1] + l / L);
        F[F.length - 1] = 1;
        const K = F.map((f, m) => (m === 0 ? 0 : m === F.length - 1 ? 1 : invertEase(glide, f)));
        for (let m = 1; m < b - a; m++) {
          A[a + m].t = round(R0 + K[m] * R);
          A[a + m].dwell = 0;
        }
        const scale = Math.round((P / R) * 1000) / 1000;
        for (let m = 0; m < b - a; m++) {
          const df = F[m + 1] - F[m];
          const profile = buildProfile((q) => (df > 1e-9 ? (glide(lerp(K[m], K[m + 1], q)) - F[m]) / df : q));
          out.segments[a + m] = { ...out.segments[a + m], profile, ease: 'recorded', scale };
        }
      }
      a = b;
    }
    return out;
  }

  // The path played over about `ms`: its moves stretch or shrink together,
  // keeping their proportions, while rests, pauses and clicks keep their time.
  // No move gets quicker than minScale times its recorded speed.
  function stretch(path, ms, minScale = 0.05) {
    const tl = timeline(path);
    const moves = tl.pieces.reduce((s, p) => s + (p.kind === 'move' ? p.len : 0), 0);
    if (moves <= 0) return path;
    const kMin = Math.max(0, ...path.segments.map((seg) => minScale / (seg.scale || 1)));
    const k = Math.max(kMin, Math.max(0, ms - (tl.end - moves)) / moves);
    const out = clone(path);
    for (const seg of out.segments) seg.scale = Math.round((seg.scale || 1) * k * 1000) / 1000;
    return out;
  }

  // The shortest the path can play in (as stretch allows).
  function minLength(path, minScale = 0.05) {
    return timeline(stretch(path, 0, minScale)).end;
  }

  const api = { fit, timeline, insertAnchor, removeAnchor, smooth, stretch, trimRest, minLength, tail, tailMin, setTail, moveClicks, recordedAt, cubicOf, bez, EASES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CursorPath = api;
})(typeof self !== 'undefined' ? self : this);
