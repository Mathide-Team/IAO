'use strict';

// Issue #162 : mode debug sur toute l'application, côté main.js.
// Même principe que test/main-log-instance.test.js : `require('electron')` est
// remplacé par un module simulé, tout se passe dans un dossier temporaire.
// main.js lit --iao-debug / IAO_DEBUG au chargement : chaque test recharge donc
// une copie neuve de main.js avec ou sans IAO_DEBUG=1.

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
  const appListeners = new Map();
  const windows = [];
  const ipcHandlers = new Map();
  const calls = { readyCallbacks: [] };

  const app = {
    getPath: (name) => (name === 'appData' ? appDataDir : path.join(appDataDir, name)),
    setPath() {},
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    setName() {},
    requestSingleInstanceLock: () => true,
    quit() {},
    on(event, fn) { appListeners.set(event, fn); return this; },
    whenReady: () => ({ then(fn) { calls.readyCallbacks.push(fn); return this; } })
  };

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.getURL = () => 'file:///index.html';
      windows.push(this);
    }
    loadFile() {}
    setMenuBarVisibility() {}
    static getAllWindows() { return windows; }
  }

  const ipcMain = {
    handle(channel, fn) { ipcHandlers.set(channel, fn); },
    on() {}
  };
  const session = {
    fromPartition: () => ({ on() {}, clearStorageData: async () => {}, clearCache: async () => {} }),
    defaultSession: {}
  };
  const dialog = { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) };
  const shell = { openExternal() {} };

  return { app, BrowserWindow, ipcMain, dialog, shell, session, appListeners, windows, ipcHandlers, calls };
}

function loadMain({ debug }) {
  const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-main-debug-'));
  const electron = createElectronMock(appDataDir);
  const output = [];
  const original = { warn: console.warn, log: console.log, error: console.error };
  const capture = () => {
    console.log = console.warn = console.error = (...a) => output.push(a.join(' '));
  };
  const release = () => { Object.assign(console, original); };
  const previousEnv = process.env.IAO_DEBUG;
  if (debug) process.env.IAO_DEBUG = '1';
  else delete process.env.IAO_DEBUG;

  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') return electron;
    return originalLoad.apply(this, arguments);
  };
  capture();
  try {
    delete require.cache[MAIN_PATH];
    require(MAIN_PATH);
  } finally {
    Module._load = originalLoad;
    release();
    if (previousEnv === undefined) delete process.env.IAO_DEBUG;
    else process.env.IAO_DEBUG = previousEnv;
  }

  const logFile = path.join(appDataDir, 'userData', 'logs', 'iao.log');
  return {
    electron,
    output,
    readLog: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : ''),
    async ready() {
      capture();
      try { for (const fn of electron.calls.readyCallbacks) await fn(); } finally { release(); }
    },
    async invoke(channel, ...args) {
      capture();
      try { return await electron.ipcHandlers.get(channel)({}, ...args); } finally { release(); }
    },
    // Attache une fausse <webview> à la fenêtre principale et renvoie son webContents.
    attachWebview(url) {
      const guest = new EventEmitter();
      guest.getURL = () => url;
      guest.setWindowOpenHandler = () => {};
      guest.session = {};
      capture();
      try { electron.windows[0].webContents.emit('did-attach-webview', {}, guest); } finally { release(); }
      return guest;
    },
    emit(emitter, ...args) {
      capture();
      try { emitter.emit(...args); } finally { release(); }
    },
    cleanup() {
      delete require.cache[MAIN_PATH];
      fs.rmSync(appDataDir, { recursive: true, force: true });
    }
  };
}

test('mode debug : app:is-debug renvoie true et l\'appel IPC est tracé sans ses arguments', async () => {
  const h = loadMain({ debug: true });
  try {
    await h.ready();
    assert.equal(await h.invoke('app:is-debug', 'secret-argument'), true);
    const log = h.readLog();
    assert.match(log, /\[ipc\] debug app:is-debug → ok \(\d+ ms, 1 argument\(s\)\)/);
    assert.ok(!log.includes('secret-argument'), 'les arguments IPC ne doivent jamais être journalisés');
  } finally { h.cleanup(); }
});

test('mode debug : versions, options et branchement de l\'ordonnanceur au démarrage', async () => {
  const h = loadMain({ debug: true });
  try {
    await h.ready();
    const log = h.readLog();
    assert.match(log, /\[demarrage\] info IAO 0\.0\.0-test .*mode debug/);
    assert.match(log, /\[demarrage\] debug mode debug actif — Electron .*; options : /);
    // setLogger : le journal d'activité de l'ordonnanceur rejoint iao.log.
    assert.match(log, /\[scheduler\] info Ordonnanceur démarré/);
  } finally { h.cleanup(); }
});

test('mode debug : onglet IA — attache, navigation, échec, console (avertissements/erreurs seulement)', async () => {
  const h = loadMain({ debug: true });
  try {
    await h.ready();
    const guest = h.attachWebview('https://claude.ai/new?token=abc');
    h.emit(guest, 'did-navigate', {}, 'https://claude.ai/chat/1?code=secret');
    h.emit(guest, 'did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://chat.z.ai/');
    h.emit(guest, 'console-message', { level: 3, message: 'TypeError: x', sourceId: 'https://claude.ai/app.js', lineNumber: 7 });
    h.emit(guest, 'console-message', { level: 0, message: 'bruit de debug du site' });
    const log = h.readLog();
    assert.match(log, /\[webview\] debug onglet attaché : claude\.ai/);
    assert.match(log, /\[webview\] debug navigation → claude\.ai/);
    assert.match(log, /\[webview\] debug échec de chargement chat\.z\.ai : ERR_NAME_NOT_RESOLVED \(-105\)/);
    assert.match(log, /\[webview claude\.ai\] error TypeError: x/);
    assert.ok(!log.includes('bruit de debug du site'), 'le niveau debug des sites tiers n\'est pas recopié');
    assert.ok(!log.includes('secret') && !log.includes('token=abc'), 'seul l\'hôte des URL est journalisé');
  } finally { h.cleanup(); }
});

test('mode normal : app:is-debug renvoie false, aucune trace debug ni console d\'onglet', async () => {
  const h = loadMain({ debug: false });
  try {
    await h.ready();
    assert.equal(await h.invoke('app:is-debug'), false);
    const guest = h.attachWebview('https://claude.ai/new');
    h.emit(guest, 'did-navigate', {}, 'https://claude.ai/chat/1');
    h.emit(guest, 'did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://chat.z.ai/');
    h.emit(guest, 'console-message', { level: 3, message: 'TypeError: x' });
    const log = h.readLog();
    assert.ok(!/ debug /.test(log), 'aucune ligne de niveau debug hors mode debug');
    assert.ok(!log.includes('TypeError: x'));
    assert.ok(!log.includes('[ipc]'));
    // Le journal d'activité de l'ordonnanceur est écrit même hors mode debug.
    assert.match(log, /\[scheduler\] info Ordonnanceur démarré/);
  } finally { h.cleanup(); }
});
