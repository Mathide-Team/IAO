'use strict';

// Issue #94 (55.25) : couverture des handlers IPC fichiers de main.js
// (select-folder, read-directory, read-directory-recursive, read-file, save-file).
// Réutilise le principe du harnais #93 (electron simulé via Module._load) ;
// tout se passe dans un dossier temporaire, aucun accès réseau.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');

const MAIN_PATH = path.join(__dirname, '..', 'main.js');

function createElectronMock(appDataDir) {
  const ipcHandlers = new Map();
  const app = {
    getPath: (name) => (name === 'appData' ? appDataDir : path.join(appDataDir, name)),
    setPath() {}, setName() {}, getVersion: () => '0.0.0-test', isPackaged: false,
    requestSingleInstanceLock: () => true, quit() {},
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
  const dialog = {
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showSaveDialog: async () => ({ canceled: true })
  };
  const session = {
    fromPartition: () => ({ clearStorageData: async () => {}, clearCache: async () => {}, getAllExtensions: () => [] }),
    defaultSession: {}
  };
  return { app, BrowserWindow, ipcMain, dialog, shell: { openExternal() {} }, session, ipcHandlers };
}

// Charge une copie neuve de main.js ; `work` est un dossier temporaire de travail.
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-file-handlers-'));
  const appDataDir = path.join(root, 'appdata');
  const work = path.join(root, 'work');
  fs.mkdirSync(appDataDir);
  fs.mkdirSync(work);
  const electron = createElectronMock(appDataDir);
  const originalLoad = Module._load;
  Module._load = function patchedLoad(request) {
    if (request === 'electron') return electron;
    return originalLoad.apply(this, arguments);
  };
  const { warn, log, error } = console;
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
    work,
    call: (channel, ...args) => electron.ipcHandlers.get(channel)({}, ...args),
    cleanup() {
      delete require.cache[MAIN_PATH];
      fs.rmSync(root, { recursive: true, force: true });
    }
  };
}

function touch(file, content = 'x') {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

test('select-folder : renvoie le dossier choisi, ou null si annulé / sans sélection', async () => {
  const h = setup();
  try {
    let received;
    h.electron.dialog.showOpenDialog = async (opts) => { received = opts; return { canceled: false, filePaths: ['/tmp/choisi', '/tmp/autre'] }; };
    assert.equal(await h.call('select-folder'), '/tmp/choisi');
    assert.deepEqual(received, { properties: ['openDirectory'] });

    h.electron.dialog.showOpenDialog = async () => ({ canceled: true, filePaths: ['/tmp/x'] });
    assert.equal(await h.call('select-folder'), null);

    h.electron.dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [] });
    assert.equal(await h.call('select-folder'), null);
  } finally { h.cleanup(); }
});

test('read-directory : fichiers seulement, dossiers techniques exclus, dossier illisible => []', async () => {
  const h = setup();
  try {
    touch(path.join(h.work, 'a.txt'));
    touch(path.join(h.work, 'b.js'));
    touch(path.join(h.work, 'sous', 'c.txt'));           // sous-dossier : non listé
    touch(path.join(h.work, 'node_modules', 'd.js'));    // dossier ignoré
    const res = await h.call('read-directory', h.work);
    assert.deepEqual(
      res.map((f) => f.name).sort(),
      ['a.txt', 'b.js']
    );
    assert.equal(res.find((f) => f.name === 'a.txt').path, path.join(h.work, 'a.txt'));

    assert.deepEqual(await h.call('read-directory', path.join(h.work, 'inexistant')), []);
  } finally { h.cleanup(); }
});

test('read-directory-recursive : liste plate avec chemins relatifs, dossiers ignorés exclus', async () => {
  const h = setup();
  try {
    touch(path.join(h.work, 'racine.txt'));
    touch(path.join(h.work, 'src', 'a.js'));
    touch(path.join(h.work, 'src', 'lib', 'b.js'));
    for (const d of ['node_modules', '.git', '.next', 'dist', 'build', '.cache']) touch(path.join(h.work, d, 'x.js'));
    const res = await h.call('read-directory-recursive', h.work);
    assert.deepEqual(
      res.map((f) => f.relativePath).sort(),
      ['racine.txt', 'src/a.js', 'src/lib/b.js']
    );
    const b = res.find((f) => f.name === 'b.js');
    assert.equal(b.path, path.join(h.work, 'src', 'lib', 'b.js'));
  } finally { h.cleanup(); }
});

test('read-directory-recursive : profondeur maximale 5 (le niveau 6 est ignoré)', async () => {
  const h = setup();
  try {
    let dir = h.work;
    for (let depth = 0; depth <= 6; depth++) {
      touch(path.join(dir, 'f' + depth + '.txt'));
      dir = path.join(dir, 'n' + (depth + 1));
    }
    const res = await h.call('read-directory-recursive', h.work);
    assert.deepEqual(
      res.map((f) => f.name).sort(),
      ['f0.txt', 'f1.txt', 'f2.txt', 'f3.txt', 'f4.txt', 'f5.txt']
    );
  } finally { h.cleanup(); }
});

