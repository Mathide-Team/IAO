'use strict';

// test/stats-lot4.test.js — statistiques, lot 4 de l'issue #206 : évolution
// du temps de réponse, comptes surchargés, export JSON des réponses/quotas.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const st = require('../lib/stats.js');

const MIN = 60 * 1000;
const H = 60 * MIN;
const J = 24 * H;
const T0 = new Date(2026, 9, 19, 10, 0, 0).getTime(); // lundi 19/10/2026 10:00 locale
const rep = (id, profil, debut, dureeMs) => ({ id, profil, service: 'claude', debut, fin: debut + dureeMs });
const ses = (profil, debut, fin, actifMs) => ({ id: profil + debut, profil, service: 'claude', debut, fin, actifMs });

test('evolutionReponses : médiane par tranche, réponse comptée à sa fin', () => {
  const jour = new Date(2026, 9, 19).getTime();
  const r = st.evolutionReponses([
    rep('a', 'p1', jour + 9 * H, 4000),
    rep('b', 'p1', jour + 9 * H + MIN, 10000),
    rep('c', 'p1', jour + 9 * H + 2 * MIN, 6000),
    rep('d', 'p1', jour + 10 * H - 1000, 5000), // finit à 10 h
    rep('e', 'p1', jour - J, 3000) // hors période
  ], { periode: 'jour', maintenant: T0 });
  assert.equal(r.length, 24);
  assert.deepEqual([r[9].nombre, r[9].medianeMs], [3, 6000]);
  assert.deepEqual([r[10].nombre, r[10].medianeMs], [1, 5000]);
  assert.deepEqual([r[0].nombre, r[0].medianeMs], [0, 0]);
  assert.equal(r[9].debut, jour + 9 * H);
  const semaine = st.evolutionReponses(null, { periode: 'semaine', maintenant: T0 });
  assert.equal(semaine.length, 7);
  assert.ok(semaine.every(t => t.nombre === 0));
  assert.equal(st.evolutionReponses([], undefined).length, 90, 'période par défaut : tout');
});

test('comptesSurcharges : seuil de quotas, tri, relais les moins utilisés', () => {
  const depuis = T0 - 7 * J;
  const quotas = [];
  for (let i = 0; i < 4; i++) quotas.push({ id: 'q1' + i, profil: 'p1', service: 'claude', date: T0 - i * H });
  for (let i = 0; i < 3; i++) quotas.push({ id: 'q2' + i, profil: 'p2', service: 'claude', date: T0 - i * H });
  quotas.push({ id: 'q3', profil: 'p3', service: 'claude', date: T0 });
  quotas.push({ id: 'vieux', profil: 'p3', service: 'claude', date: depuis - 1 });
  const sessions = [ses('p3', T0 - 2 * H, T0 - H, 30 * MIN), ses('p4', T0 - 3 * H, T0 - H, 2 * H),
    ses('p5', depuis - 2 * H, depuis - H, H), ses('inconnu', T0 - H, T0, MIN)];
  const r = st.comptesSurcharges(sessions, quotas, ['p1', 'p2', 'p3', 'p4', 'p5', 'p6'], depuis);
  assert.equal(r.seuil, 3);
  assert.deepEqual(r.surcharges, [{ profil: 'p1', quotas: 4 }, { profil: 'p2', quotas: 3 }]);
  assert.deepEqual(r.relais, ['p5', 'p6', 'p3'], 'temps actif croissant, hors surchargés');
  const seuil2 = st.comptesSurcharges(sessions, quotas, null, depuis, { seuilQuotas: 1 });
  assert.deepEqual(seuil2.surcharges.map(x => x.profil), ['p1', 'p2', 'p3']);
  assert.deepEqual(seuil2.relais, []);
  // Égalités : ordre alphabétique des profils.
  const egal = st.comptesSurcharges([], [
    { id: 'x', profil: 'pb', service: 'c', date: T0 }, { id: 'y', profil: 'pa', service: 'c', date: T0 }],
  ['pz', 'py'], 0, { seuilQuotas: 1 });
  assert.deepEqual(egal.surcharges.map(x => x.profil), ['pa', 'pb']);
  assert.deepEqual(egal.relais, ['py', 'pz']);
  assert.deepEqual(st.comptesSurcharges(null, null, undefined, 0), { seuil: 3, surcharges: [], relais: [] });
});

test('versJsonExport : réponses et quotas joints avec le nom du compte', () => {
  const j = JSON.parse(st.versJsonExport([], { p1: 'Un' }, T0,
    [rep('r1', 'p1', T0, 4200), rep('r2', 'p9', T0, 1000)],
    [{ id: 'q1', profil: 'p1', service: 'claude', date: T0 }]));
  assert.equal(j.format, 'iao-stats-1');
  assert.deepEqual(j.reponses[0], { id: 'r1', compte: 'Un', profil: 'p1', service: 'claude',
    debut: new Date(T0).toISOString(), fin: new Date(T0 + 4200).toISOString(), duree_ms: 4200 });
  assert.equal(j.reponses[1].compte, 'p9');
  assert.deepEqual(j.quotas, [{ id: 'q1', compte: 'Un', profil: 'p1', service: 'claude', date: new Date(T0).toISOString() }]);
  const vide = JSON.parse(st.versJsonExport([], null, T0));
  assert.deepEqual([vide.reponses, vide.quotas], [[], []]);
});

test('store.exporter json : inclut les réponses et quotas enregistrés', async () => {
  const dossier = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iao-stats4-')), 'stats');
  const store = st.creerStore({ dossier, fs: fs.promises, path, maintenant: () => T0 });
  await store.noterReponse({ profil: 'p1', service: 'claude', debut: T0 - 2 * MIN, fin: T0 - MIN });
  await store.noterQuota({ profil: 'p1', service: 'claude', date: T0 - MIN });
  const j = JSON.parse((await store.exporter('json', [], { p1: 'Un' })).contenu);
  assert.equal(j.reponses.length, 1);
  assert.equal(j.reponses[0].duree_ms, MIN);
  assert.equal(j.quotas[0].compte, 'Un');
  fs.rmSync(path.dirname(dossier), { recursive: true, force: true });
});

test('geometrieBarres secondes : paliers de 5 à 30 s, puis minutes', () => {
  assert.equal(st.grandeurRonde(8000, true), 10000);
  assert.equal(st.grandeurRonde(4000, true), 5000);
  assert.equal(st.grandeurRonde(30000, true), 30000);
  assert.equal(st.grandeurRonde(45000, true), st.grandeurRonde(45000));
  assert.equal(st.grandeurRonde(0, true), st.grandeurRonde(0), 'aucune valeur : échelle par défaut');
  assert.equal(st.grandeurRonde(8000), st.grandeurRonde(8000, false));
  const g = st.geometrieBarres([8000, 4000], { largeur: 100, hauteur: 100, secondes: true });
  assert.equal(g.echelle, 10000);
  assert.equal(g.barres[0].hauteur, 80);
});
