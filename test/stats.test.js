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
    charger: async () => { throw new Error('disque plein'); },
    // Lot 2 : les nouveaux canaux doivent exister (les erreurs sont renvoyées).
    noterReponse: async () => { throw new Error('reponse'); },
    noterQuota: async () => { throw new Error('quota'); },
    chargerReponses: async () => { throw new Error('reponses'); },
    chargerQuotas: async () => { throw new Error('quotas'); }
  });
  assert.deepEqual([...handlers.keys()], ['stats:sync', 'stats:load',
    'stats:noter-reponse', 'stats:noter-quota', 'stats:reponses', 'stats:quotas', 'stats:reset', 'stats:export']);
  assert.deepEqual(await handlers.get('stats:noter-reponse')({}, {}), { error: 'reponse' });
  assert.deepEqual(await handlers.get('stats:noter-quota')({}, {}), { error: 'quota' });
  assert.deepEqual(await handlers.get('stats:reponses')({}), { error: 'reponses' });
  assert.deepEqual(await handlers.get('stats:quotas')({}), { error: 'quotas' });
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

// --- Lot 2 : temps de réponse, quotas, heures de pointe, classification -------

function rep(id, profil, service, debut, fin) {
  return { id, profil, service, debut, fin };
}
function quo(id, profil, service, date) {
  return { id, profil, service, date };
}

test('normaliserReponse : valides, bornes (24 h) et refus', () => {
  assert.deepEqual(st.normaliserReponse(rep('a', 'p1', 'claude', T0, T0 + 45000)),
    rep('a', 'p1', 'claude', T0, T0 + 45000));
  assert.strictEqual(st.normaliserReponse(rep('a', 'p', 'claude', T0, T0 + 25 * 24 * H)), null); // > 24 h
  assert.strictEqual(st.normaliserReponse(rep('a', 'p', 'claude', T0, T0)), null); // durée nulle
  assert.strictEqual(st.normaliserReponse(rep('a', 'p', 'claude', T0, T0 - 1)), null); // fin < début
  assert.strictEqual(st.normaliserReponse(rep('', 'p', 'claude', T0, T0 + 1)), null);
  assert.strictEqual(st.normaliserReponse(rep('a', 'p\n', 'claude', T0, T0 + 1)), null);
  assert.strictEqual(st.normaliserReponse(rep('a', 'p', 'Claude!', T0, T0 + 1)), null);
  assert.strictEqual(st.normaliserReponse(null), null);
  assert.strictEqual(st.normaliserReponse(rep('a', 'p', 'claude', NaN, T0 + 1)), null);
  assert.strictEqual(st.normaliserReponse(rep('a', 'p', 'claude', 0, T0 + 1)), null); // debut <= 0
  assert.strictEqual(st.normaliserReponse(rep('a', 'p', 'claude', -5, T0 + 1)), null);
});

test('normaliserQuota : valides et refus', () => {
  assert.deepEqual(st.normaliserQuota(quo('a', 'p1', 'claude', T0)), quo('a', 'p1', 'claude', T0));
  assert.strictEqual(st.normaliserQuota(quo('a', 'p', 'claude', 0)), null);
  assert.strictEqual(st.normaliserQuota(quo('a', 'p', 'claude', -5)), null);
  assert.strictEqual(st.normaliserQuota(quo('', 'p', 'claude', T0)), null);
  assert.strictEqual(st.normaliserQuota(quo('a', 'p', 'chatgpt', NaN)), null);
  assert.strictEqual(st.normaliserQuota(null), null);
  assert.strictEqual(st.normaliserQuota(quo('a', 4, 'claude', T0)), null); // profil non chaîne
  assert.strictEqual(st.normaliserQuota(quo('a', 'p\n', 'claude', T0)), null); // profil invalide
  assert.strictEqual(st.normaliserQuota(quo('a', 'p', 'Claude!', T0)), null); // service invalide
});

test('mediane : listes impaires, paires, vides', () => {
  assert.strictEqual(st.mediane([1, 2, 3]), 2);
  assert.strictEqual(st.mediane([1, 2, 3, 4]), 3); // (2+3)/2 arrondi
  assert.strictEqual(st.mediane([10]), 10);
  assert.strictEqual(st.mediane([]), 0);
});

