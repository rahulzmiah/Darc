const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, ipcMain, screen, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');

const DEFAULTS = {
  mouseSpeed: 1,
  trackpadSpeed: 1,
  keyboardSpeed: 1,
  smoothness: 700, // ms for a scroll to settle
  easing: 'spring', // 'spring' (ease in + out) | 'exponential' (ease out)
  maxVelocity: 0, // px/s, 0 = unlimited
  hideScrollbars: true,
};

const DEFAULT_EASING = [0.87, 0, 0.13, 1]; // ease in-out · expo

// The pointer drawn into recordings (the tab capture has none of its own).
const CURSOR_DEFAULTS = {
  mode: 'auto', // 'off' | 'auto' (follow the page's CSS cursor) | 'arrow' | 'custom'
  size: 22, // height in CSS px for the built-in shapes and custom images
  smoothing: 120, // ms for the drawn pointer to settle on the real one, 0 = none
  damping: 1, // spring damping ratio: below 1 overshoots, above 1 trails
  hotspot: 'tip', // where a custom image points from: 'tip' (top left) | 'center'
  custom: null, // { name, path } of an uploaded image
  live: false, // also smooth the pointer on screen, not just in recordings
};

// Where [ and ] step the smoothing to, in ms.
const SMOOTHING_STEPS = [0, 40, 80, 120, 160, 200, 250, 300, 400, 500, 600];

const BLANK_PAGE = 'data:text/html,<body style="background:%23000"></body>';

const storePath = path.join(app.getPath('userData'), 'settings.json');
// Carry settings over from when the app was called Narc.
const legacyStorePath = path.join(app.getPath('appData'), 'narc', 'settings.json');
if (!fs.existsSync(storePath) && fs.existsSync(legacyStorePath)) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.copyFileSync(legacyStorePath, storePath);
}
let store = { settings: { ...DEFAULTS }, cursor: { ...CURSOR_DEFAULTS }, lastUrl: '', bounds: null, animations: {}, animatorWidth: 680, reloadOnRecord: true, recordHeight: 'native', motionBlur: 0 };
try {
  const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  store = { ...store, ...saved, settings: { ...DEFAULTS, ...saved.settings }, cursor: { ...CURSOR_DEFAULTS, ...saved.cursor } };
} catch {}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(storePath, JSON.stringify(store, null, 2)), 300);
}

let win, page, overlay, toast, animator, recorder, liveCursor;
let toastTimer;

// Recording window, docked under the main window like the animation panel
// sits beside it. Being its own window, it never touches the viewport.
const RECORDER_HEIGHT = 112;
const recorderQueue = []; // callbacks waiting for the recorder page to load
let recording = null; // { fd, path, name } while the pane writes a file
let recordingActive = false; // the pane is capturing (starting, recording or saving)
let lastRecording = null;
let closingForRecording = false; // window close deferred until the recording is saved
let pendingReload = false; // the pane asked for a reload; skip its navigation marker
let animPlaying = false;
let markerPrompt = null; // { key } while the toast is asking to restart a timeline
let markerVisitKey = null; // page whose saved timeline the user has already been asked about this visit
let overlayMode = null;
let scrollbarCssKey = null;

function toUrl(input) {
  const s = input.trim();
  if (!s) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s) || /^(about|data|file):/i.test(s)) return s;
  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/|$)/i.test(s)) return `http://${s}`;
  if (!/\s/.test(s) && /^[^/]+\.[a-z]{2,}(:\d+)?(\/.*)?$/i.test(s)) return `https://${s}`;
  return `https://www.google.com/search?q=${encodeURIComponent(s)}`;
}

function layout() {
  const [width, height] = win.getContentSize();
  page.setBounds({ x: 0, y: 0, width, height });
  liveCursor.setBounds({ x: 0, y: 0, width, height });
  overlay.setBounds({ x: 0, y: 0, width, height });
  const tw = 340;
  const th = 52;
  toast.setBounds({ x: Math.round((width - tw) / 2), y: height - th - 28, width: tw, height: th });
}

// Size of the page view in physical pixels — what a recording captures.
function viewportPixels() {
  const { width, height } = page.getBounds();
  const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor || 1;
  return { width: Math.round(width * scale), height: Math.round(height * scale), css: { width, height } };
}

const recorderOpen = () => !!recorder && !recorder.isDestroyed();

// Directly under the main window, matching its width; clamped to the display's
// work area, so with no room below it overlaps the bottom of the page instead.
function recorderDock() {
  const main = win.getBounds();
  const area = screen.getDisplayMatching(main).workArea;
  const gap = 8;
  const width = Math.min(main.width, area.width);
  const x = Math.max(area.x, Math.min(main.x, area.x + area.width - width));
  const y = Math.min(main.y + main.height + gap, area.y + area.height - RECORDER_HEIGHT);
  return { x, y: Math.max(area.y, y), width, height: RECORDER_HEIGHT };
}

function dockRecorder() {
  if (recorderOpen() && !win.isFullScreen()) recorder.setBounds(recorderDock());
}

