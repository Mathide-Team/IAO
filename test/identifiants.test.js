'use strict';

// Identifiants de connexion partagés entre profils (issue #278, lot 1).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { IdentifiantsPartages, registerIdentifiantsIPC, LOGIN_MAX, MDP_MAX } = require('../lib/identifiants.js');

// Chiffreur factice réversible (inverse les octets) ; `etat` pilote la disponibilité.
function chiffreur(etat) {
  return {
    isEncryptionAvailable: () => { if (etat.leve) throw new Error('x'); return etat.dispo; },
    getSelectedStorageBackend: etat.backend === undefined ? undefined : () => etat.backend,
    encryptString: (s) => Buffer.from(s, 'utf-8').reverse(),
    decryptString: (b) => { if (etat.casse) throw new Error('clé changée'); return Buffer.from(b).reverse().toString('utf-8'); }
  };
}

function creer(t, etat) {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-identifiants-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const journal = [];
  const fichier = path.join(dossier, 'identifiants.json');
  const identifiants = new IdentifiantsPartages({ fichier, chiffreur: chiffreur(etat), journal: (n, m) => journal.push(n + ' ' + m) });
  return { identifiants, fichier, journal };
}

test('enregistrer / obtenir / supprimer, jamais en clair sur le disque', (t) => {
  const { identifiants, fichier, journal } = creer(t, { dispo: true, backend: 'gnome_libsecret' });
  assert.deepEqual(identifiants.enregistrer('context7.com', 'moi@exemple.fr', 'S3cret!'), { ok: true });
  assert.equal(identifiants.obtenir('context7.com', 'moi@exemple.fr'), 'S3cret!');
  assert.ok(!fs.readFileSync(fichier, 'utf-8').includes('S3cret!'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(fichier).mode & 0o777, 0o600);
  assert.equal(identifiants.obtenir('context7.com', 'absent@exemple.fr'), null);
  assert.equal(identifiants.obtenir('absent.com', 'moi@exemple.fr'), null);
  assert.equal(identifiants.supprimer('context7.com', 'moi@exemple.fr'), true);
  assert.equal(identifiants.supprimer('context7.com', 'moi@exemple.fr'), false);
  assert.ok(journal.some(l => /^info Identifiants : « moi@exemple\.fr » enregistré pour context7\.com/.test(l)));
});

test('lister ne retourne jamais les mots de passe (rien à déchiffrer)', (t) => {
  const { identifiants, fichier } = creer(t, { dispo: true });
  identifiants.enregistrer('context7.com', 'a@x.fr', 'Mdp1');
  identifiants.enregistrer('context7.com', 'b@x.fr', 'Mdp2');
  identifiants.enregistrer('github.com', 'c@x.fr', 'Mdp3');
  const liste = identifiants.lister();
  assert.deepEqual(Object.keys(liste).sort(), ['context7.com', 'github.com']);
  assert.equal(liste['context7.com'].length, 2);
  assert.deepEqual(liste['context7.com'].map(e => e.login).sort(), ['a@x.fr', 'b@x.fr']);
  assert.equal(typeof liste['context7.com'][0].ajoute, 'number');
  assert.ok(!JSON.stringify(liste).includes('Mdp'));
  assert.ok(!fs.readFileSync(fichier, 'utf-8').includes('Mdp1'));
});

test('enregistrer : hôte et login vérifiés, hôte insensible à la casse', (t) => {
  const { identifiants } = creer(t, { dispo: true });
  assert.deepEqual(identifiants.enregistrer('Context7.COM', 'a@x.fr', 'm'), { ok: true });
  assert.equal(identifiants.obtenir('context7.com', 'a@x.fr'), 'm');
  assert.deepEqual(identifiants.enregistrer('pas un host', 'a@x.fr', 'm'), { ok: false, erreur: 'hote' });
  assert.deepEqual(identifiants.enregistrer('context7.com', '', 'm'), { ok: false, erreur: 'login' });
  assert.deepEqual(identifiants.enregistrer('context7.com', 'x'.repeat(LOGIN_MAX + 1), 'm'), { ok: false, erreur: 'login' });
  assert.deepEqual(identifiants.enregistrer('context7.com', 'a@x.fr', ''), { ok: false, erreur: 'mot-de-passe' });
  assert.deepEqual(identifiants.enregistrer('context7.com', 'a@x.fr', 'x'.repeat(MDP_MAX + 1)), { ok: false, erreur: 'mot-de-passe' });
});

test('enregistrer remplace un login existant, ne crée pas de doublon', (t) => {
  const { identifiants } = creer(t, { dispo: true });
  identifiants.enregistrer('context7.com', 'a@x.fr', 'ancien');
  assert.deepEqual(identifiants.enregistrer('context7.com', 'a@x.fr', 'nouveau'), { ok: true });
  assert.equal(identifiants.obtenir('context7.com', 'a@x.fr'), 'nouveau');
  assert.equal(identifiants.lister()['context7.com'].length, 1);
});

test('chiffrement indisponible (ou basic_text, ou erreur) : refus, rien d\'écrit', (t) => {
  for (const etat of [{ dispo: false }, { dispo: true, backend: 'basic_text' }, { leve: true }]) {
    const { identifiants, fichier, journal } = creer(t, etat);
    assert.deepEqual(identifiants.enregistrer('context7.com', 'a@x.fr', 'm'), { ok: false, erreur: 'chiffrement-indisponible' });
    assert.equal(fs.existsSync(fichier), false);
    assert.ok(journal.some(l => /indisponible/.test(l)));
  }
});

test('fichier illisible ou JSON invalide : liste vide, journal, pas de crash', (t) => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-identifiants-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const fichier = path.join(dossier, 'identifiants.json');
  fs.writeFileSync(fichier, '{pas du tout du json', 'utf-8');
  const journal = [];
  const identifiants = new IdentifiantsPartages({ fichier, chiffreur: chiffreur({ dispo: true }), journal: (n, m) => journal.push(n + ' ' + m) });
  assert.deepEqual(identifiants.lister(), {});
  assert.ok(journal.some(l => /illisible/.test(l)));
  // Un hôte stocké sous une forme inattendue (tableau absent) est ignoré.
  fs.writeFileSync(fichier, JSON.stringify({ 'x.com': 'pas un tableau' }), 'utf-8');
  assert.deepEqual(identifiants.lister(), {});
});

