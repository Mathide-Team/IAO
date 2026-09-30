'use strict';

// Issue #96 (55.27) : couverture des handlers IPC de réglages de main.js
// (settings:load et settings:save). Chargement de main.js avec un module
// `electron` simulé (même principe que test/main-harness.test.js, #93) ;
// aucun accès réseau, écritures uniquement dans un dossier temporaire.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

const { DEFAULT_SETTINGS, normalizeSettings } = require('../lib/settings');

const ROOT = path.join(__dirname, '..');
const MAIN_PATH = path.join(ROOT, 'main.js');

function createElectronMock(appDataDir) {
  const ipcHandlers = new Map();
  const app = {
    getPath: (name) => (name === 'appData' ? appDataDir : path.join(appDataDir, name)),
    setPath() {},
    setName() {},
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    requestSingleInstanceLock: () => true,
    quit() {},
    on() { return this; },
    whenReady: () => ({ then() { return this; } })
  };
  class BrowserWindow extends EventEmitter {
    static getAllWindows() { return []; }
  }
  const ipcMain = {
    handle: (channel, fn) => { ipcHandlers.set(channel, fn); },
    on: (channel, fn) => { ipcHandlers.set(channel, fn); }
  };
  const session = { fromPartition: () => ({}), defaultSession: {} };
  const dialog = {};
  const shell = { openExternal() {} };
  return { app, BrowserWindow, ipcMain, dialog, shell, session, ipcHandlers };
}

// Charge une copie neuve de main.js ; renvoie les handlers et le chemin de settings.json.
function loadMain() {
  const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-main-settings-'));
  const electron = createElectronMock(appDataDir);
  const userDataDir = path.join(appDataDir, 'userData');
  fs.mkdirSync(userDataDir, { recursive: true });
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
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
    load: electron.ipcHandlers.get('settings:load'),
    save: electron.ipcHandlers.get('settings:save'),
    settingsPath: path.join(userDataDir, 'settings.json'),
    cleanup() {
      delete require.cache[MAIN_PATH];
      fs.rmSync(appDataDir, { recursive: true, force: true });
    }
  };
}

// Exécute fn en coupant console.error (le handler journalise les erreurs d'écriture).
async function silenceConsoleError(fn) {
  const original = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = original; }
}

test('settings:load : fichier absent -> réglages par défaut', async () => {
  const h = loadMain();
  try {
    assert.equal(typeof h.load, 'function');
    assert.deepEqual(await h.load(), DEFAULT_SETTINGS);
  } finally { h.cleanup(); }
});

test('settings:load : fichier corrompu (JSON invalide) -> réglages par défaut', async () => {
  const h = loadMain();
  try {
    fs.writeFileSync(h.settingsPath, '{ ceci n\'est pas du JSON', 'utf-8');
    assert.deepEqual(await h.load(), DEFAULT_SETTINGS);
  } finally { h.cleanup(); }
});

test('settings:load : fichier valide -> réglages normalisés', async () => {
  const h = loadMain();
  try {
    const stored = { editorFontSize: '20', editorWordWrap: 'on', theme: 'dark', confirmBeforeClose: false };
    fs.writeFileSync(h.settingsPath, JSON.stringify(stored), 'utf-8');
    const result = await h.load();
    assert.deepEqual(result, normalizeSettings(stored));
    assert.equal(result.editorFontSize, 20);
    assert.equal(result.theme, 'dark');
    assert.equal(result.editorWordWrap, 'on');
    assert.equal(result.confirmBeforeClose, false);
  } finally { h.cleanup(); }
});

test('settings:save : succès -> ok, réglages normalisés renvoyés et écrits sur disque', async () => {
  const h = loadMain();
  try {
    const raw = { editorFontSize: 99, theme: 'inconnu', editorWordWrap: 'wordWrapColumn', showAutomationWindows: 'true' };
    const result = await h.save({}, raw);
    const expected = normalizeSettings(raw);
    assert.equal(result.ok, true);
    assert.deepEqual(result.settings, expected);
    assert.equal(result.settings.editorFontSize, 32);
    assert.equal(result.settings.theme, DEFAULT_SETTINGS.theme);
    const onDisk = JSON.parse(fs.readFileSync(h.settingsPath, 'utf-8'));
    assert.deepEqual(onDisk, expected);
    // Aller-retour : ce qui a été sauvegardé est relu à l'identique.
    assert.deepEqual(await h.load(), expected);
  } finally { h.cleanup(); }
});

test('settings:save : erreur d\'écriture -> { ok:false, error } sans exception', async () => {
  const h = loadMain();
  try {
    // settings.json est un dossier : writeFile échoue (EISDIR).
    fs.mkdirSync(h.settingsPath);
    const result = await silenceConsoleError(() => h.save({}, { theme: 'light' }));
    assert.equal(result.ok, false);
    assert.equal(typeof result.error, 'string');
    assert.ok(result.error.length > 0);
    assert.equal(result.settings, undefined);
  } finally { h.cleanup(); }
});
