// Cadence for Windows and Linux: the Cadence web app in a desktop window, plus what a browser
// tab can't do: a tray icon that keeps reminders running, start at login, and a check-in
// whenever the computer wakes or unlocks.
const { app, BrowserWindow, Tray, Menu, shell, powerMonitor, nativeImage, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const SITE = 'https://cadenceplanner.vercel.app';
const APP_URL = `${SITE}/app`;
const startHidden = process.argv.includes('--hidden');

let win = null;
let tray = null;
let quitting = false;

if (!app.requestSingleInstanceLock()) app.quit();
app.on('second-instance', () => show());
if (process.platform === 'win32') app.setAppUserModelId('com.ryanpark.cadence.desktop');

// ---------- start at login ----------
const autostartFile = path.join(os.homedir(), '.config', 'autostart', 'cadence.desktop');
function loginItemEnabled() {
  if (process.platform === 'linux') return fs.existsSync(autostartFile);
  return app.getLoginItemSettings().openAtLogin;
}
function setLoginItem(on) {
  if (process.platform === 'linux') {
    if (!on) { fs.rmSync(autostartFile, { force: true }); return; }
    const exec = process.env.APPIMAGE || process.execPath;
    fs.mkdirSync(path.dirname(autostartFile), { recursive: true });
    fs.writeFileSync(autostartFile, `[Desktop Entry]\nType=Application\nName=Cadence\nExec="${exec}" --hidden\nX-GNOME-Autostart-enabled=true\n`);
    return;
  }
  app.setLoginItemSettings({ openAtLogin: on, args: ['--hidden'] });
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1200, height: 800, minWidth: 900, minHeight: 600,
    title: 'Cadence', show: false, backgroundColor: '#1c1c1e', autoHideMenuBar: true,
    icon: path.join(__dirname, 'tray@2x.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  win.loadURL(APP_URL);
  win.once('ready-to-show', () => { if (!startHidden) win.show(); });
  // Closing hides to the tray, so reminders keep running.
  win.on('close', e => { if (!quitting) { e.preventDefault(); win.hide(); } });
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMain) => {
    if (isMain && code !== -3) win.loadFile(path.join(__dirname, 'offline.html'), { query: { retry: url || APP_URL } });
  });
  // Stay on Cadence; everything else opens in the normal browser. Google refuses sign-in inside
  // embedded app windows, so connecting Google happens in the browser (it then works here too).
  const route = url => {
    if (url.startsWith(SITE) && !url.includes('/api/google/connect')) return false;
    if (url.includes('/api/google/connect') || url.startsWith('https://accounts.google.com')) {
      shell.openExternal(`${SITE}/app/settings`);
      dialog.showMessageBox(win, { type: 'info', message: 'Connect Google Calendar in your browser',
        detail: 'Google only allows signing in from a regular browser. Sign in to Cadence there, connect Google Calendar in Settings, and it will work in this app automatically.' });
      return true;
    }
    shell.openExternal(url);
    return true;
  };
  win.webContents.setWindowOpenHandler(({ url }) => { route(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (route(url)) e.preventDefault(); });
}

function show() {
  if (!win) createWindow();
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function send(channel, ...args) { win?.webContents.send(channel, ...args); }

// ---------- tray ----------
function buildTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'tray.png'));
  icon.addRepresentation({ scaleFactor: 2, buffer: fs.readFileSync(path.join(__dirname, 'tray@2x.png')) });
  tray = new Tray(icon);
  tray.setToolTip('Cadence');
  tray.on('click', show);
  refreshTrayMenu();
}
function refreshTrayMenu(remaining) {
  if (!tray) return;
  tray.setToolTip(remaining ? `Cadence — ${remaining} left today` : 'Cadence');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: remaining ? `${remaining} left today` : 'Cadence', enabled: false },
    { type: 'separator' },
    { label: 'Open Cadence', click: show },
    { label: 'Check in now', click: () => { show(); send('cadence:command', 'check-in'); } },
    { label: 'New task', click: () => { show(); send('cadence:command', 'new-task'); } },
    { type: 'separator' },
    { label: 'Start Cadence at login', type: 'checkbox', checked: loginItemEnabled(), click: m => { setLoginItem(m.checked); } },
    { type: 'separator' },
    { label: 'Quit Cadence', click: () => { quitting = true; app.quit(); } },
  ]));
}
ipcMain.on('cadence:badge', (_e, n) => refreshTrayMenu(Number(n) || 0));

// ---------- app ----------
app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  createWindow();
  buildTray();
  // First run of an installed copy: start at login by default, like the Mac app recommends.
  const marker = path.join(app.getPath('userData'), 'first-run-done');
  if (app.isPackaged && !fs.existsSync(marker)) { setLoginItem(true); fs.writeFileSync(marker, ''); refreshTrayMenu(); }
  // Self-test (CI / local): load the app hidden, report what the page sees, quit.
  if (process.env.CADENCE_SELFTEST) {
    win.webContents.once('did-finish-load', async () => {
      await new Promise(r => setTimeout(r, 2500));
      const r = await win.webContents.executeJavaScript(
        "({ url: location.href, title: document.title, bridge: typeof window.cadenceDesktop, signInShown: !!document.querySelector('[data-form=auth]') })");
      console.log('SELFTEST', JSON.stringify(r));
      quitting = true; app.quit();
    });
  }
  // "Opening the computer": wake from sleep or unlock → the app's check-in.
  powerMonitor.on('resume', () => setTimeout(() => send('cadence:wake', 'wake'), 2500));
  powerMonitor.on('unlock-screen', () => send('cadence:wake', 'unlock'));
});
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', e => e.preventDefault?.());
