'use strict';

// Issue #278, lot 2 — menu d'identifiants au focus d'un champ de connexion.
// 1. Fonctions pures de lib/identifiants-focus.js.
// 2. Intégration main.js : preload posé sur chaque session, canal
//    'iao-identifiants:focus', menu proposé et remplissage envoyé au webContents
//    émetteur, suivi des fenêtres filles (popups d'authentification).

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('fs');
const os = require('os');
const path = require('path');

const focus = require('../lib/identifiants-focus');
const { IdentifiantsPartages } = require('../lib/identifiants');

const ROOT = path.join(__dirname, '..');
const MAIN_PATH = path.join(ROOT, 'main.js');
const PRELOAD_PATH = path.join(ROOT, 'lib', 'identifiants-preload.js');

// --- Coffre factice (chiffrement réversible en mémoire) ----------------------

function coffreFactice() {
  return {
    enregistrer() { return { ok: true }; },
    obtenir(hote, login) { return hote === 'context7.com' && login === 'a@x.fr' ? 'S3cret!' : null; },
    lister() { return { 'context7.com': [{ login: 'a@x.fr' }] }; }
  };
}

// --- 1. Fonctions pures ------------------------------------------------------

test('hoteDepuisUrl : https uniquement, en minuscules', () => {
  assert.equal(focus.hoteDepuisUrl('https://Context7.com/Login?x=1'), 'context7.com');
  assert.equal(focus.hoteDepuisUrl('http://context7.com/'), null);
  assert.equal(focus.hoteDepuisUrl('file:///opt/iao/index.html'), null);
  assert.equal(focus.hoteDepuisUrl('pas une url'), null);
  assert.equal(focus.hoteDepuisUrl('about:blank'), null);
});

test('doitProposer : hôte https + identifiants présents + cooldown écoulé', () => {
  const lister = () => ({ 'context7.com': [{ login: 'a@x.fr' }] });
  assert.deepEqual(focus.doitProposer({ url: 'https://context7.com/', lister, maintenant: 5000, derniereProposition: 0, cooldownMs: 1200 }),
    { proposer: true, hote: 'context7.com', logins: [{ login: 'a@x.fr' }] });
  // Pas d'identifiant pour l'hôte.
  assert.deepEqual(focus.doitProposer({ url: 'https://autre.com/', lister, maintenant: 5000, derniereProposition: 0, cooldownMs: 1200 }),
    { proposer: false, hote: 'autre.com' });
  // Cooldown actif (le menu vient d'être proposé).
  assert.deepEqual(focus.doitProposer({ url: 'https://context7.com/', lister, maintenant: 5000, derniereProposition: 4500, cooldownMs: 1200 }),
    { proposer: false, hote: 'context7.com' });
  // Hors https : rien, même pas l'hôte.
  assert.deepEqual(focus.doitProposer({ url: 'http://context7.com/', lister, maintenant: 5000, derniereProposition: 0, cooldownMs: 1200 }),
    { proposer: false, hote: null });
});

test('creer().surFocus : menu proposé, remplissage envoyé à l\'émetteur uniquement', (t) => {
  const envoyes = [];
  const popups = [];
  const construits = [];
  const Menu = {
    buildFromTemplate(items) { construits.push(items); return { popup(o) { popups.push(o); return true; } }; }
  };
  const gestion = focus.creer({
    identifiants: coffreFactice(),
    Menu,
    journal: () => {},
    canalRemplir: 'iao-identifiants:remplir',
    fenetrePour: () => 'FENETRE',
    pointeur: () => ({ x: 3, y: 7 }),
    maintenant: () => 5000
  });
  const sender = { getURL: () => 'https://context7.com/login', send: (c, d) => envoyes.push({ c, d }) };
  assert.equal(gestion.surFocus({ sender }), true);
  assert.equal(construits.length, 1);
  assert.deepEqual(construits[0][0], { label: 'context7.com', enabled: false });
  assert.equal(construits[0][1].label, 'a@x.fr');
  assert.deepEqual(popups[0], { window: 'FENETRE', x: 3, y: 7 });
  // Choix dans le menu : mot de passe déchiffré côté main, envoyé à l'émetteur.
  assert.equal(gestion.remplir(sender, 'context7.com', 'a@x.fr'), true);
  assert.deepEqual(envoyes, [{ c: 'iao-identifiants:remplir', d: { login: 'a@x.fr', motDePasse: 'S3cret!' } }]);
  // Login introuvable : false, rien d'envoyé.
  assert.equal(gestion.remplir(sender, 'context7.com', 'absent@x.fr'), false);
  assert.equal(envoyes.length, 1);
});

