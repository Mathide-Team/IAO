'use strict';

// Création de comptes en série (issue #201) : lib/comptes-serie.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const c = require('../lib/comptes-serie.js');

const EXISTANTS = [
  { name: '235', profile: 'profil_235' },
  { name: 'Perso', profile: 'profil_238' },
  { name: '12', profile: 'travail' },
  null
];

test('plusGrandNumero : noms numériques et profils profil_<n>', () => {
  assert.equal(c.plusGrandNumero(EXISTANTS), 238);
  assert.equal(c.plusGrandNumero([]), 0);
  assert.equal(c.plusGrandNumero(undefined), 0);
});

test('comptesEnSerie : à la suite, adresse, profil, services copiés', () => {
  const services = ['claude'];
  const r = c.comptesEnSerie({ comptes: EXISTANTS, nombre: 2, prefixe: 'docker', domaine: 'dmathilde.fr', services, maintenant: 1700 });
  assert.equal(r.ok, true);
  assert.deepEqual(r.comptes, [
    { id: 'acc_1700_239', name: '239', email: 'docker239@dmathilde.fr', profile: 'profil_239', services: ['claude'] },
    { id: 'acc_1700_240', name: '240', email: 'docker240@dmathilde.fr', profile: 'profil_240', services: ['claude'] }
  ]);
  assert.notEqual(r.comptes[0].services, services);
  const sansPrefixe = c.comptesEnSerie({ nombre: 1, domaine: 'd.fr' });
  assert.deepEqual(sansPrefixe.comptes[0], { id: 'acc_0_1', name: '1', email: '1@d.fr', profile: 'profil_1', services: [] });
});

test('comptesEnSerie : nombre et domaine vérifiés', () => {
  for (const nombre of [0, -1, 1.5, c.SERIE_MAX + 1, 'x']) {
    assert.deepEqual(c.comptesEnSerie({ nombre, domaine: 'd.fr' }), { ok: false, erreur: 'nombre' });
  }
  assert.deepEqual(c.comptesEnSerie({ nombre: 1 }), { ok: false, erreur: 'domaine' });
  assert.deepEqual(c.comptesEnSerie(), { ok: false, erreur: 'nombre' });
});

test('genererMotDePasse : longueur, alphabet, rejet des octets biaisés', () => {
  const mdp = c.genererMotDePasse(n => crypto.randomBytes(n));
  assert.equal(mdp.length, c.MOT_DE_PASSE_LONGUEUR);
  assert.ok([...mdp].every(x => c.ALPHABET.includes(x)));
  // 255 est rejeté (au-delà de la limite), puis 0 -> premier caractère.
  let appel = 0;
  const biaise = (n) => (appel++ ? new Uint8Array(n).fill(0) : new Uint8Array(n).fill(255));
  assert.equal(c.genererMotDePasse(biaise, 4), 'AAAA');
  assert.equal(appel, 2);
});

test('comptes-serie s\'attache à window dans le renderer', () => {
  const chemin = require.resolve('../lib/comptes-serie.js');
  const avant = global.window;
  global.window = {};
  try {
    delete require.cache[chemin];
    require(chemin);
    assert.equal(typeof global.window.iaoComptesSerie.comptesEnSerie, 'function');
  } finally {
    if (avant === undefined) delete global.window; else global.window = avant;
    delete require.cache[chemin];
  }
});
