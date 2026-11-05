// Minimal Electron stand-in so `node --test` can import ../updater.ts, whose
// only non-builtin import is "electron". The test maps the specifier here via
// module.registerHooks; state lives in this module instance so tests can
// observe dialogs, IPC sends, and quit() calls, and control the stub answers.
export const state = {
    version: "0.0.0",
    isPackaged: true,
    paths: {},
    dialogs: [],
    dialogResponse: 1, // 1 = "Later": importing a check must never restart by itself
    quitCount: 0,
    sent: [], // { channel, payload } from webContents.send
    ipcHandlers: {},
};

export const app = {
    get isPackaged() {
        return state.isPackaged;
    },
    getVersion: () => state.version,
    getPath: (name) => {
        if (!state.paths[name]) throw new Error(`stub getPath(${name}) not configured`);
        return state.paths[name];
    },
    quit: () => {
        state.quitCount++;
    },
};

export const dialog = {
    showMessageBox: async (options) => {
        state.dialogs.push(options);
        return { response: state.dialogResponse };
    },
};

export const ipcMain = {
    on: (channel, handler) => {
        state.ipcHandlers[channel] = handler;
    },
};
