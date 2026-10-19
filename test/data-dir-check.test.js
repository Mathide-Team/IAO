'use strict';

// Issue #184 : fichiers du dossier de données qui n'appartiennent pas au compte
// courant (lancement en root), cause possible de « Database IO error ».

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const c = require('../lib/data-dir-check');

// Système de fichiers simulé : { '/r': { uid, dir: true }, '/r/a': { uid } ... }
function fakeFs(tree, failing = {}) {
  return {
    lstatSync(p) {
      if (failing.lstat && failing.lstat.includes(p)) throw new Error('EACCES');
      const n = tree[p];
      if (!n) throw new Error('ENOENT');
      return { uid: n.uid, isDirectory: () => Boolean(n.dir) };
    },
    readdirSync(p) {
      if (failing.readdir && failing.readdir.includes(p)) throw new Error('EACCES');
      const prefix = p + '/';
      return Object.keys(tree).filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length)).sort();
    }
  };
}
const posix = path.posix;

test('currentUid : getuid si disponible, null sinon (Windows)', () => {
  assert.equal(c.currentUid({ getuid: () => 1000 }), 1000);
  assert.equal(c.currentUid({}), null);
  assert.equal(c.currentUid(undefined), null);
});

test('findForeignEntries : uid absent -> null (pas de contrôle)', () => {
  assert.equal(c.findForeignEntries('/r', { fs: fakeFs({}), path: posix, uid: null }), null);
  assert.equal(c.findForeignEntries('/r', { fs: fakeFs({}), path: posix }), null);
});

test('findForeignEntries : dossier absent (premier lancement) -> null', () => {
  assert.equal(c.findForeignEntries('/r', { fs: fakeFs({}), path: posix, uid: 1000 }), null);
});

test('findForeignEntries : relève les entrées d\'un autre propriétaire, avec exemples bornés', () => {
  const tree = {
    '/r': { uid: 1000, dir: true },
    '/r/Local Storage': { uid: 0, dir: true },
    '/r/Local Storage/leveldb': { uid: 0, dir: true },
    '/r/Local Storage/leveldb/LOCK': { uid: 0 },
    '/r/settings.json': { uid: 1000 }
  };
  const res = c.findForeignEntries('/r', { fs: fakeFs(tree), path: posix, uid: 1000, options: { maxExamples: 2 } });
  assert.equal(res.checked, 4);
  assert.equal(res.foreign, 3);
  assert.equal(res.examples.length, 2);
  assert.equal(res.truncated, false);
  assert.ok(res.examples.every((e) => e.uid === 0));
});

test('findForeignEntries : caches ignorés, profondeur et nombre d\'entrées bornés', () => {
  const tree = {
    '/r': { uid: 1, dir: true },
    '/r/Cache': { uid: 1, dir: true },
    '/r/Cache/x': { uid: 0 },
    '/r/a': { uid: 1, dir: true },
    '/r/a/b': { uid: 1, dir: true },
    '/r/a/b/c': { uid: 0 }
  };
  const shallow = c.findForeignEntries('/r', { fs: fakeFs(tree), path: posix, uid: 1, options: { maxDepth: 2 } });
  assert.equal(shallow.foreign, 0); // /r/Cache/x ignoré, /r/a/b/c trop profond
  assert.equal(shallow.checked, 3);
  const deep = c.findForeignEntries('/r', { fs: fakeFs(tree), path: posix, uid: 1 });
  assert.equal(deep.foreign, 1);
  const capped = c.findForeignEntries('/r', { fs: fakeFs(tree), path: posix, uid: 1, options: { maxEntries: 2 } });
  assert.equal(capped.truncated, true);
  assert.equal(capped.checked, 2);
});

test('findForeignEntries : dossier ou entrée illisible -> ignoré sans exception', () => {
  const tree = {
    '/r': { uid: 1, dir: true },
    '/r/a': { uid: 1, dir: true },
    '/r/a/x': { uid: 0 },
    '/r/b': { uid: 0 }
  };
  const res = c.findForeignEntries('/r', { fs: fakeFs(tree, { readdir: ['/r/a'], lstat: ['/r/b'] }), path: posix, uid: 1 });
  assert.deepEqual({ checked: res.checked, foreign: res.foreign }, { checked: 1, foreign: 0 });
});

test('findForeignEntries sur un vrai dossier temporaire : tout appartient au compte courant', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-datadir-'));
  try {
    fs.mkdirSync(path.join(tmp, 'Partitions', 'profil_1', 'Service Worker'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'settings.json'), '{}');
    const res = c.findForeignEntries(tmp, { fs, path, uid: process.getuid() });
    assert.equal(res.foreign, 0);
    assert.equal(res.checked, 4); // Partitions, profil_1, Service Worker, settings.json
    const other = c.findForeignEntries(tmp, { fs, path, uid: process.getuid() + 1 });
    assert.equal(other.foreign, 4);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('describeForeignEntries : null sans problème ; message avec commande de correction sinon', () => {
  assert.equal(c.describeForeignEntries(null, '/r'), null);
  assert.equal(c.describeForeignEntries({ checked: 3, foreign: 0, examples: [], truncated: false }, '/r'), null);
  const msg = c.describeForeignEntries({ checked: 9, foreign: 2, examples: [{ path: '/r/a', uid: 0 }], truncated: true }, '/home/m/.config/ai-manager');
  assert.match(msg, /^2 fichier\(s\) du dossier de données n'appartiennent pas au compte courant \(parcours limité à 9 entrées\)/);
  assert.match(msg, /Exemples : \/r\/a \(uid 0\)\./);
  assert.match(msg, /sudo chown -R "\$USER": "\/home\/m\/.config\/ai-manager"/);
  const short = c.describeForeignEntries({ checked: 9, foreign: 1, examples: [{ path: '/r/a', uid: 0 }], truncated: false }, '/r');
  assert.doesNotMatch(short, /parcours limité/);
});

test('reportForeignEntries : journalise un warning seulement en cas de problème', () => {
  const tree = { '/r': { uid: 1, dir: true }, '/r/a': { uid: 0 } };
  const lines = [];
  const log = (...a) => lines.push(a);
  assert.equal(c.reportForeignEntries('/r', { fs: fakeFs(tree), path: posix, proc: { getuid: () => 0 }, log }), null);
  assert.equal(lines.length, 0);
  const msg = c.reportForeignEntries('/r', { fs: fakeFs(tree), path: posix, proc: { getuid: () => 1 }, log });
  assert.equal(lines.length, 1);
  assert.deepEqual(lines[0], ['demarrage', 'warning', msg]);
  assert.equal(c.reportForeignEntries('/r', { fs: fakeFs(tree), path: posix, proc: {}, log }), null);
});