test('creer().surFocus : cooldown anti-boucle, hôte sans identifiant, émetteur invalide', (t) => {
  const popups = [];
  const Menu = { buildFromTemplate: (i) => ({ popup: (o) => { popups.push(o); return true; } }) };
  let horloge = 5000;
  const gestion = focus.creer({
    identifiants: coffreFactice(),
    Menu,
    journal: () => {},
    fenetrePour: () => 'FENETRE',
    maintenant: () => horloge
  });
  const sender = { getURL: () => 'https://context7.com/login', send: () => {} };
  assert.equal(gestion.surFocus({ sender }), true);
  // Le menu vient d'être fermé, le focus revient au champ : pas de nouvelle
  // proposition pendant le cooldown.
  assert.equal(gestion.surFocus({ sender }), false);
  assert.equal(popups.length, 1);
  horloge += 2000;
  assert.equal(gestion.surFocus({ sender }), true);
  assert.equal(popups.length, 2);
  // Hôte sans identifiants.
  assert.equal(gestion.surFocus({ sender: { getURL: () => 'https://autre.com/', send: () => {} } }), false);
  // Émetteur sans getURL/send : refus silencieux.
  assert.equal(gestion.surFocus({ sender: {} }), false);
  assert.equal(gestion.surFocus(null), false);
  // Pas de fenêtre d'ancrage : pas de menu.
  const sansFenetre = focus.creer({ identifiants: coffreFactice(), Menu, journal: () => {}, fenetrePour: () => null, maintenant: () => horloge + 5000 });
  assert.equal(sansFenetre.surFocus({ sender }), false);
});

test('creer().remplir : identifiants qui lève -> false, journalisé', (t) => {
  const journal = [];
  const gestion = focus.creer({
    identifiants: { obtenir: () => { throw new Error('boum'); }, lister: () => ({}) },
    Menu: { buildFromTemplate: () => ({ popup: () => true }) },
    journal: (n, m) => journal.push(m),
    fenetrePour: () => 'FENETRE'
  });
  assert.equal(gestion.remplir({ getURL: () => 'https://x.com/login', send: () => {} }, 'x.com', 'a'), false);
  assert.ok(journal.some((m) => /remplissage impossible/.test(m)));
});

// --- 2. Intégration main.js ---------------------------------------------------

