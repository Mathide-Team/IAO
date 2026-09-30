'use strict';

// Issue #97 (55.28) : couverture de main.js — journal iao.log et instance unique.
// Même principe que test/main-harness.test.js (issue #93) : `require('electron')`
// est remplacé par un module simulé. Fichier volontairement séparé pour ne pas
// allonger un fichier partagé. Aucun accès réseau, tout se passe dans un dossier
// temporaire.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

const ROOT = path.join(__dirname, '..');
const MAIN_PATH = path.join(ROOT, 'main.js');
const LOG_MAX_BYTES = 1024 * 1024;

function createElectronMock(appDataDir, { lock = true } = {}) {
  const appListeners = new Map();
  const windows = [];
  const calls = { quit: 0, readyCallbacks: [] };

  const app = {
    getPath: (name) => (name === 'appData' ? appDataDir : path.join(appDataDir, name)),
    setPath() {},
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    setName() {},
    requestSingleInstanceLock: () => lock,
    quit() { calls.quit++; },
    on(event, fn) { appListeners.set(event, fn); return this; },
    whenReady: () => ({ then(fn) { calls.readyCallbacks.push(fn); return this; } })
  };

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.restored = 0;
      this.focused = 0;
      this.minimized = false;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.getURL = () => 'file:///index.html';
      windows.push(this);
    }
    loadFile() {}
    setMenuBarVisibility() {}
    isMinimized() { return this.minimized; }
    restore() { this.restored++; this.minimized = false; }
    focus() { this.focused++; }
    static getAllWindows() { return windows; }
  }

  const ipcMain = { handle() {}, on() {} };
  const session = {
    fromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {}, getAllExtensions: () => [] }),
    defaultSession: {}
  };
  const dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true })
  };
  const shell = { openExternal() {} };

  return { app, BrowserWindow, ipcMain, dialog, shell, session, appListeners, windows, calls };
}

// Charge une copie neuve de main.js. `prepare(userDataDir)` permet de préparer le
// disque (journal existant, dossier non inscriptible…) avant l'exécution de main.js.
function loadMain({ lock = true, prepare } = {}) {
  const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-main-log-'));
  const userDataDir = path.join(appDataDir, 'userData');
  fs.mkdirSync(userDataDir, { recursive: true });
  if (prepare) prepare(userDataDir);

  const electron = createElectronMock(appDataDir, { lock });
  const output = { log: [], warn: [], error: [] };
  const original = { warn: console.warn, log: console.log, error: console.error };
  const capture = () => {
    console.log = (...a) => output.log.push(a.join(' '));
    console.warn = (...a) => output.warn.push(a.join(' '));
    console.error = (...a) => output.error.push(a.join(' '));
  };
  const release = () => { Object.assign(console, original); };

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
  }

  return {
    electron,
    output,
    logDir: path.join(userDataDir, 'logs'),
    logFile: path.join(userDataDir, 'logs', 'iao.log'),
    // Exécute les callbacks whenReady() (crée la fenêtre, initialise l'ordonnanceur).
    async ready() {
      capture();
      try {
        for (const fn of electron.calls.readyCallbacks) await fn();
      } finally { release(); }
    },
    // Déclenche l'événement `second-instance` enregistré par main.js.
    secondInstance() {
      capture();
      try { electron.appListeners.get('second-instance')(); } finally { release(); }
    },
    cleanup() {
      delete require.cache[MAIN_PATH];
      fs.rmSync(appDataDir, { recursive: true, force: true });
    }
  };
}

test('journal : un iao.log de plus de 1 Mo est renommé en iao.log.1 au démarrage', async () => {
  const h = loadMain({
    prepare(userDataDir) {
      const logs = path.join(userDataDir, 'logs');
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(path.join(logs, 'iao.log'), Buffer.alloc(LOG_MAX_BYTES + 1, 'a'));
    }
  });
  try {
    assert.ok(fs.existsSync(h.logFile + '.1'), 'iao.log.1 doit exister après rotation');
    assert.equal(fs.statSync(h.logFile + '.1').size, LOG_MAX_BYTES + 1);
    assert.equal(fs.existsSync(h.logFile), false, 'l\'ancien iao.log a été déplacé');

    await h.ready();
    assert.ok(fs.existsSync(h.logFile), 'un nouvel iao.log est créé par la première ligne de journal');
    assert.ok(fs.statSync(h.logFile).size < LOG_MAX_BYTES);
    assert.match(fs.readFileSync(h.logFile, 'utf-8'), /IAO 0\.0\.0-test/);
  } finally { h.cleanup(); }
});