test('read-directory-recursive : plafonné à 500 fichiers (à la racine puis dans un sous-dossier)', async () => {
  const h = setup();
  try {
    // Plafond atteint dans la boucle des entrées d'un même dossier.
    for (let i = 0; i < 520; i++) touch(path.join(h.work, 'f' + i + '.txt'), '');
    assert.equal((await h.call('read-directory-recursive', h.work)).length, 500);
  } finally { h.cleanup(); }

  const h2 = setup();
  try {
    // Plafond déjà atteint à l'entrée de walk() d'un sous-dossier.
    for (let i = 0; i < 500; i++) touch(path.join(h2.work, 'a', 'f' + i + '.txt'), '');
    touch(path.join(h2.work, 'b', 'never.txt'), '');
    const res = await h2.call('read-directory-recursive', h2.work);
    assert.equal(res.length, 500);
    assert.ok(!res.some((f) => f.name === 'never.txt'));
  } finally { h2.cleanup(); }
});

test('read-directory-recursive : liens symboliques non suivis, dossier illisible => []', async (t) => {
  const h = setup();
  try {
    touch(path.join(h.work, 'reel', 'r.txt'));
    try {
      fs.symlinkSync(path.join(h.work, 'reel'), path.join(h.work, 'lien'), 'dir');
      fs.symlinkSync(h.work, path.join(h.work, 'reel', 'boucle'), 'dir'); // boucle potentielle
    } catch (e) { t.diagnostic('symlink indisponible : ' + e.code); }
    const res = await h.call('read-directory-recursive', h.work);
    assert.deepEqual(res.map((f) => f.relativePath), ['reel/r.txt']);

    assert.deepEqual(await h.call('read-directory-recursive', path.join(h.work, 'inexistant')), []);
  } finally { h.cleanup(); }
});

test('read-directory-recursive : un lien symbolique reporté aussi comme dossier n’est pas parcouru', async () => {
  const h = setup();
  const original = fs.promises.readdir;
  try {
    touch(path.join(h.work, 'cible', 'secret.txt'));
    // Certaines plateformes peuvent reporter isDirectory() ET isSymbolicLink() : on force ce cas.
    fs.promises.readdir = async (dir, opts) => {
      const entries = await original.call(fs.promises, dir, opts);
      return entries.map((d) => (d.name === 'cible'
        ? { name: d.name, isFile: () => false, isDirectory: () => true, isSymbolicLink: () => true }
        : d));
    };
    const res = await h.call('read-directory-recursive', h.work);
    assert.deepEqual(res, []);
  } finally {
    fs.promises.readdir = original;
    h.cleanup();
  }
});

test('read-directory-recursive : erreur inattendue en cours de parcours => résultat partiel sans exception', async () => {
  const h = setup();
  const original = fs.promises.readdir;
  try {
    touch(path.join(h.work, 'a.txt'));
    // Un Dirent défaillant fait rejeter walk() : le catch externe renvoie ce qui est déjà collecté.
    fs.promises.readdir = async (dir, opts) => {
      const entries = await original.call(fs.promises, dir, opts);
      return [...entries, { name: 'piege', isFile() { throw new Error('boom'); } }];
    };
    const res = await h.call('read-directory-recursive', h.work);
    assert.deepEqual(res.map((f) => f.relativePath), ['a.txt']);
  } finally {
    fs.promises.readdir = original;
    h.cleanup();
  }
});

test('read-file : contenu UTF-8, too_large au-delà de 20 Mo, null en cas d’erreur', async () => {
  const h = setup();
  try {
    const small = path.join(h.work, 'petit.txt');
    fs.writeFileSync(small, 'héllo\nmonde', 'utf-8');
    assert.equal(await h.call('read-file', small), 'héllo\nmonde');

    const limit = 20 * 1024 * 1024;
    const exact = path.join(h.work, 'limite.bin');
    fs.writeFileSync(exact, '');
    fs.truncateSync(exact, limit);            // fichier creux : exactement 20 Mo => lisible
    assert.equal(typeof await h.call('read-file', exact), 'string');

    const big = path.join(h.work, 'gros.bin');
    fs.writeFileSync(big, '');
    fs.truncateSync(big, limit + 1);          // 20 Mo + 1 octet => refusé
    assert.deepEqual(await h.call('read-file', big), { error: 'too_large', size: limit + 1 });

    assert.equal(await h.call('read-file', path.join(h.work, 'absent.txt')), null);
    assert.equal(await h.call('read-file', h.work), null); // un dossier n'est pas lisible comme fichier
  } finally { h.cleanup(); }
});

test('save-file : écrit en UTF-8 (création et écrasement), false si l’écriture échoue', async () => {
  const h = setup();
  try {
    const file = path.join(h.work, 'sortie.txt');
    assert.equal(await h.call('save-file', file, 'première version é'), true);
    assert.equal(fs.readFileSync(file, 'utf-8'), 'première version é');

    assert.equal(await h.call('save-file', file, 'seconde'), true);
    assert.equal(fs.readFileSync(file, 'utf-8'), 'seconde');

    // Dossier parent inexistant : l'erreur est journalisée (console.error) et false est renvoyé.
    const logged = [];
    const originalError = console.error;
    console.error = (...a) => logged.push(a);
    try {
      assert.equal(await h.call('save-file', path.join(h.work, 'absent', 'x.txt'), 'data'), false);
    } finally { console.error = originalError; }
    assert.equal(logged.length, 1);
    assert.match(String(logged[0][0]), /sauvegarde/i);
  } finally { h.cleanup(); }
});
