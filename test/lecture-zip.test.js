'use strict';

// Issue #275 : lecture du FEATURES.md d'un ZIP sans shell (lib/lecture-zip.js).
// Les archives sont fabriquées ici, octet par octet, pour viser chaque cas
// (data descriptor, ZIP64, chiffrement, tailles fausses, bombe) sans outil
// système.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const z = require('../lib/lecture-zip');

// --- Écriture d'archives de test ------------------------------------------

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

// entrees : [{ nom, contenu, methode?, drapeaux?, taille?, crc?, latin1?, extra?, commentaire? }]
// options : { commentaire, fin: { disque, disqueCentral, entreesDisque, entrees, tailleCentral, decalageCentral } }
function fabriquerZip(entrees, options = {}) {
  const locaux = [];
  const centraux = [];
  let decalage = 0;
  for (const e of entrees) {
    const contenu = Buffer.from(e.contenu || '');
    const methode = e.methode === undefined ? 8 : e.methode;
    const donnees = methode === 8 ? zlib.deflateRawSync(contenu) : contenu;
    const nom = Buffer.from(e.nom, e.latin1 ? 'latin1' : 'utf8');
    const drapeaux = e.drapeaux === undefined ? (e.latin1 ? 0 : 0x0800) : e.drapeaux;
    const crc = e.crc === undefined ? z.crc32(contenu) : e.crc;
    const taille = e.taille === undefined ? contenu.length : e.taille;
    const extra = e.extra || Buffer.alloc(0);
    const local = Buffer.concat([
      u32(e.signatureLocale === undefined ? 0x04034b50 : e.signatureLocale), u16(20), u16(drapeaux), u16(methode),
      u16(0), u16(0), u32(crc), u32(donnees.length), u32(taille), u16(nom.length), u16(extra.length), nom, extra
    ]);
    const commentaire = Buffer.from(e.commentaire || '');
    centraux.push(Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(drapeaux), u16(methode), u16(0), u16(0), u32(crc),
      u32(donnees.length), u32(taille), u16(nom.length), u16(0), u16(commentaire.length), u16(0), u16(0), u32(0),
      u32(decalage), nom, commentaire
    ]));
    locaux.push(local, donnees);
    decalage += local.length + donnees.length;
  }
  const central = Buffer.concat(centraux);
  const f = Object.assign({
    disque: 0, disqueCentral: 0, entreesDisque: entrees.length, entrees: entrees.length,
    tailleCentral: central.length, decalageCentral: decalage
  }, options.fin);
  const commentaire = Buffer.from(options.commentaire || '');
  return Buffer.concat([
    ...locaux, central,
    u32(0x06054b50), u16(f.disque), u16(f.disqueCentral), u16(f.entreesDisque), u16(f.entrees),
    u32(f.tailleCentral), u32(f.decalageCentral), u16(commentaire.length), commentaire
  ]);
}

const FEATURES = '# FEATURES\n\n- [x] A\n- [ ] B\n';

function lireTout(buf, nom) {
  const lecteur = z.lecteurDeBuffer(buf);
  const entree = z.lireEntrees(lecteur).find((e) => e.nom === nom);
  return z.extraire(lecteur, entree).toString('utf8');
}

// --- CRC-32 ----------------------------------------------------------------

test('crc32 : valeurs de référence', () => {
  assert.equal(z.crc32(Buffer.from('')), 0);
  assert.equal(z.crc32(Buffer.from('123456789')), 0xcbf43926);
});

// --- Lecture des entrées ---------------------------------------------------

test('lireEntrees : ordre, dossiers, noms UTF-8 et CP437', () => {
  const buf = fabriquerZip([
    { nom: 'projet/', contenu: '', methode: 0 },
    { nom: 'projet/été.md', contenu: 'é' },
    { nom: 'ancien\xe9.txt', contenu: 'x', latin1: true }
  ]);
  const entrees = z.lireEntrees(z.lecteurDeBuffer(buf));
  assert.deepEqual(entrees.map((e) => [e.nom, e.dossier]), [['projet/', true], ['projet/été.md', false], ['ancien\xe9.txt', false]]);
});

