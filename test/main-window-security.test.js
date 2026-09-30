'use strict';

// Issue #98 (55.29) : couverture de main.js — sécurité de la fenêtre et diagnostics.
// Réutilise le principe du harnais de l'issue #93 (test/main-harness.test.js) :
// `require('electron')` est intercepté (Module._load) et remplacé par un module
// simulé. Ici, en plus, on exécute le callback app.whenReady() pour que
// createWindow() construise la fenêtre simulée, puis on déclenche à la main les
// événements de son webContents et de la <webview> invitée.
// Aucun accès réseau, aucune fenêtre réelle, écritures limitées à un dossier
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

function createElectronMock(appDataDir) {
  const ipcHandlers = new Map();
  const windows = [];
  const partitions = new Map();
  const calls = { quit: 0, openExternal: [], readyCallbacks: [] };
  const paths = {};

  const app = {
    getPath: (name) => paths[name] || (name === 'appData' ? appDataDir : path.join(appDataDir, name)),
    setPath(name, value) { paths[name] = value; },
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    setName() {},
    requestSingleInstanceLock: () => true,
    quit() { calls.quit++; },
    on() { return this; },
    whenReady: () => ({ then(fn) { calls.readyCallbacks.push(fn); return this; } })
  };

  class BrowserWindow extends EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new EventEmitter();
      this.webContents.setWindowOpenHandler = (fn) => { this.webContents.openHandler = fn; };
      this.webContents.getURL = () => 'file:///opt/iao/index.html';
      windows.push(this);
    }
    loadFile(file) { this.loaded = file; }
    setMenuBarVisibility(v) { this.menuBarVisible = v; }
    isMinimized() { return false; }
    restore() {}
    focus() {}
    static getAllWindows() { return windows; }
  }

  const ipcMain = {
    handle: (channel, fn) => { ipcHandlers.set(channel, fn); },
    on: (channel, fn) => { ipcHandlers.set(channel, fn); }
  };

  // Sessions par partition : mêmes objets à chaque appel, pour que le scheduler
  // puisse retrouver le profil d'une webview par comparaison de session.
  const session = {
    fromPartition(name) {
      if (!partitions.has(name)) partitions.set(name, new EventEmitter());
      return partitions.get(name);
    },
    defaultSession: {}
  };

  const dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true })
  };
  const shell = { openExternal: (u) => { calls.openExternal.push(u); } };

  return { app, BrowserWindow, ipcMain, dialog, shell, session, ipcHandlers, windows, calls };
}

// Capture console.* pendant fn() et renvoie les lignes émises.
function capture(fn) {
  const out = { log: [], warn: [], error: [] };
  const saved = { log: console.log, warn: console.warn, error: console.error };
  for (const k of Object.keys(out)) console[k] = (...a) => { out[k].push(a.join(' ')); };
  try { fn(); } finally { Object.assign(console, saved); }
  return out;
}

// Charge main.js, exécute app.whenReady() (=> createWindow) et renvoie le
// contexte. `debug` positionne IAO_DEBUG=1 le temps du chargement (DEBUG est lu
// une seule fois, à l'évaluation de main.js).
function boot({ debug = false } = {}) {
  const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-main-window-'));
  const electron = createElectronMock(appDataDir);
  const originalLoad = Module._load;
  const savedDebug = process.env.IAO_DEBUG;
  if (debug) process.env.IAO_DEBUG = '1'; else delete process.env.IAO_DEBUG;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') return electron;
    return originalLoad.apply(this, arguments);
  };
  const saved = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    delete require.cache[MAIN_PATH];
    require(MAIN_PATH);
    assert.equal(electron.calls.readyCallbacks.length, 1);
    electron.calls.readyCallbacks[0]();
  } finally {
    Module._load = originalLoad;
    Object.assign(console, saved);
    if (savedDebug === undefined) delete process.env.IAO_DEBUG; else process.env.IAO_DEBUG = savedDebug;
  }
  assert.equal(electron.windows.length, 1);
  const win = electron.windows[0];
  const logFile = path.join(electron.app.getPath('userData'), 'logs', 'iao.log');
  return {
    electron,
    win,
    wc: win.webContents,
    readLog: () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf-8') : ''),
    // Simule l'attache d'une <webview> et renvoie le webContents invité.
    attachGuest(extra = {}) {
      const guest = Object.assign(new EventEmitter(), {
        setWindowOpenHandler(fn) { this.openHandler = fn; },
        getURL: () => 'https://claude.ai/chat/abc',
        session: undefined
      }, extra);
      win.webContents.emit('did-attach-webview', {}, guest);
      return guest;
    },
    cleanup() {
      delete require.cache[MAIN_PATH];
      fs.rmSync(appDataDir, { recursive: true, force: true });
    }
  };
}

