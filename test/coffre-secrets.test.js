'use strict';

// Coffre des mots de passe de messagerie (issue #201).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CoffreSecrets, registerComptesIPC, VALEUR_MAX } = require('../lib/coffre-secrets.js');
const { normalizeSettings } = require('../lib/settings.js');

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
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-coffre-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const journal = [];
  const fichier = path.join(dossier, 'secrets.json');
  const coffre = new CoffreSecrets({ fichier, chiffreur: chiffreur(etat), journal: (n, m) => journal.push(n + ' ' + m) });
  return { coffre, fichier, journal };
}

test('definir / lire / supprimer, jamais en clair sur le disque', (t) => {
  const { coffre, fichier, journal } = creer(t, { dispo: true, backend: 'gnome_libsecret' });
  assert.deepEqual(coffre.definir('profil_239', 'S3cret!'), { ok: true });
  assert.equal(coffre.lire('profil_239'), 'S3cret!');
  assert.ok(!fs.readFileSync(fichier, 'utf-8').includes('S3cret!'));
  if (process.platform !== 'win32') assert.equal(fs.statSync(fichier).mode & 0o777, 0o600);
  assert.equal(coffre.lire('absent'), null);
  assert.equal(coffre.supprimer('profil_239'), true);
  assert.equal(coffre.supprimer('profil_239'), false);
  assert.ok(journal.some(l => /^info Coffre : mot de passe enregistré pour « profil_239 »/.test(l)));
});

test('definir : clé et valeur vérifiées', (t) => {
  const { coffre } = creer(t, { dispo: true });
  assert.deepEqual(coffre.definir('../x', 'v'), { ok: false, erreur: 'cle' });
  assert.deepEqual(coffre.definir('p', ''), { ok: false, erreur: 'valeur' });
  assert.deepEqual(coffre.definir('p', 3), { ok: false, erreur: 'valeur' });
  assert.deepEqual(coffre.definir('p', 'x'.repeat(VALEUR_MAX + 1)), { ok: false, erreur: 'valeur' });
});

test('chiffrement indisponible (ou basic_text, ou erreur) : refus, rien d\'écrit', (t) => {
  for (const etat of [{ dispo: false }, { dispo: true, backend: 'basic_text' }, { leve: true }]) {
    const { coffre, fichier, journal } = creer(t, etat);
    assert.deepEqual(coffre.definir('p', 'v'), { ok: false, erreur: 'chiffrement-indisponible' });
    assert.equal(fs.existsSync(fichier), false);
    assert.ok(journal.some(l => /indisponible/.test(l)));
  }
});

test('lire : déchiffrement impossible ou coffre indisponible -> null', (t) => {
  const etat = { dispo: true };
  const { coffre, journal } = creer(t, etat);
  coffre.definir('p', 'v');
  etat.casse = true;
  assert.equal(coffre.lire('p'), null);
  assert.ok(journal.some(l => /déchiffrement impossible/.test(l)));
  etat.casse = false; etat.dispo = false;
  assert.equal(coffre.lire('p'), null);
});

test('fichier illisible ou non objet : vide, journalisé', (t) => {
  const { coffre, fichier, journal } = creer(t, { dispo: true });
  fs.writeFileSync(fichier, '{cassé');
  assert.equal(coffre.lire('p'), null);
  assert.ok(journal.some(l => /^warning Coffre : .*illisible/.test(l)));
  fs.writeFileSync(fichier, '[1]');
  assert.equal(coffre.lire('p'), null);
  fs.writeFileSync(fichier, 'null');
  assert.equal(coffre.supprimer('p'), false);
});

test('valeurs par défaut : fs réel, journal muet', (t) => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-coffre-'));
  t.after(() => fs.rmSync(dossier, { recursive: true, force: true }));
  const c = new CoffreSecrets({ fichier: path.join(dossier, 's.json'), chiffreur: chiffreur({ dispo: false }) });
  assert.equal(c.definir('p', 'v').ok, false);
  assert.equal(c.lire('p'), null);
});

test('registerComptesIPC : coffre, webmail des réglages seulement, erreurs converties', async (t) => {
  const { coffre, fichier } = creer(t, { dispo: true });
  const reglages = path.join(path.dirname(fichier), 'settings.json');
  const ouverts = [];
  const h = {};
  registerComptesIPC({ handle: (c, fn) => { h[c] = fn; } }, {
    coffre, fichierReglages: reglages, normaliser: normalizeSettings,
    fsPromises: fs.promises, ouvrirExterne: async (u) => { ouverts.push(u); }
  });
  assert.equal(await h['secrets:available'](null), true);
  assert.deepEqual(await h['secrets:set'](null, 'p', 'v'), { ok: true });
  assert.equal(await h['secrets:get'](null, 'p'), 'v');
  assert.equal(await h['secrets:delete'](null, 'p'), true);
  assert.equal(await h['app:open-webmail'](null, 'https://evil.example'), false); // pas de réglages
  fs.writeFileSync(reglages, JSON.stringify({ webmailUrl: 'https://mail.dmathilde.fr' }));
  assert.equal(await h['app:open-webmail'](null, 'https://evil.example'), true);
  assert.deepEqual(ouverts, ['https://mail.dmathilde.fr/']);
  coffre.lire = () => { throw new Error('boum'); };
  assert.deepEqual(await h['secrets:get'](null, 'p'), { error: 'boum' });
  coffre.lire = () => { throw 'brut'; }; // eslint-disable-line no-throw-literal
  assert.deepEqual(await h['secrets:get'](null, 'p'), { error: 'brut' });
});
