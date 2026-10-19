'use strict';

// test/stats.test.js — statistiques d'utilisation (issue #206, lot 1,
// lib/stats.js) : suivi des onglets, agrégation, JSONL, persistance.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const st = require('../lib/stats.js');

const H = 60 * 60 * 1000;
const T0 = new Date(2026, 9, 19, 10, 0, 0).getTime(); // 19/10/2026 10:00 locale

function horloge(depart) {
  let t = depart;
  const f = () => t;
  f.avancer = (ms) => { t += ms; };
  return f;
}

function sess(id, profil, service, debut, fin, actifMs) {
  return { id, profil, service, debut, fin, actifMs };
}

// --- Validation -------------------------------------------------------------

test('normaliserSession : valeurs valides, bornes et refus', () => {
  assert.deepEqual(st.normaliserSession(sess('a', 'profil_1', 'claude', T0, T0 + 1000, 400.4)),
    sess('a', 'profil_1', 'claude', T0, T0 + 1000, 400));
  // Profil libre (espaces, accents) accepté.
  assert.equal(st.normaliserSession(sess('a', 'Perso Élodie', 'claude', T0, T0, 0)).profil, 'Perso Élodie');
  // Temps actif borné à la durée, négatif ramené à 0, absent = 0.
  assert.equal(st.normaliserSession(sess('a', 'p', 'claude', T0, T0 + 10, 99)).actifMs, 10);
  assert.equal(st.normaliserSession(sess('a', 'p', 'claude', T0, T0 + 10, -5)).actifMs, 0);
  assert.equal(st.normaliserSession({ id: 'a', profil: 'p', service: 'claude', debut: T0, fin: T0 }).actifMs, 0);
  for (const mauvais of [
    null, 'x',
    sess('', 'p', 'claude', T0, T0, 0), sess(3, 'p', 'claude', T0, T0, 0),
    sess('a', '', 'claude', T0, T0, 0), sess('a', 'p\n', 'claude', T0, T0, 0), sess('a', 4, 'claude', T0, T0, 0),
    sess('a', 'p', 'Claude!', T0, T0, 0), sess('a', 'p', null, T0, T0, 0),
    sess('a', 'p', 'claude', 0, T0, 0), sess('a', 'p', 'claude', T0, T0 - 1, 0),
    sess('a', 'p', 'claude', NaN, T0, 0), sess('a', 'p', 'claude', T0, Infinity, 0)
  ]) assert.strictEqual(st.normaliserSession(mauvais), null, JSON.stringify(mauvais));
});

test('JSONL : aller-retour, lignes abîmées ignorées une à une', () => {
  const a = sess('a', 'p1', 'claude', T0, T0 + H, H / 2);
  const b = sess('b', 'p2', 'gemini', T0, T0 + 2 * H, H);
  const texte = st.versJsonl([a, b]);
  assert.deepEqual(st.parserJsonl(texte), [a, b]);
  assert.deepEqual(st.parserJsonl('{"id":\n' + texte + '\n  \n{"id":"x"}\n'), [a, b]);
  assert.deepEqual(st.parserJsonl(undefined), []);
});

test('purger : 90 jours par défaut, durée explicite', () => {
  const vieux = sess('v', 'p', 'claude', T0 - 100 * 24 * H, T0 - 91 * 24 * H, 0);
  const recent = sess('r', 'p', 'claude', T0 - 2 * H, T0 - H, 0);
  assert.deepEqual(st.purger([vieux, recent], T0), [recent]);
  assert.deepEqual(st.purger([vieux, recent], T0, 365), [vieux, recent]);
});

// --- Suivi des onglets ------------------------------------------------------

test('suivi : temps actif seulement pour l’onglet au premier plan, fenêtre au focus', () => {
  const h = horloge(T0);
  const s = st.creerSuivi({ maintenant: h });
  assert.equal(s.ouvrir('t1', 'p1', 'claude'), true);
  assert.equal(s.ouvrir('t1', 'p1', 'claude'), false, 'pas de double ouverture');
  s.activer('t1');
  h.avancer(10 * 60000);               // t1 actif 10 min
  s.ouvrir('t2', 'p2', 'gemini');
  s.activer('t2');
  h.avancer(5 * 60000);                // t2 actif 5 min
  s.focus(false);
  h.avancer(30 * 60000);               // fenêtre sans focus : rien ne court
  s.focus(true);
  h.avancer(60000);                    // t2 actif 1 min de plus
  assert.equal(s.taille(), 2);
  const inst = s.instantane();
  assert.equal(inst.length, 2);
  assert.equal(inst.find(x => x.profil === 'p2').actifMs, 6 * 60000);
  const r1 = s.fermer('t1');
  assert.equal(r1.profil, 'p1');
  assert.equal(r1.service, 'claude');
  assert.equal(r1.fin - r1.debut, 46 * 60000);
  assert.equal(r1.actifMs, 10 * 60000);
  const r2 = s.fermer('t2');
  assert.equal(r2.actifMs, 6 * 60000);
  assert.equal(r2.fin - r2.debut, 36 * 60000);
  assert.notEqual(r1.id, r2.id);
  assert.strictEqual(s.fermer('t2'), null, 'déjà fermé');
  assert.equal(s.taille(), 0);
});

