'use strict';

const { app, BrowserWindow, ipcMain, Notification, shell, net } = require('electron');
const path = require('path');
const fs = require('fs/promises');

const APP_ID = 'com.simplerss.app';
const FETCH_TIMEOUT_MS = 20000;
const MAX_FEED_BYTES = 10 * 1024 * 1024;

let win = null;
const liveNotifications = new Set(); // keep references so click handlers aren't garbage-collected

// ---------- single instance ----------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => focusWindow());
}

if (process.platform === 'win32') app.setAppUserModelId(APP_ID); // required for Windows toasts

function focusWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function isSafeExternal(url) {
  return typeof url === 'string' && /^(https?:|mailto:)/i.test(url);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    title: 'Simple RSS',
    backgroundColor: '#15171c',
    autoHideMenuBar: true,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Never open new Electron windows or navigate away; hand links to the system browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternal(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) {
      event.preventDefault();
      if (isSafeExternal(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => { win = null; });
}

// ---------- persistent store (JSON in the user data folder) ----------
const storeFile = () => path.join(app.getPath('userData'), 'store.json');
let writeChain = Promise.resolve();

ipcMain.handle('store:load', async () => {
  try {
    return JSON.parse(await fs.readFile(storeFile(), 'utf8'));
  } catch {
    return null;
  }
});

ipcMain.handle('store:save', (_e, data) => {
  // Serialise writes and write atomically (tmp + rename) so a crash never leaves a half-written file.
  writeChain = writeChain.then(async () => {
    const file = storeFile();
    const tmp = file + '.tmp';
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(tmp, JSON.stringify(data), 'utf8');
    await fs.rename(tmp, file);
  }).catch((err) => console.error('store:save failed', err));
  return writeChain;
});

// ---------- feed fetching (main process: no CORS limits) ----------
function detectCharset(contentType, bytes) {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType || '');
  if (fromHeader) return fromHeader[1];
  const head = Buffer.from(bytes.slice(0, 300)).toString('latin1');
  const fromXml = /<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head);
  return fromXml ? fromXml[1] : 'utf-8';
}

ipcMain.handle('feed:fetch', async (_e, url) => {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
    throw new Error('Only http(s) URLs are supported');
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await net.fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': `SimpleRSS/${app.getVersion()} (+desktop RSS reader)`,
        Accept: 'application/rss+xml, application/atom+xml, application/xml;q=0.9, text/xml;q=0.9, text/html;q=0.7, */*;q=0.5',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (bytes.byteLength > MAX_FEED_BYTES) throw new Error('Feed is too large');
    let decoder;
    try {
      decoder = new TextDecoder(detectCharset(res.headers.get('content-type'), bytes));
    } catch {
      decoder = new TextDecoder('utf-8');
    }
    return { text: decoder.decode(bytes), finalUrl: res.url || url };
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
});

// ---------- desktop notifications ----------
ipcMain.handle('notify', (_e, { title, body, channelId, itemId }) => {
  if (!Notification.isSupported()) return false;
  const n = new Notification({
    title: String(title || 'Simple RSS').slice(0, 200),
    body: String(body || '').slice(0, 300),
  });
  liveNotifications.add(n);
  n.on('click', () => {
    focusWindow();
    if (win) win.webContents.send('open-item', { channelId, itemId });
  });
  n.on('close', () => liveNotifications.delete(n));
  n.show();
  return true;
});

ipcMain.handle('open-external', (_e, url) => {
  if (isSafeExternal(url)) shell.openExternal(url);
});

// ---------- lifecycle ----------
app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