test('agregerReponses : médiane/min/max par compte et service, période', () => {
  const rs = [
    rep('a', 'p1', 'claude', T0, T0 + 10000),
    rep('b', 'p1', 'claude', T0, T0 + 30000),
    rep('c', 'p2', 'claude', T0, T0 + 20000),
    rep('d', 'p2', 'chatgpt', T0, T0 + 5000)
  ];
  const r = st.agregerReponses(rs, { maintenant: T0 + 60000 });
  assert.strictEqual(r.totaux.nombre, 4);
  assert.strictEqual(r.totaux.minMs, 5000);
  assert.strictEqual(r.totaux.maxMs, 30000);
  assert.strictEqual(r.totaux.medianeMs, 15000); // trié : 5,10,20,30 -> (10+20)/2
  const p1c = r.parCompteService.find(l => l.profil === 'p1' && l.service === 'claude');
  assert.strictEqual(p1c.nombre, 2);
  assert.strictEqual(p1c.medianeMs, 20000); // (10+30)/2
  assert.strictEqual(p1c.minMs, 10000);
  assert.strictEqual(p1c.maxMs, 30000);
  // Tri par nombre décroissant (p1-claude et p2 ont... p1-claude a 2,
  // les autres 1) ; à nombre égal, par profil croissant.
  assert.strictEqual(r.parCompteService[0].profil, 'p1');
  assert.strictEqual(r.parCompteService[0].nombre, 2);
  // Période « jour » : tout est récent -> inclus ; événement ancien exclu.
  const anciens = st.agregerReponses(
    [rep('v', 'p', 'claude', T0 - 8 * 24 * H, T0 - 8 * 24 * H + 1000)],
    { maintenant: T0, periode: 'semaine' });
  assert.strictEqual(anciens.totaux.nombre, 0);
  // Entrées non tableau / vides.
  assert.strictEqual(st.agregerReponses(null).totaux.nombre, 0);
});

test('agregerQuotas : nombre et répartition par heure locale', () => {
  const qs = [
    quo('a', 'p1', 'claude', new Date(2026, 9, 19, 9, 30).getTime()),
    quo('b', 'p1', 'claude', new Date(2026, 9, 19, 9, 45).getTime()),
    quo('c', 'p1', 'claude', new Date(2026, 9, 19, 18, 10).getTime()),
    quo('d', 'p2', 'claude', new Date(2026, 9, 18, 22, 0).getTime())
  ];
  const r = st.agregerQuotas(qs, { maintenant: T0 });
  const p1 = r.parCompteService.find(l => l.profil === 'p1');
  assert.strictEqual(p1.nombre, 3);
  assert.strictEqual(p1.parHeure[9], 2);
  assert.strictEqual(p1.parHeure[18], 1);
  assert.strictEqual(p1.parHeure.reduce((a, b) => a + b, 0), 3);
  assert.strictEqual(r.parCompteService.length, 2);
  // Période : événement trop ancien exclu.
  const vieux = st.agregerQuotas([quo('v', 'p', 'claude', T0 - 8 * 24 * H)], { maintenant: T0, periode: 'semaine' });
  assert.strictEqual(vieux.parCompteService.length, 0);
});


test('classerComptes : sous-utilisés et surchargés, seuils', () => {
  const sessions = [
    sess('a', 'rare', 'claude', T0 - H, T0, 1000),
    sess('b', 'souvent', 'claude', T0 - H, T0, 1000),
    sess('c', 'souvent', 'claude', T0 - H, T0, 1000),
    sess('d', 'souvent', 'claude', T0 - H, T0, 1000)
  ];
  const quotas = [
    quo('q1', 'souvent', 'claude', T0 - H),
    quo('q2', 'souvent', 'claude', T0 - H / 2),
    quo('q3', 'souvent', 'claude', T0 - H / 3)
  ];
  const r = st.classerComptes(sessions, quotas, { maintenant: T0 });
  assert.deepEqual(r.sousUtilises, ['rare']); // <= 2 sessions
  assert.deepEqual(r.surcharges, ['souvent']); // >= 3 quotas
  // Seuils personnalisés.
  // Seuil 0 : aucun profil n'a 0 session -> personne de sous-utilisé ;
  // seuil quotas 10 : personne de surchargé.
  const r2 = st.classerComptes(sessions, quotas, { maintenant: T0, seuilSessions: 0, seuilQuotas: 10 });
  assert.deepEqual(r2.sousUtilises, []);
  assert.deepEqual(r2.surcharges, []);
});

