// Small bridge the Cadence web app looks for (window.cadenceDesktop) when it runs in the desktop app.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cadenceDesktop', {
  platform: process.platform,
  onWake: cb => ipcRenderer.on('cadence:wake', (_e, reason) => cb(reason)),
  onCommand: cb => ipcRenderer.on('cadence:command', (_e, cmd) => cb(cmd)),
  setBadge: n => ipcRenderer.send('cadence:badge', n),
});
