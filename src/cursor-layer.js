// The pointer Darc draws, shared by recordings and the live cursor.
// The tab capture has no pointer in it, so the recorder draws one onto each
// frame from the page's mouse position, after motion blur so it stays sharp.
// The live cursor (cursor.html) draws the same one over the page in place of
// the real one. A damped spring smooths the raw movement, and the page's
// cursor spans (set in the animation panel) fade it in and out during
// animation playback. Pressing a mouse button shrinks it a little, like a
// click.
// Built-in shapes come from cursor-shapes.js. `size` 22 draws them at macOS's
// own pointer size (the 32-unit frame at 32 CSS px).
const SHAPE_FRAME = 32;
const SHAPE_NATIVE_SIZE = 22;
const shapeUrl = (name) => `data:image/svg+xml,${encodeURIComponent(CURSOR_SVGS[name] || CURSOR_SVGS.default)}`;
const loadImage = (src) => {
  const img = new Image();
  img.src = src;
  return img;
};
const ready = (img) => !!img && img.complete && img.naturalWidth > 0;
const PRESS_SCALE = 0.82; // size while a button is held
const PRESS_IN = 0.06; // s to shrink
const PRESS_OUT = 0.14; // s to grow back

// Where a custom cursor image goes, in px at `k` px per CSS px: `size` tall,
// or for one taken from a page (`native`), its own size scaled with `size` like
// the built-in shapes. Its hotspot is the top left, the center, or the point
// the page's CSS gave it.
function customCursorBox(img, s, k) {
  let w, h;
  if (s.native) {
    const u = (s.size / SHAPE_NATIVE_SIZE) * k;
    w = img.naturalWidth * u;
    h = img.naturalHeight * u;
  } else {
    h = s.size * k;
    w = (img.naturalWidth / img.naturalHeight) * h;
  }
  if (s.hotspot === 'center') return { w, h, hx: w / 2, hy: h / 2 };
  if (s.hotspot === 'page') return { w, h, hx: (s.hx || 0) * (w / img.naturalWidth), hy: (s.hy || 0) * (h / img.naturalHeight) };
  return { w, h, hx: 0, hy: 0 };
}

class CursorLayer {
  constructor({ settings, spans, scale, images, pointer, anim, live }, width, height) {
    this.live = !!live; // drawn over the page rather than into a recording
    this.width = width;
    this.height = height;
    this.scale = scale; // output px per CSS px
    this.pos = null; // drawn position, output px
    this.vel = { x: 0, y: 0 };
    this.target = null; // where the real pointer is
    this.inside = false;
    this.shape = { type: 'default' };
    this.alpha = 0;
    this.down = false; // a mouse button is held
    this.press = 0; // 0 normal size to 1 fully shrunk
    this.pressLatch = false; // a click that hasn't shown yet
    this.anim = anim || { playing: false, elapsed: 0 };
    this.images = new Map();
    for (const [id, data] of images || []) this.images.set(id, loadImage(data));
    this.builtin = {};
    for (const name of Object.keys(CURSOR_SVGS)) this.builtin[name] = loadImage(shapeUrl(name));
    this.setSpans(spans);
    this.configure(settings);
    if (pointer) this.pointer(pointer);
  }

  configure(settings) {
    const same = this.settings && this.settings.image === settings.image;
    this.settings = settings;
    if (!same) this.custom = settings.image ? loadImage(settings.image) : null;
  }

  setSpans(spans) {
    this.spans = (spans || []).filter((s) => s.end > s.start);
  }

  // The page's pointer, as fractions of the viewport, and the CSS cursor under
  // it. The live cursor takes only the shape: it moves itself (moveTo).
  pointer(p) {
    this.shape = p.shape || { type: 'default' };
    // A click can go down and up between frames; it still shrinks all the way.
    if (p.down && !this.down) this.pressLatch = true;
    this.down = !!p.down;
    if (this.live) return;
    this.moveTo(p.x * this.width, p.y * this.height, !!p.inside);
  }

  moveTo(x, y, inside) {
    this.target = { x, y };
    this.inside = inside;
    if (!this.pos) this.pos = { ...this.target };
  }

  image({ id, data }) {
    this.images.set(id, loadImage(data));
  }

  progress(p) {
    this.anim = p;
  }

  // Follows the page's CSS cursor. The live cursor stands in for the real
  // one, so with recordings' cursor off it still looks like the page's.
  followsPage() {
    return this.settings.mode === 'auto' || (this.live && this.settings.mode === 'off');
  }