test('store lot 2 : noter/charger temps de réponse et quotas, purge, plafond', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-stats2-'));
  try {
    const store = st.creerStore({ dossier, fs: fs.promises, path, maintenant: () => T0 });
    assert.deepEqual(await store.noterReponse({ profil: 'p1', service: 'claude', debut: T0 - 30000, fin: T0 - 5000 }),
      { ok: true });
    assert.deepEqual(await store.noterQuota({ profil: 'p1', service: 'claude', date: T0 - 60000 }),
      { ok: true });
    // Événement invalide refusé, rien d'écrit.
    assert.ok((await store.noterReponse({ profil: 'p1', service: 'claude', debut: T0, fin: T0 - 1 })).ok === false);
    const reponses = await store.chargerReponses();
    assert.strictEqual(reponses.length, 1);
    assert.strictEqual(reponses[0].profil, 'p1');
    assert.ok(/^r[a-z0-9]+-/.test(reponses[0].id), 'id préfixé r : ' + reponses[0].id);
    const quotas = await store.chargerQuotas();
    assert.strictEqual(quotas.length, 1);
    assert.ok(/^q[a-z0-9]+-/.test(quotas[0].id));
    // Les fichiers sont distincts de sessions.jsonl.
    assert.strictEqual(fs.existsSync(path.join(dossier, 'reponses.jsonl')), true);
    assert.strictEqual(fs.existsSync(path.join(dossier, 'quotas.jsonl')), true);
    // Purge : un événement plus vieux que 90 jours disparaît au chargement.
    const storeVieux = st.creerStore({ dossier, fs: fs.promises, path,
      maintenant: () => T0 + 91 * 24 * H });
    assert.strictEqual((await storeVieux.chargerReponses()).length, 0);
    assert.strictEqual((await storeVieux.chargerQuotas()).length, 0);
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});

test('store lot 2 : plafond d’événements (maxEvenements injectable)', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-stats2b-'));
  try {
    const store = st.creerStore({ dossier, fs: fs.promises, path, maintenant: () => T0, maxEvenements: 2 });
    for (let i = 0; i < 4; i++) {
      await store.noterReponse({ profil: 'p' + i, service: 'claude', debut: T0 - 60000, fin: T0 - 1000 });
    }
    const reponses = await store.chargerReponses();
    assert.strictEqual(reponses.length, 2, 'plafonné à 2 événements');
    assert.strictEqual(reponses[0].profil, 'p2', 'les plus anciens sont jetés');
    assert.strictEqual(reponses[1].profil, 'p3');
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});

test('store lot 2 : écritures concurrentes sérialisées — aucun événement perdu', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-stats2c-'));
  try {
    const store = st.creerStore({ dossier, fs: fs.promises, path, maintenant: () => T0, maxEvenements: 1000 });
    // 12 quotas + 12 réponses notés SIMULTANÉMENT : sans sérialisation, des
    // lectures concurrentes du même historique s'écrasent mutuellement et des
    // événements disparaissent. (Profils distincts : la déduplication
    // d'épisodes de quota ne doit pas interférer avec ce test.)
    const proms = [];
    for (let i = 0; i < 12; i++) {
      proms.push(store.noterQuota({ profil: 'p' + i, service: 'claude', date: T0 - i * 1000 }));
      proms.push(store.noterReponse({ profil: 'p' + i, service: 'claude', debut: T0 - 60000, fin: T0 - i }));
    }
    const res = await Promise.all(proms);
    assert.ok(res.every(r => r && r.ok), 'toutes les notations réussissent');
    const quotas = await store.chargerQuotas();
    const reponses = await store.chargerReponses();
    assert.strictEqual(quotas.length, 12, 'aucun événement quota perdu');
    assert.strictEqual(reponses.length, 12, 'aucun événement réponse perdu');
    // Relecture brute du disque : les événements ont réellement survécu.
    const brutQ = fs.readFileSync(path.join(dossier, 'quotas.jsonl'), 'utf-8').trim().split('\n');
    const brutR = fs.readFileSync(path.join(dossier, 'reponses.jsonl'), 'utf-8').trim().split('\n');
    assert.strictEqual(brutQ.length, 12);
    assert.strictEqual(brutR.length, 12);
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});

