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

// `cue`: the line a cursor path starts at. Playback waits there, as the move
// to it ends, until the path has played (anim:resume).
function play(stops, cue) {
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
  const cueAt = cue != null && segments[cue * 2] ? segments[cue * 2].end : null;
  playback = { segments, total: t, start: performance.now(), raf: 0, cueAt, paused: null, tick: null };
  const tick = (now) => {
    let elapsed = now - playback.start;
    const cued = playback.cueAt != null && elapsed >= playback.cueAt;
    if (cued) elapsed = playback.cueAt;
    const seg = segments.find((s) => elapsed < s.end) || segments[segments.length - 1];
    const p = seg.end > seg.start ? Math.min(1, Math.max(0, (elapsed - seg.start) / (seg.end - seg.start))) : 1;
    const y = Math.max(0, Math.min(maxScroll(el).y, seg.from + (seg.to - seg.from) * seg.ease(p)));
    el.scrollTo({ top: y, behavior: 'instant' });
    ipcRenderer.send('anim:progress', { playing: true, y, elapsed: Math.min(elapsed, t), total: t, index: seg.index });
    if (cued) {
      playback.cueAt = null;
      playback.paused = elapsed;
      ipcRenderer.send('anim:cue');
    } else if (elapsed >= t) stopPlayback();
    else playback.raf = requestAnimationFrame(tick);
  };
  playback.tick = tick;
  tick(playback.start);
}

// The cursor path has played: carry on from wherever it left the page, so the
// rest of the line's hold and the next move start there instead of jumping back.
function resumePlayback() {
  if (!playback || playback.paused == null) return;
  const el = root();
  const elapsed = playback.paused;
  const y = el.scrollTop;
  const i = playback.segments.findIndex((s) => elapsed < s.end || s.end === elapsed);
  for (const s of playback.segments.slice(Math.max(0, i))) {
    if (s.start < elapsed || s.from === s.to) {
      s.from = s.to = y; // the rest of the hold
      continue;
    }
    s.from = y; // the next move
    break;
  }
  playback.paused = null;
  playback.start = performance.now() - elapsed;
  playback.raf = requestAnimationFrame(playback.tick);
}

ipcRenderer.on('anim:play', (_e, stops, cue) => play(stops, cue));
ipcRenderer.on('anim:resume', resumePlayback);
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
// A cursor path sets the scroll position outright, every frame it plays and
// wherever it's scrubbed to.
ipcRenderer.on('path:scroll', (_e, y) => {
  if (playback && playback.paused == null) stopPlayback(); // not one waiting on the path
  const el = root();
  animations.delete(el);
  el.scrollTo({ top: y, behavior: 'instant' });
});
ipcRenderer.on('anim:get-scroll', () => {
  const el = root();
  const anim = !playback && animations.get(el);
  ipcRenderer.send('anim:scroll', Math.round(anim ? anim.target.y : el.scrollTop));
});

// While recording, report the root scroll velocity every frame so the
// recorder can add motion blur along the direction of travel. The pointer
// goes out on the same frames, while recording or while the live cursor is on.
let motion = false;
let motionRaf = 0;
let motionLast = null;
let motionMoving = false;
function motionFrame(now) {
  if (!motion && !live.on && !pathActive) {
    motionRaf = 0;
    return;
  }
  const el = root();
  const pos = { x: el.scrollLeft, y: el.scrollTop, t: now };
  if (motion && motionLast) {
    const dt = (now - motionLast.t) / 1000;
    if (dt > 0) {
      const dx = pos.x - motionLast.x;
      const dy = pos.y - motionLast.y;
      // A jump of half a screen or more in one frame is a teleport (page
      // transition, anchor link, scroll restore), not motion to blur.
      const jump = Math.abs(dx) > innerWidth / 2 || Math.abs(dy) > innerHeight / 2;
      const vx = jump ? 0 : dx / dt;
      const vy = jump ? 0 : dy / dt;
      const moving = vx !== 0 || vy !== 0;
      if (moving || motionMoving || jump) ipcRenderer.send('rec:velocity', { vx, vy, jump });
      motionMoving = moving;
    }
  }
  motionLast = pos;
  pointerFrame();
  motionRaf = requestAnimationFrame(motionFrame);
}
// While a cursor path plays or is edited, the pointer goes out too, so the
// path view draws the page's own cursor shape.
let pathActive = false;
ipcRenderer.on('path:active', (_e, on) => {
  pathActive = !!on;
  pointerSent = '';
  if (pathActive && !motionRaf) motionRaf = requestAnimationFrame(motionFrame);
});