test('lireEntrees : commentaire d\'archive et commentaire d\'entrée', () => {
  const buf = fabriquerZip([{ nom: 'FEATURES.md', contenu: FEATURES, commentaire: 'note' }], { commentaire: 'PK\x05\x06 leurre' });
  assert.equal(lireTout(buf, 'FEATURES.md'), FEATURES);
});

test('lireEntrees : archive vide', () => {
  assert.deepEqual(z.lireEntrees(z.lecteurDeBuffer(fabriquerZip([]))), []);
});

test('lireEntrees : fichier trop court, pas un ZIP, ZIP tronqué', () => {
  assert.throws(() => z.lireEntrees(z.lecteurDeBuffer(Buffer.from('court'))), /trop court/);
  assert.throws(() => z.lireEntrees(z.lecteurDeBuffer(Buffer.alloc(100, 0x41))), /fin du répertoire central introuvable/);
  const buf = fabriquerZip([{ nom: 'a.txt', contenu: 'a' }]);
  // Répertoire central annoncé au-delà de la fin du fichier.
  const tronque = fabriquerZip([{ nom: 'a.txt', contenu: 'a' }], { fin: { decalageCentral: buf.length } });
  assert.throws(() => z.lireEntrees(z.lecteurDeBuffer(tronque)), (e) => e instanceof z.ErreurZip && /tronqué/.test(e.message));
});

test('lireEntrees : ZIP64 et archives en plusieurs volumes refusés', () => {
  for (const fin of [{ entrees: 0xffff }, { tailleCentral: 0xffffffff }, { decalageCentral: 0xffffffff }]) {
    assert.throws(() => z.lireEntrees(z.lecteurDeBuffer(fabriquerZip([{ nom: 'a', contenu: 'a' }], { fin }))), /ZIP64/);
  }
  for (const fin of [{ disque: 1 }, { disqueCentral: 1 }, { entreesDisque: 0 }]) {
    assert.throws(() => z.lireEntrees(z.lecteurDeBuffer(fabriquerZip([{ nom: 'a', contenu: 'a' }], { fin }))), /plusieurs volumes/);
  }
});

test('lireEntrees : répertoire central incohérent', () => {
  // Plus d'entrées annoncées que présentes : fin du répertoire atteinte.
  const plus = fabriquerZip([{ nom: 'a', contenu: 'a' }], { fin: { entrees: 2, entreesDisque: 2 } });
  assert.throws(() => z.lireEntrees(z.lecteurDeBuffer(plus)), /répertoire central invalide/);
  // Signature d'en-tête central corrompue.
  const buf = fabriquerZip([{ nom: 'a', contenu: 'a' }]);
  const decalage = buf.length - 22 - (46 + 1);
  const corrompu = Buffer.from(buf);
  corrompu.writeUInt32LE(0xdeadbeef, decalage);
  assert.throws(() => z.lireEntrees(z.lecteurDeBuffer(corrompu)), /répertoire central invalide/);
  // Longueur de nom qui déborde du répertoire central.
  const deborde = Buffer.from(buf);
  deborde.writeUInt16LE(500, decalage + 28);
  assert.throws(() => z.lireEntrees(z.lecteurDeBuffer(deborde)), /répertoire central invalide/);
});

// --- Extraction ------------------------------------------------------------

test('extraire : méthodes stocké et deflate, champ extra local', () => {
  const buf = fabriquerZip([
    { nom: 'stocke.md', contenu: 'brut', methode: 0 },
    { nom: 'deflate.md', contenu: FEATURES.repeat(50), extra: Buffer.from('0123456789') }
  ]);
  assert.equal(lireTout(buf, 'stocke.md'), 'brut');
  assert.equal(lireTout(buf, 'deflate.md'), FEATURES.repeat(50));
});

