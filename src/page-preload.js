// Smooth-scroll engine. Takes over wheel + keyboard scrolling and drives every
// scroll with a critically damped spring (or exponential ease-out), so motion
// eases in and out like keyframed animation instead of stepping per tick.
const { ipcRenderer } = require('electron');

let settings = ipcRenderer.sendSync('settings:get');
ipcRenderer.on('settings', (_e, s) => {
  settings = s;
});

const LINE_HEIGHT = 40;
const animations = new Map(); // scroller element -> animation state
let rafId = 0;
let lastFrame = 0;

const root = () => document.scrollingElement || document.documentElement;

function maxScroll(el) {
  return { x: el.scrollWidth - el.clientWidth, y: el.scrollHeight - el.clientHeight };
}

function isScrollable(el, axis) {
  const max = maxScroll(el)[axis];
  if (max <= 0) return false;
  const prop = axis === 'y' ? 'overflowY' : 'overflowX';
  if (el === root()) {
    return getComputedStyle(document.documentElement)[prop] !== 'hidden'
      && (!document.body || getComputedStyle(document.body)[prop] !== 'hidden');
  }
  const overflow = getComputedStyle(el)[prop];
  return overflow === 'auto' || overflow === 'scroll' || overflow === 'overlay';
}

// Would scrolling `el` by `delta` on `axis` actually move it (taking any
// in-flight animation into account)?
function canScrollBy(el, axis, delta) {
  if (!delta || !isScrollable(el, axis)) return false;
  const anim = animations.get(el);
  const pos = anim ? anim.target[axis] : axis === 'y' ? el.scrollTop : el.scrollLeft;
  return delta > 0 ? pos < maxScroll(el)[axis] - 0.5 : pos > 0.5;
}

function findScroller(path, dx, dy) {
  for (const node of path) {
    if (!(node instanceof Element) || node === document.body || node === document.documentElement) continue;
    if (canScrollBy(node, 'y', dy) || canScrollBy(node, 'x', dx)) return node;
  }
  const r = root();
  return canScrollBy(r, 'y', dy) || canScrollBy(r, 'x', dx) ? r : null;
}

function pathFrom(el) {
  const path = [];
  for (let n = el; n; n = n.parentElement || (n.getRootNode && n.getRootNode().host)) path.push(n);
  return path;
}

// Sites running their own smooth-scroll library already animate; let them.
function siteHasOwnSmoothScroll() {
  const cl = document.documentElement.classList;
  return cl.contains('lenis') || cl.contains('has-scroll-smooth');
}

function stateFor(el) {
  let s = animations.get(el);
  const actual = { x: el.scrollLeft, y: el.scrollTop };
  if (!s) {
    s = { pos: { ...actual }, target: { ...actual }, vel: { x: 0, y: 0 }, written: { ...actual } };
    animations.set(el, s);
  } else {
    // Something else moved it (scrollbar drag, page script) — follow along.
    for (const a of ['x', 'y']) {
      const drift = actual[a] - s.written[a];
      if (Math.abs(drift) > 2) {
        s.pos[a] += drift;
        s.target[a] += drift;
        s.written[a] = actual[a];
      }
    }
  }
  return s;
}

function scrollBy(el, dx, dy) {
  const s = stateFor(el);
  const max = maxScroll(el);
  s.target.x = Math.max(0, Math.min(max.x, s.target.x + dx));
  s.target.y = Math.max(0, Math.min(max.y, s.target.y + dy));
  if (!rafId) {
    lastFrame = performance.now();
    rafId = requestAnimationFrame(frame);
  }
}

function frame(now) {
  const dt = Math.max(1 / 240, Math.min((now - lastFrame) / 1000, 1 / 20));
  lastFrame = now;
  const duration = Math.max(settings.smoothness, 16) / 1000;
  const spring = settings.easing !== 'exponential';
  const omega = 6 / duration; // spring is ~98% settled after `duration`
  const decay = Math.exp(-dt / (duration / 4.6)); // exponential: ~99% after `duration`
  const decaySpring = Math.exp(-omega * dt);
  const vmax = settings.maxVelocity > 0 ? settings.maxVelocity : Infinity;

  for (const [el, s] of animations) {
    if (!el.isConnected) {
      animations.delete(el);
      continue;
    }
    const max = maxScroll(el);
    let done = true;
    for (const a of ['x', 'y']) {
      s.target[a] = Math.max(0, Math.min(max[a], s.target[a]));
      const x0 = s.pos[a] - s.target[a];
      const v0 = s.vel[a];
      let x, v;
      if (spring) {
        // Exact solution of a critically damped spring — stable at any frame rate.
        const b = v0 + omega * x0;
        x = (x0 + b * dt) * decaySpring;
        v = (v0 - omega * b * dt) * decaySpring;
      } else {
        x = x0 * decay;
        v = (x - x0) / dt;
      }
      if (Math.abs(v) > vmax) {
        v = Math.sign(v) * vmax;
        x = x0 + v * dt;
      }
      if (Math.abs(x) < 0.5 && Math.abs(v) < 20) {
        x = 0;
        v = 0;
      } else {
        done = false;
      }
      s.pos[a] = s.target[a] + x;
      s.vel[a] = v;
    }
    el.scrollTo({ left: s.pos.x, top: s.pos.y, behavior: 'instant' });
    s.written.x = el.scrollLeft;
    s.written.y = el.scrollTop;
    if (done) animations.delete(el);
  }

  rafId = animations.size ? requestAnimationFrame(frame) : 0;
}

