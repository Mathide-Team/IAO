'use strict';

// Issue #203 : traces de démarrage sur le stockage (pistes #184 et #186).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const s = require('../lib/startup-storage.js');
const c = require('../lib/startup-accounts.js');

// Faux système de fichiers : { chemin: { uid, taille } } pour un fichier,
// { uid, dir: true } pour un dossier ; `casse` : chemin -> opération qui lève.
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
    lstatSync(p) {
      leve('lstat', p);
      const e = arbre[p];
      if (!e) throw new Error('absent ' + p);
      return { uid: e.uid, size: e.taille || 0, isDirectory: () => !!e.dir };
    }
  };
}

const R = path.join(path.sep, 'home', 'm', '.config', 'ai-manager');
const j = (...p) => path.join(R, ...p);

function arbreType(uidRacine) {
  return {
    [R]: { uid: 1000, dir: true },
    [j('Local Storage')]: { uid: 1000, dir: true },
    [j('Local Storage', 'leveldb')]: { uid: 1000, dir: true },
    [j('Local Storage', 'leveldb', '000003.log')]: { uid: 1000, taille: 300 },
    [j('Local Storage', 'leveldb', 'LOCK')]: { uid: uidRacine, taille: 0 },
    [j('Partitions')]: { uid: 1000, dir: true },
    [j('Partitions', 'profil_1')]: { uid: 1000, dir: true },
    [j('Partitions', 'profil_1', 'Service Worker')]: { uid: 1000, dir: true },
    [j('Partitions', 'profil_2')]: { uid: 1000, dir: true }
  };
}

test('inspecterDonnees : stockage, partitions, service workers, propriétaires', () => {
  const info = s.inspecterDonnees(R, fauxFs(arbreType(0)), 1000);
  assert.equal(info.existe, true);
  assert.deepEqual(info.localStorage, { existe: true, fichiers: 2, octets: 300 });
  assert.equal(info.partitions, 2);
  assert.equal(info.partitionsServiceWorker, 1);
  assert.deepEqual(info.etrangers, [j('Local Storage', 'leveldb', 'LOCK')]);
  assert.equal(info.etrangersTotal, 1);
  assert.match(s.resumeDonnees(info), /Local Storage : 2 fichier\(s\), 300 octet\(s\) — partitions : 2 \(dont 1 avec un dossier Service Worker\)/);
  const alertes = s.alertesDonnees(info);
  assert.equal(alertes.length, 1);
  assert.match(alertes[0], /1 fichier\(s\) .* autre utilisateur \(lancement avec sudo \?\).*LOCK$/);
});

test('inspecterDonnees : sans contrôle des propriétaires (Windows) ni anomalie', () => {
  for (const uid of [null, undefined]) {
    const info = s.inspecterDonnees(R, fauxFs(arbreType(0)), uid);
    assert.equal(info.etrangersTotal, 0);
    assert.deepEqual(s.alertesDonnees(info), []);
  }
});

test('inspecterDonnees : dossier absent, puis sans Local Storage ni Partitions', () => {
  const absent = s.inspecterDonnees(R, fauxFs({}), 1000);
  assert.equal(absent.existe, false);
  assert.match(s.resumeDonnees(absent), /absent \(premier lancement \?\)/);
  const vide = s.inspecterDonnees(R, fauxFs({ [R]: { uid: 1000, dir: true } }), 1000);
  assert.match(s.resumeDonnees(vide), /Local Storage : absent — partitions : 0/);
});

test('inspecterDonnees : plus de 10 fichiers étrangers -> liste tronquée', () => {
  const arbre = { [R]: { uid: 0, dir: true } };
  for (let i = 0; i < 12; i++) arbre[j('f' + i)] = { uid: 0 };
  const info = s.inspecterDonnees(R, fauxFs(arbre), 1000);
  assert.equal(info.etrangersTotal, 13);
  assert.equal(info.etrangers.length, s.MAX_ETRANGERS);
  assert.match(s.alertesDonnees(info)[0], /, …$/);
});

test('inspecterDonnees : parcours borné', () => {
  const arbre = { [R]: { uid: 1000, dir: true } };
  for (let i = 0; i < s.MAX_PARCOURS + 10; i++) arbre[j('f' + i)] = { uid: 0 };
  const info = s.inspecterDonnees(R, fauxFs(arbre), 1000);
  assert.equal(info.etrangersTotal, s.MAX_PARCOURS - 1);
});

test('inspecterDonnees : les erreurs sont collectées, jamais levées', () => {
  const lsDir = j('Local Storage', 'leveldb');
  const cas = [
    [{ [R]: 'exists' }, /existence/],
    [{ [lsDir]: 'readdir' }, /Local Storage/],
    [{ [j('Partitions')]: 'readdir' }, /Partitions/],
    [{ [j('Partitions', 'profil_2')]: 'lstat' }, /propriétaire/],
    [{ [j('Partitions', 'profil_2')]: 'readdir' }, /lecture/]
  ];
  for (const [casse, motif] of cas) {
    const info = s.inspecterDonnees(R, fauxFs(arbreType(1000), casse), 1000);
    assert.match(s.alertesDonnees(info).join(' | '), motif, JSON.stringify(casse));
  }
});

test('messageRenderer : portée et niveau bornés, message tronqué', () => {
  assert.deepEqual(s.messageRenderer('comptes', 'warning', 'x'), { portee: 'renderer:comptes', niveau: 'warning', message: 'x' });
  assert.deepEqual(s.messageRenderer('Pas Bon!', 'error', 42), { portee: 'renderer:renderer', niveau: 'info', message: '42' });
  assert.equal(s.messageRenderer('a', 'info', 'y'.repeat(2000)).message.length, 1000);
});

test('resumeComptes / niveauComptes', () => {
  assert.equal(c.resumeComptes({ statut: 'ok', nombre: 70, sauvegarde: true }),
    'Comptes lus au démarrage : 70 — ai_accounts : lu — sauvegarde ai_accounts_backup : présente.');
  assert.match(c.resumeComptes({ statut: 'empty', sauvegarde: false }), /: 0 — ai_accounts : absent — .* absente\.$/);
  assert.match(c.resumeComptes({ statut: 'corrupt', nombre: 0 }), /CORROMPU/);
  assert.match(c.resumeComptes({ statut: 'invalid', nombre: 0 }), /pas un tableau/);
  assert.match(c.resumeComptes({ statut: 'autre', nombre: 0 }), /ai_accounts : autre/);
  assert.equal(c.niveauComptes({ statut: 'ok', nombre: 3, sauvegarde: true }), 'info');
  assert.equal(c.niveauComptes({ statut: 'empty', nombre: 0, sauvegarde: false }), 'info');
  assert.equal(c.niveauComptes({ statut: 'empty', nombre: 0, sauvegarde: true }), 'warning');
  assert.equal(c.niveauComptes({ statut: 'corrupt', nombre: 0 }), 'warning');
  assert.equal(c.niveauComptes({ statut: 'invalid', nombre: 0 }), 'warning');
});

test('startup-accounts s\'attache à window dans le renderer', () => {
  const chemin = require.resolve('../lib/startup-accounts.js');
  const avant = global.window;
  global.window = {};
  try {
    delete require.cache[chemin];
    require(chemin);
    assert.equal(typeof global.window.iaoStartupAccounts.resumeComptes, 'function');
  } finally {
    if (avant === undefined) delete global.window; else global.window = avant;
    delete require.cache[chemin];
  }
});
