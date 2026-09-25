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

const BLANK_PAGE = 'data:text/html,<body style="background:%23000"></body>';

const storePath = path.join(app.getPath('userData'), 'settings.json');
// Carry settings over from when the app was called Narc.
const legacyStorePath = path.join(app.getPath('appData'), 'narc', 'settings.json');
if (!fs.existsSync(storePath) && fs.existsSync(legacyStorePath)) {
  fs.mkdirSync(path.dirname(storePath), { recursive: true });
  fs.copyFileSync(legacyStorePath, storePath);
}
let store = { settings: { ...DEFAULTS }, lastUrl: '', bounds: null, animations: {}, animatorBounds: null };
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
  const tw = 240;
  const th = 48;
  toast.setBounds({ x: Math.round((width - tw) / 2), y: height - th - 28, width: tw, height: th });
}

function showToast(text) {
  toast.setVisible(true);
  toast.webContents.executeJavaScript(`show(${JSON.stringify(text)})`);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.setVisible(false), 2200);
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

function toggleAnimator() {
  if (animator && !animator.isDestroyed()) {
    if (animator.isFocused()) animator.close();
    else animator.focus();
    return;
  }
  let bounds = store.animatorBounds;
  if (!bounds) {
    const main = win.getBounds();
    const area = screen.getDisplayMatching(main).workArea;
    const width = 680;
    const height = Math.min(880, area.height);
    const x = main.x + main.width + 12 + width <= area.x + area.width ? main.x + main.width + 12 : area.x + area.width - width;
    bounds = { x, y: Math.max(area.y, main.y), width, height };
  }
  animator = new BrowserWindow({
    ...bounds,
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
  const remember = () => {
    store.animatorBounds = animator.getBounds();
    save();
  };
  animator.on('moved', remember);
  animator.on('resized', remember);
  animator.on('closed', () => {
    animator = null;
  });
}

// Full-length screenshot of the page, downscaled for the animation panel.
// Taken from a hidden offscreen copy of the page: capturing beyond the viewport
// on the live view can freeze its rendering for ~30s. Captured in tiles
// because a single very tall capture hangs Chromium.
const PREVIEW_TILE = 4000;
const withTimeout = (promise, ms) => {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Timed out capturing the page')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

async function capturePreview() {
  const live = page.webContents;
  const [width, height] = await live.executeJavaScript('[innerWidth, innerHeight]');
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
    wc.setZoomLevel(live.getZoomLevel());
    await withTimeout(wc.loadURL(live.getURL()).catch(() => {}), 30000);
    if (store.settings.hideScrollbars) {
      await wc.insertCSS('::-webkit-scrollbar{display:none!important}*{scrollbar-width:none!important}', { cssOrigin: 'user' });
    }
    await new Promise((r) => setTimeout(r, 600)); // let fonts and late layout settle
    const info = await wc.executeJavaScript(`(() => {
      const el = document.scrollingElement || document.documentElement;
      return { width: innerWidth, height: el.scrollHeight, viewport: innerHeight, dpr: devicePixelRatio };
    })()`);
    const scale = Math.min(1, 640 / (info.width * info.dpr));
    wc.debugger.attach('1.3');
    const tiles = [];
    for (let y = 0; y < info.height; y += PREVIEW_TILE) {
      const tileHeight = Math.min(PREVIEW_TILE, info.height - y);
      const { data } = await withTimeout(wc.debugger.sendCommand('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 82,
        captureBeyondViewport: true,
        clip: { x: 0, y, width: info.width, height: tileHeight, scale },
      }), 10000);
      tiles.push({ src: `data:image/jpeg;base64,${data}`, height: tileHeight });
    }
    return { tiles, ...info };
  } finally {
    copy.destroy();
  }
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

  toast = new WebContentsView();
  toast.setBackgroundColor('#00000000');
  toast.setVisible(false);
  toast.webContents.loadFile(path.join(__dirname, 'toast.html'));

  win.contentView.addChildView(page);
  win.contentView.addChildView(overlay);
  win.contentView.addChildView(toast);
  layout();
  win.on('resize', layout);
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
  });
  const remember = (_e, url) => {
    if (url.startsWith('http')) {
      store.lastUrl = url;
      save();
    }
  };
  wc.on('did-navigate', remember);
  wc.on('did-navigate-in-page', remember);
  wc.on('did-finish-load', () => sendToAnimator('anim:page-changed'));
  wc.on('did-navigate-in-page', () => sendToAnimator('anim:page-changed'));

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

ipcMain.handle('anim:load', () => {
  const key = animationKey();
  return { key, stops: (key && store.animations[key]) || [] };
});

ipcMain.handle('anim:capture', () => capturePreview());

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
