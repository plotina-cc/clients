// Plotina Lite Desktop preload (sandboxed, contextIsolation).
// The web app needs no desktop APIs for sign-in or messaging; this exposes
// safe metadata plus the updater bridge (the main-process module
// src/updater.js owns all logic; the renderer can only ask for a check /
// install and subscribe to status events — the future Settings → About
// update button plugs into this contract). External links stay handled
// centrally by the main process (will-navigate / window-open ->
// shell.openExternal).
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('plotinaLite', {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  isDesktop: true,
  updater: {
    installKind: () => ipcRenderer.invoke('plotina:install-kind'),
    checkForUpdates: () => ipcRenderer.invoke('plotina:check-updates'),
    installUpdate: () => ipcRenderer.invoke('plotina:install-update'),
    onStatus: (callback) => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('plotina:update-status', listener);
      return () => ipcRenderer.removeListener('plotina:update-status', listener);
    },
    // Update channel. The menu entry ('Канал обновлений: Стабильный / Dev')
    // and a future web Settings page use this same contract; the main process
    // (src/updater.js + src/update-channel.js) owns the policy, so the
    // renderer cannot bypass the dev warning or the downgrade rules.
    channel: {
      get: () => ipcRenderer.invoke('plotina:update-channel-get'),
      set: (channel, options = {}) => ipcRenderer.invoke('plotina:update-channel-set', {
        channel,
        acknowledged: !!options.acknowledged,
        manual: options.manual !== false,
      }),
      returnToStable: () => ipcRenderer.invoke('plotina:update-return-stable'),
    },
  },
});
