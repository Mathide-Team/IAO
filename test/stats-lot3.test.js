'use strict';

// test/stats-lot3.test.js — statistiques, lot 3 de l'issue #206 :
// évolution, géométrie de l'histogramme, export CSV/JSON, remise à zéro.

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
const ses = (id, profil, debut, fin, actifMs, service) => ({ id, profil, service: service || 'claude', debut, fin, actifMs });

test('tranchesEvolution : 24 heures aujourd\'hui, 7 / 30 / 90 jours locaux', () => {
  const jour = st.tranchesEvolution('jour', T0);
  assert.equal(jour.length, 24);
  assert.equal(jour[0].debut, new Date(2026, 9, 19).getTime());
  assert.equal(jour[23].fin, new Date(2026, 9, 20).getTime());
  const semaine = st.tranchesEvolution('semaine', T0);
  assert.equal(semaine.length, 7);
  assert.equal(semaine[0].debut, new Date(2026, 9, 13).getTime());
  assert.equal(semaine[6].fin, new Date(2026, 9, 20).getTime());
  assert.equal(st.tranchesEvolution('mois', T0).length, 30);
  const tout = st.tranchesEvolution('tout', T0);
  assert.equal(tout.length, 90);
  // Changement d'heure (25/10/2026) : la tranche dure 25 h, pas de décalage.
  assert.ok(tout.every((t, i) => i === 0 || t.debut === tout[i - 1].fin));
});

test('evolution : sessions réparties au prorata entre tranches, hors période ignorées', () => {
  const r = st.evolution([
    ses('a', 'p', T0 + 30 * MIN, T0 + 90 * MIN, 30 * MIN), // 10:30 -> 11:30
    ses('b', 'p', T0 - 3 * J, T0 - 3 * J + H, H),           // hors « jour »
    ses('z', 'p', T0, T0, 0)                                  // durée nulle
  ], { periode: 'jour', maintenant: T0 + 2 * H });
  assert.equal(r[10].dureeMs, 30 * MIN);
  assert.equal(r[10].actifMs, 15 * MIN);
  assert.equal(r[11].actifMs, 15 * MIN);
  assert.equal(r.reduce((a, t) => a + t.dureeMs, 0), H);
  const sem = st.evolution([ses('b', 'p', T0 - 3 * J, T0 - 3 * J + H, H)], { periode: 'semaine', maintenant: T0 });
  assert.equal(sem[3].actifMs, H);
  assert.equal(st.evolution(null, { periode: 'semaine' }).length, 7);
  assert.equal(st.evolution(undefined).length, 90);
});

test('grandeurRonde : graduation au-dessus du maximum', () => {
  assert.equal(st.grandeurRonde(0), MIN);
  assert.equal(st.grandeurRonde(3 * MIN), 5 * MIN);
  assert.equal(st.grandeurRonde(50 * MIN), H);
  assert.equal(st.grandeurRonde(13 * H), 24 * H);
  assert.equal(st.grandeurRonde(30 * H), 48 * H);
});

test('geometrieBarres : rectangles proportionnels, valeurs invalides à zéro, options', () => {
  const g = st.geometrieBarres([0, 30 * MIN, 60 * MIN, -5, NaN], { largeur: 100, hauteur: 50, ecart: 0 });
  assert.equal(g.echelle, H);
  assert.deepEqual(g.barres.map(b => b.hauteur), [0, 25, 50, 0, 0]);
  assert.deepEqual(g.barres.map(b => b.x), [0, 20, 40, 60, 80]);
  assert.equal(g.barres[2].y, 0);
  assert.equal(g.barres[0].largeur, 20);
  const d = st.geometrieBarres([MIN]);
  assert.equal(d.barres[0].largeur, 598);
  assert.equal(d.barres[0].x, 1);
  assert.equal(st.geometrieBarres(null).barres.length, 0);
  assert.equal(st.geometrieBarres(new Array(1000).fill(MIN), { largeur: 100 }).barres[0].largeur, 1);
});