test('obtenir : déchiffrement impossible → null journalisé', (t) => {
  const { identifiants, journal } = creer(t, { dispo: true, casse: true });
  identifiants.enregistrer('context7.com', 'a@x.fr', 'm');
  // forcer une écriture antérieure au "casse" : le chiffreur casse à la lecture.
  assert.equal(identifiants.obtenir('context7.com', 'a@x.fr'), null);
  assert.ok(journal.some(l => /déchiffrement impossible/.test(l)));
});

test('quotas : hôtes et identifiants par hôte bornés', (t) => {
  const { identifiants } = creer(t, { dispo: true });
  for (let i = 0; i < 200; i++) identifiants.enregistrer('h' + i + '.com', 'a@x.fr', 'm');
  assert.deepEqual(identifiants.enregistrer('encore-un.com', 'a@x.fr', 'm'), { ok: false, erreur: 'quota-hotes' });
  for (let i = 0; i < 20; i++) identifiants.enregistrer('h0.com', 'login' + i, 'm');
  assert.deepEqual(identifiants.enregistrer('h0.com', 'login20', 'm'), { ok: false, erreur: 'quota-hote' });
});

test('registerIdentifiantsIPC : 4 canaux, erreurs absorbées en { error }', async (t) => {
  const canaux = new Map();
  const ipc = { handle: (c, fn) => canaux.set(c, fn) };
  const { identifiants } = creer(t, { dispo: true });
  identifiants.enregistrer('context7.com', 'a@x.fr', 'm');
  registerIdentifiantsIPC(ipc, { identifiants });
  assert.deepEqual([...canaux].map(([c]) => c).sort(),
    ['identifiants:enregistrer', 'identifiants:lister', 'identifiants:obtenir', 'identifiants:supprimer']);
  const evt = {};
  assert.deepEqual(await canaux.get('identifiants:lister')(evt), { 'context7.com': [{ login: 'a@x.fr', ajoute: identifiants.lister()['context7.com'][0].ajoute }] });
  assert.equal(await canaux.get('identifiants:obtenir')(evt, 'context7.com', 'a@x.fr'), 'm');
  assert.deepEqual(await canaux.get('identifiants:enregistrer')(evt, 'context7.com', 'b@x.fr', 'n'), { ok: true });
  assert.equal(await canaux.get('identifiants:supprimer')(evt, 'context7.com', 'b@x.fr'), true);
  // Exception dans un handler -> { error: ... }, pas de crash du canal.
  const identifiantsQuiFaitTout = {
    lister: () => { throw new Error('boum'); }
  };
  registerIdentifiantsIPC(ipc, { identifiants: identifiantsQuiFaitTout });
  assert.deepEqual(await canaux.get('identifiants:lister')(evt), { error: 'boum' });
});

