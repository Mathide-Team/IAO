'use strict';

// Issue #93 (55.24) : harnais de chargement de main.js sous `node --test`.
// `require('electron')` est intercepté (Module._load) et remplacé par un
// module simulé (app, BrowserWindow, ipcMain, dialog, session, shell) qui
// capture les handlers IPC et les écouteurs d'événements. Aucun accès réseau,
// aucune fenêtre réelle, aucune écriture hors d'un dossier temporaire.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

const ROOT = path.join(__dirname, '..');
const MAIN_PATH = path.join(ROOT, 'main.js');

function createElectronMock(appDataDir) {
  const ipcHandlers = new Map();
  const appListeners = new Map();
  const windows = [];
  const calls = { quit: 0, openExternal: [], readyCallbacks: [] };

  const app = {
    getPath: (name) => (name === 'appData' ? appDataDir : path.join(appDataDir, name)),
    setPath(name, value) { this._paths = Object.assign(this._paths || {}, { [name]: value }); },
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    setName(name) { this._name = name; },
    requestSingleInstanceLock: () => true,
    quit() { calls.quit++; },
    on(event, fn) { appListeners.set(event, fn); return this; },
    whenReady: () => ({ then(fn) { calls.readyCallbacks.push(fn); return this; } })
  };

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.loaded = null;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (fn) => { this.webContents.openHandler = fn; };
      this.webContents.getURL = () => 'file:///index.html';
      windows.push(this);
    }
    loadFile(file) { this.loaded = file; }
    isMinimized() { return false; }
    restore() {}
    focus() {}
    static getAllWindows() { return windows; }
  }

  const ipcMain = {
    handle: (channel, fn) => { ipcHandlers.set(channel, fn); },
    on: (channel, fn) => { ipcHandlers.set(channel, fn); }
  };

  const session = {
    fromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {}, getAllExtensions: () => [] }),
    defaultSession: {}
  };

  const dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true })
  };

  const shell = { openExternal: (u) => { calls.openExternal.push(u); } };

  return { app, BrowserWindow, ipcMain, dialog, shell, session, ipcHandlers, appListeners, windows, calls };
}

// Charge une copie neuve de main.js avec `electron` simulé, puis restaure Module._load.
function loadMain() {
  const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-main-harness-'));
  const electron = createElectronMock(appDataDir);
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request, parent, isMain) {
    if (request === 'electron') return electron;
    return originalLoad.apply(this, arguments);
  };
  const warn = console.warn; const log = console.log; const error = console.error;
  console.warn = console.log = console.error = () => {};
  try {
    delete require.cache[MAIN_PATH];
    require(MAIN_PATH);
  } finally {
    Module._load = originalLoad;
    console.warn = warn; console.log = log; console.error = error;
  }
  return {
    electron,
    cleanup() {
      delete require.cache[MAIN_PATH];
      fs.rmSync(appDataDir, { recursive: true, force: true });
    }
  };
}

const MAIN_CHANNELS = [
  'accounts:disconnect-profile', 'accounts:export', 'accounts:import',
  'read-directory', 'read-directory-recursive', 'read-file', 'save-file',
  'select-folder', 'settings:load', 'settings:save'
];

test('main.js se charge avec un module electron simulé et liste ses canaux IPC', (t) => {
  const h = loadMain();
  try {
    const channels = [...h.electron.ipcHandlers.keys()].sort();
    t.diagnostic('canaux IPC enregistrés (' + channels.length + ') : ' + channels.join(', '));
    // Canaux propres à main.js : liste exacte (tout ajout/retrait doit être voulu).
    assert.deepEqual(channels.filter((c) => !c.startsWith('scheduler:')), MAIN_CHANNELS);
    // Canaux de l'ordonnanceur (registerSchedulerIPC) : présents et préfixés.
    const scheduler = channels.filter((c) => c.startsWith('scheduler:'));
    assert.ok(scheduler.includes('scheduler:get-state') && scheduler.includes('scheduler:set-config'));
    assert.equal(scheduler.length + MAIN_CHANNELS.length, channels.length);
    assert.ok(channels.every((c) => typeof h.electron.ipcHandlers.get(c) === 'function'));
  } finally { h.cleanup(); }
});

test('main.js : userData fixé sur ai-manager, nom applicatif IAO, instance unique demandée', () => {
  const h = loadMain();
  try {
    assert.equal(path.basename(h.electron.app._paths.userData), 'ai-manager');
    assert.equal(h.electron.app._name, 'IAO');
    assert.ok(h.electron.appListeners.has('second-instance'));
    assert.ok(h.electron.appListeners.has('window-all-closed'));
    assert.equal(h.electron.calls.readyCallbacks.length, 1);
    assert.equal(h.electron.calls.quit, 0);
  } finally { h.cleanup(); }
});
