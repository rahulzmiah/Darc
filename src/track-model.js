// A page's animation laid out on one clock: the scroll track's moves and holds
// (⌘.), and the cursor path (⌘P) where it plays. On a page with lines, the
// path starts path.startAt ms in and plays over them, like a hand on the
// mouse while the page scrolls: the lines keep the scroll, and the path moves
// the pointer and clicks whatever is under it. With no lines, the path plays
// alone, scrolling as it was captured, after gliding from the top.
//
// Paths saved before that waited at a line instead (path.startAfter, and
// path.startDelay ms into its hold), the scroll paused while they played
// with their own. Old recordings are laid out as they played; modernize()
// converts a path to start at a time.
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

  // Whether the path plays over the lines, from path.startAt.
  const overlays = (stops, path) => !!path && path.startAt != null && stops.length > 0;

  // segs: [{ kind: 'move' | 'hold' | 'lead' | 'path', i, start, end, from, to, ease }]
  // i is the line for moves and holds. lines[i]: { start, arrive, depart } of
  // each line's move and hold. path: { start, body, end, tl, cue, overlay }
  // or null; a path over the lines has no segs of its own.
  function layout(stops, path, { startY = 0 } = {}) {
    const segs = [];
    const lines = [];
    const tl = path && path.anchors && path.anchors.length && CursorPath ? CursorPath.timeline(path) : null;
    const overlay = !!tl && overlays(stops, path);
    const cue = tl && !overlay ? cueOf(stops, path) : null;
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

    if (tl && cue == null && !overlay) {
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
    if (overlay) {
      const start = Math.max(0, Math.round(path.startAt));
      block = { start, body: start, end: start + tl.end, tl, cue: null, overlay: true };
    }
    const total = Math.max(t, block ? block.end : 0);

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
    // it glides into place first (scrollY), or over the lines, where the
    // lines have it (y). Null outside the path.
    function pathAt(time) {
      if (!block || time < block.start || time > block.end || (time === block.end && block.end < total)) return null;
      if (overlay) return { t: Math.min(tl.end, time - block.body), y: yAt(time) };
      if (time < block.body) return { t: 0, scrollY: yAt(time) };
      return { t: Math.min(tl.end, time - block.body) };
    }

    return { total, segs, lines, path: block, pathOnly: !!block && cue == null && !overlay, overlay, yAt, pathAt, segAt };
  }

  // A path that waited at a line (or started right away, skipping the
  // lines) made to start at a time instead, playing over the lines. Its
  // line's hold grows by however long it paused things, so everything after
  // keeps its time. { stops, path }, as they were when there's nothing to do.
  function modernize(stops, path) {
    if (!path || path.startAt != null || !stops.length) return { stops, path };
    const L = layout(stops, path);
    const next = { ...path };
    delete next.startAfter;
    delete next.startDelay;
    if (!L.path || L.path.cue == null) return { stops, path: { ...next, startAt: 0 } };
    const out = stops.map((s) => ({ ...s }));
    out[L.path.cue].hold = Math.round(Math.max(0, out[L.path.cue].hold) + (L.path.end - L.path.start));
    return { stops: out, path: { ...next, startAt: Math.round(L.path.body) } };
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

  const api = { layout, cubicBezier, cueOf, cueDelay, leadLen, modernize, overlays, removeLines };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.TrackModel = api;
})(typeof self !== 'undefined' ? self : this);