function creerElectronMock(appDataDir) {
  const ipcHandlers = new Map();
  const appListeners = new Map();
  const windows = [];
  const partitions = new Map();
  const setPreloads = [];
  const appels = { menusConstruits: [], popups: [] };
  const chemins = {};

  const app = {
    getPath: (n) => chemins[n] || (n === 'appData' ? appDataDir : path.join(appDataDir, n)),
    setPath(n, v) { chemins[n] = v; },
    getVersion: () => '0.0.0-test',
    isPackaged: false,
    setName() {},
    requestSingleInstanceLock: () => true,
    quit() {},
    on(canal, fn) { if (!appListeners.has(canal)) appListeners.set(canal, []); appListeners.get(canal).push(fn); return this; },
    whenReady: () => ({ then(fn) { fn(); return this; } })
  };

  class BrowserWindow extends require('node:events').EventEmitter {
    constructor(options) {
      super();
      this.options = options;
      this.webContents = new (require('node:events').EventEmitter)();
      this.webContents.setWindowOpenHandler = (fn) => { this.webContents.openHandler = fn; };
      this.webContents.getURL = () => 'file:///opt/iao/index.html';
      this.webContents.send = (canal, donnee) => { appels.envoyesAuRenderer = appels.envoyesAuRenderer || []; appels.envoyesAuRenderer.push({ canal, donnee }); };
      this.webContents.id = windows.length + 1;
      windows.push(this);
    }
    loadFile() {}
    setMenuBarVisibility() {}
    isMinimized() { return false; }
    restore() {}
    focus() {}
    static getAllWindows() { return windows; }
  }

  const Menu = {
    buildFromTemplate(items) { const m = { items, popup(o) { appels.menusConstruits.push(items); appels.popups.push(o); return true; } }; return m; }
  };
  const screen = { getCursorScreenPoint: () => ({ x: 11, y: 22 }) };
  const safeStorage = {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => 'mock_libsecret',
    encryptString: (s) => Buffer.from(String(s), 'utf-8'),
    decryptString: (b) => Buffer.from(b).toString('utf-8')
  };
  const session = {
    fromPartition(nom) { if (!partitions.has(nom)) partitions.set(nom, new (require('node:events').EventEmitter)()); return partitions.get(nom); }
  };
  const ipcMain = {
    handle: (c, fn) => { ipcHandlers.set(c, fn); },
    on: (c, fn) => { ipcHandlers.set(c, fn); }
  };
  const shell = { openExternal: () => Promise.resolve() };

  return { app, BrowserWindow, ipcMain, dialog: {}, shell, session, safeStorage, Menu, screen, ipcHandlers, appListeners, windows, appels, setPreloads, chemins };
}

function boot() {
  const appDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-identifiants-focus-'));
  // Identifiants pré-enregistrés (mêmes règles que le coffre réel : secret chiffré
  // par le safeStorage simulé, en base64). main.js fixe userData sur <appData>/ai-manager.
  fs.mkdirSync(path.join(appDataDir, 'ai-manager'), { recursive: true });
  fs.writeFileSync(path.join(appDataDir, 'ai-manager', 'identifiants.json'), JSON.stringify({
    'context7.com': [{ login: 'moi@exemple.fr', secret: Buffer.from('S3cret!', 'utf-8').toString('base64'), ajoute: 1 }]
  }), 'utf-8');
  const electron = creerElectronMock(appDataDir);
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') return electron;
    return originalLoad.apply(this, arguments);
  };
  const sauve = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = () => {};
  try {
    delete require.cache[MAIN_PATH];
    require(MAIN_PATH);
  } finally {
    Module._load = originalLoad;
    Object.assign(console, sauve);
  }
  const handlerSession = electron.appListeners.get('session-created');
  assert.ok(handlerSession && handlerSession.length === 1, 'handler session-created enregistré');
  return {
    electron,
    appDataDir,
    cleanup() { delete require.cache[MAIN_PATH]; fs.rmSync(appDataDir, { recursive: true, force: true }); },
    declencherSession(ses) { handlerSession[0](ses); }
  };
}

test('main.js : le preload des identifiants est posé sur chaque session créée', (t) => {
  const h = boot();
  try {
    const poses = [];
    h.declencherSession({ setPreloads: (chemins) => poses.push(chemins) });
    assert.deepEqual(poses, [[PRELOAD_PATH]]);
    // Session dont setPreloads lève : absorbé, journalisé, pas de crash.
    const journal = [];
    const sauve = console.warn;
    console.warn = (...a) => journal.push(a.join(' '));
    try {
      h.declencherSession({ setPreloads: () => { throw new Error('lecture seule'); } });
    } finally { console.warn = sauve; }
    assert.ok(journal.some((l) => /preload de session non posé/.test(l)));
  } finally { h.cleanup(); }
});