function fakeEvent() {
  return { prevented: false, preventDefault() { this.prevented = true; } };
}

// ---------------------------------------------------------------------------
// 1. Fenêtre hôte : will-navigate et setWindowOpenHandler
// ---------------------------------------------------------------------------

test('will-navigate : la fenêtre hôte bloque toute navigation hors file:// et ne journalise que le host', () => {
  const h = boot();
  try {
    const event = fakeEvent();
    const out = capture(() => {
      h.wc.emit('will-navigate', event, 'https://evil.example.com/steal?token=SECRET123');
    });
    assert.equal(event.prevented, true);
    assert.equal(out.warn.length, 1);
    assert.match(out.warn[0], /navigation de la fenêtre hôte bloquée/);
    assert.match(out.warn[0], /evil\.example\.com/);
    assert.doesNotMatch(out.warn[0], /SECRET123/, 'aucun token de query string dans le journal');
  } finally { h.cleanup(); }
});

test('will-navigate : une URL illisible est bloquée et journalisée comme « url illisible »', () => {
  const h = boot();
  try {
    const event = fakeEvent();
    const out = capture(() => { h.wc.emit('will-navigate', event, 'pas une url'); });
    assert.equal(event.prevented, true);
    assert.match(out.warn[0], /\(url illisible\)/);
  } finally { h.cleanup(); }
});

test('will-navigate : un file:// local (rechargement dev) n\'est pas bloqué', () => {
  const h = boot();
  try {
    const event = fakeEvent();
    const out = capture(() => { h.wc.emit('will-navigate', event, 'file:///opt/iao/index.html'); });
    assert.equal(event.prevented, false);
    assert.equal(out.warn.length, 0);
  } finally { h.cleanup(); }
});