test('supprimer le dernier identifiant d\'un hôte retire l\'hôte', (t) => {
  const { identifiants } = creer(t, { dispo: true });
  identifiants.enregistrer('context7.com', 'a@x.fr', 'm');
  identifiants.supprimer('context7.com', 'a@x.fr');
  assert.deepEqual(identifiants.lister(), {});
});

test('robustesse : journal par défaut, JSON non objet, arguments vides, hôte absent', (t) => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-identifiants-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const fichier = path.join(dossier, 'identifiants.json');
  // fs injecté (surcharge) : le module doit l'utiliser tel quel.
  const fsPerso = Object.create(fs);
  assert.equal(fsPerso.readFileSync, fs.readFileSync);
  const identifiants = new IdentifiantsPartages({ fichier, chiffreur: chiffreur({ dispo: true }), fs: fsPerso });
  // Sans journal injecté : le repli par défaut ne doit pas crasher.
  const identifiants2 = new IdentifiantsPartages({ fichier, chiffreur: chiffreur({ dispo: true }) });
  assert.deepEqual(identifiants.enregistrer('context7.com', 'a@x.fr', 'm'), { ok: true });
  assert.deepEqual(identifiants2.enregistrer('context7.com', 'a@x.fr', 'm'), { ok: true });
  // _lire : JSON tableau ou null -> traité comme vide.
  fs.writeFileSync(fichier, '[1, 2]', 'utf-8');
  assert.deepEqual(identifiants.lister(), {});
  fs.writeFileSync(fichier, 'null', 'utf-8');
  assert.deepEqual(identifiants.lister(), {});
  // Entrée stockée avec un « ajoute » non numérique : lister renvoie null, pas de crash.
  fs.writeFileSync(fichier, JSON.stringify({ 'x.com': [{ login: 'a@x.fr', secret: 'e', ajoute: 'pas-un-nombre' }] }), 'utf-8');
  assert.deepEqual(identifiants.lister(), { 'x.com': [{ login: 'a@x.fr', ajoute: null }] });
  // Entrées mal formées dans le tableau (null, chaîne) : supprimer les filtre sans crash.
  fs.writeFileSync(fichier, JSON.stringify({ 'x.com': [null, 'pas une entrée', { login: 'a@x.fr', secret: 'e', ajoute: 1 }] }), 'utf-8');
  assert.equal(identifiants.supprimer('x.com', 'a@x.fr'), true);
  // Les entrées mal formées restent dans le fichier (listées comme rien) : l'hôte n'est
  // retiré que si le tableau devient vide après filtrage.
  assert.deepEqual(identifiants.lister(), { 'x.com': [] });
  // Arguments vides : hôte/login falsy -> refus ou null/false, jamais de crash.
  assert.deepEqual(identifiants.enregistrer(null, 'a@x.fr', 'm'), { ok: false, erreur: 'hote' });
  assert.deepEqual(identifiants.enregistrer('context7.com', null, 'm'), { ok: false, erreur: 'login' });
  assert.equal(identifiants.obtenir(null, 'a@x.fr'), null);
  assert.equal(identifiants.obtenir('context7.com', null), null);
  assert.equal(identifiants.obtenir('pas un host', 'a@x.fr'), null);
  assert.equal(identifiants.supprimer(null, 'a@x.fr'), false);
  assert.equal(identifiants.supprimer('context7.com', null), false);
  assert.equal(identifiants.supprimer('absent.com', 'a@x.fr'), false);
  // Login inexistant pour un hôte qui a des entrées : false, rien n'est modifié.
  fs.writeFileSync(fichier, JSON.stringify({ 'x.com': [{ login: 'a@x.fr', secret: 'e', ajoute: 1 }] }), 'utf-8');
  assert.equal(identifiants.supprimer('x.com', 'personne@x.fr'), false);
  assert.deepEqual(identifiants.lister(), { 'x.com': [{ login: 'a@x.fr', ajoute: 1 }] });
});

test('registerIdentifiantsIPC : erreur sans message -> { error: String(e) }', async () => {
  const canaux = new Map();
  const ipc = { handle: (c, fn) => canaux.set(c, fn) };
  registerIdentifiantsIPC(ipc, { identifiants: { lister: () => { throw 'boum-sans-message'; } } });
  assert.deepEqual(await canaux.get('identifiants:lister')({}), { error: 'boum-sans-message' });
});