test('journal : un iao.log d\'exactement 1 Mo n\'est pas tourné (seuil strict)', () => {
  const h = loadMain({
    prepare(userDataDir) {
      const logs = path.join(userDataDir, 'logs');
      fs.mkdirSync(logs, { recursive: true });
      fs.writeFileSync(path.join(logs, 'iao.log'), Buffer.alloc(LOG_MAX_BYTES, 'a'));
    }
  });
  try {
    assert.equal(fs.existsSync(h.logFile + '.1'), false);
    assert.equal(fs.statSync(h.logFile).size, LOG_MAX_BYTES);
  } finally { h.cleanup(); }
});

test('journal : sans iao.log existant, le dossier est créé et le journal s\'écrit', async () => {
  const h = loadMain();
  try {
    assert.ok(fs.existsSync(h.logDir));
    assert.equal(fs.existsSync(h.logFile + '.1'), false);
    await h.ready();
    const content = fs.readFileSync(h.logFile, 'utf-8');
    assert.match(content, /interface chargée|IAO 0\.0\.0-test/);
    assert.ok(content.endsWith('\n'));
  } finally { h.cleanup(); }
});

test('journal : dossier non inscriptible → message dans le terminal, pas de fichier, pas de plantage', async () => {
  // `logs` existe déjà sous forme de FICHIER : mkdirSync({recursive}) échoue (EEXIST).
  const h = loadMain({
    prepare(userDataDir) { fs.writeFileSync(path.join(userDataDir, 'logs'), 'je ne suis pas un dossier'); }
  });
  try {
    assert.equal(h.output.error.length, 1);
    assert.match(h.output.error[0], /\[demarrage\] journal indisponible/);
    assert.ok(h.output.error[0].includes(h.logFile));

    // Le démarrage continue : log() écrit dans le terminal seulement.
    await h.ready();
    assert.equal(fs.statSync(path.join(h.logDir, '..', 'logs')).isFile(), true);
    assert.ok(h.output.log.some((l) => /IAO 0\.0\.0-test/.test(l)));
    assert.equal(h.electron.windows.length, 1, 'la fenêtre est quand même créée');
  } finally { h.cleanup(); }
});

test('journal : échec d\'écriture (disque plein simulé) → repli sur le terminal seul', async () => {
  // iao.log est un DOSSIER : statSync réussit (taille faible), appendFileSync lève EISDIR.
  const h = loadMain({
    prepare(userDataDir) { fs.mkdirSync(path.join(userDataDir, 'logs', 'iao.log'), { recursive: true }); }
  });
  try {
    assert.equal(h.output.error.length, 0, 'le dossier est utilisable, pas de message d\'indisponibilité');
    await h.ready();
    assert.ok(h.output.log.some((l) => /IAO 0\.0\.0-test/.test(l)), 'la ligne reste visible dans le terminal');
    assert.equal(fs.statSync(h.logFile).isDirectory(), true);
    assert.equal(h.electron.windows.length, 1);
  } finally { h.cleanup(); }
});

test('instance unique : 2e instance (verrou refusé) → avertissement, app.quit(), rien d\'ouvert', async () => {
  const h = loadMain({ lock: false });
  try {
    assert.equal(h.electron.calls.quit, 1);
    assert.equal(h.output.warn.length, 1);
    assert.match(h.output.warn[0], /IAO est déjà lancé/);
    assert.equal(h.electron.appListeners.has('second-instance'), false, 'pas d\'écouteur second-instance');
    assert.equal(fs.existsSync(h.logDir), false, 'le journal n\'est pas préparé');

    await h.ready();
    assert.equal(h.electron.windows.length, 0, 'aucune fenêtre créée');
    assert.equal(h.electron.appListeners.has('activate'), false);
    assert.equal(fs.existsSync(h.logDir), false);
  } finally { h.cleanup(); }
});

test('second-instance : fenêtre réduite → restaurée puis mise au premier plan', async () => {
  const h = loadMain();
  try {
    await h.ready();
    const win = h.electron.windows[0];
    win.minimized = true;
    h.secondInstance();
    assert.equal(win.restored, 1);
    assert.equal(win.focused, 1);
    assert.match(fs.readFileSync(h.logFile, 'utf-8'), /Seconde instance demandée/);
  } finally { h.cleanup(); }
});

test('second-instance : fenêtre non réduite → focus seul, sans restore', async () => {
  const h = loadMain();
  try {
    await h.ready();
    const win = h.electron.windows[0];
    h.secondInstance();
    assert.equal(win.restored, 0);
    assert.equal(win.focused, 1);
  } finally { h.cleanup(); }
});

test('second-instance : aucune fenêtre (avant whenReady) → journalisé, pas d\'exception', () => {
  const h = loadMain();
  try {
    assert.doesNotThrow(() => h.secondInstance());
    assert.equal(h.electron.windows.length, 0);
    assert.match(fs.readFileSync(h.logFile, 'utf-8'), /Seconde instance demandée/);
  } finally { h.cleanup(); }
});
