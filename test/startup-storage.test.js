'use strict';

// Issue #203 : état du dossier de données au démarrage (piste #184).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const s = require('../lib/startup-storage.js');

// Faux système de fichiers : { chemin: { taille } } (fichier) ou { dir: true } ;
// `casse` : chemin -> opération qui lève.
function fauxFs(arbre, casse) {
  const k = casse || {};
  const leve = (op, p) => { if (k[p] === op) throw new Error(op + ' ' + p); };
  return {
    existsSync(p) { leve('exists', p); return Object.prototype.hasOwnProperty.call(arbre, p); },
    readdirSync(p) {
      leve('readdir', p);
      const pref = p + path.sep;
      return Object.keys(arbre).filter(x => x.startsWith(pref) && !x.slice(pref.length).includes(path.sep))
        .map(x => x.slice(pref.length));
    },
    lstatSync(p) { leve('lstat', p); return { size: arbre[p].taille || 0 }; }
  };
}

const R = path.join(path.sep, 'home', 'm', '.config', 'ai-manager');
const j = (...p) => path.join(R, ...p);
const ARBRE = {
  [R]: { dir: true },
  [j('Local Storage')]: { dir: true },
  [j('Local Storage', 'leveldb')]: { dir: true },
  [j('Local Storage', 'leveldb', '000003.log')]: { taille: 300 },
  [j('Local Storage', 'leveldb', 'LOCK')]: {},
  [j('Partitions')]: { dir: true },
  [j('Partitions', 'profil_1')]: { dir: true },
  [j('Partitions', 'profil_1', 'Service Worker')]: { dir: true },
  [j('Partitions', 'profil_2')]: { dir: true }
};

test('inspecterDonnees : Local Storage, partitions, dossiers Service Worker', () => {
  const info = s.inspecterDonnees(R, fauxFs(ARBRE));
  assert.deepEqual(info.localStorage, { existe: true, fichiers: 2, octets: 300 });
  assert.equal(info.partitions, 2);
  assert.equal(info.partitionsServiceWorker, 1);
  assert.equal(s.resumeDonnees(info), 'Dossier de données ' + R +
    ' — Local Storage : 2 fichier(s), 300 octet(s) — partitions : 2 (dont 1 avec un dossier Service Worker).');
});

test('inspecterDonnees : dossier absent, puis sans Local Storage ni Partitions', () => {
  assert.match(s.resumeDonnees(s.inspecterDonnees(R, fauxFs({}))), /absent \(premier lancement \?\)/);
  assert.match(s.resumeDonnees(s.inspecterDonnees(R, fauxFs({ [R]: { dir: true } }))),
    /Local Storage : absent — partitions : 0 \(dont 0/);
});

test('inspecterDonnees : erreurs collectées, jamais levées ; journaliserDonnees', () => {
  const cas = [
    [{ [R]: 'exists' }, /existence/],
    [{ [j('Local Storage', 'leveldb')]: 'readdir' }, /Local Storage/],
    [{ [j('Partitions')]: 'readdir' }, /Partitions/]
  ];
  for (const [casse, motif] of cas) {
    const lignes = [];
    s.journaliserDonnees(s.inspecterDonnees(R, fauxFs(ARBRE, casse)), (...a) => lignes.push(a));
    assert.equal(lignes[0][1], 'info');
    assert.equal(lignes.length, 2);
    assert.deepEqual(lignes[1].slice(0, 2), ['demarrage', 'warning']);
    assert.match(lignes[1][2], motif);
  }
  const lignes = [];
  s.journaliserDonnees(s.inspecterDonnees(R, fauxFs(ARBRE)), (...a) => lignes.push(a));
  assert.equal(lignes.length, 1);
});