  // Target opacity: hidden when the page has no pointer over it or hides its
  // own cursor, and outside the page's cursor spans when it has any. The live
  // cursor only honors spans while the animation plays.
  wanted() {
    const s = this.settings;
    if ((s.mode === 'off' && !this.live) || !this.inside || !this.pos) return 0;
    if (this.followsPage() && this.shape.type === 'none') return 0;
    if (!this.spans.length || (this.live && !this.anim.playing)) return 1;
    if (!this.anim.playing) return 0;
    const t = this.anim.elapsed;
    return this.spans.some((sp) => t >= sp.start && t < sp.end) ? 1 : 0;
  }

  // Advance the spring and the fade by one frame of video time.
  step(dt) {
    if (!this.target) return;
    const { smoothing, damping } = this.settings;
    if (!(smoothing > 0)) {
      this.pos = { ...this.target };
      this.vel = { x: 0, y: 0 };
    } else {
      const omega = 6 / (smoothing / 1000); // ~98% settled after `smoothing` when critically damped
      const zeta = Math.max(0.05, +damping || 1);
      const n = Math.max(1, Math.ceil((omega * dt) / 0.2)); // substeps keep stiff springs stable
      const h = dt / n;
      for (let i = 0; i < n; i++) {
        for (const a of ['x', 'y']) {
          const x = this.pos[a] - this.target[a];
          this.vel[a] += (-2 * zeta * omega * this.vel[a] - omega * omega * x) * h;
          this.pos[a] += this.vel[a] * h;
        }
      }
    }
    const want = this.wanted();
    const fade = dt / 0.25;
    this.alpha = want > this.alpha ? Math.min(want, this.alpha + fade) : Math.max(want, this.alpha - fade);
    if (this.down || this.pressLatch) {
      this.press = Math.min(1, this.press + dt / PRESS_IN);
      if (this.press === 1) this.pressLatch = false;
    } else this.press = Math.max(0, this.press - dt / PRESS_OUT);
  }

  // Nothing left to animate until the pointer moves again.
  settled() {
    if (!this.target || !this.pos) return true;
    const near = Math.abs(this.pos.x - this.target.x) < 0.1 && Math.abs(this.pos.y - this.target.y) < 0.1;
    const still = Math.abs(this.vel.x) < 1 && Math.abs(this.vel.y) < 1;
    const pressing = this.pressLatch || this.press !== (this.down ? 1 : 0);
    return near && still && !pressing && this.alpha === this.wanted();
  }

  draw(ctx) {
    if (this.alpha <= 0.005 || !this.pos) return;
    const s = this.settings;
    const k = this.scale;
    const shape = this.followsPage() ? this.shape : null;
    let img, w, h, hx, hy;
    let shadow = false;
    if (s.mode === 'custom' && ready(this.custom)) {
      img = this.custom;
      ({ w, h, hx, hy } = customCursorBox(img, s, k));
    } else if (shape && shape.type === 'url' && ready(this.images.get(shape.id))) {
      // Image cursors from the page's CSS keep their own size and hotspot.
      img = this.images.get(shape.id);
      w = img.naturalWidth * k;
      h = img.naturalHeight * k;
      hx = shape.hx * k;
      hy = shape.hy * k;
    } else {
      const name = shape && this.builtin[shape.type] ? shape.type : 'default';
      img = this.builtin[name];
      if (!ready(img)) return;
      const u = (s.size / SHAPE_NATIVE_SIZE) * k;
      w = h = SHAPE_FRAME * u;
      hx = hy = (SHAPE_FRAME / 2) * u;
      // macOS's soft drop shadow; the beachball has its own.
      if (name !== 'beachball') {
        shadow = true;
        ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
        ctx.shadowBlur = 2.5 * u;
        ctx.shadowOffsetY = u;
      }
    }
    // Shrinks toward the hotspot, so the point stays on what's clicked.
    const p = this.press;
    const z = p > 0 ? 1 - (1 - PRESS_SCALE) * p * (2 - p) : 1;
    ctx.globalAlpha = this.alpha;
    if (z === 1) ctx.drawImage(img, Math.round(this.pos.x - hx), Math.round(this.pos.y - hy), w, h);
    else ctx.drawImage(img, this.pos.x - hx * z, this.pos.y - hy * z, w * z, h * z);
    ctx.globalAlpha = 1;
    if (shadow) {
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    }
  }
}
