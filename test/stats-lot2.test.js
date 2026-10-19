'use strict';

// test/stats-lot2.test.js — statistiques, lot 2 de l'issue #206 :
// heures de pointe, comptes inutilisés, série de jours, tâches, tri.

const test = require('node:test');
const assert = require('node:assert/strict');
const st = require('../lib/stats.js');

const H = 60 * 60 * 1000;
const J = 24 * H;
const T0 = new Date(2026, 9, 19, 10, 0, 0).getTime(); // lundi 19/10/2026 10:00 locale
const ses = (id, profil, debut, fin, actifMs) => ({ id, profil, service: 'claude', debut, fin, actifMs });

test('heuresDePointe : temps actif réparti au prorata des tranches horaires (jour local, lundi = 0)', () => {
  const r = st.heuresDePointe([
    ses('a', 'p1', T0 + 30 * 60000, T0 + 90 * 60000, 60 * 60000), // 10:30 -> 11:30, tout actif
    ses('b', 'p1', T0 + J, T0 + J + H, 0),                          // mardi, rien d'actif : ignoré
    ses('c', 'p1', T0 - J, T0 - J + 2 * H, 2 * H)                    // dimanche 10:00-12:00
  ], 0);
  assert.equal(r.grille.length, 7);
  assert.equal(r.grille[0][10], 30 * 60000);
  assert.equal(r.grille[0][11], 30 * 60000);
  assert.equal(r.grille[1].reduce((a, b) => a + b, 0), 0);
  assert.equal(r.grille[6][10], H);
  assert.equal(r.grille[6][11], H);
  assert.equal(r.max, H);
});

test('heuresDePointe : seule la partie dans la période compte ; entrée vide ou non tableau', () => {
  const r = st.heuresDePointe([ses('a', 'p1', T0 - H, T0 + H, 2 * H)], T0);
  assert.equal(r.grille[0][9], 0);
  assert.equal(r.grille[0][10], H);
  assert.equal(st.heuresDePointe([ses('a', 'p1', T0 - 2 * H, T0 - H, H)], T0).max, 0); // hors période
  assert.equal(st.heuresDePointe(null).max, 0);
  assert.equal(st.heuresDePointe([ses('z', 'p1', T0, T0, 0)]).max, 0); // durée nulle
});

test('comptesInutilises : comptes sans session sur la période, avec la dernière utilisation connue', () => {
  const s = [ses('a', 'p1', T0 - 10 * J, T0 - 10 * J + H, 0), ses('b', 'p2', T0, T0 + H, 0),
    ses('c', 'p1', T0 - 20 * J, T0 - 20 * J + H, 0)];
  assert.deepEqual(st.comptesInutilises(s, ['p1', 'p2', 'p3'], T0 - J), [
    { cle: 'p1', dernier: T0 - 10 * J + H }, { cle: 'p3', dernier: 0 }]);
  assert.deepEqual(st.comptesInutilises(s, ['p1'], undefined), []);
  assert.deepEqual(st.comptesInutilises(null, null, 0), []);
  assert.deepEqual(st.comptesInutilises(null, ['p1']), [{ cle: 'p1', dernier: 0 }]);
});

test('serieJours : série en cours jusqu\'à aujourd\'hui ou hier, record, sessions à cheval sur minuit', () => {
  const s = [
    ses('a', 'p', T0, T0 + H, 0),                          // lundi 19
    ses('b', 'p', T0 - J + 13 * H, T0 - J + 15 * H, 0),    // dimanche 23:00 -> lundi 01:00
    ses('c', 'p', T0 - 2 * J, T0 - 2 * J + H, 0),          // samedi 17
    ses('d', 'p', T0 - 10 * J, T0 - 10 * J + H, 0),        // 09/10
    ses('e', 'p', T0 - 9 * J, T0 - 9 * J + H, 0),
    ses('f', 'p', T0 - 8 * J, T0 - 8 * J + H, 0),
    ses('g', 'p', T0 - 7 * J, T0 - 7 * J + H, 0)           // 4 jours : 09 -> 12/10
  ];
  assert.deepEqual(st.serieJours(s, T0 + 2 * H), { actuelle: 3, record: 4 });
  // Rien encore aujourd'hui (mardi) : la série d'hier reste en cours.
  assert.deepEqual(st.serieJours(s, T0 + J), { actuelle: 3, record: 4 });
  // Interrompue depuis deux jours.
  assert.deepEqual(st.serieJours(s, T0 + 2 * J), { actuelle: 0, record: 4 });
  assert.deepEqual(st.serieJours(null, T0), { actuelle: 0, record: 0 });
});