ipcRenderer.on('rec:motion', (_e, on) => {
  motion = !!on;
  motionLast = null;
  pointerSent = '';
  cursorImagesSent.clear();
  if (motion && !motionRaf) motionRaf = requestAnimationFrame(motionFrame);
});

// The recorder also gets the mouse position over the page and the CSS cursor
// under it, for the pointer it draws into the footage (tab capture has none).
// The live cursor window gets the same, to draw the smoothed pointer on screen.
let pointer = null; // { x, y, inside } from the last mouse event
let pointerSent = '';
let buttonDown = false; // a mouse button is held over the page
let pressed = false; // went down since the last frame, so quick clicks still show
const cursorImages = new Map(); // CSS cursor url -> data URL, null if unfetchable, or a pending fetch
const cursorIds = new Map(); // CSS cursor url -> short id used on the wire
const cursorImagesSent = new Set(); // ids already handed to this recording

window.addEventListener('mousemove', (e) => {
  pointer = { x: e.clientX, y: e.clientY, inside: true };
}, { capture: true, passive: true });
window.addEventListener('mousedown', () => {
  buttonDown = pressed = true;
}, { capture: true, passive: true });
window.addEventListener('mouseup', () => {
  buttonDown = false;
}, { capture: true, passive: true });
window.addEventListener('mouseout', (e) => {
  if (!e.relatedTarget && pointer) pointer = { ...pointer, inside: false };
}, { capture: true, passive: true });
window.addEventListener('mouseover', () => {
  if (pointer) pointer = { ...pointer, inside: true };
}, { capture: true, passive: true });

function cursorImage(url) {
  if (cursorImages.has(url)) return cursorImages.get(url);
  if (url.startsWith('data:')) {
    cursorImages.set(url, url);
    return url;
  }
  const pending = fetch(url)
    .then((r) => r.blob())
    .then((blob) => new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    }))
    .catch(() => null)
    .then((data) => {
      cursorImages.set(url, data);
      return data;
    });
  cursorImages.set(url, pending);
  return pending;
}

// CSS cursor keywords -> the macOS shapes in cursor-shapes.js. Anything not
// listed draws the arrow.
const CURSOR_KEYWORDS = {
  pointer: 'pointer',
  grab: 'grab',
  grabbing: 'grabbing',
  text: 'text',
  'vertical-text': 'text',
  crosshair: 'cross',
  cell: 'cross',
  'context-menu': 'menu',
  'zoom-in': 'zoom-in',
  'zoom-out': 'zoom-out',
  move: 'move',
  'all-scroll': 'move',
  wait: 'beachball',
  'col-resize': 'col-resize',
  'row-resize': 'row-resize',
  'ew-resize': 'ew-resize',
  'ns-resize': 'ns-resize',
  'e-resize': 'resize-right',
  'w-resize': 'resize-left',
  'n-resize': 'resize-up',
  's-resize': 'resize-down',
  'nwse-resize': 'nwse-resize',
  'nw-resize': 'nwse-resize',
  'se-resize': 'nwse-resize',
  'nesw-resize': 'nesw-resize',
  'ne-resize': 'nesw-resize',
  'sw-resize': 'nesw-resize',
};

