const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, ipcMain, screen, shell, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pathToFileURL } = require('url');
const { readMp4Index } = require('./mp4-index');

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
  library: [], // custom cursors, uploaded or taken from pages (see cursorEntry)
  selected: null, // id of the library cursor drawn in 'custom' mode
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
let store = { settings: { ...DEFAULTS }, cursor: { ...CURSOR_DEFAULTS }, lastUrl: '', bounds: null, animations: {}, animatorWidth: 680, reloadOnRecord: true, playOnRecord: false, recordHeight: 'native', motionBlur: 0 };
try {
  const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  store = { ...store, ...saved, settings: { ...DEFAULTS, ...saved.settings }, cursor: { ...CURSOR_DEFAULTS, ...saved.cursor } };
} catch {}

// Before the library there was one uploaded image, with the hotspot set for it.
if (store.cursor.custom) {
  const { custom, hotspot, ...rest } = store.cursor;
  store.cursor = rest;
  if (custom.path && fs.existsSync(custom.path) && !store.cursor.library.length) {
    store.cursor.library = [{ id: 'legacy', name: custom.name, file: custom.path, hotspot: hotspot || 'tip' }];
    store.cursor.selected = 'legacy';
  }
}

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
let lastRecording = null; // last video saved from the editor
let lastTake = null; // last recording, waiting in the editor to be saved
let closingForRecording = false; // window close deferred until the recording is saved
let pendingReload = false; // the pane asked for a reload; skip its navigation marker
let animPlaying = false;
// A recording that reloads the page: { issued } until the reloaded page has
// loaded. Playing the animation before then would scroll the page that's
// about to be replaced, so it waits (queuedPlay) and starts after the load.
let recordReload = null;
let queuedPlay = false;
const PLAY_AFTER_LOAD = 250; // ms after the reloaded page loads
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
  if (on && !recordingActive && store.reloadOnRecord !== false) recordReload = { issued: false };
  if (!on && recordReload) {
    // Never got as far as the reload (capture failed to start).
    recordReload = null;
    if (queuedPlay) {
      queuedPlay = false;
      playAnimation();
    }
  }
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

// Recordings land here first, without a cursor, until the editor saves them.
function takesDir() {
  return path.join(recordingsDir(), 'Unsaved');
}

// What the recorder logged alongside a take: the pointer, animation playback
// and cursor settings, so the editor can draw the cursor afterwards.
const sidecarPath = (file) => file.replace(/\.mp4$/i, '.darc.json');
const isTake = (file) => path.dirname(file) === takesDir();