function openRecorder() {
  if (recorderOpen()) return;
  recorder = new BrowserWindow({
    ...recorderDock(),
    resizable: false,
    minimizable: false,
    title: 'Record',
    frame: false,
    roundedCorners: false,
    hasShadow: true,
    backgroundColor: '#0b0b0b',
    webPreferences: {
      preload: path.join(__dirname, 'recorder-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // the encoder's frame clock must not slow down
    },
  });
  recorder.loadFile(path.join(__dirname, 'recorder.html'));
  recorder.webContents.once('did-finish-load', () => {
    for (const fn of recorderQueue.splice(0)) fn();
  });
  recorder.on('close', (e) => {
    if (recordingActive) {
      e.preventDefault();
      showToast('Stop the recording first · ⌘E');
    }
  });
  recorder.on('closed', () => {
    recorder = null;
    recorderQueue.length = 0;
  });
}

function closeRecorder() {
  if (recorderOpen()) recorder.close();
}

function toggleRecorder() {
  if (recorderOpen()) closeRecorder();
  else openRecorder();
}

function sendToRecorder(channel, data) {
  if (recorderOpen()) recorder.webContents.send(channel, data);
}

function whenRecorderReady(fn) {
  if (!recorderOpen()) return;
  if (recorder.webContents.isLoading()) recorderQueue.push(fn);
  else fn();
}

// ⌘E: open the pane and start recording, or stop the one in progress.
function toggleRecording() {
  if (!recordingActive && !/^https?:/.test(page.webContents.getURL())) return showToast('Open a page first · ⌘L');
  openRecorder();
  whenRecorderReady(() => sendToRecorder('rec:toggle'));
}

function setRecordingActive(on) {
  if (!win || win.isDestroyed()) return;
  recordingActive = on;
  sendToAnimator('rec:state', on);
  // The page streams its scroll velocity to the recorder while capturing.
  page.webContents.send('rec:motion', on);
  // Hand focus back to the page once capture starts, so space and the
  // scrolling keys work straight away.
  if (on) {
    win.focus();
    page.webContents.focus();
  }
}

function recordingsDir() {
  return path.join(app.getPath('videos'), 'Darc');
}

function recordingName() {
  let host = 'page';
  try {
    host = new URL(page.webContents.getURL()).hostname.replace(/^www\./, '') || host;
  } catch {}
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}.${p(d.getMinutes())}.${p(d.getSeconds())}`;
  return `${host} ${stamp}.mp4`;
}

function revealLastRecording() {
  if (lastRecording && fs.existsSync(lastRecording)) shell.showItemInFolder(lastRecording);
  else showToast('No recordings yet · ⌘E');
}

function showToast(text) {
  markerPrompt = null;
  toast.setVisible(true);
  toast.webContents.executeJavaScript(`show(${JSON.stringify(text)})`);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.setVisible(false), 2200);
}

// A toast with ✕ / ✓ buttons. Left unanswered it goes away as if dismissed.
function askToast(text) {
  toast.setVisible(true);
  toast.webContents.executeJavaScript(`ask(${JSON.stringify(text)})`);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(dismissToast, 8000);
}

function dismissToast() {
  markerPrompt = null;
  clearTimeout(toastTimer);
  toast.webContents.executeJavaScript('hide()').catch(() => {});
  toastTimer = setTimeout(() => toast.setVisible(false), 300);
}

async function applyScrollbarCss() {
  const wc = page.webContents;
  if (scrollbarCssKey) {
    wc.removeInsertedCSS(scrollbarCssKey).catch(() => {});
    scrollbarCssKey = null;
  }
  if (store.settings.hideScrollbars) {
    scrollbarCssKey = await wc
      .insertCSS('::-webkit-scrollbar{display:none!important}*{scrollbar-width:none!important}', { cssOrigin: 'user' })
      .catch(() => null);
  }
}

function showOverlay(mode) {
  if (overlayMode === mode) return hideOverlay();
  overlayMode = mode;
  syncLiveCursor();
  const url = page.webContents.getURL();
  overlay.setVisible(true);
  overlay.webContents.focus();
  overlay.webContents.send('overlay:show', {
    mode,
    url: url.startsWith('data:') ? '' : url,
    settings: store.settings,
  });
}

function hideOverlay() {
  overlayMode = null;
  syncLiveCursor();
  overlay.setVisible(false);
  page.webContents.focus();
}

const SIZE_PRESETS = [
  [1280, 720, '16:9'],
  [1600, 900, '16:9'],
  [1920, 1080, '16:9'],
  [1280, 800, '16:10'],
  [1440, 900, '16:10'],
  [1680, 1050, '16:10'],
  [1920, 1200, '16:10'],
];

function setWindowSize(width, height, ratio) {
  if (win.isFullScreen()) win.setFullScreen(false);
  win.setContentSize(width, height, true);
  win.center();
  const [w, h] = win.getContentSize();
  showToast(`${w} × ${h} · ${ratio}`);
}

// Scroll animations are saved per page (origin + path).
function animationKey() {
  try {
    const u = new URL(page.webContents.getURL());
    return u.protocol.startsWith('http') ? u.origin + u.pathname : null;
  } catch {
    return null;
  }
}

// A page's track: its scroll stops, plus the spans of playback time (ms) the
// recorded pointer is shown for. Older saves were just the stops.
function trackFor(key) {
  const t = key && store.animations[key];
  if (!t) return { stops: [], cursor: [] };
  if (Array.isArray(t)) return { stops: t, cursor: [] };
  return { stops: t.stops || [], cursor: t.cursor || [] };
}

function saveTrack(key, track) {
  if (track.stops.length || track.cursor.length) store.animations[key] = track;
  else delete store.animations[key];
  save();
  syncCursorSpans();
}

function sendToAnimator(channel, data) {
  if (animator && !animator.isDestroyed()) animator.webContents.send(channel, data);
}

// ---- Cursor overlay settings -------------------------------------------------
const IMAGE_MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

// Settings as the recorder and the panel's demo need them: with the custom
// image inlined, since neither can read files.
function cursorPayload() {
  const c = store.cursor;
  let image = null;
  if (c.custom && c.custom.path) {
    try {
      const mime = IMAGE_MIME[path.extname(c.custom.path).toLowerCase()] || 'image/png';
      image = `data:${mime};base64,${fs.readFileSync(c.custom.path).toString('base64')}`;
    } catch {}
  }
  return { ...c, image };
}

// With the live cursor on, the page only ever sees the already-smoothed
// pointer, so recordings just take the edge off frame timing.
function recorderCursorPayload() {
  const payload = cursorPayload();
  return liveCursorState().on ? { ...payload, smoothing: LIVE_RECORD_SMOOTHING, damping: 1 } : payload;
}

function syncCursor() {
  sendToLiveCursor('live:cursor', cursorPayload());
  syncLiveCursor();
}

function syncCursorSpans() {
  const spans = trackFor(animationKey()).cursor;
  sendToRecorder('rec:cursor-spans', spans);
  sendToLiveCursor('live:cursor-spans', spans);
}

// ---- Live cursor -------------------------------------------------------------
// With it on, a transparent view laid over the page takes the real mouse,
// hides the system pointer and draws a smoothed one. The page is fed the
// smoothed position instead of the real one (sendInputEvent), so hover effects
// happen right under the drawn pointer, and clicks wait for it to arrive. Tab
// capture only sees the page, so it never shows up in recordings, which draw
// their own pointer.
const LIVE_RECORD_SMOOTHING = 30; // ms; recordings of an already-smoothed pointer
const liveCursorOpen = () => !!liveCursor && !liveCursor.webContents.isDestroyed();

function liveCursorState() {
  const keys = !!store.cursor.live;
  return { keys, on: keys && store.cursor.smoothing > 0 && !overlayMode };
}

function sendToLiveCursor(channel, data) {
  if (liveCursorOpen()) liveCursor.webContents.send(channel, data);
}

function syncLiveCursor() {
  const state = liveCursorState();
  page.webContents.send('cursor:live', state);
  sendToRecorder('rec:cursor', recorderCursorPayload());
  if (liveCursorOpen()) liveCursor.setVisible(state.on);
}

function createLiveCursor() {
  liveCursor = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'cursor-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  liveCursor.setBackgroundColor('#00000000');
  liveCursor.setVisible(false);
  liveCursor.webContents.loadFile(path.join(__dirname, 'cursor.html'));
  // A click on the view takes keyboard focus from the page; hand it straight
  // back (the page doesn't see the blur, see page-preload.js).
  liveCursor.webContents.on('focus', () => {
    if (!overlayMode) page.webContents.focus();
  });
}

// Mouse input from the live cursor view, already smoothed, on to the page.
function liveInput(ev) {
  page.webContents.sendInputEvent(ev);
}

// [ and ] on the page step the smoothing down and up.
function nudgeSmoothing(dir) {
  const cur = store.cursor.smoothing || 0;
  const next = dir > 0
    ? SMOOTHING_STEPS.find((v) => v > cur) ?? SMOOTHING_STEPS[SMOOTHING_STEPS.length - 1]
    : [...SMOOTHING_STEPS].reverse().find((v) => v < cur) ?? 0;
  store.cursor = { ...store.cursor, smoothing: next };
  save();
  syncCursor();
  sendToAnimator('anim:cursor', cursorPayload());
  showToast(next ? `Cursor smoothing · ${next} ms` : 'Cursor smoothing off');
}

// Copies the chosen image into the app's data folder so it outlives the original.
async function pickCursorImage() {
  const { canceled, filePaths } = await dialog.showOpenDialog(animator && !animator.isDestroyed() ? animator : win, {
    title: 'Choose a cursor image',
    filters: [{ name: 'Images', extensions: ['png', 'svg', 'gif', 'jpg', 'jpeg', 'webp'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return null;
  const src = filePaths[0];
  const dest = path.join(app.getPath('userData'), `cursor${path.extname(src).toLowerCase()}`);
  fs.copyFileSync(src, dest);
  store.cursor = { ...store.cursor, mode: 'custom', custom: { name: path.basename(src), path: dest } };
  save();
  syncCursor();
  return cursorPayload();
}

// Open the panel docked against the right edge of the main window, matching its
// height and clamped to the display's work area so it never lands off-screen.
function animatorDock() {
  const main = win.getBounds();
  const area = screen.getDisplayMatching(main).workArea;
  const gap = 8;
  const width = Math.min(Math.max(store.animatorWidth || 680, 560), area.width);
  const top = Math.max(area.y, main.y);
  const height = Math.max(420, Math.min(main.y + main.height, area.y + area.height) - top);
  const x = Math.max(Math.min(main.x + main.width + gap, area.x + area.width - width), area.x);
  return { x, y: Math.min(top, area.y + area.height - height), width, height };
}

function toggleAnimator() {
  if (animator && !animator.isDestroyed()) {
    if (animator.isFocused()) animator.close();
    else animator.focus();
    return;
  }
  animator = new BrowserWindow({
    ...animatorDock(),
    minWidth: 560,
    minHeight: 420,
    title: 'Animation',
    frame: false,
    roundedCorners: false,
    hasShadow: true,
    backgroundColor: '#0b0b0b',
    webPreferences: {
      preload: path.join(__dirname, 'animator-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  animator.loadFile(path.join(__dirname, 'animator.html'));
  // The recording window comes along, so output settings can be chosen before pressing record.
  openRecorder();
  animator.on('resized', () => {
    store.animatorWidth = animator.getBounds().width;
    save();
  });
  animator.on('closed', () => {
    animator = null;
  });
}

// Full-length screenshot of the page, downscaled for the animation panel.
// Taken from a hidden offscreen copy of the page: capturing beyond the viewport
// on the live view can freeze its rendering for ~30s. The copy is scrolled down
// one screen at a time and each screen captured in place, because many sites
// change layout as they scroll (sticky headers shrinking, sections growing on
// reveal) — a single capture from the top would drift from what playback shows.
const PREVIEW_SETTLE = 350; // ms for scroll-driven interactions to catch up
const PREVIEW_MAX_SCREENS = 60;
const PREVIEW_IDLE = 1500; // ms after a page loads or resizes before capturing in the background
const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out capturing the page')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

async function capturePreview(job) {
  const { url, width, height, zoom } = job;
  const alive = () => {
    if (job.cancelled) throw new Error('Capture superseded');
  };
  const copy = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });
  const wc = copy.webContents;
  try {
    wc.setAudioMuted(true);
    wc.setZoomLevel(zoom);
    await withTimeout(wc.loadURL(url).catch(() => {}), 30000);
    alive();
    if (store.settings.hideScrollbars) {
      await wc.insertCSS('::-webkit-scrollbar{display:none!important}*{scrollbar-width:none!important}', { cssOrigin: 'user' });
    }
    await new Promise((r) => setTimeout(r, 600)); // let fonts and late layout settle
    alive();
    // Run through the whole page first, half a screen at a time, so reveal-on-
    // scroll content and lazy images have all fired before anything is captured.
    // Waits at the bottom for lazily appended content, then returns to the top.
    await withTimeout(wc.executeJavaScript(`new Promise(async (resolve) => {
      const el = document.scrollingElement || document.documentElement;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      const atBottom = () => el.scrollTop + innerHeight >= el.scrollHeight - 1;
      const limit = innerHeight * ${PREVIEW_MAX_SCREENS};
      const deadline = Date.now() + 20000;
      while (Date.now() < deadline && el.scrollTop < limit) {
        if (atBottom()) {
          await wait(600);
          if (atBottom()) break;
        }
        el.scrollTo({ top: el.scrollTop + innerHeight / 2, behavior: 'instant' });
        await wait(120);
      }
      el.scrollTo({ top: 0, behavior: 'instant' });
      await wait(500);
      resolve();
    })`), 30000);
    alive();
    // Measure any sticky/fixed navbar pinned to the top once the page has been
    // scrolled a screen down, so the panel can show how much of the viewport it covers.
    const navbar = await withTimeout(wc.executeJavaScript(`new Promise(async (resolve) => {
      const el = document.scrollingElement || document.documentElement;
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      el.scrollTo({ top: Math.min(innerHeight, el.scrollHeight - innerHeight), behavior: 'instant' });
      await wait(${PREVIEW_SETTLE});
      let bottom = 0;
      for (const n of document.querySelectorAll('body *')) {
        const cs = getComputedStyle(n);
        if (cs.position !== 'fixed' && cs.position !== 'sticky') continue;
        if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity === 0) continue;
        let r = n.getBoundingClientRect();
        if (r.height < 1) {
          // Zero-height fixed wrappers: use their visible children instead.
          for (const c of n.children) {
            const cr = c.getBoundingClientRect();
            if (cr.height >= 1 && cr.width > r.width) r = cr;
          }
        }
        if (r.top > 1 || r.bottom <= 0 || r.height < 1) continue;
        if (r.width < innerWidth * 0.5 || r.height > innerHeight * 0.4) continue;
        bottom = Math.max(bottom, r.bottom);
      }
      el.scrollTo({ top: 0, behavior: 'instant' });
      await wait(300);
      resolve(Math.round(bottom));
    })`), 10000).catch(() => 0);
    alive();
    // Past the first screen, small fixed/sticky bars (headers, chat bubbles) are
    // hidden so they aren't stamped onto every screen of the stitched preview.
    // Big ones are left alone — they're backgrounds or pinned scroll sections.
    const scrollTo = (y) => wc.executeJavaScript(`new Promise((resolve) => {
      const el = document.scrollingElement || document.documentElement;
      el.scrollTo({ top: ${y}, behavior: 'instant' });
      if (${y} > 0) {
        for (const n of document.querySelectorAll('body *')) {
          const pos = getComputedStyle(n).position;
          if ((pos === 'fixed' || pos === 'sticky') && n.getBoundingClientRect().height < innerHeight * 0.4) {
            n.style.setProperty('visibility', 'hidden', 'important');
          }
        }
      }
      setTimeout(() => resolve({ top: el.scrollTop, height: el.scrollHeight, width: innerWidth, viewport: innerHeight }), ${PREVIEW_SETTLE});
    })`);
    const tiles = [];
    let covered = 0; // page px captured so far
    let info;
    for (let i = 0; i < PREVIEW_MAX_SCREENS; i++) {
      info = await scrollTo(covered);
      alive();
      // At the bottom the scroll clamps short, overlapping the last screen.
      const skip = Math.max(0, covered - info.top);
      const tileHeight = info.viewport - skip;
      if (tileHeight <= 0) break;
      const image = await withTimeout(wc.capturePage(), 10000);
      const px = image.getSize().width / info.width;
      const tile = image
        .crop({ x: 0, y: Math.round(skip * px), width: image.getSize().width, height: Math.round(tileHeight * px) })
        .resize({ width: Math.min(640, image.getSize().width), quality: 'good' });
      tiles.push({ src: `data:image/jpeg;base64,${tile.toJPEG(82).toString('base64')}`, height: tileHeight });
      covered = info.top + info.viewport;
      if (covered >= info.height - 1) break;
    }
    alive();
    return { tiles, width: info.width, height: covered, viewport: info.viewport, navbar };
  } finally {
    copy.destroy();
  }
}

// The preview is captured in the background whenever the page loads or the
// window resizes, so it's ready by the time the animation panel asks for it.
// One capture runs at a time; a newer request for a different page supersedes it.
let preview = null; // { id, job, promise }
let previewTimer;

async function previewJob() {
  const live = page.webContents;
  const url = live.getURL();
  if (!/^https?:/.test(url)) return null;
  const [width, height] = await live.executeJavaScript('[innerWidth, innerHeight]');
  const zoom = live.getZoomLevel();
  const id = [url, width, height, zoom, store.settings.hideScrollbars].join('|');
  return { id, url, width, height, zoom, cancelled: false };
}

async function getPreview(force) {
  const job = await previewJob();
  if (!job) throw new Error('Nothing to capture');
  if (!force && preview && preview.id === job.id) return preview.promise;
  if (preview) preview.job.cancelled = true;
  // Anyone still waiting on a superseded capture gets the one that replaced it.
  const promise = capturePreview(job).catch((err) => {
    if (job.cancelled && preview) return preview.promise;
    throw err;
  });
  const entry = { id: job.id, job, promise };
  preview = entry;
  // Don't keep failures around; the next request should try again.
  promise.catch(() => preview === entry && (preview = null));
  return promise;
}

// A load (including a reload of the same URL) makes any earlier capture stale.
function invalidatePreview() {
  if (preview) preview.job.cancelled = true;
  preview = null;
  schedulePreview();
}

function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(() => getPreview(false).catch(() => {}), PREVIEW_IDLE);
}

// Ask the page for its scroll position — the smooth-scroll target if a scroll
// is still settling, so a marker lands where the user was heading.
function pageScrollY() {
  const wc = page.webContents;
  return new Promise((resolve) => {
    const done = (y) => {
      clearTimeout(timer);
      ipcMain.removeListener('anim:scroll', onReply);
      resolve(y);
    };
    const onReply = (e, y) => e.sender === wc && done(y);
    const timer = setTimeout(() => done(null), 500);
    ipcMain.on('anim:scroll', onReply);
    wc.send('anim:get-scroll');
  });
}

// Record mode: scroll the page, then drop a marker at the current position —
// same as clicking the preview in the animation panel. The first marker on a
// visit to a page that already has a timeline asks whether to start over, so
// re-recording doesn't pile new markers onto the old ones.
async function setMarker() {
  const key = animationKey();
  if (!key) return showToast('Open a page first · ⌘L');
  const saved = trackFor(key).stops;
  if (markerPrompt) {
    // ⌘K again while asking means "keep it" — carry on adding markers.
    dismissToast();
  } else if (markerVisitKey !== key && saved.length) {
    markerVisitKey = key;
    markerPrompt = { key };
    return askToast(`Restart timeline? ${saved.length} marker${saved.length === 1 ? '' : 's'} saved`);
  }
  markerVisitKey = key;
  addMarker(key, false);
}

async function addMarker(key, reset) {
  const y = await pageScrollY();
  if (y == null) return;
  if (animator && !animator.isDestroyed()) {
    // The panel owns the stops while it's open; let it add the marker so its
    // pending edits aren't clobbered.
    sendToAnimator('anim:add-stop', { key, y, reset });
  } else {
    const track = trackFor(key);
    // Easing is shared across the track, so follow the existing lines.
    const easing = track.stops.length ? [...track.stops[0].easing] : [...DEFAULT_EASING];
    const stops = reset ? [] : track.stops;
    stops.push({ y, duration: 1600, easing, hold: 600 });
    saveTrack(key, { stops, cursor: reset ? [] : track.cursor });
  }
  showToast(reset ? `Timeline restarted · ${y}px` : `Marker set · ${y}px`);
}

function playAnimation() {
  const { stops } = trackFor(animationKey());
  if (!stops.length) return showToast('No animation for this page · ⌘.');
  hideOverlay();
  win.focus();
  page.webContents.focus();
  page.webContents.send('anim:play', stops);
}

function buildMenu() {
  const nav = (fn) => () => fn(page.webContents.navigationHistory);
  const template = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: () => showOverlay('settings') },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open Location…', accelerator: 'CmdOrCtrl+L', click: () => showOverlay('url') },
        { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => page.webContents.reload() },
        { label: 'Hard Reload', accelerator: 'Shift+CmdOrCtrl+R', click: () => page.webContents.reloadIgnoringCache() },
        { type: 'separator' },
        { label: 'Back', accelerator: 'CmdOrCtrl+[', click: nav((h) => h.canGoBack() && h.goBack()) },
        { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: nav((h) => h.canGoForward() && h.goForward()) },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Actual Size', accelerator: 'CmdOrCtrl+0', click: () => page.webContents.setZoomLevel(0) },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => page.webContents.setZoomLevel(page.webContents.getZoomLevel() + 0.5) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => page.webContents.setZoomLevel(page.webContents.getZoomLevel() - 0.5) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { label: 'Developer Tools', accelerator: 'Alt+CmdOrCtrl+I', click: () => page.webContents.toggleDevTools() },
      ],
    },
    {
      label: 'Animation',
      submenu: [
        { label: 'Animation Panel', accelerator: 'CmdOrCtrl+.', click: toggleAnimator },
        { type: 'separator' },
        { label: 'Set Marker', accelerator: 'CmdOrCtrl+K', click: setMarker },
        { type: 'separator' },
        { label: 'Play', accelerator: 'CmdOrCtrl+Enter', click: playAnimation },
        { label: 'Stop', accelerator: 'Shift+CmdOrCtrl+.', click: () => page.webContents.send('anim:stop') },
      ],
    },
    {
      label: 'Record',
      submenu: [
        { label: 'Record / Stop', accelerator: 'CmdOrCtrl+E', click: toggleRecording },
        { label: 'Recording Window', accelerator: 'Alt+CmdOrCtrl+E', click: toggleRecorder },
        { type: 'separator' },
        { label: 'Reveal Last Recording', click: revealLastRecording },
        {
          label: 'Open Recordings Folder',
          click: () => {
            fs.mkdirSync(recordingsDir(), { recursive: true });
            shell.openPath(recordingsDir());
          },
        },
      ],
    },
    {
      label: 'Window',
      submenu: [
        ...SIZE_PRESETS.flatMap(([width, height, ratio], i) => [
          ...(i > 0 && SIZE_PRESETS[i - 1][2] !== ratio ? [{ type: 'separator' }] : []),
          {
            label: `${width} × ${height}  (${ratio})`,
            accelerator: `CmdOrCtrl+${i + 1}`,
            click: () => setWindowSize(width, height, ratio),
          },
        ]),
        { type: 'separator' },
        { label: 'Center', accelerator: 'CmdOrCtrl+Alt+C', click: () => win.center() },
        { type: 'separator' },
        { role: 'minimize' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;
  win = new BaseWindow({
    width: Math.min(1440, sw),
    height: Math.min(900, sh),
    ...(store.bounds || {}),
    frame: false,
    roundedCorners: false,
    hasShadow: true,
    backgroundColor: '#000000',
  });

  page = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'page-preload.js'),
      contextIsolation: true,
      sandbox: true,
      // Keep painting while the animation panel covers the window, so previews
      // can be captured and playback stays smooth.
      backgroundThrottling: false,
    },
  });
  page.setBackgroundColor('#000000');

  overlay = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'overlay-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  overlay.setBackgroundColor('#00000000');
  overlay.setVisible(false);

  toast = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, 'toast-preload.js'),
      contextIsolation: true,
      sandbox: true,
    },
  });
  toast.setBackgroundColor('#00000000');
  toast.setVisible(false);
  toast.webContents.loadFile(path.join(__dirname, 'toast.html'));

  createLiveCursor();
  win.contentView.addChildView(page);
  win.contentView.addChildView(liveCursor); // under the overlay and toast
  win.contentView.addChildView(overlay);
  win.contentView.addChildView(toast);
  layout();
  syncLiveCursor();
  win.on('resize', layout);
  win.on('resize', schedulePreview);
  // The recording window follows the main window around.
  win.on('move', dockRecorder);
  win.on('resize', dockRecorder);
  let viewportTimer;
  win.on('resize', () => {
    clearTimeout(viewportTimer);
    viewportTimer = setTimeout(() => sendToRecorder('rec:viewport', viewportPixels()), 150);
  });
  win.on('leave-full-screen', dockRecorder);
  win.on('close', (e) => {
    if (recordingActive) {
      // Finish writing the file first; the pane reports back and we close then.
      e.preventDefault();
      if (!closingForRecording) {
        closingForRecording = true;
        showToast('Saving recording…');
        sendToRecorder('rec:stop');
      }
      return;
    }
    store.bounds = win.getBounds();
    clearTimeout(saveTimer);
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  });
  // The panes belong to the main window; without it they'd be left orphaned.
  win.on('closed', () => {
    if (recorderOpen()) recorder.destroy();
    if (animator && !animator.isDestroyed()) animator.destroy();
  });

  const wc = page.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    wc.loadURL(url);
    return { action: 'deny' };
  });
  wc.on('dom-ready', () => {
    if (recordingActive) wc.send('rec:motion', true); // a reload mid-recording restarts the preload
    scrollbarCssKey = null;
    applyScrollbarCss();
    // No keyboard focus rings on recorded pages.
    wc.insertCSS('*:focus,*:focus-visible{outline:none!important}', { cssOrigin: 'user' }).catch(() => {});
  });
  const remember = (_e, url) => {
    if (url.startsWith('http')) {
      store.lastUrl = url;
      save();
    }
  };
  wc.on('did-navigate', remember);
  // A fresh visit (including a reload) asks again before adding to a saved timeline.
  wc.on('did-navigate', () => {
    markerVisitKey = null;
    if (markerPrompt) dismissToast();
  });
  wc.on('did-navigate-in-page', remember);
  // Timeline markers for the recording pane. Recording carries on across
  // navigations; these just note where they happened.
  wc.on('did-navigate', syncCursorSpans);
  wc.on('did-navigate-in-page', syncCursorSpans);
  wc.on('did-navigate', (_e, url) => {
    if (pendingReload) {
      pendingReload = false;
      return;
    }
    let label = url;
    try {
      const u = new URL(url);
      label = u.hostname.replace(/^www\./, '') + (u.pathname !== '/' ? u.pathname : '');
    } catch {}
    sendToRecorder('rec:event', { type: 'nav', label: label.length > 40 ? `${label.slice(0, 39)}…` : label });
  });
  wc.on('did-finish-load', () => sendToRecorder('rec:event', { type: 'load', label: 'Loaded' }));
  wc.on('did-finish-load', () => sendToAnimator('anim:page-changed'));
  wc.on('did-navigate-in-page', () => sendToAnimator('anim:page-changed'));
  wc.on('did-finish-load', invalidatePreview);
  wc.on('did-navigate-in-page', schedulePreview);

  // Always start blank with the URL bar open rather than reopening the last site.
  overlay.webContents.loadFile(path.join(__dirname, 'overlay.html'));
  wc.loadURL(BLANK_PAGE);
  overlay.webContents.once('did-finish-load', () => showOverlay('url'));
}

ipcMain.on('settings:get', (e) => {
  e.returnValue = store.settings;
});

ipcMain.on('settings:set', (_e, partial) => {
  const prevHide = store.settings.hideScrollbars;
  store.settings = { ...store.settings, ...partial };
  save();
  page.webContents.send('settings', store.settings);
  if (store.settings.hideScrollbars !== prevHide) applyScrollbarCss();
});

ipcMain.on('settings:reset', () => {
  store.settings = { ...DEFAULTS };
  save();
  page.webContents.send('settings', store.settings);
  applyScrollbarCss();
  overlay.webContents.send('overlay:settings', store.settings);
});

ipcMain.on('navigate', (_e, input) => {
  const url = toUrl(input);
  hideOverlay();
  if (url) page.webContents.loadURL(url);
});

ipcMain.on('overlay:hide', hideOverlay);

ipcMain.on('toast:answer', (_e, ok) => {
  const prompt = markerPrompt;
  if (!prompt) return;
  dismissToast();
  if (ok && prompt.key === animationKey()) addMarker(prompt.key, true);
  win.focus();
  page.webContents.focus();
});

ipcMain.handle('anim:load', () => {
  const key = animationKey();
  return { key, ...trackFor(key) };
});

ipcMain.handle('anim:capture', (_e, force) => getPreview(force));

ipcMain.on('anim:set', (_e, { key, stops, cursor }) => {
  if (!key) return;
  saveTrack(key, { stops: stops || [], cursor: cursor || [] });
});

ipcMain.handle('cursor:get', cursorPayload);
ipcMain.on('cursor:live-get', (e) => {
  e.returnValue = liveCursorState();
});
ipcMain.on('cursor:nudge', (e, dir) => e.sender === page.webContents && nudgeSmoothing(dir));
ipcMain.on('live:input', (e, ev) => liveCursorOpen() && e.sender === liveCursor.webContents && liveInput(ev));
ipcMain.handle('live:init', () => ({ settings: cursorPayload(), spans: trackFor(animationKey()).cursor }));
ipcMain.handle('cursor:pick', pickCursorImage);
ipcMain.on('cursor:set', (_e, partial) => {
  store.cursor = { ...store.cursor, ...partial };
  save();
  syncCursor();
});

ipcMain.on('anim:play', playAnimation);
ipcMain.on('anim:close', () => animator && animator.close());
ipcMain.on('anim:stop', () => page.webContents.send('anim:stop'));
ipcMain.on('anim:seek', (_e, y) => page.webContents.send('anim:seek', y));
ipcMain.on('anim:progress', (_e, data) => {
  sendToAnimator('anim:progress', data);
  // The recorder times the pointer's cursor spans off playback.
  const anim = { playing: !!data.playing, elapsed: data.elapsed || 0 };
  sendToRecorder('rec:anim-progress', anim);
  sendToLiveCursor('live:anim-progress', anim);
  if (!!data.playing !== animPlaying) {
    animPlaying = !!data.playing;
    sendToRecorder('rec:event', { type: animPlaying ? 'anim-start' : 'anim-end', label: animPlaying ? 'Animation' : '' });
  }
});

// ---- Recording -------------------------------------------------------------
// The pane captures the page's WebContents (tab capture, so nothing but the
// page is in the footage) and streams a finished MP4 here, chunk by chunk.
ipcMain.on('rec:toggle', toggleRecording);
ipcMain.on('rec:close-pane', closeRecorder);
ipcMain.on('rec:reveal', revealLastRecording);
ipcMain.handle('rec:init', () => ({
  reload: store.reloadOnRecord !== false,
  height: store.recordHeight || 'native',
  blur: store.motionBlur || 0,
  viewport: viewportPixels(),
  cursor: recorderCursorPayload(),
  cursorSpans: trackFor(animationKey()).cursor,
}));
ipcMain.handle('rec:viewport', () => viewportPixels());
ipcMain.on('rec:set-height', (_e, h) => {
  store.recordHeight = h;
  save();
});
ipcMain.on('rec:set-blur', (_e, deg) => {
  store.motionBlur = +deg || 0;
  save();
});
ipcMain.on('rec:velocity', (e, v) => e.sender === page.webContents && sendToRecorder('rec:velocity', v));
ipcMain.on('rec:pointer', (e, p) => {
  if (e.sender !== page.webContents) return;
  sendToRecorder('rec:pointer', p);
  sendToLiveCursor('live:pointer', p);
});
ipcMain.on('rec:cursor-image', (e, img) => {
  if (e.sender !== page.webContents) return;
  sendToRecorder('rec:cursor-image', img);
  sendToLiveCursor('live:cursor-image', img);
});
ipcMain.on('rec:set-reload', (_e, on) => {
  store.reloadOnRecord = !!on;
  save();
});
ipcMain.on('rec:state', (_e, on) => setRecordingActive(!!on));

ipcMain.handle('rec:source', () => {
  const wc = page.webContents;
  if (!/^https?:/.test(wc.getURL())) return { error: 'Open a page first (⌘L)' };
  if (!recorderOpen()) return { error: 'Recording window closed' };
  return { id: wc.getMediaSourceId(recorder.webContents), ...viewportPixels() };
});

ipcMain.handle('rec:open', () => {
  if (recording) return { error: 'Already recording' };
  try {
    fs.mkdirSync(recordingsDir(), { recursive: true });
    const name = recordingName();
    const file = path.join(recordingsDir(), name);
    recording = { fd: fs.openSync(file, 'w'), path: file, name };
    return { path: file, name };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.on('rec:write', (_e, position, data) => {
  if (!recording) return;
  try {
    fs.writeSync(recording.fd, data, 0, data.byteLength, position);
  } catch (err) {
    console.error('recording write failed', err);
  }
});

function finishRecording(keep) {
  const rec = recording;
  recording = null;
  if (!rec) return null;
  try {
    fs.closeSync(rec.fd);
  } catch {}
  if (!keep) {
    fs.rmSync(rec.path, { force: true });
    return null;
  }
  lastRecording = rec.path;
  return rec;
}

function afterRecording() {
  if (closingForRecording) setTimeout(() => win.close(), 50);
}

ipcMain.handle('rec:finish', (_e, stats) => {
  const rec = finishRecording(true);
  if (rec) showToast(`Saved · ${rec.name}`);
  if (process.env.DARC_SMOKE) console.log(JSON.stringify({ saved: rec && rec.path, ...stats }));
  afterRecording();
  return rec ? { path: rec.path, name: rec.name } : { error: 'No file open' };
});

ipcMain.handle('rec:cancel', () => {
  finishRecording(false);
  if (process.env.DARC_SMOKE) console.log(JSON.stringify({ saved: null }));
  afterRecording();
  return true;
});

// Reload for a fresh run of the page's load animations: from the top, since
// Chromium restores the scroll position across a reload.
ipcMain.on('rec:reload', async () => {
  const wc = page.webContents;
  await wc.executeJavaScript('window.scrollTo(0, 0)', true).catch(() => {});
  pendingReload = true;
  wc.reload();
});

app.whenReady().then(() => {
  if (!app.isPackaged) app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  buildMenu();
  createWindow();
  if (process.env.DARC_SMOKE) smokeTest(process.env.DARC_SMOKE);
});

// DARC_SMOKE=<url> npm start — loads the page, records it for a few seconds,
// prints the result as JSON and quits. For checking the pipeline end to end.
function smokeTest(url) {
  const wc = page.webContents;
  if (process.env.DARC_SMOKE_BLUR) store.motionBlur = +process.env.DARC_SMOKE_BLUR;
  if (process.env.DARC_SMOKE_HEIGHT) store.recordHeight = process.env.DARC_SMOKE_HEIGHT === 'native' ? 'native' : +process.env.DARC_SMOKE_HEIGHT;
  if (process.env.DARC_SMOKE_CURSOR) store.cursor = { ...store.cursor, ...JSON.parse(process.env.DARC_SMOKE_CURSOR) };
  const seconds = Number(process.env.DARC_SMOKE_SECONDS) || 4;
  // A track for the page, e.g. '{"stops":[...],"cursor":[...]}', and when to play it.
  if (process.env.DARC_SMOKE_TRACK) {
    const u = new URL(url);
    store.animations[u.origin + u.pathname] = JSON.parse(process.env.DARC_SMOKE_TRACK);
  }
  wc.once('did-finish-load', () => {
    hideOverlay();
    const size = (process.env.DARC_SMOKE_SIZE || '').match(/^(\d+)x(\d+)$/);
    if (size) setWindowSize(+size[1], +size[2], 'smoke');
    wc.loadURL(url);
    wc.once('did-finish-load', () => {
      // DARC_SMOKE_ANIMATOR_SHOT=<png>: screenshot the animation panel instead of recording.
      if (process.env.DARC_SMOKE_ANIMATOR_SHOT) {
        toggleAnimator();
        animator.webContents.on('console-message', (e) => console.log(`[animator] ${e.message}`));
        setTimeout(async () => {
          if (process.env.DARC_SMOKE_ANIMATOR_JS) {
            await animator.webContents.executeJavaScript(process.env.DARC_SMOKE_ANIMATOR_JS, true).catch((e) => console.log('smoke animator js', e.message));
            await new Promise((r) => setTimeout(r, 400));
          }
          const img = await animator.webContents.capturePage();
          fs.writeFileSync(process.env.DARC_SMOKE_ANIMATOR_SHOT, img.toPNG());
          app.exit(0);
        }, 6000);
        return;
      }
      setTimeout(() => {
        toggleRecording();
        recorder.webContents.on('console-message', (e) => console.log(`[recorder] ${e.message}`));
        if (process.env.DARC_SMOKE_PLAY) {
          setTimeout(playAnimation, +process.env.DARC_SMOKE_PLAY);
        }
        if (process.env.DARC_SMOKE_SCROLL) {
          setTimeout(() => wc.send('anim:seek', +process.env.DARC_SMOKE_SCROLL), 1500);
        }
        if (process.env.DARC_SMOKE_JS) {
          setTimeout(() => wc.executeJavaScript(process.env.DARC_SMOKE_JS, true).catch((e) => console.log('smoke js', e.message)), 2500);
        }
        setTimeout(toggleRecording, seconds * 1000);
      }, 1500);
    });
  });
  const orig = afterRecording;
  afterRecording = () => {
    orig();
    setTimeout(async () => {
      if (process.env.DARC_SMOKE_SHOT && recorderOpen()) {
        const img = await recorder.webContents.capturePage();
        fs.writeFileSync(process.env.DARC_SMOKE_SHOT, img.toPNG());
      }
      app.exit(0);
    }, 600);
  };
}

app.on('window-all-closed', () => app.quit());