test('suivi : fermeture de l’onglet actif puis activation d’un onglet inconnu ou nul', () => {
  const h = horloge(T0);
  const s = st.creerSuivi({ maintenant: h, focus: false });
  s.ouvrir('t1', 'p1', 'claude');
  s.activer('t1');
  h.avancer(60000);
  s.focus(true);
  h.avancer(60000);
  assert.equal(s.fermer('t1').actifMs, 60000);
  s.activer('fantome');               // onglet non suivi : aucun segment
  h.avancer(60000);
  s.ouvrir('t2', 'p2', 'claude');
  s.activer();                        // aucun onglet actif
  h.avancer(60000);
  assert.equal(s.fermer('t2').actifMs, 0);
});

test('suivi : horloge par défaut et enregistrement invalide ignoré', () => {
  const s = st.creerSuivi();
  s.ouvrir('t1', '', 'claude');       // profil vide : invalide
  assert.deepEqual(s.instantane(), []);
  assert.strictEqual(s.fermer('t1'), null);
  st.creerSuivi(undefined).activer('x');
});

// --- Agrégation -------------------------------------------------------------

test('debutPeriode : minuit local, 7 et 30 jours glissants, tout', () => {
  assert.equal(st.debutPeriode('jour', T0), new Date(2026, 9, 19).getTime());
  assert.equal(st.debutPeriode('semaine', T0), T0 - 7 * 24 * H);
  assert.equal(st.debutPeriode('mois', T0), T0 - 30 * 24 * H);
  assert.equal(st.debutPeriode('tout', T0), 0);
  assert.deepEqual(st.PERIODES, ['jour', 'semaine', 'mois', 'tout']);
});

test('agreger : totaux, par compte, par service, part et tri', () => {
  const minuit = new Date(2026, 9, 19).getTime();
  const sessions = [
    sess('a', 'p1', 'claude', T0 - 2 * H, T0 - H, 30 * 60000),
    sess('b', 'p1', 'gemini', T0 - H, T0, 10 * 60000),
    sess('c', 'p2', 'claude', T0 - H, T0 - H / 2, 20 * 60000),
    // à cheval sur minuit : 2 h dont 1 h aujourd'hui, actif au prorata
    sess('d', 'p3', 'claude', minuit - H, minuit + H, 40 * 60000),
    // hors période « jour »
    sess('e', 'p4', 'grok', minuit - 3 * H, minuit - 2 * H, 50 * 60000)
  ];
  const r = st.agreger(sessions, { periode: 'jour', maintenant: T0 });
  assert.equal(r.depuis, minuit);
  assert.deepEqual(r.totaux, { sessions: 4, dureeMs: 3.5 * H, actifMs: 80 * 60000 });
  assert.deepEqual(r.parCompte.map(l => [l.cle, l.sessions, l.actifMs]),
    [['p1', 2, 40 * 60000], ['p3', 1, 20 * 60000], ['p2', 1, 20 * 60000]]);
  assert.equal(r.parCompte[0].dernier, T0);
  assert.deepEqual(r.parService.map(l => [l.cle, l.actifMs]),
    [['claude', 70 * 60000], ['gemini', 10 * 60000]]);
  assert.equal(r.parService[0].part, 70 / 80);
  const tout = st.agreger(sessions, { periode: 'tout', maintenant: T0 });
  assert.equal(tout.totaux.sessions, 5);
  assert.equal(tout.parCompte[0].cle, 'p4');
});

