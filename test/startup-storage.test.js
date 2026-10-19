'use strict';

// Issue #203 : état du dossier de données au démarrage (piste #184).

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
    lstatSync(p) {
      leve('lstat', p);
      const e = arbre[p] || {};
      return {
        size: e.taille || 0,
        isDirectory() { return e.dir === true; },
        isSymbolicLink() { return e.lien === true; }
      };
    },
    rmSync(p) { leve('rm', p); delete arbre[p]; }
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

// --- Piste #184 (correctif) : dossiers Service Worker à nettoyer ---

test('dossiersServiceWorkerANettoyer : fenêtre principale + partitions, existants seulement', () => {
  // Avec ARBRE : Service Worker de la fenêtre principale absent, profil_1 oui, profil_2 non.
  const dossiers = s.dossiersServiceWorkerANettoyer(R, fauxFs(ARBRE));
  assert.deepStrictEqual(dossiers, [j('Partitions', 'profil_1', 'Service Worker')]);

  // Avec le dossier de la fenêtre principale présent aussi.
  const arbre2 = Object.assign({}, ARBRE, { [j('Service Worker')]: { dir: true } });
  const dossiers2 = s.dossiersServiceWorkerANettoyer(R, fauxFs(arbre2));
  assert.deepStrictEqual(dossiers2.sort(), [
    j('Service Worker'),
    j('Partitions', 'profil_1', 'Service Worker')
  ].sort());
});

test('dossiersServiceWorkerANettoyer : ne lève jamais (Partitions illisible, exists qui lève)', () => {
  // readdir de Partitions qui lève : les partitions sont ignorées, aucune
  // levée (la fenêtre principale n'existe pas dans ARBRE -> liste vide).
  const casse = {};
  casse[j('Partitions')] = 'readdir';
  assert.deepStrictEqual(s.dossiersServiceWorkerANettoyer(R, fauxFs(ARBRE, casse)), []);
  // existsSync de la fenêtre principale qui lève : ignoré silencieusement.
  const casse2 = {};
  casse2[j('Service Worker')] = 'exists';
  const dossiers = s.dossiersServiceWorkerANettoyer(R, fauxFs(ARBRE, casse2));
  assert.ok(Array.isArray(dossiers)); // aucune levée
});

test('dossiersServiceWorkerANettoyer : dossier de données absent -> liste vide', () => {
  assert.deepStrictEqual(s.dossiersServiceWorkerANettoyer(path.sep + 'inexistant', fauxFs({})), []);
});

// --- Passe corrective #223 : liens symboliques, périmètre, isolation des erreurs ---

test('dossiersServiceWorkerANettoyer : un lien symbolique dans Partitions/ est ignoré', () => {
  // Un lien symbolique vers un dossier EXTERNE ne doit jamais faire sortir le
  // nettoyage du périmètre du dossier de données.
  const arbre = {
    [R]: { dir: true },
    [j('Partitions')]: { dir: true },
    [j('Partitions', 'vrai_profil')]: { dir: true },
    [j('Partitions', 'vrai_profil', 'Service Worker')]: { dir: true },
    [j('Partitions', 'lien_externe')]: { lien: true }
  };
  assert.deepStrictEqual(s.dossiersServiceWorkerANettoyer(R, fauxFs(arbre)),
    [j('Partitions', 'vrai_profil', 'Service Worker')]);
});

test('dossiersServiceWorkerANettoyer : une entrée non répertoire (fichier) est ignorée', () => {
  const arbre = {
    [R]: { dir: true },
    [j('Partitions')]: { dir: true },
    [j('Partitions', 'pas_un_profil')]: { taille: 10 }, // fichier, pas un dossier
    [j('Partitions', 'propre')]: { dir: true },
    [j('Partitions', 'propre', 'Service Worker')]: { dir: true }
  };
  assert.deepStrictEqual(s.dossiersServiceWorkerANettoyer(R, fauxFs(arbre)),
    [j('Partitions', 'propre', 'Service Worker')]);
});