function removeTake(file) {
  fs.rmSync(file, { force: true });
  fs.rmSync(sidecarPath(file), { force: true });
  if (lastTake === file) lastTake = null;
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
const IMAGE_MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.gif': 'image/gif', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.cur': 'image/x-icon', '.ico': 'image/x-icon' };
const MIME_EXT = { 'image/png': '.png', 'image/svg+xml': '.svg', 'image/gif': '.gif', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/x-icon': '.cur', 'image/vnd.microsoft.icon': '.cur' };
const cursorsDir = () => path.join(app.getPath('userData'), 'cursors');

// A library entry: { id, name, file, hotspot, hx, hy, native, source }.
// hotspot is 'tip' (top left), 'center', or 'page' for the (hx, hy) a page's
// CSS gave it, in the image's own px. Cursors taken from a page are `native`:
// drawn at their own size, scaled with the size setting like the built-in
// shapes, rather than squeezed to `size` tall.
function cursorEntry(id) {
  return store.cursor.library.find((e) => e.id === id) || null;
}

function imageData(file) {
  try {
    const mime = IMAGE_MIME[path.extname(file).toLowerCase()] || 'image/png';
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

// Settings as the recorder and the panel's demo need them: with the selected
// custom image inlined, since neither can read files.
function cursorPayload() {
  const { library, ...c } = store.cursor;
  const entry = cursorEntry(c.selected);
  if (!entry) return { ...c, image: null };
  return { ...c, image: imageData(entry.file), name: entry.name, hotspot: entry.hotspot, hx: entry.hx || 0, hy: entry.hy || 0, native: !!entry.native };
}

// Every custom cursor, with its image, for the panel and the editor to pick from.
function cursorLibrary() {
  return store.cursor.library.map((e) => ({ ...e, image: imageData(e.file) }));
}

// Files them by content, so adding the same image again just selects it.
function addCursor(buf, ext, meta) {
  const id = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 12);
  if (!cursorEntry(id)) {
    fs.mkdirSync(cursorsDir(), { recursive: true });
    const file = path.join(cursorsDir(), `${id}${ext}`);
    fs.writeFileSync(file, buf);
    store.cursor.library = [...store.cursor.library, { id, file, ...meta }];
  }
  return id;
}

function cursorsChanged() {
  save();
  syncCursor();
  sendToAnimator('anim:cursor', cursorPayload());
  sendToAnimator('anim:cursor-library', cursorLibrary());
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

// Copies the chosen images into the app's data folder so they outlive the
// originals, and selects the last.
async function pickCursorImage() {
  const { canceled, filePaths } = await dialog.showOpenDialog(animator && !animator.isDestroyed() ? animator : win, {
    title: 'Choose cursor images',
    filters: [{ name: 'Images', extensions: ['png', 'svg', 'gif', 'jpg', 'jpeg', 'webp', 'cur', 'ico'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (canceled || !filePaths.length) return null;
  let id = null;
  for (const src of filePaths) {
    const ext = path.extname(src).toLowerCase();
    const buf = fs.readFileSync(src);
    const hot = ext === '.cur' ? curHotspot(buf) : null;
    id = addCursor(buf, ext, hot ? { name: path.basename(src), hotspot: 'page', ...hot } : { name: path.basename(src), hotspot: 'tip' });
  }
  store.cursor = { ...store.cursor, mode: 'custom', selected: id };
  cursorsChanged();
  return cursorPayload();
}

function removeCursor(id) {
  const entry = cursorEntry(id);
  if (!entry) return;
  store.cursor.library = store.cursor.library.filter((e) => e !== entry);
  if (path.dirname(entry.file) === cursorsDir()) fs.rm(entry.file, { force: true }, () => {});
  if (store.cursor.selected === id) {
    const next = store.cursor.library[store.cursor.library.length - 1];
    store.cursor.selected = next ? next.id : null;
    if (!next && store.cursor.mode === 'custom') store.cursor.mode = 'auto';
  }
  cursorsChanged();
}

// A .cur file carries its own hotspot (in the first image's px), used when
// the CSS doesn't give one.
function curHotspot(buf) {
  if (buf.length < 22 || buf.readUInt16LE(0) !== 0 || buf.readUInt16LE(2) !== 2) return null;
  return { hx: buf.readUInt16LE(10), hy: buf.readUInt16LE(12) };
}

// ---- Cursors from the page's CSS -------------------------------------------
// Runs in the page: every `cursor` with an image in it, from the page's style
// sheets, style attributes and the root's computed style. Sheets from other
// origins can't be read here; their URLs come back for the main process to
// fetch and search instead.
const CURSOR_SCAN = `(() => {
  const rules = [];
  const sheets = [];
  const walk = (list, base) => {
    for (const r of list) {
      if (r.styleSheet) sheet(r.styleSheet);
      else if (r.style && r.style.cursor.includes('url(')) rules.push({ value: r.style.cursor, base, selector: r.selectorText || '' });
      if (r.cssRules) walk(r.cssRules, base);
    }
  };
  const sheet = (s) => {
    const base = s.href || document.baseURI;
    try { walk(s.cssRules, base); } catch { if (s.href) sheets.push(s.href); }
  };
  for (const s of [...document.styleSheets, ...(document.adoptedStyleSheets || [])]) sheet(s);
  for (const el of document.querySelectorAll('[style*="cursor"]')) {
    if (el.style.cursor.includes('url(')) rules.push({ value: el.style.cursor, base: document.baseURI, selector: el.tagName.toLowerCase() });
  }
  const roots = [document.documentElement, document.body].filter(Boolean).map((el) => getComputedStyle(el).cursor).filter((v) => v.includes('url('));
  return { rules, sheets: sheets.slice(0, 20), roots, base: document.baseURI, host: location.hostname };
})()`;

const ROOT_SELECTOR = /(^|,)\s*(html|body|:root|\*)\s*(,|$)/i;
const MAX_CURSOR_BYTES = 2 * 1024 * 1024;

// The first image of a `cursor` value, with its hotspot if it has one, and
// the keyword it falls back to.
function parseCursorValue(value, base) {
  const m = /url\(\s*(["']?)(.*?)\1\s*\)\s*(-?[\d.]+)?\s*(-?[\d.]+)?/.exec(value);
  if (!m) return null;
  let url;
  try {
    url = new URL(m[2], base).href;
  } catch {
    return null;
  }
  const keyword = value.replace(/url\([^)]*\)[^,]*,?/g, '').trim().split(/\s*,\s*/).pop() || 'auto';
  return { url, hx: m[3] != null ? +m[3] : null, hy: m[4] != null ? +m[4] : null, keyword };
}

// `cursor` declarations in a style sheet's text, for sheets the page can't read.
function cursorRulesInCss(css, base) {
  const out = [];
  const re = /([^{}]*)\{([^{}]*)\}/g;
  let m;
  css = css.replace(/\/\*[\s\S]*?\*\//g, '');
  while ((m = re.exec(css))) {
    const decl = /(?:^|;)\s*cursor\s*:\s*([^;]*url\([^;]*)/i.exec(m[2]);
    if (decl) out.push({ value: decl[1], base, selector: m[1].trim() });
  }
  return out;
}

async function fetchCursorImage(ses, url) {
  if (url.startsWith('data:')) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url);
    if (!m) return null;
    const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
    return { buf, mime: (m[1] || '').toLowerCase() };
  }
  const res = await ses.fetch(url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, mime: (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase() };
}

// Adds every image cursor the page's CSS sets to the library and selects its
// main one: the cursor on the root, else on html/body/:root/*, else the first
// that stands in for the arrow rather than a hover state like `pointer`.
async function cursorsFromPage() {
  let scan;
  try {
    scan = await page.webContents.executeJavaScript(CURSOR_SCAN, true);
  } catch {
    return { found: 0 };
  }
  const ses = page.webContents.session;
  const rules = [...scan.rules];
  await Promise.all(scan.sheets.map(async (href) => {
    try {
      const res = await ses.fetch(href);
      if (res.ok) rules.push(...cursorRulesInCss(await res.text(), href));
    } catch {}
  }));
  const found = new Map(); // url -> { url, hx, hy, keyword, rank }
  const consider = (c, rank) => {
    if (!c) return;
    const had = found.get(c.url);
    if (!had || rank < had.rank) found.set(c.url, { ...c, rank, hx: c.hx ?? had?.hx ?? null, hy: c.hy ?? had?.hy ?? null });
  };
  for (const v of scan.roots) consider(parseCursorValue(v, scan.base), 0);
  for (const r of rules) {
    const c = parseCursorValue(r.value, r.base);
    if (!c) continue;
    const arrowish = /^(auto|default)$/.test(c.keyword);
    consider(c, ROOT_SELECTOR.test(r.selector) ? 1 : arrowish ? 2 : 3);
  }
  const ranked = [...found.values()].sort((a, b) => a.rank - b.rank).slice(0, 24);
  let main = null;
  let added = 0;
  for (const c of ranked) {
    try {
      const img = await fetchCursorImage(ses, c.url);
      if (!img || !img.buf.length || img.buf.length > MAX_CURSOR_BYTES) continue;
      const urlExt = path.extname(new URL(c.url).pathname).toLowerCase();
      const ext = MIME_EXT[img.mime] || (IMAGE_MIME[urlExt] ? urlExt : null);
      if (!ext) continue;
      const cur = ext === '.cur' ? curHotspot(img.buf) : null;
      const hx = c.hx ?? cur?.hx ?? 0;
      const hy = c.hy ?? cur?.hy ?? 0;
      const file = c.url.startsWith('data:') ? `cursor${ext}` : path.basename(new URL(c.url).pathname) || `cursor${ext}`;
      const id = addCursor(img.buf, ext, { name: `${scan.host || 'page'} · ${file}`, hotspot: 'page', hx, hy, native: true, source: c.url.startsWith('data:') ? scan.host : c.url });
      added++;
      if (!main) main = cursorEntry(id);
    } catch {}
  }
  if (main) store.cursor = { ...store.cursor, mode: 'custom', selected: main.id };
  cursorsChanged();
  return { found: added, name: main && main.name };
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
  if (recordReload) {
    queuedPlay = true;
    return;
  }
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
        { label: 'Edit Last Recording', click: () => (lastTake && fs.existsSync(lastTake) ? openEditor(lastTake) : showToast('No recording to edit · ⌘E')) },
        { label: 'Open Recording…', accelerator: 'CmdOrCtrl+O', click: openRecordingDialog },
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
    // Unsaved takes stay on disk, to open again later.
    for (const ed of editors.values()) {
      if (ed.out) {
        try {
          fs.closeSync(ed.out.fd);
        } catch {}
        fs.rmSync(ed.out.tmp, { force: true });
      }
      if (!ed.win.isDestroyed()) ed.win.destroy();
    }
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
  wc.on('did-finish-load', () => recordReload && recordReload.issued && afterRecordReload());
  wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
    if (isMainFrame && code !== -3 && recordReload && recordReload.issued) afterRecordReload(); // -3: aborted by another navigation
  });
  // Leaving the page ends its animation; the page can't say so itself.
  wc.on('did-start-navigation', (e) => {
    if (e.isMainFrame && !e.isSameDocument && animPlaying) animProgress({ playing: false });
  });
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
ipcMain.handle('cursor:library', cursorLibrary);
ipcMain.handle('cursor:from-page', cursorsFromPage);
ipcMain.on('cursor:remove', (_e, id) => removeCursor(id));
ipcMain.on('cursor:set', (_e, partial) => {
  const { library, ...rest } = partial;
  store.cursor = { ...store.cursor, ...rest };
  save();
  syncCursor();
});
// Changes one library cursor's own settings, like its hotspot.
ipcMain.on('cursor:set-entry', (_e, id, partial) => {
  const { hotspot } = partial;
  store.cursor.library = store.cursor.library.map((e) => (e.id === id ? { ...e, hotspot } : e));
  save();
  syncCursor();
});

ipcMain.on('anim:play', playAnimation);
ipcMain.on('anim:close', () => animator && animator.close());
ipcMain.on('anim:stop', () => page.webContents.send('anim:stop'));
ipcMain.on('anim:seek', (_e, y) => page.webContents.send('anim:seek', y));
// The recording's reload has finished loading: play the animation if it was
// asked for meanwhile, or if recordings start it.
function afterRecordReload() {
  recordReload = null;
  if (!queuedPlay && !store.playOnRecord) return;
  queuedPlay = false;
  setTimeout(() => recordingActive && playAnimation(), PLAY_AFTER_LOAD);
}

ipcMain.on('anim:progress', (_e, data) => animProgress(data));
function animProgress(data) {
  sendToAnimator('anim:progress', data);
  // The recorder times the pointer's cursor spans off playback.
  const anim = { playing: !!data.playing, elapsed: data.elapsed || 0 };
  sendToRecorder('rec:anim-progress', anim);
  sendToLiveCursor('live:anim-progress', anim);
  if (!!data.playing !== animPlaying) {
    animPlaying = !!data.playing;
    sendToRecorder('rec:event', { type: animPlaying ? 'anim-start' : 'anim-end', label: animPlaying ? 'Animation' : '' });
  }
}

// ---- Recording -------------------------------------------------------------
// The pane captures the page's WebContents (tab capture, so nothing but the
// page is in the footage) and streams a finished MP4 here, chunk by chunk.
ipcMain.on('rec:toggle', toggleRecording);
ipcMain.on('rec:close-pane', closeRecorder);
ipcMain.handle('rec:init', () => ({
  reload: store.reloadOnRecord !== false,
  play: !!store.playOnRecord,
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
ipcMain.on('rec:set-play', (_e, on) => {
  store.playOnRecord = !!on;
  save();
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
    fs.mkdirSync(takesDir(), { recursive: true });
    const name = recordingName();
    const file = path.join(takesDir(), name);
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
  lastTake = rec.path;
  return rec;
}

function afterRecording() {
  if (closingForRecording) setTimeout(() => win.close(), 50);
}

ipcMain.handle('rec:finish', (_e, stats, take) => {
  const rec = finishRecording(true);
  if (rec && take) {
    try {
      fs.writeFileSync(sidecarPath(rec.path), JSON.stringify({ version: 1, name: rec.name, ...take }));
    } catch (err) {
      console.error('take sidecar write failed', err);
    }
  }
  if (rec && closingForRecording) showToast(`Kept in Unsaved · ${rec.name}`);
  if (process.env.DARC_SMOKE) console.log(JSON.stringify({ saved: rec && rec.path, ...stats }));
  afterRecording();
  return rec ? { path: rec.path, name: rec.name } : { error: 'No file open' };
});

// The pane discarded a recording just after it was saved.
ipcMain.handle('rec:discard', (_e, file) => {
  if (!file || file !== lastTake) return false;
  removeTake(file);
  showToast('Recording discarded');
  return true;
});

// Open the last recording in the editor.
ipcMain.on('rec:edit', () => {
  if (closingForRecording) return;
  if (lastTake && fs.existsSync(lastTake)) openEditor(lastTake);
  else showToast('No recording to edit · ⌘E');
});

ipcMain.handle('rec:cancel', (_e, discarded) => {
  if (discarded && recording) showToast('Recording discarded');
  finishRecording(false);
  if (process.env.DARC_SMOKE) console.log(JSON.stringify({ saved: null }));
  afterRecording();
  return true;
});

// Reload for a fresh run of the page's load animations: from the top, since
// Chromium restores the scroll position across a reload.
ipcMain.on('rec:reload', async () => {
  const wc = page.webContents;
  if (recordReload) recordReload.issued = true;
  await wc.executeJavaScript('window.scrollTo(0, 0)', true).catch(() => {});
  pendingReload = true;
  wc.reload();
});

// ---- Editor ----------------------------------------------------------------
// Each recording opens in an editor window to preview it, trim it and tweak
// the cursor before it's saved to the recordings folder. Saving re-encodes
// the take with the cursor drawn on; until then it waits in Unsaved.
const editors = new Map(); // webContents id -> { win, file, dirty, saved, out }

function editorFor(sender) {
  return editors.get(sender.id);
}

function editorBounds() {
  const area = screen.getDisplayMatching(win.getBounds()).workArea;
  const width = Math.min(1280, area.width - 80);
  const height = Math.min(860, area.height - 80);
  return { x: Math.round(area.x + (area.width - width) / 2), y: Math.round(area.y + (area.height - height) / 2), width, height };
}

function openEditor(file) {
  for (const ed of editors.values()) {
    if (ed.file === file && !ed.win.isDestroyed()) return ed.win.focus();
  }
  const ed = { file, dirty: isTake(file), saved: null, out: null };
  ed.win = new BrowserWindow({
    ...editorBounds(),
    minWidth: 760,
    minHeight: 520,
    title: path.basename(file),
    frame: false,
    roundedCorners: false,
    hasShadow: true,
    backgroundColor: '#0b0b0b',
    webPreferences: {
      preload: path.join(__dirname, 'editor-preload.js'),
      contextIsolation: true,
      sandbox: true,
      backgroundThrottling: false, // saving keeps going behind other windows
    },
  });
  const id = ed.win.webContents.id;
  editors.set(id, ed);
  ed.win.loadFile(path.join(__dirname, 'editor.html'));
  ed.win.on('close', (e) => {
    if (ed.out) {
      e.preventDefault();
      ed.win.webContents.send('edit:busy');
      return;
    }
    if (ed.force) return;
    if (!ed.dirty) {
      if (isTake(file) && ed.saved) removeTake(file);
      return;
    }
    e.preventDefault();
    const take = isTake(file);
    const buttons = take ? ['Discard', 'Keep in Unsaved', 'Cancel'] : ['Close', 'Cancel'];
    const choice = dialog.showMessageBoxSync(ed.win, {
      type: 'question',
      message: take ? (ed.saved ? 'Discard your latest changes?' : 'Discard this recording?') : 'Close without saving?',
      detail: take
        ? (ed.saved ? 'The saved video stays as it is. Keep the recording to carry on later from Record › Open Recording…' : "It hasn't been saved yet. Keep it to finish it later from Record › Open Recording…")
        : 'Your edits will be lost.',
      buttons,
      defaultId: buttons.length - 1,
      cancelId: buttons.length - 1,
    });
    if (buttons[choice] === 'Cancel') return;
    if (buttons[choice] === 'Discard') removeTake(file);
    ed.force = true;
    ed.win.close();
  });
  ed.win.on('closed', () => editors.delete(id));
  if (process.env.DARC_SMOKE) smokeEditor(ed);
}

// Where Save writes: the recordings folder, under the take's name.
function outputPath(ed) {
  const out = path.join(recordingsDir(), path.basename(ed.file));
  return out === ed.file ? out.replace(/\.mp4$/i, ' edited.mp4') : out;
}

async function openRecordingDialog() {
  const parent = BrowserWindow.getFocusedWindow() || win;
  const takes = takesDir();
  const { canceled, filePaths } = await dialog.showOpenDialog(parent, {
    title: 'Open a recording',
    defaultPath: fs.existsSync(takes) ? takes : recordingsDir(),
    filters: [{ name: 'Videos', extensions: ['mp4'] }],
    properties: ['openFile'],
  });
  if (!canceled && filePaths.length) openEditor(filePaths[0]);
}

ipcMain.handle('edit:init', (e) => {
  const ed = editorFor(e.sender);
  if (!ed) return { error: 'No recording' };
  try {
    const index = readMp4Index(ed.file);
    let take = null;
    try {
      take = JSON.parse(fs.readFileSync(sidecarPath(ed.file), 'utf8'));
    } catch {}
    // Typed arrays clone over IPC far faster than an array of objects.
    const n = index.samples.length;
    const samples = { offset: new Float64Array(n), size: new Uint32Array(n), dts: new Float64Array(n), pts: new Float64Array(n), key: new Uint8Array(n) };
    index.samples.forEach((s, i) => {
      samples.offset[i] = s.offset;
      samples.size[i] = s.size;
      samples.dts[i] = s.dts;
      samples.pts[i] = s.pts;
      samples.key[i] = s.key ? 1 : 0;
    });
    return {
      url: pathToFileURL(ed.file).href,
      name: path.basename(ed.file),
      output: path.basename(outputPath(ed)),
      isTake: isTake(ed.file),
      take,
      index: { codec: index.codec, width: index.width, height: index.height, duration: index.duration, description: new Uint8Array(index.description), samples },
    };
  } catch (err) {
    return { error: err.message };
  }
});

// Sample data for the decoder, by byte range.
ipcMain.handle('edit:read', (e, position, length) => {
  const ed = editorFor(e.sender);
  if (!ed) return null;
  const fd = fs.openSync(ed.file, 'r');
  try {
    const buf = Buffer.alloc(length);
    const n = fs.readSync(fd, buf, 0, length, position);
    return new Uint8Array(buf.buffer, buf.byteOffset, n);
  } finally {
    fs.closeSync(fd);
  }
});

// Edits are kept in the take's sidecar, so a take kept for later reopens as it was left.
ipcMain.on('edit:state', (e, edits, dirty) => {
  const ed = editorFor(e.sender);
  if (!ed) return;
  ed.dirty = !!dirty;
  if (!isTake(ed.file) || !edits) return;
  clearTimeout(ed.stateTimer);
  ed.stateTimer = setTimeout(() => {
    try {
      const side = sidecarPath(ed.file);
      const take = JSON.parse(fs.readFileSync(side, 'utf8'));
      fs.writeFileSync(side, JSON.stringify({ ...take, edits }));
    } catch {}
  }, 400);
});

// Saving: the editor streams the re-encoded MP4 here, written beside the
// final name and moved into place once it's complete.
ipcMain.handle('edit:open-output', (e) => {
  const ed = editorFor(e.sender);
  if (!ed || ed.out) return { error: 'Already saving' };
  try {
    fs.mkdirSync(recordingsDir(), { recursive: true });
    const file = outputPath(ed);
    const tmp = path.join(path.dirname(file), `.${path.basename(file)}.part`);
    ed.out = { fd: fs.openSync(tmp, 'w'), tmp, path: file };
    return { name: path.basename(file) };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.on('edit:write', (e, position, data) => {
  const ed = editorFor(e.sender);
  if (!ed || !ed.out) return;
  try {
    fs.writeSync(ed.out.fd, data, 0, data.byteLength, position);
  } catch (err) {
    console.error('editor write failed', err);
  }
});

function savedOutput(ed, file) {
  ed.saved = file;
  ed.dirty = false;
  lastRecording = file;
  showToast(`Saved · ${path.basename(file)}`);
  if (process.env.DARC_SMOKE) console.log(JSON.stringify({ exported: file }));
  return { path: file, name: path.basename(file) };
}

ipcMain.handle('edit:finish-output', (e, keep) => {
  const ed = editorFor(e.sender);
  if (!ed || !ed.out) return { error: 'Not saving' };
  const out = ed.out;
  ed.out = null;
  try {
    fs.closeSync(out.fd);
  } catch {}
  if (!keep) {
    fs.rmSync(out.tmp, { force: true });
    return null;
  }
  try {
    fs.renameSync(out.tmp, out.path);
    return savedOutput(ed, out.path);
  } catch (err) {
    fs.rmSync(out.tmp, { force: true });
    return { error: err.message };
  }
});

// Nothing to draw and nothing trimmed: the take is saved as it is, a clone of
// the file rather than a re-encode.
ipcMain.handle('edit:copy', (e) => {
  const ed = editorFor(e.sender);
  if (!ed || ed.out) return { error: 'Already saving' };
  try {
    fs.mkdirSync(recordingsDir(), { recursive: true });
    const file = outputPath(ed);
    fs.copyFileSync(ed.file, file, fs.constants.COPYFILE_FICLONE);
    return savedOutput(ed, file);
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.on('edit:discard', (e) => {
  const ed = editorFor(e.sender);
  if (!ed || ed.out) return;
  if (isTake(ed.file)) {
    removeTake(ed.file);
    showToast('Recording discarded');
  }
  ed.force = true;
  ed.win.close();
});

ipcMain.on('edit:reveal', (e) => {
  const ed = editorFor(e.sender);
  if (ed && ed.saved && fs.existsSync(ed.saved)) shell.showItemInFolder(ed.saved);
});

ipcMain.on('edit:close', (e) => {
  const ed = editorFor(e.sender);
  if (ed) ed.win.close();
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
    if (process.env.DARC_SMOKE_EDIT) return; // smokeEditor takes it from here
    setTimeout(async () => {
      if (process.env.DARC_SMOKE_SHOT && recorderOpen()) {
        const img = await recorder.webContents.capturePage();
        fs.writeFileSync(process.env.DARC_SMOKE_SHOT, img.toPNG());
      }
      app.exit(0);
    }, 600);
  };
}

// DARC_SMOKE_EDIT=1 carries the smoke test on into the editor:
// DARC_SMOKE_EDIT_JS runs in it first, DARC_SMOKE_EDIT_SHOT=<png> screenshots
// it, and DARC_SMOKE_EXPORT=1 saves the video before quitting.
function smokeEditor(ed) {
  if (!process.env.DARC_SMOKE_EDIT) return;
  const wc = ed.win.webContents;
  wc.on('console-message', (e) => console.log(`[editor] ${e.message}`));
  wc.once('did-finish-load', () => {
    setTimeout(async () => {
      const run = (js) => wc.executeJavaScript(js, true).catch((err) => console.log('smoke editor js', err.message));
      if (process.env.DARC_SMOKE_EDIT_JS) {
        await run(process.env.DARC_SMOKE_EDIT_JS);
        await new Promise((r) => setTimeout(r, 600));
      }
      if (process.env.DARC_SMOKE_EDIT_SHOT) fs.writeFileSync(process.env.DARC_SMOKE_EDIT_SHOT, (await wc.capturePage()).toPNG());
      if (process.env.DARC_SMOKE_EXPORT) console.log(JSON.stringify({ export: await run('save()') }));
      app.exit(0);
    }, 2000);
  });
}

app.on('window-all-closed', () => app.quit());
