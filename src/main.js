const { app, BaseWindow, BrowserWindow, WebContentsView, Menu, ipcMain, screen } = require('electron');
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

const BLANK_PAGE = 'data:text/html,<body style="background:%23000"></body>';

const storePath = path.join(app.getPath('userData'), 'settings.json');
// Carry settings over from when the app was called Narc.
const legacyStorePath = path.join(app.getPath('appData'), 'narc', 'settings.json');
if (!fs.existsSync(storePath) && fs.existsSync(legacyStorePath)) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.copyFileSync(legacyStorePath, storePath);
}
let store = { settings: { ...DEFAULTS }, lastUrl: '', bounds: null, animations: {}, animatorWidth: 680 };
try {
  const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  store = { ...store, ...saved, settings: { ...DEFAULTS, ...saved.settings } };
} catch {}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(storePath, JSON.stringify(store, null, 2)), 300);
}

let win, page, overlay, toast, animator;
let toastTimer;
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
  overlay.setBounds({ x: 0, y: 0, width, height });
  const tw = 340;
  const th = 52;
  toast.setBounds({ x: Math.round((width - tw) / 2), y: height - th - 28, width: tw, height: th });
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

function sendToAnimator(channel, data) {
  if (animator && !animator.isDestroyed()) animator.webContents.send(channel, data);
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
    return { tiles, width: info.width, height: covered, viewport: info.viewport };
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
  const saved = store.animations[key] || [];
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
    const stops = reset ? [] : store.animations[key] || [];
    // Easing is shared across the track, so follow the existing lines.
    const prev = store.animations[key] || [];
    const easing = prev.length ? [...prev[0].easing] : [...DEFAULT_EASING];
    stops.push({ y, duration: 1600, easing, hold: 600 });
    store.animations[key] = stops;
    save();
  }
  showToast(reset ? `Timeline restarted · ${y}px` : `Marker set · ${y}px`);
}

function playAnimation() {
  const stops = store.animations[animationKey()];
  if (!stops || !stops.length) return showToast('No animation for this page · ⌘.');
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

  win.contentView.addChildView(page);
  win.contentView.addChildView(overlay);
  win.contentView.addChildView(toast);
  layout();
  win.on('resize', layout);
  win.on('resize', schedulePreview);
  win.on('close', () => {
    store.bounds = win.getBounds();
    clearTimeout(saveTimer);
    fs.writeFileSync(storePath, JSON.stringify(store, null, 2));
  });

  const wc = page.webContents;
  wc.setWindowOpenHandler(({ url }) => {
    wc.loadURL(url);
    return { action: 'deny' };
  });
  wc.on('dom-ready', () => {
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
  wc.on('did-finish-load', () => sendToAnimator('anim:page-changed'));
  wc.on('did-navigate-in-page', () => sendToAnimator('anim:page-changed'));
  wc.on('did-finish-load', invalidatePreview);
  wc.on('did-navigate-in-page', schedulePreview);

  overlay.webContents.loadFile(path.join(__dirname, 'overlay.html'));
  if (store.lastUrl) {
    wc.loadURL(store.lastUrl);
  } else {
    wc.loadURL(BLANK_PAGE);
    overlay.webContents.once('did-finish-load', () => showOverlay('url'));
  }
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
  return { key, stops: (key && store.animations[key]) || [] };
});

ipcMain.handle('anim:capture', (_e, force) => getPreview(force));

ipcMain.on('anim:set', (_e, { key, stops }) => {
  if (!key) return;
  if (stops.length) store.animations[key] = stops;
  else delete store.animations[key];
  save();
});

ipcMain.on('anim:play', playAnimation);
ipcMain.on('anim:close', () => animator && animator.close());
ipcMain.on('anim:stop', () => page.webContents.send('anim:stop'));
ipcMain.on('anim:progress', (_e, data) => sendToAnimator('anim:progress', data));

app.whenReady().then(() => {
  if (!app.isPackaged) app.dock.setIcon(path.join(__dirname, '..', 'assets', 'icon.png'));
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
