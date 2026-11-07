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

// Linux desktop environments can hide Electron's native menu bar (and Alt
// may do nothing on KDE/Wayland). Keep the updater reachable without relying
// on that menu or on being logged in: a small fixed button opens the same
// native Updates menu at the cursor.
function installUpdatesButton() {
  if (typeof document === 'undefined' || document.getElementById('plotina-updates-button')) return;
  if (!document.body) return;
  const button = document.createElement('button');
  button.id = 'plotina-updates-button';
  button.type = 'button';
  button.textContent = 'Обновления';
  button.setAttribute('aria-label', 'Обновления');
  button.style.cssText = [
    'position:fixed',
    'right:12px',
    'bottom:12px',
    'z-index:2147483647',
    'background:#1f2430',
    'color:#f2f3f5',
    'border:1px solid #414a5c',
    'border-radius:8px',
    'padding:6px 10px',
    'font:12px system-ui,sans-serif',
    'opacity:.88',
    'cursor:pointer',
  ].join(';');
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    ipcRenderer.invoke('plotina:show-updates-menu').catch(() => {});
  });
  document.body.appendChild(button);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installUpdatesButton, { once: true });
} else {
  installUpdatesButton();
}

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