test('store lot 2 : épisodes de quota dédupliqués (1 par compte et par heure)', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-stats2d-'));
  try {
    const store = st.creerStore({ dossier, fs: fs.promises, path, maintenant: () => T0 });
    assert.deepEqual(await store.noterQuota({ profil: 'p1', service: 'claude', date: T0 }), { ok: true });
    // Re-détection 30 min plus tard : même blocage (boucle wait_quota) -> ignorée.
    assert.deepEqual(await store.noterQuota({ profil: 'p1', service: 'claude', date: T0 + 30 * 60 * 1000 }),
      { ok: true, dedup: true });
    // Un autre compte n'est jamais dédupliqué.
    assert.deepEqual(await store.noterQuota({ profil: 'p2', service: 'claude', date: T0 + 30 * 60 * 1000 }), { ok: true });
    // Deux heures plus tard pour le même compte : nouvel épisode, noté.
    assert.deepEqual(await store.noterQuota({ profil: 'p1', service: 'claude', date: T0 + 2 * H }), { ok: true });
    const quotas = await store.chargerQuotas();
    assert.strictEqual(quotas.length, 3, '3 épisodes distincts, la re-détection ne compte pas');
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});

test('store lot 2 : purge 90 jours PERSISTÉE — le fichier est réécrit', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-stats2e-'));
  try {
    fs.mkdirSync(dossier, { recursive: true });
    // Fichier écrit DIRECTEMENT (la notation purge déjà à l'écriture) : un
    // événement expiré et un valide.
    const ligne = (id, profil, date) => JSON.stringify({ id, profil, service: 'claude', date });
    fs.writeFileSync(path.join(dossier, 'quotas.jsonl'),
      [ligne('q1', 'p1', T0 - 91 * 24 * H), ligne('q2', 'p2', T0 - 60 * 1000)].join('\n') + '\n');
    const store = st.creerStore({ dossier, fs: fs.promises, path, maintenant: () => T0 });
    const quotas = await store.chargerQuotas();
    assert.strictEqual(quotas.length, 1, 'seul l\'événement non expiré est renvoyé');
    // L'événement expiré est retiré DU FICHIER (pas seulement du résultat) :
    // la « conservation 90 jours » tient même sans nouvelle notation.
    const brut = fs.readFileSync(path.join(dossier, 'quotas.jsonl'), 'utf-8');
    assert.ok(!brut.includes('"p1"'), 'l\'événement expiré est physiquement purgé');
    assert.ok(brut.includes('"p2"'), 'l\'événement récent est conservé');
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});

test('store lot 2 : un échec d\'écriture n\'empoisonne pas la chaîne (réessai)', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-stats2f-'));
  try {
    let ecritures = 0;
    const fsFragile = Object.assign({}, fs.promises, {
      writeFile: (f, ...r) => {
        ecritures++;
        // La première écriture d'en-cours.json (récupération) échoue.
        if (f.endsWith('en-cours.json') && ecritures === 1) {
          return Promise.reject(new Error('disque plein (test)'));
        }
        return fs.promises.writeFile(f, ...r);
      }
    });
    const store = st.creerStore({ dossier, fs: fsFragile, path, maintenant: () => T0 });
    // Première notation : la récupération échoue -> la notation est rejetée.
    await assert.rejects(store.noterReponse({ profil: 'p1', service: 'claude', debut: T0 - 1000, fin: T0 }),
      /disque plein/);
    // La chaîne n'est PAS empoisonnée : l'appel suivant réessaie (la
    // récupération n'est pas mémoïsée sur son rejet) et réussit.
    assert.deepEqual(await store.noterReponse({ profil: 'p1', service: 'claude', debut: T0 - 1000, fin: T0 }),
      { ok: true });
    assert.strictEqual((await store.chargerReponses()).length, 1);
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});