test('main.js : focus d\'un champ -> menu des identifiants de l\'hôte, remplissage au choix', (t) => {
  const h = boot();
  try {
    const handler = h.electron.ipcHandlers.get('iao-identifiants:focus');
    assert.ok(typeof handler === 'function', 'canal iao-identifiants:focus enregistré');
    const envoyes = [];
    const sender = {
      getURL: () => 'https://context7.com/login',
      send: (canal, donnee) => envoyes.push({ canal, donnee }),
      id: 4242
    };
    handler({ sender });
    assert.equal(h.electron.appels.menusConstruits.length, 1, 'menu proposé');
    const items = h.electron.appels.menusConstruits[0];
    assert.deepEqual(items[0], { label: 'context7.com', enabled: false });
    assert.equal(items[1].label, 'moi@exemple.fr');
    assert.deepEqual(h.electron.appels.popups[0], { window: h.electron.windows[0], x: 11, y: 22 }, 'menu ancré à la fenêtre principale, au curseur');
    // Choix : mot de passe déchiffré dans le main, envoyé à l'émetteur seul.
    items[1].click();
    assert.deepEqual(envoyes, [{ canal: 'iao-identifiants:remplir', donnee: { login: 'moi@exemple.fr', motDePasse: 'S3cret!' } }]);
    // Cooldown : un second focus immédiat ne repropose pas.
    handler({ sender });
    assert.equal(h.electron.appels.menusConstruits.length, 1);
    // Hôte sans identifiant : aucun menu.
    handler({ sender: { getURL: () => 'https://autre.com/', send: () => {} } });
    assert.equal(h.electron.appels.menusConstruits.length, 1);
  } finally { h.cleanup(); }
});

test('main.js : écran/cursor indisponible -> menu quand même proposé, sans position', (t) => {
  const h = boot();
  try {
    // Pas d'écran (X indisponible) : screen.getCursorScreenPoint lève.
    h.electron.screen.getCursorScreenPoint = () => { throw new Error('écran indisponible'); };
    const handler = h.electron.ipcHandlers.get('iao-identifiants:focus');
    assert.ok(typeof handler === 'function');
    const sender = { getURL: () => 'https://context7.com/login', send: () => {}, id: 4242 };
    assert.equal(handler({ sender }), true, 'menu proposé malgré l\'écran indisponible');
    assert.equal(h.electron.appels.menusConstruits.length, 1);
    assert.deepEqual(h.electron.appels.popups[0], { window: h.electron.windows[0] }, 'menu ancré à la fenêtre principale, sans position de curseur');
  } finally { h.cleanup(); }
});

test('main.js : une popup d\'authentification (fenêtre fille) ancre le menu dans SA fenêtre', (t) => {
  const h = boot();
  try {
    // Attache une webview puis une fenêtre fille créée par elle.
    const EventEmitter = require('node:events');
    const guest = new EventEmitter();
    guest.session = h.electron.session.fromPartition('persist:profil_1');
    guest.getURL = () => 'https://claude.ai/';
    guest.setWindowOpenHandler = () => {};
    guest.on = guest.on.bind(guest);
    h.electron.windows[0].webContents.emit('did-attach-webview', {}, guest);
    const enfant = new EventEmitter();
    enfant.webContents = new EventEmitter();
    enfant.webContents.id = 777;
    enfant.webContents.setWindowOpenHandler = () => {};
    enfant.webContents.getURL = () => 'https://context7.com/oauth';
    enfant.webContents.send = (canal, donnee) => { enfant.envoyes = (enfant.envoyes || []).concat([{ canal, donnee }]); };
    guest.emit('did-create-window', enfant);
    // Focus dans la popup : le menu s'ancre à la fenêtre fille, pas à la principale.
    const handler = h.electron.ipcHandlers.get('iao-identifiants:focus');
    handler({ sender: enfant.webContents });
    assert.equal(h.electron.appels.menusConstruits.length, 1);
    assert.equal(h.electron.appels.popups[0].window, enfant, 'menu ancré à la popup');
    h.electron.appels.menusConstruits[0][1].click();
    assert.deepEqual(enfant.envoyes, [{ canal: 'iao-identifiants:remplir', donnee: { login: 'moi@exemple.fr', motDePasse: 'S3cret!' } }]);
    // Fenêtre fermée : le suivi est nettoyé (le menu revient à la fenêtre
    // principale). Horloge simulée : franchir le cooldown anti-boucle.
    enfant.emit('closed');
    const { mock } = require('node:test');
    const maintenantReel = Date.now(); // avant de simuler : la 1re proposition a
    // été faite à l'heure réelle, le cooldown doit être franchi en avançant.
    mock.timers.enable({ apis: ['Date'] });
    try {
      mock.timers.setTime(maintenantReel + 5000);
      handler({ sender: enfant.webContents });
      assert.equal(h.electron.appels.popups[1].window, h.electron.windows[0]);
    } finally {
      mock.timers.reset();
    }
  } finally { h.cleanup(); }
});