test('agreger : tri stable à égalité, entrées vides, session instantanée', () => {
  const r = st.agreger([
    sess('a', 'zz', 'claude', T0, T0 + 1000, 0),
    sess('b', 'aa', 'claude', T0, T0 + 1000, 0),
    sess('c', 'mm', 'claude', T0, T0 + 2000, 0),
    sess('d', 'aa', 'gemini', T0, T0 + 1000, 0),
    sess('e', 'zz', 'gemini', T0 + 5000, T0 + 5000, 0) // durée nulle
  ], { periode: 'tout', maintenant: T0 + 10000 });
  assert.deepEqual(r.parCompte.map(l => l.cle), ['aa', 'mm', 'zz']);
  assert.deepEqual(r.parService.map(l => l.part), [0, 0]);
  const vide = st.agreger(null);
  assert.deepEqual(vide.totaux, { sessions: 0, dureeMs: 0, actifMs: 0 });
  assert.deepEqual(st.agreger([], undefined).parCompte, []);
  // Session de durée nulle terminée dans la période : comptée.
  const borne = st.agreger([sess('z', 'p', 'claude', T0 - 1, T0 - 1, 0)], { periode: 'semaine', maintenant: T0 });
  assert.equal(borne.totaux.sessions, 1);
});

test('agreger : session à cheval sur la borne -> temps actif au prorata', () => {
  const depuis = st.debutPeriode('semaine', T0);
  const r = st.agreger([sess('z', 'p', 'claude', depuis - 1000, depuis + 1000, 2000)],
    { periode: 'semaine', maintenant: T0 });
  assert.deepEqual(r.totaux, { sessions: 1, dureeMs: 1000, actifMs: 1000 });
});

test('decomposerDuree', () => {
  assert.deepEqual(st.decomposerDuree(0), { heures: 0, minutes: 0 });
  assert.deepEqual(st.decomposerDuree(59999), { heures: 0, minutes: 0 });
  assert.deepEqual(st.decomposerDuree(3 * H + 5 * 60000 + 30000), { heures: 3, minutes: 5 });
  assert.deepEqual(st.decomposerDuree(-1), { heures: 0, minutes: 0 });
  assert.deepEqual(st.decomposerDuree(NaN), { heures: 0, minutes: 0 });
});

// --- Persistance -------------------------------------------------------------

function dossierTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'iao-stats-'));
}

test('store : sync puis charger, sessions en cours conservées à part', async () => {
  const racine = dossierTemp();
  const dossier = path.join(racine, 'stats');
  const store = st.creerStore({ dossier, fs: fs.promises, path, maintenant: () => T0 });
  const a = sess('a', 'p1', 'claude', T0 - H, T0, 1000);
  const ouverte = sess('o', 'p2', 'claude', T0 - H, T0, 2000);
  assert.deepEqual(await store.sync([a, { id: 'invalide' }], [ouverte, null]),
    { ok: true, terminees: 1, enCours: 1, interrompues: 0 });
  assert.deepEqual(await store.charger(), [a]);
  assert.deepEqual(JSON.parse(fs.readFileSync(store.fichierEnCours, 'utf-8')), [ouverte]);
  // Fermeture normale : la session passe de en-cours à terminées, comptée une fois.
  const fermee = Object.assign({}, ouverte, { fin: T0 + 1000 });
  assert.deepEqual(await store.sync([fermee], []), { ok: true, terminees: 1, enCours: 0, interrompues: 0 });
  assert.deepEqual(await store.charger(), [a, fermee]);
  // Entrées non tableaux : rien d'ajouté, en-cours vidé.
  assert.deepEqual(await store.sync(null, undefined), { ok: true, terminees: 0, enCours: 0, interrompues: 0 });
  assert.deepEqual(await store.charger(), [a, fermee]);
});

test('store : page rechargée -> sessions disparues de l’instantané versées à l’historique', async () => {
  const dossier = path.join(dossierTemp(), 'stats');
  const store = st.creerStore({ dossier, fs: fs.promises, path, maintenant: () => T0 });
  const x = sess('x', 'p', 'claude', T0 - H, T0 - 1000, 10);
  const y = sess('y', 'p', 'gemini', T0 - H, T0 - 1000, 20);
  await store.sync([], [x, y]);
  // Après rechargement, le nouveau renderer ne connaît que sa nouvelle session z.
  const z = sess('z', 'p', 'claude', T0 - 500, T0, 0);
  const r = await store.sync([], [z]);
  assert.equal(r.interrompues, 2);
  assert.deepEqual(await store.charger(), [x, y]);
  // Une mise à jour de z (même id) n'est pas une interruption.
  assert.equal((await store.sync([], [Object.assign({}, z, { fin: T0 + 1 })])).interrompues, 0);
});

