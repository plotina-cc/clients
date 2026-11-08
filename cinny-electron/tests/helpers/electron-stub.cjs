'use strict';
// Minimal fake 'electron' for pure-node tests of src/updater.js. Registers
// itself in the module cache under the resolved 'electron' path (or the bare
// id when electron is not installed) so `require('electron')` inside updater.js
// gets this stub. Returns a mutable state object: tests change version,
// userData dir and dialog answers before requiring/running the updater.
const { createRequire } = require('node:module');
const req = createRequire(__filename);

function installElectronStub(initial = {}) {
  const state = {
    version: initial.version || '4.12.8-plotina.18',
    packaged: initial.packaged !== false,
    userData: initial.userData || process.cwd(),
    dialogResponse: typeof initial.dialogResponse === 'number' ? initial.dialogResponse : 1, // 1 = 'Later'
    statuses: [],
    messages: [],   // dialog.showMessageBox payloads, in order
    opened: [],     // shell.openExternal urls
    handlers: {},   // ipcMain.handle registrations, by channel name
    quitCount: 0,
    webContents: {
      isDestroyed: () => false,
      send: (_channel, payload) => { state.statuses.push(payload); },
    },
  };
  const app = {
    // isPackaged is read by detectInstallKind() at require time, so it must be
    // a live getter: tests set state.packaged before requiring updater.js.
    get isPackaged() { return state.packaged; },
    getVersion: () => state.version,
    getPath: () => state.userData,
    quit: () => { state.quitCount += 1; },
    on: () => {},
    setAppUserModelId: () => {},
  };
  const dialog = {
    async showMessageBox(options) {
      state.messages.push(options);
      return { response: state.dialogResponse };
    },
  };
  const ipcMain = { handle(name, fn) { state.handlers[name] = fn; return true; } };
  const shell = { async openExternal(url) { state.opened.push(url); } };

  const stub = { app, dialog, ipcMain, shell };
  let id;
  try { id = req.resolve('electron'); } catch { id = 'electron'; }
  req.cache[id] = { id, filename: id, loaded: true, exports: stub };
  return state;
}

module.exports = { installElectronStub };
