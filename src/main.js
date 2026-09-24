const { app, BaseWindow, WebContentsView, Menu, ipcMain, screen } = require('electron');
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
let store = { settings: { ...DEFAULTS }, lastUrl: '', bounds: null };
try {
  const saved = JSON.parse(fs.readFileSync(storePath, 'utf8'));
  store = { ...store, ...saved, settings: { ...DEFAULTS, ...saved.settings } };
} catch {}

let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => fs.writeFileSync(storePath, JSON.stringify(store, null, 2)), 300);
}

let win, page, overlay, toast;
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

function setWindowSize(width, height) {
  if (win.isFullScreen()) win.setFullScreen(false);
  win.setContentSize(width, height, true);
  win.center();
  const [w, h] = win.getContentSize();
  showToast(`${w} × ${h}`);
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
      label: 'Window',
      submenu: [
        { label: '1280 × 720', accelerator: 'CmdOrCtrl+1', click: () => setWindowSize(1280, 720) },
        { label: '1440 × 900', accelerator: 'CmdOrCtrl+2', click: () => setWindowSize(1440, 900) },
        { label: '1920 × 1080', accelerator: 'CmdOrCtrl+3', click: () => setWindowSize(1920, 1080) },
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

app.whenReady().then(() => {
  buildMenu();
  createWindow();
});

app.on('window-all-closed', () => app.quit());