// Chromium on macOS reports trackpad wheel events with wheelDelta === -3 * delta;
// notched mouse wheels don't. Keep the classification sticky within a gesture.
let lastWheel = { time: 0, trackpad: false };
function isTrackpad(e) {
  const now = performance.now();
  let trackpad;
  if (now - lastWheel.time < 120) trackpad = lastWheel.trackpad;
  else {
    trackpad = e.deltaMode === 0 && (
      (e.wheelDeltaY !== 0 && Math.abs(e.wheelDeltaY + 3 * e.deltaY) < 1)
      || (e.wheelDeltaX !== 0 && Math.abs(e.wheelDeltaX + 3 * e.deltaX) < 1)
    );
  }
  lastWheel = { time: now, trackpad };
  return trackpad;
}

// Bubble phase on window: runs after the site's own handlers, so anything the
// page already claimed (maps, carousels, custom scrollers) is left alone.
window.addEventListener('wheel', (e) => {
  if (playback) stopPlayback();
  if (e.defaultPrevented || e.ctrlKey || siteHasOwnSmoothScroll()) return;
  const unit = e.deltaMode === 1 ? LINE_HEIGHT : e.deltaMode === 2 ? window.innerHeight : 1;
  const speed = isTrackpad(e) ? settings.trackpadSpeed : settings.mouseSpeed;
  const dx = e.deltaX * unit * speed;
  const dy = e.deltaY * unit * speed;
  const el = findScroller(e.composedPath(), dx, dy);
  if (!el) return;
  e.preventDefault();
  scrollBy(el, dx, dy);
}, { passive: false });

function isEditable(el) {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

window.addEventListener('keydown', (e) => {
  if (playback && e.key === 'Escape') {
    e.preventDefault();
    e.stopImmediatePropagation();
    stopPlayback();
    return;
  }
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  if (isEditable(active)) return;

  // Space plays the page's scroll animation (or stops it) instead of paging,
  // so recordings don't need the animation panel on screen.
  if (e.key === ' ') {
    e.preventDefault();
    if (!e.repeat) {
      if (playback) stopPlayback();
      else ipcRenderer.send('anim:play');
    }
    return;
  }

  const page = window.innerHeight * 0.85;
  const step = 120 * settings.keyboardSpeed;
  let dx = 0;
  let dy = 0;
  switch (e.key) {
    case 'ArrowDown': dy = step; break;
    case 'ArrowUp': dy = -step; break;
    case 'ArrowRight': dx = step; break;
    case 'ArrowLeft': dx = -step; break;
    case 'PageDown': dy = page; break;
    case 'PageUp': dy = -page; break;
    case 'Home': dy = -Infinity; break;
    case 'End': dy = Infinity; break;
    default: return;
  }
  const start = active && active !== document.body ? active : document.body || document.documentElement;
  const el = findScroller(pathFrom(start), Math.sign(dx), Math.sign(dy));
  if (!el) return;
  e.preventDefault();
  const max = maxScroll(el);
  scrollBy(el, Math.max(-max.x, Math.min(max.x, dx)), Math.max(-max.y, Math.min(max.y, dy)));
});

// Scripted scroll animation from the animation panel: ease from wherever the
// page is to each stop in turn with per-stop cubic-bezier curves, durations and holds.
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

let playback = null;

function stopPlayback() {
  if (!playback) return;
  cancelAnimationFrame(playback.raf);
  playback = null;
  ipcRenderer.send('anim:progress', { playing: false });
}

function play(stops) {
  stopPlayback();
  const el = root();
  animations.delete(el);
  const segments = [];
  let t = 0;
  stops.forEach((stop, i) => {
    const duration = Math.max(0, stop.duration);
    const from = i ? stops[i - 1].y : el.scrollTop;
    segments.push({ start: t, end: t + duration, from, to: stop.y, ease: cubicBezier(...stop.easing), index: i });
    t += duration;
    segments.push({ start: t, end: t + Math.max(0, stop.hold), from: stop.y, to: stop.y, ease: (p) => p, index: i });
    t += Math.max(0, stop.hold);
  });
  playback = { segments, total: t, start: performance.now(), raf: 0 };
  const tick = (now) => {
    const elapsed = now - playback.start;
    const seg = segments.find((s) => elapsed < s.end) || segments[segments.length - 1];
    const p = seg.end > seg.start ? Math.min(1, Math.max(0, (elapsed - seg.start) / (seg.end - seg.start))) : 1;
    const y = Math.max(0, Math.min(maxScroll(el).y, seg.from + (seg.to - seg.from) * seg.ease(p)));
    el.scrollTo({ top: y, behavior: 'instant' });
    ipcRenderer.send('anim:progress', { playing: true, y, elapsed: Math.min(elapsed, t), total: t, index: seg.index });
    if (elapsed >= t) stopPlayback();
    else playback.raf = requestAnimationFrame(tick);
  };
  tick(playback.start);
}

ipcRenderer.on('anim:play', (_e, stops) => play(stops));
ipcRenderer.on('anim:stop', stopPlayback);
// Selecting a marker in the animation panel glides the page to it.
ipcRenderer.on('anim:seek', (_e, y) => {
  stopPlayback();
  const el = root();
  const s = stateFor(el);
  s.target.y = Math.max(0, Math.min(maxScroll(el).y, y));
  if (!rafId) {
    lastFrame = performance.now();
    rafId = requestAnimationFrame(frame);
  }
});
ipcRenderer.on('anim:get-scroll', () => {
  const el = root();
  const anim = !playback && animations.get(el);
  ipcRenderer.send('anim:scroll', Math.round(anim ? anim.target.y : el.scrollTop));
});