test('extraire : entrée chiffrée, méthode inconnue, en-tête local invalide', () => {
  const buf = fabriquerZip([
    { nom: 'chiffre.md', contenu: 'x', drapeaux: 0x0801 },
    { nom: 'bzip2.md', contenu: 'x', methode: 12 },
    { nom: 'local.md', contenu: 'x', signatureLocale: 0x12345678 }
  ]);
  const lecteur = z.lecteurDeBuffer(buf);
  const [chiffre, bzip2, local] = z.lireEntrees(lecteur);
  assert.throws(() => z.extraire(lecteur, chiffre), /entrée chiffrée : chiffre\.md/);
  assert.throws(() => z.extraire(lecteur, bzip2), /méthode de compression 12/);
  assert.throws(() => z.extraire(lecteur, local), /en-tête local invalide/);
});

test('extraire : taille annoncée au-delà de la limite → refus avant décompression', () => {
  const buf = fabriquerZip([{ nom: 'gros.md', contenu: 'x', taille: z.TAILLE_MAX_DEFAUT + 1 }]);
  const lecteur = z.lecteurDeBuffer(buf);
  assert.throws(() => z.extraire(lecteur, z.lireEntrees(lecteur)[0]), /entrée trop grande/);
});

test('extraire : ZIP bombe qui ment sur sa taille → décompression arrêtée à la limite', () => {
  // 64 Kio de zéros annoncés comme 10 octets, limite 1 Kio.
  const buf = fabriquerZip([{ nom: 'bombe.md', contenu: '\0'.repeat(65536), taille: 10 }]);
  const lecteur = z.lecteurDeBuffer(buf);
  assert.throws(() => z.extraire(lecteur, z.lireEntrees(lecteur)[0], { tailleMax: 1024 }), /décompression impossible \(ERR_BUFFER_TOO_LARGE\)/);
});

test('extraire : données deflate corrompues', () => {
  const buf = fabriquerZip([{ nom: 'a.md', contenu: FEATURES }]);
  const lecteur = z.lecteurDeBuffer(buf);
  const entree = z.lireEntrees(lecteur)[0];
  const corrompu = Buffer.from(buf);
  corrompu.fill(0xff, 30 + 4, 30 + entree.tailleCompressee); // données après le nom « a.md »
  assert.throws(() => z.extraire(z.lecteurDeBuffer(corrompu), entree), /décompression impossible/);
});

test('extraire : taille ou CRC faux', () => {
  const buf = fabriquerZip([
    { nom: 'taille.md', contenu: 'abc', methode: 0, taille: 2 },
    { nom: 'crc.md', contenu: 'abc', crc: 1 }
  ]);
  const lecteur = z.lecteurDeBuffer(buf);
  const [taille, crc] = z.lireEntrees(lecteur);
  assert.throws(() => z.extraire(lecteur, taille), /taille incohérente : taille\.md/);
  assert.throws(() => z.extraire(lecteur, crc), /CRC incorrect : crc\.md/);
});

// --- Recherche de FEATURES.md ----------------------------------------------

test('trouverFeaturesMd : nom exact (casse ignorée), dossiers et homonymes exclus', () => {
  const e = (nom) => ({ nom, dossier: nom.endsWith('/') });
  assert.equal(z.trouverFeaturesMd([e('FEATURES.md/'), e('MYFEATURES.md'), e('src/features.MD')]).nom, 'src/features.MD');
  assert.equal(z.trouverFeaturesMd([e('a/FEATURES.md'), e('FEATURES.md')]).nom, 'a/FEATURES.md'); // ordre de l'archive
  assert.equal(z.trouverFeaturesMd([e('README.md')]), null);
});

// --- Fichier sur disque ----------------------------------------------------

function dossierTemp(t) {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-zip-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}

test('lireFeaturesMd : FEATURES.md dans un dossier avec espaces', (t) => {
  const chemin = path.join(dossierTemp(t), 'livraison.zip');
  fs.writeFileSync(chemin, fabriquerZip([{ nom: 'Mon projet/src/x.js', contenu: '//' }, { nom: 'Mon projet/FEATURES.md', contenu: FEATURES }]));
  assert.deepEqual(z.lireFeaturesMd(chemin), { nom: 'Mon projet/FEATURES.md', contenu: FEATURES });
});