test('store lot 2 : une erreur de lecture n\'est PAS une absence (pas de perte)', async () => {
  const dossier = fs.mkdtempSync(path.join(os.tmpdir(), 'iao-stats2g-'));
  try {
    // Un événement valide déjà sur disque.
    fs.mkdirSync(dossier, { recursive: true });
    fs.writeFileSync(path.join(dossier, 'quotas.jsonl'),
      JSON.stringify({ id: 'q1', profil: 'p1', service: 'claude', date: T0 - 60000 }) + '\n');
    let lecturesQuotas = 0;
    const fsFragile = Object.assign({}, fs.promises, {
      readFile: (f, ...r) => {
        if (f.endsWith('quotas.jsonl')) {
          lecturesQuotas++;
          // Première lecture de quotas.jsonl : erreur transitoire (EIO).
          if (lecturesQuotas === 1) {
            const e = new Error('EIO (test)'); e.code = 'EIO';
            return Promise.reject(e);
          }
        }
        return fs.promises.readFile(f, ...r);
      }
    });
    const store = st.creerStore({ dossier, fs: fsFragile, path, maintenant: () => T0 });
    // La notation échoue (lecture impossible) et le fichier reste INTACT :
    // sans la propagation de l'erreur, une lecture EIO vaudrait « historique
    // vide » et la réécriture détruirait l'événement existant.
    await assert.rejects(store.noterQuota({ profil: 'p2', service: 'claude', date: T0 }), /EIO/);
    const brut = fs.readFileSync(path.join(dossier, 'quotas.jsonl'), 'utf-8');
    assert.ok(brut.includes('"p1"'), 'le fichier est inchangé après l\'échec de lecture');
    // Nouvelle tentative : la lecture réussit, les DEUX événements sont là.
    assert.deepEqual(await store.noterQuota({ profil: 'p2', service: 'claude', date: T0 }), { ok: true });
    assert.strictEqual((await store.chargerQuotas()).length, 2, 'aucun événement perdu');
  } finally {
    fs.rmSync(dossier, { recursive: true, force: true });
  }
});

test('agregerReponses/agregerQuotas : tri à nombre égal par profil', () => {
  const rs = [
    rep('a', 'zoe', 'claude', T0, T0 + 1000),
    rep('b', 'anne', 'claude', T0, T0 + 2000)
  ];
  const r = st.agregerReponses(rs, { maintenant: T0 });
  assert.strictEqual(r.parCompteService[0].profil, 'anne'); // -1 : anne < zoe
  assert.strictEqual(r.parCompteService[1].profil, 'zoe');
  const qs = [quo('a', 'zoe', 'claude', T0), quo('b', 'anne', 'claude', T0)];
  const rq = st.agregerQuotas(qs, { maintenant: T0 });
  assert.strictEqual(rq.parCompteService[0].profil, 'anne');
});


test('classerComptes : quotas trop anciens ignorés', () => {
  const sessions = [sess('a', 'p1', 'claude', T0 - H, T0, 1000)];
  const quotas = [
    quo('q1', 'p1', 'claude', T0 - H),
    quo('q2', 'p1', 'claude', T0 - H / 2),
    quo('vieux', 'p1', 'claude', T0 - 10 * 24 * H), // hors période semaine : ignoré
    quo('q3', 'p1', 'claude', T0 - H / 3)
  ];
  // 3 quotas RÉCENTS -> surchargé ; le vieux est ignoré (2 + vieux n'aurait
  // pas dû compter sans la période) — avec seuil 3 il faut les 3 récents.
  const r = st.classerComptes(sessions, quotas, { maintenant: T0, periode: 'semaine', seuilQuotas: 3 });
  assert.deepEqual(r.surcharges, ['p1']);
  // Sans le quota récent q3, 2 < 3 -> pas surchargé.
  const r2 = st.classerComptes(sessions, quotas.slice(0, 3), { maintenant: T0, periode: 'semaine', seuilQuotas: 3 });
  assert.deepEqual(r2.surcharges, []);
});