test('nettoyerDossiersServiceWorker : arborescence réelle — seules les cibles sont supprimées', () => {
  // Vraie arborescence temporaire : le nettoyage doit supprimer uniquement
  // les dossiers Service Worker, jamais Local Storage ni les cookies.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-sw-test-'));
  try {
    const mk = (...p) => fs.mkdirSync(path.join(tmp, ...p), { recursive: true });
    const fic = (...p) => fs.writeFileSync(path.join(tmp, ...p), 'x');
    mk('Service Worker'); fic('Service Worker', 'base');
    mk('Local Storage', 'leveldb'); fic('Local Storage', 'leveldb', 'LOCK');
    mk('Cookies'); fic('Cookies', 'db');
    mk('Partitions', 'p1', 'Service Worker'); fic('Partitions', 'p1', 'Service Worker', 'base');
    mk('Partitions', 'p1', 'Local Storage'); fic('Partitions', 'p1', 'Local Storage', 'data');
    mk('Partitions', 'p2', 'Service Worker');
    mk('Partitions', 'p2', 'Cookies');

    const r = s.nettoyerDossiersServiceWorker(tmp, fs, null);
    assert.strictEqual(r.total, 3, '3 dossiers Service Worker attendus');
    assert.strictEqual(r.nettoyés.length, 3);
    // Les cibles ont disparu…
    assert.ok(!fs.existsSync(path.join(tmp, 'Service Worker')), 'SW principal supprimé');
    assert.ok(!fs.existsSync(path.join(tmp, 'Partitions', 'p1', 'Service Worker')), 'SW p1 supprimé');
    assert.ok(!fs.existsSync(path.join(tmp, 'Partitions', 'p2', 'Service Worker')), 'SW p2 supprimé');
    // …rien d'autre n'a été touché.
    assert.ok(fs.existsSync(path.join(tmp, 'Local Storage', 'leveldb', 'LOCK')), 'Local Storage intact');
    assert.ok(fs.existsSync(path.join(tmp, 'Cookies', 'db')), 'Cookies intacts');
    assert.ok(fs.existsSync(path.join(tmp, 'Partitions', 'p1', 'Local Storage', 'data')), 'Local Storage partition intact');
    assert.ok(fs.existsSync(path.join(tmp, 'Partitions', 'p2', 'Cookies')), 'Cookies partition intacts');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('nettoyerDossiersServiceWorker : une erreur sur un dossier n’interrompt pas les autres', () => {
  const arbre = {
    [R]: { dir: true },
    [j('Service Worker')]: { dir: true },
    [j('Partitions')]: { dir: true },
    [j('Partitions', 'ok')]: { dir: true },
    [j('Partitions', 'ok', 'Service Worker')]: { dir: true },
    [j('Partitions', 'bloque')]: { dir: true },
    [j('Partitions', 'bloque', 'Service Worker')]: { dir: true }
  };
  const f = fauxFs(arbre);
  const rmOrig = f.rmSync;
  const journal = [];
  f.rmSync = (p) => {
    if (p === j('Partitions', 'bloque', 'Service Worker')) {
      journal.push('échec ' + p);
      throw new Error('permission refusée (test)');
    }
    rmOrig(p);
    journal.push('ok ' + p);
  };
  const r = s.nettoyerDossiersServiceWorker(R, f, (niv, msg) => journal.push(niv + ' : ' + msg));
  assert.strictEqual(r.total, 3);
  assert.strictEqual(r.nettoyés.length, 2, 'les 2 autres dossiers doivent être nettoyés');
  assert.ok(journal.some(x => x.startsWith('warning')), 'l’échec doit être journalisé en warning');
});

test('dossiersServiceWorkerANettoyer : Partitions/ LUI-MÊME lien symbolique -> tout le scan est ignoré', () => {
  // Partitions/ pointe vers un dossier EXTERNE : ses enfants sont de vrais
  // répertoires (de la cible) et passeraient le contrôle unitaire — sans la
  // garde sur Partitions/ lui-même, le nettoyage sortirait du dossier de
  // données. On doit ignorer TOUT le scan des partitions.
  const arbre = {
    [R]: { dir: true },
    [j('Service Worker')]: { dir: true },
    [j('Partitions')]: { lien: true },
    [j('Partitions', 'cible_externe')]: { dir: true },
    [j('Partitions', 'cible_externe', 'Service Worker')]: { dir: true }
  };
  assert.deepStrictEqual(s.dossiersServiceWorkerANettoyer(R, fauxFs(arbre)),
    [j('Service Worker')], 'seule la fenêtre principale est couverte');
});

test('nettoyerDossiersServiceWorker : arborescence réelle avec liens externes — les témoins restent', () => {
  // Vraie arborescence : Partitions LIÉ vers un dossier externe, ET une
  // partition enfant liée vers un autre dossier externe. Chaque cible
  // externe contient un vrai dossier Service Worker avec un fichier témoin :
  // le nettoyage ne doit JAMAIS y toucher (périmètre = dossier de données).
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-sw-liens-'));
  const externe1 = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-ext1-'));
  const externe2 = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-ext2-'));
  try {
    const fic = (base, ...p) => fs.writeFileSync(path.join(base, ...p), 'temoin');
    // userData : SW principal réel.
    fs.mkdirSync(path.join(tmp, 'Service Worker'), { recursive: true });
    fic(tmp, 'Service Worker', 'base');
    // externe1 : cible du lien Partitions/ (avec un SW et un témoin).
    fs.mkdirSync(path.join(externe1, 'cible', 'Service Worker'), { recursive: true });
    fic(externe1, 'cible', 'Service Worker', 'base');
    // externe2 : cible d'un lien de partition enfant.
    fs.mkdirSync(path.join(externe2, 'Service Worker'), { recursive: true });
    fic(externe2, 'Service Worker', 'base');
    // Les deux liens.
    fs.symlinkSync(externe1, path.join(tmp, 'Partitions'));
    fs.symlinkSync(externe2, path.join(tmp, 'Partitions', 'enfant_lié'));

    const r = s.nettoyerDossiersServiceWorker(tmp, fs, null);
    // Seul le Service Worker de la fenêtre principale est nettoyé.
    assert.strictEqual(r.total, 1);
    assert.strictEqual(r.nettoyés.length, 1);
    assert.ok(!fs.existsSync(path.join(tmp, 'Service Worker')), 'SW principal supprimé');
    // Les témoins externes sont INTACTS (aucune fuite du périmètre).
    assert.ok(fs.existsSync(path.join(externe1, 'cible', 'Service Worker', 'base')),
      'témoin du lien Partitions/ intact');
    assert.ok(fs.existsSync(path.join(externe2, 'Service Worker', 'base')),
      'témoin du lien de partition intact');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(externe1, { recursive: true, force: true });
    fs.rmSync(externe2, { recursive: true, force: true });
  }
});

test('nettoyerDossiersServiceWorker : échec sur le PREMIER dossier — les suivants sont quand même nettoyés', () => {
  // Le dossier récalcitrant est le PREMIER de la liste (fenêtre principale) :
  // prouver que l'erreur n'interrompt pas la suite (et pas seulement le cas
  // « dernier dossier » déjà couvert).
  const arbre = {
    [R]: { dir: true },
    [j('Service Worker')]: { dir: true },
    [j('Partitions')]: { dir: true },
    [j('Partitions', 'ok')]: { dir: true },
    [j('Partitions', 'ok', 'Service Worker')]: { dir: true }
  };
  const f = fauxFs(arbre);
  const rmOrig = f.rmSync;
  const journal = [];
  f.rmSync = (p) => {
    if (p === j('Service Worker')) {
      journal.push('échec ' + p);
      throw new Error('verrou Chromium (test)');
    }
    rmOrig(p);
    journal.push('ok ' + p);
  };
  const r = s.nettoyerDossiersServiceWorker(R, f, () => {});
  assert.strictEqual(r.total, 2);
  assert.strictEqual(r.nettoyés.length, 1, 'la partition est nettoyée malgré l\'échec du premier');
  assert.ok(journal.some(x => x.startsWith('ok ' + j('Partitions'))),
    'le nettoyage a continué après l\'échec');
});

test('dossiersServiceWorkerANettoyer : une partition illisible (lstat) est ignorée sans levée', () => {
  const casse = {};
  casse[j('Partitions', 'vrai_profil')] = 'lstat';
  const arbre = {
    [R]: { dir: true },
    [j('Partitions')]: { dir: true },
    [j('Partitions', 'vrai_profil')]: { dir: true },
    [j('Partitions', 'vrai_profil', 'Service Worker')]: { dir: true },
    [j('Partitions', 'autre')]: { dir: true },
    [j('Partitions', 'autre', 'Service Worker')]: { dir: true }
  };
  const dossiers = s.dossiersServiceWorkerANettoyer(R, fauxFs(arbre, casse));
  assert.deepStrictEqual(dossiers, [j('Partitions', 'autre', 'Service Worker')]);
});