test('lireFeaturesMd : noms hostiles lus comme des données, aucune commande exécutée', (t) => {
  // Si un shell interprétait ces noms, `touch PREUVE` créerait le fichier dans
  // le dossier courant : on se place dans un dossier temporaire pour le voir.
  const d = dossierTemp(t);
  const origine = process.cwd();
  process.chdir(d);
  t.after(() => process.chdir(origine));
  const chemin = path.join(d, 'livraison$(touch PREUVE)`touch PREUVE`"\'.zip');
  const nom = 'x$(touch PREUVE)";touch PREUVE;\'/FEATURES.md';
  fs.writeFileSync(chemin, fabriquerZip([{ nom, contenu: FEATURES }]));
  assert.deepEqual(z.lireFeaturesMd(chemin), { nom, contenu: FEATURES });
  assert.equal(fs.existsSync(path.join(d, 'PREUVE')), false);
});

test('lireFeaturesMd : archive sans FEATURES.md → null, fichier refermé', (t) => {
  const chemin = path.join(dossierTemp(t), 'sans.zip');
  fs.writeFileSync(chemin, fabriquerZip([{ nom: 'README.md', contenu: 'x' }]));
  const fermes = [];
  const fsEspion = Object.assign({}, fs, { closeSync: (fd) => { fermes.push(fd); fs.closeSync(fd); } });
  assert.equal(z.lireFeaturesMd(chemin, { fs: fsEspion }), null);
  assert.equal(fermes.length, 1);
});

test('lireFeaturesMd : archive illisible → ErreurZip, fichier refermé ; fichier absent → erreur système', (t) => {
  const chemin = path.join(dossierTemp(t), 'corrompu.zip');
  fs.writeFileSync(chemin, 'ceci n\'est pas un zip, mais assez long pour être lu');
  const fermes = [];
  const fsEspion = Object.assign({}, fs, { closeSync: (fd) => { fermes.push(fd); fs.closeSync(fd); } });
  assert.throws(() => z.lireFeaturesMd(chemin, { fs: fsEspion }), z.ErreurZip);
  assert.equal(fermes.length, 1);
  assert.throws(() => z.lireFeaturesMd(path.join(path.dirname(chemin), 'absent.zip')), { code: 'ENOENT' });
});

test('lireFeaturesMd : limite de taille transmise', (t) => {
  const chemin = path.join(dossierTemp(t), 'limite.zip');
  fs.writeFileSync(chemin, fabriquerZip([{ nom: 'FEATURES.md', contenu: FEATURES }]));
  assert.throws(() => z.lireFeaturesMd(chemin, { tailleMax: 4 }), /entrée trop grande/);
});

test('lecteurDeFichier : lectures partielles reprises, fin de fichier détectée', () => {
  const contenu = Buffer.from('0123456789');
  const fsFaux = {
    fstatSync: () => ({ size: contenu.length }),
    // Rend au plus 3 octets par appel, comme un système de fichiers lent.
    readSync: (fd, buf, decalage, longueur, position) => contenu.copy(buf, decalage, position, Math.min(position + Math.min(longueur, 3), contenu.length))
  };
  const lecteur = z.lecteurDeFichier(1, fsFaux);
  assert.equal(lecteur.lire(2, 7).toString(), '2345678');
  assert.throws(() => lecteur.lire(8, 5), /tronqué/);
  assert.throws(() => lecteur.lire(-1, 1), /tronqué/);
  // Fichier raccourci entre fstat et read : 0 octet lu.
  const fsRaccourci = { fstatSync: () => ({ size: 10 }), readSync: () => 0 };
  assert.throws(() => z.lecteurDeFichier(1, fsRaccourci).lire(0, 4), /tronqué/);
});

test('lecteurDeBuffer : bornes', () => {
  const lecteur = z.lecteurDeBuffer(Buffer.from('abc'));
  assert.equal(lecteur.lire(1, 2).toString(), 'bc');
  assert.throws(() => lecteur.lire(2, 2), /tronqué/);
  assert.throws(() => lecteur.lire(-1, 1), /tronqué/);
});

test('ErreurZip : nom et héritage', () => {
  const e = new z.ErreurZip('m');
  assert.ok(e instanceof Error);
  assert.equal(e.name, 'ErreurZip');
});