test('store : au lancement suivant, sessions interrompues récupérées une fois, dédoublonnées, purge', async () => {
  const dossier = path.join(dossierTemp(), 'stats');
  fs.mkdirSync(dossier, { recursive: true });
  const vieux = sess('v', 'p', 'claude', T0 - 100 * 24 * H, T0 - 95 * 24 * H, 0);
  const deja = sess('d', 'p', 'claude', T0 - 2 * H, T0 - H, 0);
  fs.writeFileSync(path.join(dossier, 'sessions.jsonl'), st.versJsonl([vieux, deja]));
  const interrompue = sess('i', 'p', 'gemini', T0 - H, T0 - 60000, 5000);
  fs.writeFileSync(path.join(dossier, 'en-cours.json'), JSON.stringify([deja, interrompue, { x: 1 }]));
  const store = st.creerStore({ dossier, fs: fs.promises, path, maintenant: () => T0 });
  assert.deepEqual(await store.charger(), [deja, interrompue]);
  assert.equal(fs.readFileSync(path.join(dossier, 'en-cours.json'), 'utf-8'), '[]');
  // Le fichier a été réécrit sans la session trop ancienne.
  assert.deepEqual(st.parserJsonl(fs.readFileSync(path.join(dossier, 'sessions.jsonl'), 'utf-8')), [deja, interrompue]);
  assert.deepEqual(await store.charger(), [deja, interrompue], 'récupération faite une seule fois');
});

test('store : en-cours illisible ou non tableau, historique inchangé non réécrit', async () => {
  const dossier = path.join(dossierTemp(), 'stats');
  fs.mkdirSync(dossier, { recursive: true });
  const a = sess('a', 'p', 'claude', T0 - H, T0, 0);
  fs.writeFileSync(path.join(dossier, 'sessions.jsonl'), st.versJsonl([a]));
  fs.writeFileSync(path.join(dossier, 'en-cours.json'), '{"pas":"un tableau"}');
  const ecritures = [];
  const fsEspion = Object.assign({}, fs.promises, {
    writeFile: (f, ...r) => { ecritures.push(path.basename(f)); return fs.promises.writeFile(f, ...r); }
  });
  const store = st.creerStore({ dossier, fs: fsEspion, path, maintenant: () => T0 });
  assert.deepEqual(await store.charger(), [a]);
  assert.deepEqual(ecritures, ['en-cours.json'], 'historique non réécrit');
  const store2 = st.creerStore({ dossier, fs: fs.promises, path });
  fs.writeFileSync(path.join(dossier, 'en-cours.json'), 'abîmé');
  assert.equal((await store2.charger()).length, 1);
});

test('registerStatsIPC : canaux enregistrés, erreurs renvoyées sans exception', async () => {
  const handlers = new Map();
  const ipc = { handle: (c, fn) => handlers.set(c, fn) };
  const appels = [];
  st.registerStatsIPC(ipc, {
    sync: async (t, e) => { appels.push([t, e]); return { ok: true }; },
    charger: async () => { throw new Error('disque plein'); }
  });
  assert.deepEqual([...handlers.keys()], ['stats:sync', 'stats:load', 'stats:reset', 'stats:export']);
  assert.deepEqual(await handlers.get('stats:sync')({}, [1], [2]), { ok: true });
  assert.deepEqual(appels, [[[1], [2]]]);
  assert.deepEqual(await handlers.get('stats:load')({}), { error: 'disque plein' });
  st.registerStatsIPC(ipc, { charger: async () => { throw 'brut'; }, sync: async () => 0 });
  assert.deepEqual(await handlers.get('stats:load')({}), { error: 'brut' });
});

test('stats s’attache à window dans le renderer', () => {
  const chemin = require.resolve('../lib/stats.js');
  const avant = global.window;
  global.window = {};
  try {
    delete require.cache[chemin];
    require(chemin);
    assert.equal(typeof global.window.iaoStats.creerSuivi, 'function');
  } finally {
    if (avant === undefined) delete global.window; else global.window = avant;
    delete require.cache[chemin];
  }
});

test('agreger : égalité parfaite -> ordre alphabétique, quel que soit l’ordre d’entrée', () => {
  const x = sess('1', 'b', 'claude', T0, T0 + 1000, 0);
  const y = sess('2', 'a', 'claude', T0, T0 + 1000, 0);
  for (const entree of [[x, y], [y, x]]) {
    assert.deepEqual(st.agreger(entree, { periode: 'tout', maintenant: T0 }).parCompte.map(l => l.cle), ['a', 'b']);
  }
});