test('creer().remplir : navigation depuis la proposition -> rien n\'est déchiffré ni envoyé', () => {
  const appels = [];
  const envoyes = [];
  const gestion = focus.creer({
    identifiants: {
      enregistrer: () => ({ ok: true }),
      obtenir(h, l) { appels.push([h, l]); return 'S3cret!'; },
      lister: () => ({ 'context7.com': [{ login: 'a@x.fr' }] })
    },
    Menu: { buildFromTemplate: (i) => ({ popup: () => true }) },
    journal: () => {},
    fenetrePour: () => 'FENETRE'
  });
  let url = 'https://context7.com/login';
  const sender = { getURL: () => url, send: (c, d) => envoyes.push({ c, d }) };
  assert.equal(gestion.surFocus({ sender }), true, 'menu proposé pour context7.com');
  // La page navigue avant que l'utilisateur choisisse dans le menu : l'item
  // capturé vise toujours context7.com, l'émetteur n'y est plus.
  url = 'https://autre.com/login';
  assert.equal(gestion.remplir(sender, 'context7.com', 'a@x.fr'), false, 'refus silencieux');
  assert.deepEqual(appels, [], 'aucun déchiffrement ne doit avoir lieu');
  assert.deepEqual(envoyes, [], 'rien ne doit être envoyé');
  // Émetteur sans getURL (défensif) : refus sans déchiffrement.
  assert.equal(gestion.remplir({ send: () => {} }, 'context7.com', 'a@x.fr'), false);
  assert.deepEqual(appels, [], 'toujours aucun déchiffrement');
});

test('creer().surFocus : une erreur de Menu est absorbée et journalisée (false)', (t) => {
  const journal = [];
  const gestion = focus.creer({
    identifiants: coffreFactice(),
    Menu: { buildFromTemplate: () => { throw new Error('menu cassé'); } },
    journal: (n, m) => journal.push(m),
    fenetrePour: () => 'FENETRE'
  });
  const sender = { getURL: () => 'https://context7.com/login', send: () => {} };
  assert.equal(gestion.surFocus({ sender }), false);
  assert.ok(journal.some((m) => /proposition impossible \(menu cassé\)/.test(m)));
});

test('creer() sans journal : le repli silencieux par défaut est utilisé', (t) => {
  const gestion = focus.creer({
    identifiants: coffreFactice(),
    Menu: { buildFromTemplate: (i) => ({ popup: () => true }) },
    fenetrePour: () => 'FENETRE'
  });
  const sender = { getURL: () => 'https://context7.com/login', send: () => {} };
  assert.equal(gestion.surFocus({ sender }), true);
  assert.equal(gestion.remplir(sender, 'context7.com', 'inconnu@x.fr'), false);
});
