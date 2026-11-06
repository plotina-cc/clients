// Plotina Lite Desktop preload (sandboxed, contextIsolation).
// The web app itself needs no desktop APIs for Phase 1; this only exposes
// safe metadata. External links are handled centrally by the main process
// (will-navigate / window-open handlers -> shell.openExternal), so the
// sandboxed preload does not need ipc at all.
'use strict';

const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('plotinaLite', {
  platform: process.platform,
  versions: {
    chrome: process.versions.chrome,
    electron: process.versions.electron,
    node: process.versions.node,
  },
  isDesktop: true,
});