test('lot 2 : entrées non tableaux et cas limites des agrégats', () => {
  // Entrées non tableau : listes vides, aucun levée.
  assert.strictEqual(st.agregerQuotas(null).parCompteService.length, 0);
  const r = st.classerComptes(null, null);
  assert.deepEqual(r.sousUtilises, []);
  // Session hors période ignorée dans classerComptes ; quotas seuls.
  const ancienne = sess('v', 'p_vieux', 'claude', T0 - 10 * 24 * H, T0 - 10 * 24 * H + H, H / 2);
  const quotasSeuls = [quo('a', 'p_quotas', 'claude', T0 - H), quo('b', 'p_quotas', 'claude', T0 - H / 2)];
  const rc = st.classerComptes([ancienne], quotasSeuls, { maintenant: T0, periode: 'semaine' });
  // p_quotas : 0 session -> sous-utilisé (branche || 0) ; pas surchargé (2 < 3).
  assert.deepEqual(rc.sousUtilises, ['p_quotas']);
  assert.deepEqual(rc.surcharges, []);
});

test('lot 2 : tri à nombre égal, même profil (services différents)', () => {
  // Deux entrées de même nombre avec le MÊME profil (services différents) :
  // le tie-break prend la branche « 1 » du comparateur.
  const rs = [
    rep('a', 'p1', 'claude', T0, T0 + 1000),
    rep('b', 'p1', 'chatgpt', T0, T0 + 2000)
  ];
  const r = st.agregerReponses(rs, { maintenant: T0 });
  assert.strictEqual(r.parCompteService.length, 2);
  assert.ok(r.parCompteService.every(l => l.profil === 'p1'));
  const qs = [quo('a', 'p1', 'claude', T0), quo('b', 'p1', 'chatgpt', T0)];
  assert.strictEqual(st.agregerQuotas(qs, { maintenant: T0 }).parCompteService.length, 2);
});

test('lot 2 : appels sans options (paramètres par défaut, Date.now injecté non requis)', () => {
  const rs = [rep('a', 'p', 'claude', Date.now() - 5000, Date.now() - 1000)];
  const qs = [quo('a', 'p', 'claude', Date.now() - 1000)];
  const ss = [sess('a', 'p', 'claude', Date.now() - 2 * H, Date.now() - H, H / 2)];
  // Sans options : Date.now() réel, période « tout » — les événements
  // récents d'il y a quelques secondes restent dans toutes les périodes.
  assert.ok(st.agregerReponses(rs).totaux.nombre === 1);
  assert.ok(st.agregerQuotas(qs).parCompteService.length === 1);
  assert.ok(st.classerComptes(ss, qs).sousUtilises.length === 1);
});

test('decomposerSecondes : minutes et secondes, valeurs invalides à 0', () => {
  assert.deepEqual(st.decomposerSecondes(0), { minutes: 0, secondes: 0 });
  assert.deepEqual(st.decomposerSecondes(999), { minutes: 0, secondes: 0 });
  assert.deepEqual(st.decomposerSecondes(42500), { minutes: 0, secondes: 42 });
  assert.deepEqual(st.decomposerSecondes(125000), { minutes: 2, secondes: 5 });
  assert.deepEqual(st.decomposerSecondes(-5), { minutes: 0, secondes: 0 });
  assert.deepEqual(st.decomposerSecondes(NaN), { minutes: 0, secondes: 0 });
});

test('agregerReponses : clé de tri compte|service (#206)', () => {
  const r = st.agregerReponses([rep('a', 'p1', 'claude', T0, T0 + 1000)], { maintenant: T0 });
  assert.strictEqual(r.parCompteService[0].cle, 'p1|claude');
  const tri = st.trierLignes(r.parCompteService, 'medianeMs', 'asc');
  assert.strictEqual(tri[0].cle, 'p1|claude');
});