// `cursor: auto` is an I-beam over selectable text and in text fields, like
// the real pointer, and the arrow elsewhere.
function autoCursor(el, x, y) {
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return 'text';
  if (el.tagName === 'INPUT') return /^(button|submit|reset|checkbox|radio|range|color|file|image)$/.test(el.type) ? 'default' : 'text';
  if (getComputedStyle(el).userSelect === 'none') return 'default';
  const range = document.caretRangeFromPoint && document.caretRangeFromPoint(x, y);
  const node = range && range.startContainer;
  if (!node || node.nodeType !== Node.TEXT_NODE) return 'default';
  const r = document.createRange();
  r.selectNodeContents(node);
  for (const rect of r.getClientRects()) {
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return 'text';
  }
  return 'default';
}

// Reduce a computed `cursor` value to what the recorder can draw. Image
// cursors are fetched in the background; the keyword fallback shows meanwhile.
function cursorShape(value, el, x, y) {
  const m = /url\((["']?)(.*?)\1\)\s*(-?[\d.]+)?\s*(-?[\d.]+)?/.exec(value);
  if (m) {
    const url = m[2];
    const data = cursorImage(url);
    if (typeof data === 'string') {
      if (!cursorIds.has(url)) cursorIds.set(url, cursorIds.size + 1);
      const id = cursorIds.get(url);
      if (!cursorImagesSent.has(id)) {
        cursorImagesSent.add(id);
        ipcRenderer.send('rec:cursor-image', { id, data });
      }
      return { type: 'url', id, hx: +m[3] || 0, hy: +m[4] || 0 };
    }
  }
  const keyword = value.replace(/url\([^)]*\)[^,]*,?/g, '').trim().split(/\s*,\s*/).pop();
  if (keyword === 'none') return { type: 'none' };
  if (keyword === 'auto') return { type: autoCursor(el, x, y) };
  return { type: CURSOR_KEYWORDS[keyword] || 'default' };
}

function pointerFrame() {
  if (!pointer) return;
  let shape = { type: 'default' };
  if (pointer.inside) {
    const el = document.elementFromPoint(pointer.x, pointer.y);
    if (el) shape = cursorShape(cssCursor(el), el, pointer.x, pointer.y);
  }
  const msg = { x: pointer.x / innerWidth, y: pointer.y / innerHeight, inside: pointer.inside, shape, down: buttonDown || pressed };
  pressed = false;
  const key = JSON.stringify(msg);
  if (key === pointerSent) return;
  pointerSent = key;
  ipcRenderer.send('rec:pointer', msg);
}

// ---- Live cursor -------------------------------------------------------------
// With the live cursor on, the page's mouse input comes from the cursor window,
// already smoothed. The pointer and the CSS cursor under it go back to that
// window every frame, so it draws the right shape. [ and ] change how smooth.
let live = ipcRenderer.sendSync('cursor:live-get'); // { keys, on }

// The cursor window can't hide the system pointer (it never has focus), so
// the page does: it's under the pointer as far as macOS is concerned, and it
// gets the smoothed mouse moves, so its `cursor: none` is what shows.
const HIDE_ATTR = 'data-darc-live-cursor';
const hideStyle = document.createElement('style');
// The :not(#_) pairs outweigh the page's own `cursor: … !important` rules.
hideStyle.textContent = `:root[${HIDE_ATTR}]:not(#_):not(#_), :root[${HIDE_ATTR}]:not(#_):not(#_) * { cursor: none !important; }`;
let cursorEl = null; // element whose CSS cursor is cached while hidden
let cursorValue = 'auto';

function applyLiveCursor() {
  const html = document.documentElement;
  if (!html) return;
  if (live.on) {
    if (!hideStyle.isConnected) html.appendChild(hideStyle);
    if (!html.hasAttribute(HIDE_ATTR)) html.setAttribute(HIDE_ATTR, '');
  } else {
    html.removeAttribute(HIDE_ATTR);
    hideStyle.remove();
  }
}

// The page's own CSS cursor for `el`. While the pointer is hidden that means
// briefly lifting the hiding rule, so it's only read again when the element
// under the pointer changes or a button goes down or up.
function cssCursor(el) {
  if (!live.on) return getComputedStyle(el).cursor || 'auto';
  applyLiveCursor(); // the page may have replaced <html> or its attributes
  if (el !== cursorEl) {
    const html = document.documentElement;
    html.removeAttribute(HIDE_ATTR);
    cursorValue = getComputedStyle(el).cursor || 'auto';
    html.setAttribute(HIDE_ATTR, '');
    cursorEl = el;
  }
  return cursorValue;
}
for (const type of ['mousedown', 'mouseup']) {
  window.addEventListener(type, () => { cursorEl = null; }, { capture: true, passive: true });
}

// Clicking the live cursor view takes focus from the page for a moment before
// it's handed back. The page doesn't hear about that: losing focus would close
// menus and pickers mid-click. Blurs the page causes itself (el.blur(), focus
// moving within the page) still happen, as the document keeps focus for those.
let focusHeld = false;
for (const type of ['blur', 'focusout']) {
  window.addEventListener(type, (e) => {
    if (!live.on || !e.isTrusted || document.hasFocus()) return;
    focusHeld = true;
    e.stopImmediatePropagation();
  }, true);
}
for (const type of ['focus', 'focusin']) {
  window.addEventListener(type, (e) => {
    if (!focusHeld || !e.isTrusted) return;
    e.stopImmediatePropagation();
    if (type === 'focus' && e.target === window) setTimeout(() => { focusHeld = false; });
  }, true);
}

ipcRenderer.on('cursor:live', (_e, state) => {
  const was = live.on;
  live = state;
  cursorEl = null;
  applyLiveCursor();
  if (live.on && !was) {
    pointerSent = '';
    cursorImagesSent.clear();
    if (!motionRaf) motionRaf = requestAnimationFrame(motionFrame);
  }
});
if (live.on) {
  if (document.documentElement) applyLiveCursor();
  document.addEventListener('DOMContentLoaded', applyLiveCursor);
  motionRaf = requestAnimationFrame(motionFrame);
}

window.addEventListener('keydown', (e) => {
  if (!live.keys || (e.key !== '[' && e.key !== ']')) return;
  if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
  let active = document.activeElement;
  while (active && active.shadowRoot && active.shadowRoot.activeElement) active = active.shadowRoot.activeElement;
  if (isEditable(active)) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  ipcRenderer.send('cursor:nudge', e.key === ']' ? 1 : -1);
}, true);

// ---- Cursor path capture -------------------------------------------------------
// ⇧⌘E: every frame, where the pointer is (null while it's off the page) and
// how far the page is scrolled, plus each button press, on to the main
// process. It fits them into a path once capture stops, or the page changes.
let capture = null; // { t0, raf }
const BUTTON_NAMES = ['left', 'middle', 'right'];

function captureFrame(now) {
  if (!capture) return;
  const el = root();
  const p = pointer && pointer.inside ? pointer : null;
  ipcRenderer.send('path:sample', [Math.round((now - capture.t0) * 10) / 10, p ? p.x : null, p ? p.y : null, Math.round(el.scrollTop * 10) / 10]);
  capture.raf = requestAnimationFrame(captureFrame);
}

ipcRenderer.on('path:capture', (_e, on) => {
  if (capture) cancelAnimationFrame(capture.raf);
  capture = on ? { t0: performance.now(), raf: 0 } : null;
  if (capture) captureFrame(capture.t0);
});

for (const [type, kind] of [['mousedown', 'down'], ['mouseup', 'up']]) {
  window.addEventListener(type, (e) => {
    if (!capture || !e.isTrusted) return;
    ipcRenderer.send('path:click', { t: Math.round((performance.now() - capture.t0) * 10) / 10, type: kind, x: e.clientX, y: e.clientY, button: BUTTON_NAMES[e.button] || 'left', count: e.detail || 1 });
  }, { capture: true, passive: true });
}