test('celluleCsv : guillemets, virgules, retours ligne, formules neutralisées', () => {
  assert.equal(st.celluleCsv('simple'), 'simple');
  assert.equal(st.celluleCsv(null), '');
  assert.equal(st.celluleCsv(undefined), '');
  assert.equal(st.celluleCsv(42), '42');
  assert.equal(st.celluleCsv('a,b'), '"a,b"');
  assert.equal(st.celluleCsv('dit "oui"'), '"dit ""oui"""');
  assert.equal(st.celluleCsv('l1\nl2'), '"l1\nl2"');
  assert.equal(st.celluleCsv('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"');
  assert.equal(st.celluleCsv('+1'), "'+1");
  assert.equal(st.celluleCsv('-1'), "'-1");
  assert.equal(st.celluleCsv('@a'), "'@a");
});

test('versCsv : BOM, en-tête, tri chronologique, nom du compte, invalides ignorées', () => {
  const csv = st.versCsv([
    ses('b', 'p2', T0 + H, T0 + 2 * H, 30 * MIN, 'gemini'),
    ses('a', 'p1', T0, T0 + 90 * 1000, 61 * 1000),
    { id: 'invalide' }
  ], { p1: 'Compte, Un', p2: 42 });
  assert.ok(csv.startsWith('\ufeffid,compte,profil,service,debut,fin,duree_s,actif_s\r\n'));
  const lignes = csv.slice(1).trim().split('\r\n');
  assert.equal(lignes.length, 3);
  assert.equal(lignes[1], `a,"Compte, Un",p1,claude,${new Date(T0).toISOString()},${new Date(T0 + 90000).toISOString()},90,61`);
  assert.ok(lignes[2].startsWith('b,p2,p2,gemini,'), 'nom non textuel -> profil');
  assert.equal(st.versCsv(null, null), '\ufeffid,compte,profil,service,debut,fin,duree_s,actif_s\r\n');
});

test('versJsonExport : enveloppe versionnée, sessions lisibles', () => {
  const j = JSON.parse(st.versJsonExport([ses('a', 'p1', T0, T0 + H, H)], { p1: 'Un' }, T0));
  assert.equal(j.application, 'IAO');
  assert.equal(j.format, 'iao-stats-1');
  assert.equal(j.exporte, new Date(T0).toISOString());
  assert.deepEqual(j.sessions[0], { id: 'a', compte: 'Un', profil: 'p1', service: 'claude',
    debut: new Date(T0).toISOString(), fin: new Date(T0 + H).toISOString(), duree_s: 3600, actif_s: 3600 });
});

test('suivi.recommencer : les onglets ouverts repartent de maintenant avec un nouvel id', () => {
  let t = T0;
  const suivi = st.creerSuivi({ maintenant: () => t });
  suivi.ouvrir('o1', 'p1', 'claude');
  suivi.activer('o1');
  t += H;
  const avant = suivi.instantane()[0];
  assert.equal(avant.actifMs, H);
  suivi.recommencer();
  t += 10 * MIN;
  const apres = suivi.instantane()[0];
  assert.notEqual(apres.id, avant.id);
  assert.equal(apres.debut, T0 + H);
  assert.equal(apres.actifMs, 10 * MIN);
});

test('store : reinitialiser vide l\'historique et l\'instantané ; exporter CSV et JSON', async () => {
  const dossier = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'iao-stats3-')), 'stats');
  const store = st.creerStore({ dossier, fs: fs.promises, path, maintenant: () => T0 });
  await store.sync([ses('a', 'p1', T0 - H, T0 - 30 * MIN, 10 * MIN)], [ses('b', 'p1', T0 - 10 * MIN, T0, 0)]);
  const csv = await store.exporter('csv', [ses('c', 'p2', T0 - MIN, T0, 0)], { p1: 'Un' });
  assert.equal(csv.nom, 'iao-statistiques-' + new Date(T0).toISOString().slice(0, 10) + '.csv');
  assert.equal(csv.contenu.trim().split('\r\n').length, 3, 'en-tête + historique + en cours');
  assert.ok(csv.contenu.includes(',Un,p1,'));
  const json = await store.exporter('json', null, null);
  assert.ok(json.nom.endsWith('.json'));
  assert.equal(JSON.parse(json.contenu).sessions.length, 1);
  const cible = path.join(dossier, 'sortie.csv');
  await store.ecrire(cible, csv.contenu);
  assert.equal(fs.readFileSync(cible, 'utf-8'), csv.contenu);
  assert.deepEqual(await store.reinitialiser(), { ok: true });
  assert.deepEqual(await store.charger(), []);
  assert.equal(fs.readFileSync(store.fichierEnCours, 'utf-8'), '[]');
  // Après la remise à zéro, une session disparue de l'instantané précédent
  // n'est pas reversée dans l'historique.
  await store.sync([], []);
  assert.deepEqual(await store.charger(), []);
});

test('stats:reset et stats:export : canal, format, annulation, dialogue absent, erreur', async () => {
  const handlers = new Map();
  const ipc = { handle: (c, fn) => handlers.set(c, fn) };
  const ecrits = [];
  const formats = [];
  const store = {
    sync: async () => ({}), charger: async () => [],
    reinitialiser: async () => ({ ok: true }),
    exporter: async (f, e, n) => { formats.push([f, e, n]); return { nom: 'x.' + f, contenu: 'C' }; },
    ecrire: async (c, x) => { ecrits.push([c, x]); }
  };
  let reponse = '/tmp/x.csv';
  const demandes = [];
  st.registerStatsIPC(ipc, store, { choisirFichier: async (nom, f) => { demandes.push([nom, f]); return reponse; } });
  assert.deepEqual(await handlers.get('stats:reset')({}), { ok: true });
  assert.deepEqual(await handlers.get('stats:export')({}, 'csv', [1], { p: 'n' }), { ok: true, chemin: '/tmp/x.csv' });
  assert.deepEqual(ecrits, [['/tmp/x.csv', 'C']]);
  await handlers.get('stats:export')({}, 'json');
  await handlers.get('stats:export')({}, 'exe');
  assert.deepEqual(formats.map(f => f[0]), ['csv', 'json', 'csv'], 'format inconnu -> csv');
  assert.deepEqual(demandes[1], ['x.json', 'json']);
  reponse = null;
  assert.deepEqual(await handlers.get('stats:export')({}, 'csv'), { canceled: true });
  st.registerStatsIPC(ipc, store);
  assert.deepEqual(await handlers.get('stats:export')({}, 'csv'), { error: 'export_indisponible' });
  st.registerStatsIPC(ipc, Object.assign({}, store, { exporter: async () => { throw new Error('disque'); } }), { choisirFichier: async () => 'x' });
  assert.deepEqual(await handlers.get('stats:export')({}, 'csv'), { error: 'disque' });
});
