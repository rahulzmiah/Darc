// A page's animation laid out on one clock: the scroll track's moves and holds
// (⌘.), and the cursor path (⌘P) where it plays. A path that starts at line N
// plays as the move to that line ends, or path.startDelay ms into its hold
// (no further than the hold goes): the page glides to where the path
// begins, the path plays (its own scroll and all), then the line's hold and
// the next move carry on from wherever the path left the page. A path that
// starts right away plays alone, after gliding from the top.
//
// Playback (page-preload.js and path.html) runs the same steps; this is what
// the panel and the timeline draw and scrub, and what cursor spans are timed
// against. Previews start from the top, as a recording that reloads does.
(function (root) {
  const CursorPath = root.CursorPath || (typeof require === 'function' ? require('./cursor-path') : null);

  function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
    const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
    const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
    const sampleY = (t) => ((ay * t + by) * t + cy) * t;
    const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
    return (x) => {
      if (x <= 0) return 0;
      if (x >= 1) return 1;
      let t = x;
      for (let i = 0; i < 8; i++) {
        const err = sampleX(t) - x;
        if (Math.abs(err) < 1e-6) return sampleY(t);
        const d = slopeX(t);
        if (Math.abs(d) < 1e-6) break;
        t -= err / d;
      }
      let lo = 0, hi = 1;
      t = x;
      while (hi - lo > 1e-6) {
        if (sampleX(t) < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
      return sampleY(t);
    };
  }

  // The glide to where a path begins (path.html's leadIn).
  const easeInOut = (k) => (k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2);
  function leadLen(from, to) {
    const d = Math.abs(to - from);
    return d < 2 ? 0 : Math.min(1800, 450 + Math.sqrt(d) * 16);
  }

  // The line a path starts at, or null when it starts right away (or its line is gone).
  function cueOf(stops, path) {
    return path && path.startAfter != null && path.startAfter < stops.length ? path.startAfter : null;
  }

  // How far into its line's hold the path starts.
  function cueDelay(stops, path) {
    const cue = cueOf(stops, path);
    return cue == null ? 0 : Math.max(0, Math.min(path.startDelay || 0, Math.max(0, stops[cue].hold)));
  }

  const linear = (p) => p;

  // segs: [{ kind: 'move' | 'hold' | 'lead' | 'path', i, start, end, from, to, ease }]
  // i is the line for moves and holds. lines[i]: { start, arrive, depart } of
  // each line's move and hold. path: { start, body, end, tl, cue } or null.
  function layout(stops, path, { startY = 0 } = {}) {
    const segs = [];
    const lines = [];
    const tl = path && path.anchors && path.anchors.length && CursorPath ? CursorPath.timeline(path) : null;
    const cue = tl ? cueOf(stops, path) : null;
    let t = 0;
    let at = startY;
    let block = null;

    function addPath() {
      const sy0 = tl.at(0).sy;
      const lead = leadLen(at, sy0);
      const start = t;
      if (lead) segs.push({ kind: 'lead', i: -1, start: t, end: t + lead, from: at, to: sy0, ease: easeInOut });
      t += lead;
      const body = t;
      segs.push({ kind: 'path', i: -1, start: t, end: t + tl.end, from: sy0, to: tl.at(tl.end).sy, ease: linear });
      t += tl.end;
      at = tl.at(tl.end).sy;
      block = { start, body, end: t, tl, cue };
    }

    if (tl && cue == null) {
      addPath();
    } else {
      stops.forEach((s, i) => {
        const line = { start: t };
        const duration = Math.max(0, s.duration);
        segs.push({ kind: 'move', i, start: t, end: t + duration, from: at, to: s.y, ease: cubicBezier(...s.easing) });
        t += duration;
        at = s.y;
        line.arrive = t;
        let hold = Math.max(0, s.hold);
        if (i === cue) {
          // The hold up to the path (maybe none), the path, then the rest of it.
          const delay = cueDelay(stops, path);
          segs.push({ kind: 'hold', i, start: t, end: t + delay, from: at, to: at, ease: linear });
          t += delay;
          hold -= delay;
          addPath();
        }
        segs.push({ kind: 'hold', i, start: t, end: t + hold, from: at, to: at, ease: linear });
        t += hold;
        line.depart = t;
        lines.push(line);
      });
    }
    const total = t;

    function segAt(time) {
      return segs.find((s) => time < s.end) || segs[segs.length - 1] || null;
    }

    // Where the page is scrolled to at time t.
    function yAt(time) {
      const s = segAt(time);
      if (!s) return startY;
      if (s.kind === 'path') return tl.at(Math.max(0, time - s.start)).sy;
      const p = s.end > s.start ? Math.min(1, Math.max(0, (time - s.start) / (s.end - s.start))) : 1;
      return s.from + (s.to - s.from) * s.ease(p);
    }

    // The path at time t: its own played time, plus the page's scroll while
    // it glides into place first. Null outside the path.
    function pathAt(time) {
      if (!block || time < block.start || time > block.end || (time === block.end && block.end < total)) return null;
      if (time < block.body) return { t: 0, scrollY: yAt(time) };
      return { t: Math.min(tl.end, time - block.body) };
    }

    return { total, segs, lines, path: block, pathOnly: !!block && cue == null, yAt, pathAt, segAt };
  }

  // Where a path dragged to start at time `want` (ms) can start: right away,
  // or anywhere from a line's arrival to the end of its hold. Within `snap`
  // ms of an arrival it starts right on it. { cue, delay, t }
  function pathSlot(stops, want, snap = 0) {
    const bare = layout(stops, null);
    let best = { cue: null, delay: 0, t: 0, d: Math.abs(want) };
    bare.lines.forEach((ln, i) => {
      const hold = Math.max(0, stops[i].hold);
      let delay = Math.max(0, Math.min(hold, want - ln.arrive));
      if (delay < snap) delay = 0;
      const t = ln.arrive + delay;
      const d = Math.abs(want - t);
      if (d < best.d) best = { cue: i, delay: Math.round(delay), t, d };
    });
    return best;
  }

  // The stops without the lines in `gone` (a Set of indices). Each removed
  // line's move and hold go into the next kept line's move, so the lines
  // after it still arrive when they did.
  function removeLines(stops, gone) {
    const out = [];
    let carry = 0;
    stops.forEach((s, i) => {
      if (gone.has(i)) {
        carry += Math.max(0, s.duration) + Math.max(0, s.hold);
        return;
      }
      out.push(carry ? { ...s, duration: Math.max(0, s.duration) + carry } : s);
      carry = 0;
    });
    return out;
  }

  const api = { layout, cubicBezier, cueOf, cueDelay, leadLen, pathSlot, removeLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TrackModel = api;
})(typeof self !== 'undefined' ? self : this);