test('serieJours : la série traverse un changement de mois', () => {
  const fin = new Date(2026, 9, 31, 12).getTime();
  const debut = new Date(2026, 10, 1, 12).getTime();
  assert.deepEqual(st.serieJours([ses('a', 'p', fin, fin + H, 0), ses('b', 'p', debut, debut + H, 0)], debut),
    { actuelle: 2, record: 2 });
});

test('resultatsTaches : envois, quotas (dernier + heure), erreurs, autres, par compte et période', () => {
  const iso = (t) => new Date(t).toISOString();
  const h = [
    { date: iso(T0), tache: 't1', nom: 'A', profil: 'p1', resultat: 'envoye', detail: 'enter' },
    { date: iso(T0 + H), tache: 't1', nom: 'A', profil: 'p1', resultat: 'quota', detail: '15:00' },
    { date: iso(T0 - H), tache: 't1', nom: 'A', profil: 'p1', resultat: 'quota', detail: '09:00' },
    { date: iso(T0 + 2 * H), tache: 't1', nom: 'A', profil: 'p1', resultat: 'quota', detail: null },
    { date: iso(T0), tache: 't2', nom: 'B', profil: 'p2', resultat: 'erreur', detail: 'x' },
    { date: iso(T0), tache: 't2', nom: 'B', profil: 'p2', resultat: 'non-connecte', detail: 'x' },
    { date: iso(T0), tache: 't2', nom: 'B', profil: 'p2', resultat: 'heures-calmes', detail: null },
    { date: iso(T0), tache: 't2', nom: 'B', profil: null, resultat: 'aucun-compte', detail: null },
    { date: iso(T0), tache: 't1', nom: 'A', profil: 'p1', resultat: 'lancee', detail: null },
    { date: 'pas une date', profil: 'p3', resultat: 'envoye' },
    { date: iso(T0 - 5 * J), profil: 'p3', resultat: 'envoye' },
    null
  ];
  const r = st.resultatsTaches(h, T0 - 2 * H);
  assert.deepEqual(r, [
    { cle: 'p1', envoye: 1, quota: 3, erreur: 0, autre: 0, total: 4, dernierQuota: iso(T0 + 2 * H), heureQuota: null },
    { cle: 'p2', envoye: 0, quota: 0, erreur: 2, autre: 1, total: 3, dernierQuota: null, heureQuota: null }
  ]);
  const r2 = st.resultatsTaches(h.slice(0, 3));
  assert.equal(r2[0].heureQuota, '15:00');
  assert.equal(st.resultatsTaches([{ date: iso(T0), profil: 'b', resultat: 'envoye' }, { date: iso(T0), profil: 'a' }])[0].cle, 'a');
  assert.deepEqual(st.resultatsTaches(undefined), []);
});

test('trierLignes : nombres, textes, sens, égalité départagée par la clé, copie', () => {
  const l = [{ cle: 'b', n: 2, t: 'Zoé' }, { cle: 'a', n: 2, t: 'émile' }, { cle: 'c', n: 5, t: null }];
  assert.deepEqual(st.trierLignes(l, 'n', 'desc').map(x => x.cle), ['c', 'a', 'b']);
  assert.deepEqual(st.trierLignes(l, 'n', 'asc').map(x => x.cle), ['a', 'b', 'c']);
  assert.deepEqual(st.trierLignes(l, 't', 'asc').map(x => x.cle), ['c', 'a', 'b']);
  assert.deepEqual(st.trierLignes(l, null).map(x => x.cle), ['b', 'a', 'c']);
  assert.notEqual(st.trierLignes(l, 'n'), l);
  assert.deepEqual(st.trierLignes(null, 'n'), []);
});