test('setWindowOpenHandler de l\'hôte : refuse toujours l\'ouverture de fenêtre', () => {
  const h = boot();
  try {
    assert.equal(typeof h.wc.openHandler, 'function');
    assert.deepEqual(h.wc.openHandler({ url: 'https://claude.ai/' }), { action: 'deny' });
    assert.deepEqual(h.wc.openHandler({ url: 'https://accounts.google.com/' }), { action: 'deny' });
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// 2. <webview> invitée : did-attach-webview
// ---------------------------------------------------------------------------

test('did-attach-webview : popup vers une origine autorisée => allow, sans navigateur externe', () => {
  const h = boot();
  try {
    const guest = h.attachGuest();
    assert.equal(typeof guest.openHandler, 'function');
    const out = capture(() => {
      assert.deepEqual(guest.openHandler({ url: 'https://accounts.google.com/o/oauth2/auth?x=1' }), { action: 'allow' });
      assert.deepEqual(guest.openHandler({ url: 'https://claude.ai/login' }), { action: 'allow' });
    });
    assert.deepEqual(h.electron.calls.openExternal, []);
    assert.equal(out.warn.length, 0);
  } finally { h.cleanup(); }
});

test('did-attach-webview : popup https hors liste => deny + navigateur système, host seul journalisé', () => {
  const h = boot();
  try {
    const guest = h.attachGuest();
    const url = 'https://tracker.example.org/redirect?code=OAUTH_SECRET';
    let result;
    const out = capture(() => { result = guest.openHandler({ url }); });
    assert.deepEqual(result, { action: 'deny' });
    assert.deepEqual(h.electron.calls.openExternal, [url]);
    assert.equal(out.warn.length, 1);
    assert.match(out.warn[0], /navigateur système/);
    assert.match(out.warn[0], /tracker\.example\.org/);
    assert.doesNotMatch(out.warn[0], /OAUTH_SECRET/);
  } finally { h.cleanup(); }
});

test('did-attach-webview : le schéma http(s) est reconnu sans tenir compte de la casse', () => {
  const h = boot();
  try {
    const guest = h.attachGuest();
    let result;
    capture(() => { result = guest.openHandler({ url: 'HTTP://autre.example.net/page' }); });
    assert.deepEqual(result, { action: 'deny' });
    assert.deepEqual(h.electron.calls.openExternal, ['HTTP://autre.example.net/page']);
  } finally { h.cleanup(); }
});

test('did-attach-webview : popup non web (about:, data:, javascript:) => deny pur, jamais openExternal', () => {
  const h = boot();
  try {
    const guest = h.attachGuest();
    for (const url of ['about:blank', 'data:text/html,<script>1</script>', 'javascript:alert(1)']) {
      let result;
      const out = capture(() => { result = guest.openHandler({ url }); });
      assert.deepEqual(result, { action: 'deny' }, url);
      assert.equal(out.warn.length, 1, url);
      assert.match(out.warn[0], /popup refusée \(schéma non web\)/, url);
    }
    assert.deepEqual(h.electron.calls.openExternal, []);
  } finally { h.cleanup(); }
});

test('did-attach-webview : render-process-gone de l\'invité est journalisé avec son host et la raison', () => {
  const h = boot();
  try {
    const guest = h.attachGuest();
    const out = capture(() => { guest.emit('render-process-gone', {}, { reason: 'crashed' }); });
    assert.equal(out.warn.length, 1);
    assert.match(out.warn[0], /\[webview\] warning onglet claude\.ai arrêté : crashed/);
    assert.match(h.readLog(), /\[webview\] warning onglet claude\.ai arrêté : crashed/);
  } finally { h.cleanup(); }
});

test('did-attach-webview : sans profil identifiable, la webview n\'est pas enregistrée (aucun écouteur destroyed)', () => {
  const h = boot();
  try {
    const guest = h.attachGuest({ session: h.electron.session.fromPartition('persist:inconnu') });
    assert.equal(guest.listenerCount('destroyed'), 0);
    const sansSession = h.attachGuest({ session: undefined });
    assert.equal(sansSession.listenerCount('destroyed'), 0);
  } finally { h.cleanup(); }
});

test('did-attach-webview : un profil connu enregistre la webview, et destroyed la désenregistre sans erreur', async () => {
  const h = boot();
  try {
    const sync = h.electron.ipcHandlers.get('scheduler:sync-accounts');
    const ok = await sync({}, [{ id: 'acc_1', name: 'Compte 1', profile: 'profil_1' }]);
    assert.equal(ok, true);
    const guest = h.attachGuest({ session: h.electron.session.fromPartition('persist:profil_1') });
    assert.equal(guest.listenerCount('destroyed'), 1);
    const out = capture(() => { guest.emit('destroyed'); });
    assert.equal(out.error.length, 0);
  } finally { h.cleanup(); }
});

test('did-attach-webview : une session illisible est absorbée en silence (webview non enregistrée)', () => {
  const h = boot();
  try {
    const guest = new EventEmitter();
    guest.setWindowOpenHandler = () => {};
    guest.getURL = () => 'https://claude.ai/';
    Object.defineProperty(guest, 'session', { get() { throw new Error('session indisponible'); } });
    let thrown = null;
    capture(() => {
      try { h.wc.emit('did-attach-webview', {}, guest); } catch (e) { thrown = e; }
    });
    assert.equal(thrown, null);
    assert.equal(guest.listenerCount('destroyed'), 0);
  } finally { h.cleanup(); }
});

// ---------------------------------------------------------------------------
// 3. Diagnostics de la fenêtre principale
// ---------------------------------------------------------------------------

test('preload-error : journalisé en erreur avec le nom du preload, la cause et la conséquence', () => {
  const h = boot();
  try {
    const out = capture(() => {
      h.wc.emit('preload-error', {}, '/opt/iao/resources/app/preload.js', new Error("module not found: path"));
    });
    assert.equal(out.error.length, 1);
    assert.match(out.error[0], /\[preload\] error échec de preload\.js : module not found: path/);
    assert.match(out.error[0], /window\.iaoAPI sera absent/);
    assert.doesNotMatch(out.error[0], /\/opt\/iao\/resources/, 'seul le nom du fichier est journalisé');
    assert.match(h.readLog(), /\[preload\] error échec de preload\.js/);
  } finally { h.cleanup(); }
});

test('render-process-gone : le processus de rendu arrêté est journalisé avec la raison et le code', () => {
  const h = boot();
  try {
    const out = capture(() => {
      h.wc.emit('render-process-gone', {}, { reason: 'oom', exitCode: 137 });
    });
    assert.equal(out.error.length, 1);
    assert.match(out.error[0], /\[renderer\] error processus de rendu arrêté : oom \(code 137\)/);
    assert.match(h.readLog(), /processus de rendu arrêté : oom \(code 137\)/);
  } finally { h.cleanup(); }
});

test('console-message (mode normal) : seuls warning et error sont recopiés, avec source et ligne', () => {
  const h = boot();
  try {
    const out = capture(() => {
      h.wc.emit('console-message', { level: 'info', message: 'bruit', sourceId: 'file:///opt/iao/assets/app.js', lineNumber: 1 });
      h.wc.emit('console-message', { level: 'debug', message: 'trace', sourceId: '', lineNumber: 2 });
      h.wc.emit('console-message', { level: 'warning', message: 'attention', sourceId: 'file:///opt/iao/assets/app.js', lineNumber: 42 });
      h.wc.emit('console-message', { level: 'error', message: 'panne', sourceId: 'file:///opt/iao/index.html', lineNumber: 7 });
    });
    assert.equal(out.log.length, 0, 'info et debug ne sont pas transmis hors mode debug');
    assert.equal(out.warn.length, 1);
    assert.match(out.warn[0], /\[renderer\] warning attention \(assets\/app\.js:42\)/);
    assert.equal(out.error.length, 1);
    assert.match(out.error[0], /\[renderer\] error panne \(iao\/index\.html:7\)/);
    const fichier = h.readLog();
    assert.match(fichier, /attention/);
    assert.match(fichier, /panne/);
    assert.doesNotMatch(fichier, /bruit|trace/);
  } finally { h.cleanup(); }
});

test('console-message (mode debug IAO_DEBUG=1) : tous les niveaux sont recopiés', () => {
  const h = boot({ debug: true });
  try {
    const out = capture(() => {
      h.wc.emit('console-message', { level: 'info', message: 'détail utile', sourceId: 'file:///opt/iao/assets/app.js', lineNumber: 3 });
    });
    assert.equal(out.log.length, 1);
    assert.match(out.log[0], /\[renderer\] info détail utile \(assets\/app\.js:3\)/);
    assert.match(h.readLog(), /détail utile/);
  } finally { h.cleanup(); }
});

test('did-fail-load : seul l\'échec du cadre principal est journalisé (avec URL, description et code)', () => {
  const h = boot();
  try {
    const out = capture(() => {
      h.wc.emit('did-fail-load', {}, -6, 'ERR_FILE_NOT_FOUND', 'file:///opt/iao/index.html', true);
      h.wc.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://claude.ai/frame', false);
    });
    assert.equal(out.error.length, 1);
    assert.match(out.error[0], /\[renderer\] error chargement impossible de file:\/\/\/opt\/iao\/index\.html : ERR_FILE_NOT_FOUND \(-6\)/);
    assert.doesNotMatch(h.readLog(), /ERR_ABORTED/);
  } finally { h.cleanup(); }
});

test('unresponsive et did-finish-load : la fenêtre qui ne répond plus et l\'interface chargée sont journalisées', () => {
  const h = boot();
  try {
    const out = capture(() => {
      h.wc.emit('unresponsive');
      h.wc.emit('did-finish-load');
    });
    assert.equal(out.warn.length, 1);
    assert.match(out.warn[0], /\[renderer\] warning la fenêtre ne répond plus/);
    assert.equal(out.log.length, 1);
    assert.match(out.log[0], /\[demarrage\] info interface chargée \(index\.html\)\./);
    const fichier = h.readLog();
    assert.match(fichier, /la fenêtre ne répond plus/);
    assert.match(fichier, /interface chargée \(index\.html\)/);
  } finally { h.cleanup(); }
});

test('did-attach-webview : une erreur au désenregistrement (destroyed) est absorbée sans planter le process principal', async () => {
  const { Scheduler } = require('../scheduler');
  const original = Scheduler.prototype.unregisterWebview;
  const h = boot();
  try {
    await h.electron.ipcHandlers.get('scheduler:sync-accounts')({}, [{ id: 'acc_2', name: 'Compte 2', profile: 'profil_2' }]);
    const guest = h.attachGuest({ session: h.electron.session.fromPartition('persist:profil_2') });
    assert.equal(guest.listenerCount('destroyed'), 1);
    let appels = 0;
    Scheduler.prototype.unregisterWebview = function () { appels++; throw new Error('désenregistrement impossible'); };
    let thrown = null;
    capture(() => {
      try { guest.emit('destroyed'); } catch (e) { thrown = e; }
    });
    assert.equal(appels, 1);
    assert.equal(thrown, null);
  } finally {
    Scheduler.prototype.unregisterWebview = original;
    h.cleanup();
  }
});

// ---------------------------------------------------------------------------
// Issue #149 : barre de menu masquée, outils de développement par bouton
// ---------------------------------------------------------------------------

test('#149 : la barre de menu native est masquée, sans masquage automatique (Alt ne la rouvre pas)', () => {
  const h = boot();
  try {
    assert.equal(h.win.menuBarVisible, false);
    assert.notEqual(h.win.options.autoHideMenuBar, true, 'Alt+1..9 ne doit pas faire réapparaître le menu');
  } finally {
    h.cleanup();
  }
});

test('#149 : app:toggle-devtools bascule les outils de la fenêtre principale uniquement', async () => {
  const h = boot();
  try {
    const handler = h.electron.ipcHandlers.get('app:toggle-devtools');
    let toggles = 0;
    h.wc.toggleDevTools = () => { toggles++; };
    assert.equal(await handler({ sender: h.wc }), true);
    assert.equal(toggles, 1);

    // Un autre émetteur (ex. une webview invitée) est refusé.
    const autre = { toggleDevTools() { throw new Error('ne doit pas être appelé'); } };
    assert.equal(await handler({ sender: autre }), false);

    // Fenêtre fermée : plus de fenêtre principale, refus.
    h.win.emit('closed');
    assert.equal(await handler({ sender: h.wc }), false);
    assert.equal(toggles, 1);
  } finally {
    h.cleanup();
  }
});
